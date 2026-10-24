import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createMarketService, normalizeCoins } from "../blockchain/market-service.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/market/${name}`, import.meta.url), "utf8"));
const responses = { "coins/markets": "coins.json", "/global": "global.json", "search/trending": "trending.json", fng: "fng.json" };
const fromFixtures = async (url) => fixture(Object.entries(responses).find(([key]) => url.includes(key))[1]);

test("NIR Markets serves one cached overview of prices, market, trends and Fear & Greed", async () => {
  let calls = 0;
  const service = createMarketService({ fetch: async (url) => { calls += 1; return fromFixtures(url); }, now: () => 1_700_000_000_000 });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/market/overview`)).status, 503);
    await service.refresh();
    assert.equal(calls, 4);
    const response = await fetch(`${base}/market/overview`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /max-age=30/);
    const overview = await response.json();
    assert.equal(overview.coins.length, 16);
    const btc = overview.coins[0];
    assert.equal(btc.symbol, "BTC");
    assert.equal(btc.price, 80183.42);
    assert.equal(btc.change24h, -1.75);
    assert.ok(btc.sparkline.length > 30 && btc.sparkline.length < 50);
    assert.equal(overview.global.btcDominance, 60.2);
    assert.deepEqual(overview.fearGreed, { label: "Neutral", value: 46 });
    assert.equal(overview.trending[0].symbol, "ORE");
    assert.equal(overview.gainers[0].symbol, "SUI");
    assert.equal(overview.losers[0].symbol, "DOGE");
    assert.equal(overview.source, "CoinGecko");
    assert.equal(overview.updatedAt, 1_700_000_000_000);
    // Visitors never reach the data sources: more requests, no more fetches.
    await fetch(`${base}/market/overview`);
    assert.equal(calls, 4);
    assert.equal((await fetch(`${base}/market/other`)).status, 404);
    assert.equal((await fetch(`${base}/market/overview`, { method: "POST" })).status, 404);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("a failing source keeps its last good data while the others refresh", async () => {
  let failing = false;
  const service = createMarketService({ fetch: async (url) => {
    if (failing && url.includes("fng")) throw new Error("alternative.me answered 500");
    return fromFixtures(url);
  } });
  await service.refresh();
  failing = true;
  await service.refresh();
  assert.deepEqual(service.overview().fearGreed, { label: "Neutral", value: 46 });
  assert.match(service.state.errors.fearGreed, /500/);
  assert.equal(service.overview().coins.length, 16);
});

test("coin data is bounded and only CoinGecko images are passed on", () => {
  const many = Array.from({ length: 150 }, (_, index) => ({ id: `c${index}`, symbol: "abc", name: "A".repeat(500),
    current_price: 1, image: index === 0 ? "https://evil.example/x.png" : "https://coin-images.coingecko.com/x.png" }));
  const coins = normalizeCoins(many);
  assert.equal(coins.length, 100);
  assert.equal(coins[0].image, null);
  assert.equal(coins[1].image, "https://coin-images.coingecko.com/x.png");
  assert.equal(coins[0].name.length, 60);
  assert.equal(coins[0].symbol, "ABC");
  assert.throws(() => normalizeCoins({}), /coin list is invalid/);
  assert.deepEqual(normalizeCoins([{ id: "x", symbol: "x", name: "x", current_price: null }]), []);
});
