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

test("the trend screener merges the exchanges' futures markets by coin and fills short-term changes from its own snapshots", async () => {
  const { createScreener, readExchange, merge } = await import("../blockchain/market-screener.mjs");
  const bitget = { data: [{ symbol: "ZEUSUSDT", lastPr: "10", change24h: "0.05", high24h: "11", low24h: "9", usdtVolume: "1000000", holdingAmount: "50000", fundingRate: "0.0001" }] };
  const gate = [{ contract: "ZEUS_USDT", last: "10.1", change_percentage: "4", high_24h: "11", low_24h: "9", volume_24h_quote: "300000", total_size: "1000", quanto_multiplier: "10", funding_rate: "0.0003" },
    { contract: "HERA_USDT", last: "500", change_percentage: "1", volume_24h_quote: "10" }];
  assert.deepEqual(readExchange("bitget", bitget)[0], { symbol: "ZEUS", price: 10, change24h: 5, high: 11, low: 9, volume: 1_000_000, oi: 500_000, funding: 0.01 });
  const [zeus] = merge({ bitget: readExchange("bitget", bitget), gate: readExchange("gate", gate) }).filter((coin) => coin.symbol === "ZEUS");
  assert.equal(zeus.price, 10, "the busiest market sets the price");
  assert.equal(zeus.volume, 1_300_000);
  assert.equal(zeus.oi, 500_000 + 101_000);
  assert.ok(Math.abs(zeus.funding - (0.01 * 1_000_000 + 0.03 * 300_000) / 1_300_000) < 1e-12, "funding weighted by volume");
  assert.deepEqual(zeus.exchanges, ["bitget", "gate"]);

  let clock = 1_700_000_000_000;
  let price = "10";
  const get = async (url) => (url.includes("bitget") ? { data: [{ ...bitget.data[0], lastPr: price }] } : null);
  const screener = createScreener({ get, now: () => clock });
  await screener.poll();
  assert.equal(screener.snapshot().rows[0].ch5m, null, "no history yet");
  clock += 5 * 60_000;
  price = "11";
  await screener.poll();
  const row = screener.snapshot().rows[0];
  assert.ok(Math.abs(row.ch5m - 10) < 1e-9, "10% over five minutes");
  assert.equal(row.ch1h, null);
});

test("the trend screener fills four hours from the exchanges' candles and keeps its snapshots across a restart", async () => {
  const { createScreener, readCandles } = await import("../blockchain/market-screener.mjs");
  const clock = 1_700_000_000_000;
  const start = clock - 50 * 300_000;
  assert.deepEqual(readCandles("gate", [{ t: 100, c: "2" }]), [[400_000, 2]]);
  // Five-minute candles from 10 up to 12, the price now 12.
  const candles = { data: Array.from({ length: 50 }, (_, index) => [String(start + index * 300_000 - 300_000), "0", "0", "0", String(10 + (index * 2) / 49), "0"]) };
  const ticker = { data: [{ symbol: "ZEUSUSDT", lastPr: "12", change24h: "0", usdtVolume: "1000", holdingAmount: "1" }] };
  const get = async (url) => (url.includes("candles") ? candles : url.includes("tickers") && url.includes("bitget") ? ticker : null);
  const files = new Map();
  const options = { get, now: () => clock, file: "screener.json", read: (path) => files.get(path), write: (path, text) => files.set(path, text) };
  const screener = createScreener(options);
  await screener.poll();
  await screener.backfill(screener.snapshot().rows, clock);
  await screener.poll();
  const [row] = screener.snapshot().rows;
  assert.ok(row.ch4h > 15 && row.ch4h < 21, `four hours from the candles: ${row.ch4h}`);
  assert.ok(row.ch5m !== null && Math.abs(row.ch5m) < 1);
  assert.ok(files.has("screener.json"), "the snapshots are saved");
  const again = createScreener({ ...options, get: async (url) => (url.includes("tickers") && url.includes("bitget") ? ticker : null) });
  await again.poll();
  assert.ok(again.snapshot().rows[0].ch4h > 15, "a restart keeps the history");
});

