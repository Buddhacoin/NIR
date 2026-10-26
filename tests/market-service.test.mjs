import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createMarketService, normalizeCoin, normalizeCoins, withoutLookalikes } from "../blockchain/market-service.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/market/${name}`, import.meta.url), "utf8"));
const responses = { "coins/markets": "coins.json", "/global": "global.json", "search/trending": "trending.json", fng: "fng.json" };
const fromFixtures = async (url) => {
  if (url.includes("/search?query=")) return fixture("search.json");
  if (url.includes("/coins/bitcoin/market_chart")) return fixture("chart-bitcoin.json");
  if (url.includes("/coins/bitcoin?")) return fixture("coin-bitcoin.json");
  if (/\/coins\/(?!markets)/.test(url)) throw Object.assign(new Error("api.coingecko.com answered 404"), { status: 404 });
  return fixture(Object.entries(responses).find(([key]) => url.includes(key))[1]);
};

test("NIR Markets serves one cached overview of prices, market, trends and Fear & Greed", async () => {
  let calls = 0;
  const service = createMarketService({ fetch: async (url) => { calls += 1; return fromFixtures(url); }, now: () => 1_700_000_000_000 });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/market/overview`)).status, 503);
    await service.refresh();
    // Four sources, the trending coins outside the top hundred and the exchange logos in one request each.
    assert.equal(calls, 6);
    await service.communityTick();
    assert.equal(calls, 7);
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
    assert.ok(overview.trendingCoins.length > 0 && overview.trendingCoins.every((coin) => "change7d" in coin && "sparkline" in coin));
    assert.equal(typeof overview.community.bitcoin, "number", "the community's rise votes come one coin at a time");
    assert.equal(overview.gainers[0].symbol, "SUI");
    assert.equal(overview.losers[0].symbol, "DOGE");
    assert.equal(overview.source, "CoinGecko");
    assert.equal(overview.updatedAt, 1_700_000_000_000);
    // Visitors never reach the data sources: more requests, no more fetches.
    await fetch(`${base}/market/overview`);
    assert.equal(calls, 7);
    assert.equal((await fetch(`${base}/market/other`)).status, 404);
    assert.equal((await fetch(`${base}/market/overview`, { method: "POST" })).status, 404);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("a failing source keeps its last good data while the others refresh", async () => {
  let failing = false;
  let clock = 1_700_000_000_000;
  const asked = [];
  const service = createMarketService({ now: () => clock, fetch: async (url) => {
    asked.push(url);
    if (failing && url.includes("fng")) throw new Error("alternative.me answered 500");
    return fromFixtures(url);
  } });
  await service.refresh();
  // A minute later only the prices are asked again; the slower figures wait their turn.
  clock += 60_000;
  const before = asked.length;
  await service.refresh();
  assert.deepEqual(asked.slice(before).map((url) => new URL(url).pathname.split("/").pop()), ["markets"]);
  failing = true;
  clock += 600_000;
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

test("a coin's page and chart are fetched on demand, cached and limited", async () => {
  let clock = 1_700_000_000_000;
  const fetched = [];
  const service = createMarketService({ fetch: async (url) => { fetched.push(url); return fromFixtures(url); },
    now: () => clock, coinFetchesPerMinute: 3 });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const [first, second] = await Promise.all([fetch(`${base}/market/coin/bitcoin`), fetch(`${base}/market/coin/bitcoin`)]);
    assert.equal(first.status, 200);
    assert.match(first.headers.get("cache-control"), /max-age=60/);
    const coin = await first.json();
    assert.deepEqual(await second.json(), coin);
    assert.equal(fetched.length, 1, "two visitors at once share one fetch");
    assert.equal(coin.symbol, "BTC");
    assert.equal(coin.price, 80183.42);
    assert.equal(coin.maxSupply, 21_000_000);
    assert.equal(coin.links.x, "https://x.com/bitcoin");
    assert.deepEqual(coin.links.explorers, ["https://mempool.space/", "https://blockchair.com/bitcoin/", "https://btc.com/"]);
    assert.deepEqual(coin.tickers.map((ticker) => ticker.market), ["Binance", "Coinbase Exchange", "OKX", "Kraken"]);
    assert.equal(coin.tickers[2].url, null);
    assert.doesNotMatch(coin.description.en, /<a|&amp;/);
    assert.doesNotMatch(coin.description.ru, /<script/);

    const chart = await (await fetch(`${base}/market/chart/bitcoin?days=30`)).json();
    assert.ok(chart.prices.length > 150 && chart.prices.length <= 241);
    assert.equal(chart.prices.at(-1)[1], 80183.42);
    assert.equal((await fetch(`${base}/market/chart/bitcoin?days=2`)).status, 404);
    assert.equal((await fetch(`${base}/market/coin/no-such-coin`)).status, 404);
    assert.equal((await fetch(`${base}/market/coin/..%2Fglobal`)).status, 404);
    assert.equal(fetched.length, 3);

    // The minute's 3 fetches are spent: a new coin waits, a cached one is still served.
    assert.equal((await fetch(`${base}/market/coin/other-coin`)).status, 503);
    clock += 10 * 60_000;
    assert.equal((await fetch(`${base}/market/coin/bitcoin`)).status, 200);
    assert.equal(fetched.length, 4, "an expired copy is fetched again once the limit allows");
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("coin details reject what is not a coin", () => {
  assert.throws(() => normalizeCoin(null), /coin data is invalid/);
  const coin = normalizeCoin({ id: "x", symbol: "x", name: "X", links: { homepage: ["javascript:alert(1)"], twitter_screen_name: "a b" } });
  assert.deepEqual(coin.links.websites, []);
  assert.equal(coin.links.x, null);
  assert.equal(coin.price, null);
});

test("search covers every coin, cleans the results and caches each query", async () => {
  const fetched = [];
  const service = createMarketService({ fetch: async (url) => { fetched.push(url); return fromFixtures(url); } });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const response = await fetch(`${base}/market/search?q=%20Zeus%20`);
    assert.equal(response.status, 200);
    const { coins } = await response.json();
    assert.deepEqual(coins.map((coin) => coin.id), ["bitcoin", "zeus-token", "athena-coin"]);
    assert.equal(coins[1].rank, 812);
    assert.equal(coins[2].image, null);
    await fetch(`${base}/market/search?q=zeus`);
    assert.equal(fetched.length, 1, "the same query is served from the cache");
    assert.match(fetched[0], /query=zeus$/);
    assert.deepEqual(await (await fetch(`${base}/market/search?q=`)).json(), { coins: [] });
    assert.deepEqual(await (await fetch(`${base}/market/search?q=${"x".repeat(41)}`)).json(), { coins: [] });
    assert.equal(fetched.length, 1);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("pages after the first hundred, the fear and greed history and the exchange count", async () => {
  const fetched = [];
  const service = createMarketService({ fetch: async (url) => { fetched.push(url); return fromFixtures(url); } });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    await service.refresh();
    const before = fetched.length;
    const first = await (await fetch(`${base}/market/coins?page=1`)).json();
    assert.equal(first.coins[0].symbol, "BTC");
    assert.equal(fetched.length, before, "page one is the overview's copy");
    const second = await (await fetch(`${base}/market/coins?page=2`)).json();
    assert.equal(second.page, 2);
    assert.match(fetched.at(-1), /per_page=100&page=2&/);
    assert.ok(second.coins.length > 0);
    assert.ok("circulating" in second.coins[0] && "maxSupply" in second.coins[0]);
    await fetch(`${base}/market/coins?page=2`);
    assert.equal(fetched.filter((url) => url.includes("coins/markets") && url.includes("page=2")).length, 1, "a page is cached");
    for (const bad of ["0", "501", "x", "1.5"]) assert.equal((await fetch(`${base}/market/coins?page=${bad}`)).status, 404);
    const history = await (await fetch(`${base}/market/fear-greed`)).json();
    assert.ok(history.history.length >= 1);
    assert.equal(typeof history.history[0].value, "number");
    assert.ok("exchanges" in service.overview().global);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("a change CoinGecko leaves out is read off the 7-day prices, and a coin too young for it gets none", () => {
  const prices = Array.from({ length: 168 }, (_, hour) => 100 + hour * 0.1);
  const [full, young] = normalizeCoins([
    { id: "olympus", symbol: "oly", name: "Olympus", current_price: 116.7, price_change_percentage_1h_in_currency: null,
      price_change_percentage_24h: null, price_change_percentage_7d_in_currency: null, sparkline_in_7d: { price: prices } },
    { id: "delos", symbol: "del", name: "Delos", current_price: 2, sparkline_in_7d: { price: prices.slice(0, 30) } },
  ]);
  assert.equal(full.change7d, Number(((116.7 / 100 - 1) * 100).toFixed(2)));
  assert.equal(full.change24h, Number(((116.7 / 114.3 - 1) * 100).toFixed(2)));
  assert.equal(full.change1h, Number(((116.7 / 116.6 - 1) * 100).toFixed(2)));
  assert.equal(young.change7d, null);
  assert.ok(young.change24h !== null);
});

test("a coin's page opens from the market list while CoinGecko is busy, and fills in later", async () => {
  let clock = 1_700_000_000_000;
  let busy = false;
  const service = createMarketService({ now: () => clock, fetch: async (url) => {
    if (busy && /\/coins\/(?!markets)/.test(url)) throw Object.assign(new Error("api.coingecko.com answered 429"), { status: 429 });
    return fromFixtures(url);
  } });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    await service.refresh();
    busy = true;
    const response = await fetch(`${base}/market/coin/bitcoin`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /max-age=0/);
    const partial = await response.json();
    assert.equal(partial.partial, true);
    assert.equal(partial.price, 80183.42);
    assert.deepEqual(partial.tickers, []);
    const week = await (await fetch(`${base}/market/chart/bitcoin?days=7`)).json();
    assert.ok(week.partial && week.prices.length > 30);
    const month = await (await fetch(`${base}/market/chart/bitcoin?days=30`)).json();
    assert.ok(month.partial && month.days === 7, "any period gets the week while the real chart waits");
    // Once fetched, a coin is served from the copy at once, even after it expires and while the source is busy.
    // (A "too many" answer pauses new fetches for two minutes.)
    busy = false;
    clock += 121_000;
    assert.equal((await (await fetch(`${base}/market/coin/bitcoin`)).json()).partial, undefined);
    busy = true;
    clock += 10 * 60_000;
    const stale = await fetch(`${base}/market/coin/bitcoin`);
    assert.equal(stale.status, 200);
    assert.equal((await stale.json()).symbol, "BTC");
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("a coin's live trades come from its busiest exchange pool, read from the coin's side", async () => {
  const { choosePool, readTrades } = await import("../blockchain/market-trades.mjs");
  const token = "0x00000000000000000000000000000000000000aa";
  const pools = { data: [
    { attributes: { name: "OLY / USD 0.3%", address: "0xpool1", volume_usd: { h24: "100" } }, relationships: { base_token: { data: { id: `eth_${token}` } }, dex: { data: { id: "olympus_swap" } } } },
    { attributes: { name: "OLY / ETH", address: "0xpool2", volume_usd: { h24: "900" } }, relationships: { base_token: { data: { id: `eth_${token}` } }, dex: { data: { id: "delos_dex" } } } },
    { attributes: { name: "ETH / OLY", address: "0xpool3", volume_usd: { h24: "5000" } }, relationships: { base_token: { data: { id: "eth_0xother" } }, dex: { data: { id: "x" } } } },
  ] };
  assert.deepEqual(choosePool(pools, "eth", token), { name: "OLY / ETH", address: "0xpool2", network: "eth", dex: "delos_dex" });
  const trades = { data: [
    { attributes: { block_timestamp: "2026-10-26T12:00:00Z", kind: "buy", from_token_address: "0xusd", to_token_address: token, from_token_amount: "200",
      to_token_amount: "2", price_from_in_usd: "1", price_to_in_usd: "100", volume_in_usd: "200", tx_from_address: "0xzeus", tx_hash: "0xt1" } },
    { attributes: { block_timestamp: "2026-10-26T12:01:00Z", kind: "sell", from_token_address: token.toUpperCase().replace("0X", "0x"), to_token_address: "0xusd",
      from_token_amount: "0.5", to_token_amount: "50", price_from_in_usd: "101", price_to_in_usd: "1", volume_in_usd: "50.5", tx_from_address: "0xhera", tx_hash: "0xt2" } },
    { attributes: { block_timestamp: "2026-10-26T12:02:00Z", kind: "buy", is_anomalous: true, volume_in_usd: "1", from_token_amount: "1", to_token_amount: "1" } },
  ] };
  assert.deepEqual(readTrades(trades, token), [
    { time: Date.parse("2026-10-26T12:00:00Z"), kind: "buy", price: 100, usd: 200, amount: 2, maker: "0xzeus", tx: "0xt1" },
    { time: Date.parse("2026-10-26T12:01:00Z"), kind: "sell", price: 101, usd: 50.5, amount: 0.5, maker: "0xhera", tx: "0xt2" },
  ]);

  const asked = [];
  const service = createMarketService({ fetch: async (url) => { asked.push(url); return url.includes("/pools?") ? pools : url.includes("/trades") ? trades : fromFixtures(url); } });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const answer = await (await fetch(`${base}/market/trades?network=eth&token=${token}`)).json();
    assert.equal(answer.pool.address, "0xpool2");
    assert.equal(answer.trades.length, 2);
    assert.equal(answer.buys, 200);
    assert.equal(answer.sells, 50.5);
    await fetch(`${base}/market/trades?network=eth&token=${token}`);
    assert.equal(asked.length, 2, "the pool and its trades are kept: a second visitor costs nothing");
    assert.equal((await fetch(`${base}/market/trades?network=eth&token=../x`)).status, 400);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test("trending tokens borrowing a large coin's ticker are left out", () => {
  const coins = [{ id: "zeus", symbol: "ZEUS" }, { id: "hera", symbol: "HERA" }];
  const trending = [{ id: "fake-zeus", symbol: "ZEUS" }, { id: "hera", symbol: "HERA" }, { id: "olympus", symbol: "OLY" }];
  assert.deepEqual(withoutLookalikes(trending, coins).map((coin) => coin.id), ["hera", "olympus"]);
});