test("coin pages fetched before are kept on disk and answer at once after a restart", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cacheFile = join(mkdtempSync(join(tmpdir(), "nir-cache-")), "cache.db");
  const open = async (fetchImpl) => {
    const service = createMarketService({ fetch: fetchImpl, cacheFile });
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    return { service, base: `http://127.0.0.1:${service.server.address().port}` };
  };
  const first = await open(async (url) => fromFixtures(url));
  try {
    assert.equal((await fetch(`${first.base}/market/coin/bitcoin`)).status, 200);
  } finally { await new Promise((resolve) => first.service.server.close(resolve)); }
  // The data source is down after the restart: the copy on disk still answers.
  const second = await open(async () => { throw Object.assign(new Error("busy"), { status: 429 }); });
  try {
    const response = await fetch(`${second.base}/market/coin/bitcoin`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "bitcoin");
  } finally { await new Promise((resolve) => second.service.server.close(resolve)); }
});

test("the density screener finds the big resting orders in each exchange's book and keeps how long they stand", async () => {
  const { createDensities, findWalls, EXCHANGES } = await import("../blockchain/market-densities.mjs");
  const book = { bids: [[99.5, 1], [99, 1], [98.5, 1], [98, 1], [97.5, 1], [97, 1], [96, 50], [80, 900]], asks: [[101, 1], [102, 1], [103, 2], [104, 1]] };
  const walls = findWalls(book, { minimum: 1_000 });
  assert.equal(walls.length, 1, "only the level many times the average, near the price and big enough");
  assert.deepEqual([walls[0].side, walls[0].price, walls[0].usd], ["bid", 96, 4_800]);
  assert.ok(Math.abs(walls[0].distance - ((100.25 - 96) / 100.25) * 100) < 1e-9, "distance from the middle of the spread");
  // Each exchange's own answer reads into the same book; OKX's contracts become coins.
  assert.deepEqual(EXCHANGES.bybit.read({ result: { b: [["10", "2"]], a: [["11", "3"]] } }), { bids: [[10, 2]], asks: [[11, 3]] });
  assert.deepEqual(EXCHANGES.okx.read({ data: [{ bids: [["10", "5", "0", "1"]], asks: [["11", "5", "0", "1"]] }] }, "ZEUS", new Map([["ZEUS", 0.1]])),
    { bids: [[10, 0.5]], asks: [[11, 0.5]] });

  let clock = 1_700_000_000_000;
  const answer = { bids: [["99.5", "1"], ["99", "1"], ["98.5", "1"], ["98", "1"], ["97", "1"], ["96", "5000"]], asks: [["101", "1"], ["102", "1"], ["103", "1"]] };
  const densities = createDensities({ get: async () => answer, now: () => clock, floor: 100_000, names: ["binance"],
    coins: () => [{ symbol: "ZEUS", volume: 1_000_000 }], coinOf: (symbol) => (symbol === "ZEUS" ? { id: "zeus", image: null } : null) });
  assert.equal(await densities.read("binance", "ZEUS"), true);
  clock += 120_000;
  await densities.read("binance", "ZEUS");
  const [wall] = densities.snapshot().rows;
  assert.deepEqual([wall.symbol, wall.exchange, wall.side, wall.price, wall.usd, wall.id], ["ZEUS", "binance", "bid", 96, 480_000, "zeus"]);
  assert.equal(clock - wall.since, 120_000, "the wall has stood since the first reading");
});

test("the screener reads Binance and Bybit too, and lists where a coin is cheapest and dearest", async () => {
  const { createScreener, readExchange } = await import("../blockchain/market-screener.mjs");
  const quote = "U" + "SDT";
  const binance = [{ symbol: `ZEUS${quote}`, lastPrice: "10", priceChangePercent: "2.5", highPrice: "11", lowPrice: "9", quoteVolume: "5000000" }];
  const funding = [{ symbol: `ZEUS${quote}`, lastFundingRate: "0.0001" }];
  assert.deepEqual(readExchange("binance", binance, funding)[0], { symbol: "ZEUS", price: 10, change24h: 2.5, high: 11, low: 9, volume: 5_000_000, oi: null, funding: 0.01 });
  const bybit = { result: { list: [{ symbol: `ZEUS${quote}`, lastPrice: "10.2", price24hPcnt: "0.03", highPrice24h: "11", lowPrice24h: "9", turnover24h: "2000000", openInterestValue: "300000", fundingRate: "0.0004" }] } };
  assert.deepEqual(readExchange("bybit", bybit)[0], { symbol: "ZEUS", price: 10.2, change24h: 3, high: 11, low: 9, volume: 2_000_000, oi: 300_000, funding: 0.04 });

  const get = async (url) => (url.includes("binance.com/fapi/v1/ticker") ? binance : url.includes("premiumIndex") ? funding : url.includes("bybit") ? bybit : null);
  const screener = createScreener({ get, now: () => 1_700_000_000_000 });
  await screener.poll();
  const [row] = screener.arbitrage().rows;
  assert.deepEqual([row.symbol, row.buy.exchange, row.sell.exchange, row.markets], ["ZEUS", "binance", "bybit", 2]);
  assert.ok(Math.abs(row.spread - 2) < 1e-9, "2% dearer on the second exchange");
  assert.ok(Math.abs(row.fundingGap - 0.03) < 1e-9);
  assert.equal(row.volume, 2_000_000, "the smaller of the two volumes");
  assert.equal(screener.snapshot().rows[0].markets, undefined, "the trend rows do not carry each exchange's prices");
});

test("liquidations from every exchange's stream add up by side, coin and period, each counted once", async () => {
  const { createLiquidations, readLiquidations } = await import("../blockchain/market-liquidations.mjs");
  const quote = "U" + "SDT";
  const clock = 1_700_000_000_000;
  // Binance: a forced SELL closes a long.
  const binance = readLiquidations("binance", { o: { s: `ZEUS${quote}`, S: "SELL", ap: "10", z: "1000", T: clock - 60_000 } });
  assert.deepEqual(binance, [{ exchange: "binance", symbol: "ZEUS", side: "long", price: 10, usd: 10_000, time: clock - 60_000 }]);
  // Bybit: a Buy side is a long closed.
  assert.equal(readLiquidations("bybit", { data: [{ s: `ZEUS${quote}`, S: "Sell", p: "10", v: "50", T: clock }] })[0].side, "short");
  // OKX: contracts times their size in coins.
  const okx = readLiquidations("okx", { data: [{ instId: `HERA-${quote}-SWAP`, details: [{ posSide: "short", bkPx: "2", sz: "100", ts: String(clock - 5 * 3_600_000) }] }] }, new Map([["HERA", 10]]));
  assert.deepEqual([okx[0].side, okx[0].usd], ["short", 2_000]);
  const liquidations = createLiquidations({ get: async () => null, now: () => clock });
  liquidations.take([...binance, ...binance, ...okx]);
  const view = liquidations.snapshot();
  assert.deepEqual(view.totals.h1, { long: 10_000, short: 0 }, "the same liquidation counts once");
  assert.deepEqual(view.totals.d1, { long: 10_000, short: 2_000 });
  assert.equal(view.coins[0].symbol, "ZEUS");
  assert.equal(view.recent.length, 1, "the last hour only");
});

test("a futures market that appears after the screener began watching an exchange is listed as new", async () => {
  const { createScreener } = await import("../blockchain/market-screener.mjs");
  let clock = 1_700_000_000_000;
  let list = [{ symbol: "ZEUSUSDT", lastPr: "10", usdtVolume: "1000" }].map((item) => ({ ...item, symbol: item.symbol.replace("USDT", "U" + "SDT") }));
  const get = async (url) => (url.includes("bitget") && url.includes("tickers") ? { data: list } : null);
  const screener = createScreener({ get, now: () => clock });
  await screener.poll();
  assert.equal(screener.newListings().rows.length, 0, "the first list only counts as known");
  clock += 60_000;
  list = [...list, { symbol: "HERA" + "U" + "SDT", lastPr: "2", usdtVolume: "500" }];
  await screener.poll();
  const [listing] = screener.newListings().rows;
  assert.deepEqual([listing.symbol, listing.exchange, listing.price, listing.at], ["HERA", "bitget", 2, clock]);
});

test("the order book screener gathers a book into price steps and reads each exchange's answers its own way", async () => {
  const { createBook, gatherBook, niceStep } = await import("../blockchain/market-book.mjs");
  assert.equal(niceStep(1.17), 2);
  assert.equal(niceStep(0.0031), 0.005);
  const gathered = gatherBook({ bids: [[99.9, 1], [99.1, 2], [60, 5], [10, 5]], asks: [[100.1, 3], [100.9, 4]] }, 0.5, 100);
  assert.equal(gathered.step, 0.5, "the step follows how far the book reaches (40 below the price, in a hundred steps)");
  assert.deepEqual(gathered.bids, [[99.5, 1], [99, 2], [60, 5]], "bids round down into their step; one beyond the range is left out");
  assert.deepEqual(gathered.asks, [[100.5, 3], [101, 4]], "asks round up");
  assert.equal(gatherBook({ bids: [[99.99, 1]], asks: [[100.01, 1]] }, 0.5, 100).step, 0.0005, "a short book keeps fine prices");
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    if (url.includes("instruments")) return { data: [{ instId: "ETH-U" + "SDT-SWAP", ctVal: "0.1" }] };
    if (url.includes("/books?")) return { data: [{ bids: [["2000", "10", "0", "1"]], asks: [["2001", "20", "0", "1"]] }] };
    if (url.includes("/market/trades")) return { data: [{ px: "2000.5", sz: "3", side: "sell", ts: "1000" }] };
    if (url.includes("bitfinex")) return [[2000, 1, 2], [2002, 1, -3]];
    return null;
  };
  const book = createBook({ get, now: () => 5_000 });
  const call = async (path) => {
    const response = { status: 0, body: "", writeHead(code) { this.status = code; }, end(text) { this.body = text; } };
    await book.handle({ method: "GET" }, response, new URL(`http://x${path}`));
    return { status: response.status, data: JSON.parse(response.body) };
  };
  const swap = await call("/market/book?ex=okx-f&base=ETH&quote=U" + "SDT");
  assert.deepEqual([swap.data.bids[0][1], swap.data.asks[0][1]], [1, 2], "contracts count as their coins");
  assert.deepEqual((await call("/market/book/trades?ex=okx-f&base=ETH&quote=U" + "SDT")).data.trades, [{ time: 1000, price: 2000.5, amount: 0.30000000000000004, side: "sell" }]);
  const dollars = await call("/market/book?ex=bitfinex&base=ETH&quote=U" + "SDT");
  assert.equal(dollars.data.quote, "USD", "an exchange that trades dollars answers for the stablecoin");
  assert.deepEqual([dollars.data.bids.length, dollars.data.asks.length], [1, 1]);
  const before = asked.length;
  await call("/market/book?ex=bitfinex&base=ETH&quote=U" + "SDT");
  assert.equal(asked.length, before, "a second visitor within two seconds costs the exchange nothing");
  assert.equal((await call("/market/book?ex=nowhere&base=ETH")).status, 400);
  assert.equal((await call("/market/book?ex=coinbase&base=ETH")).status, 404, "an empty book is no market");
  assert.equal((await call("/market/book/exchanges")).data.exchanges.length, 11);
});

test("Binance's book is kept in full depth from its stream of changes on top of a snapshot", async () => {
  const { createDeep, layered } = await import("../blockchain/market-book.mjs");
  let snapshotId = 100;
  const sockets = [];
  const asked = [];
  const deep = createDeep({ get: async (url) => { asked.push(url); return { lastUpdateId: snapshotId, bids: [["100", "1"], ["99", "2"]], asks: [["101", "1"], ["102", "3"]] }; },
    socket: () => { const ws = { close() {} }; sockets.push(ws); return ws; }, wait: async () => {}, now: () => 0 });
  deep.open("binance", "ETHX", "https://snapshot");
  assert.equal(deep.read("binance", "ETHX"), null, "nothing until the stream and the snapshot meet");
  const ws = sockets[0];
  ws.onmessage({ data: JSON.stringify({ U: 95, u: 99, b: [["50", "9"]], a: [] }) }); // before the snapshot: buffered, then dropped as old
  ws.onopen();
  await new Promise((resolve) => setTimeout(resolve, 0));
  ws.onmessage({ data: JSON.stringify({ U: 100, u: 101, b: [["60", "40"], ["99", "0"]], a: [["300", "7"]] }) });
  ws.onmessage({ data: JSON.stringify({ U: 102, u: 102, b: [], a: [["101", "5"]] }) });
  const book = deep.read("binance", "ETHX");
  assert.deepEqual(book.bids.sort((left, right) => right[0] - left[0]), [[100, 1], [60, 40]], "a far level joins from the stream; an emptied one leaves");
  assert.deepEqual(book.asks.sort((left, right) => left[0] - right[0]), [[101, 5], [102, 3], [300, 7]]);
  // A gap in the stream: the book is read again, and the far levels beyond the snapshot's reach stay.
  snapshotId = 200;
  ws.onmessage({ data: JSON.stringify({ U: 150, u: 151, b: [], a: [] }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  ws.onmessage({ data: JSON.stringify({ U: 201, u: 201, b: [], a: [] }) });
  const again = deep.read("binance", "ETHX");
  assert.ok(again.bids.some(([price]) => price === 60) && again.asks.some(([price]) => price === 300));
  assert.equal(asked.length, 2);
  // Bitfinex at several precisions: each coarser layer adds only what lies beyond the finer one.
  assert.deepEqual(layered([{ bids: [[100, 1], [99, 1]], asks: [[101, 1]] }, { bids: [[100, 5], [90, 2]], asks: [[101, 9], [120, 3]] }]),
    { bids: [[100, 1], [99, 1], [90, 2]], asks: [[101, 1], [120, 3]] });
});

test("Bybit's book comes from its stream: a snapshot, then changes; a depth it does not offer falls back to a smaller one", async () => {
  const { createDeep } = await import("../blockchain/market-book.mjs");
  const sockets = [];
  const deep = createDeep({ get: async () => null, socket: () => { const ws = { sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() {} }; sockets.push(ws); return ws; }, now: () => 0 });
  deep.open("bybit-f", "ETHX", null);
  const ws = sockets[0];
  ws.onopen();
  assert.deepEqual(ws.sent[0], { op: "subscribe", args: ["orderbook.1000.ETHX"] });
  ws.onmessage({ data: JSON.stringify({ op: "subscribe", success: false }) });
  assert.deepEqual(ws.sent[1], { op: "subscribe", args: ["orderbook.500.ETHX"] });
  ws.onmessage({ data: JSON.stringify({ topic: "orderbook.500.ETHX", type: "delta", data: { b: [["1", "1"]], a: [], u: 5 } }) });
  assert.equal(deep.read("bybit-f", "ETHX"), null, "a change before the snapshot is not a book");
  ws.onmessage({ data: JSON.stringify({ topic: "orderbook.500.ETHX", type: "snapshot", data: { b: [["99", "2"], ["98", "1"]], a: [["101", "3"]], u: 10 } }) });
  ws.onmessage({ data: JSON.stringify({ topic: "orderbook.500.ETHX", type: "delta", data: { b: [["98", "0"], ["97", "4"]], a: [], u: 11 } }) });
  assert.deepEqual(deep.read("bybit-f", "ETHX").bids.sort((left, right) => right[0] - left[0]), [[99, 2], [97, 4]]);
});
