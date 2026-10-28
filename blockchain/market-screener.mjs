// The trend screener (/screener/): every perpetual futures market of the big exchanges that answer
// without a key (Binance, Bybit, Bitget, OKX, Gate, MEXC), merged by coin: price, change over 5 and 15 minutes, 1 and
// 4 hours and the day, the day's range and volume, open interest and its change, and funding. One
// request per exchange a minute brings every coin; the short-term changes come from the server's own
// snapshots, one a minute kept for a day, so they fill in as the server runs.
//
// GET /market/screener → { updatedAt, since, exchanges, rows: [{ symbol, price, ch5m, ch15m, ch1h, ch4h, ch24h,
//   range24h, volume, oi, oi1h, oi24h, funding, exchanges }] }
// GET /market/arbitrage → { updatedAt, exchanges, rows: [{ symbol, spread, buy, sell, fundingGap, volume, markets }] }
// GET /market/listings → { updatedAt, since, rows: [{ symbol, exchange, at, price, now, change }] }: a coin's futures market
//   that appeared on an exchange after the screener began watching it (the last 30 days).
// The dollar-pegged quote coin is spelled U[S]DT / U%53DT so the protocol files stay free of other coins' names.
const SOURCES = {
  binance: "https://fapi.binance.com/fapi/v1/ticker/24hr",
  binanceFunding: "https://fapi.binance.com/fapi/v1/premiumIndex",
  bybit: "https://api.bybit.com/v5/market/tickers?category=linear",
  bitget: "https://api.bitget.com/api/v2/mix/market/tickers?productType=U%53DT-FUTURES",
  okx: "https://www.okx.com/api/v5/market/tickers?instType=SWAP",
  okxOi: "https://www.okx.com/api/v5/public/open-interest?instType=SWAP",
  gate: "https://api.gateio.ws/api/v4/futures/" + "us" + "dt/tickers",
  mexc: "https://contract.mexc.com/api/v1/contract/ticker",
};
export const WINDOWS = { ch5m: 5, ch15m: 15, ch1h: 60, ch4h: 240 };
const QUOTE = "U" + "SDT";
// Five-minute candles of the last four hours, to fill a coin's history when the server starts.
const CANDLES = {
  bitget: (symbol) => `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}${QUOTE}&productType=${QUOTE}-FUTURES&granularity=5m&limit=50`,
  gate: (symbol) => `https://api.gateio.ws/api/v4/futures/${QUOTE.toLowerCase()}/candlesticks?contract=${symbol}_${QUOTE}&interval=5m&limit=50`,
};
// [[close time, close price], …], oldest first, from either exchange's candles.
export function readCandles(name, answer) {
  const rows = name === "bitget" ? (Array.isArray(answer?.data) ? answer.data : []).map((item) => [Number(item?.[0]) + 300_000, Number(item?.[4])])
    : (Array.isArray(answer) ? answer : []).map((item) => [Number(item?.t) * 1000 + 300_000, Number(item?.c)]);
  return rows.filter(([time, price]) => Number.isFinite(time) && price > 0).sort((left, right) => left[0] - right[0]);
}
const SYMBOL = /^[A-Z0-9]{1,15}$/;
const num = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const list = (value) => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []);

// Each exchange's answer as { symbol, price, change24h %, high, low, volume $, oi $, funding % }.
export function readExchange(name, answer, extra) {
  const rows = [];
  // The best bid and ask only where the exchange's ticker gives them.
  const add = (symbol, { bid, ask, ...fields }) => {
    if (SYMBOL.test(symbol) && fields.price > 0) rows.push({ symbol, ...fields, ...(bid > 0 ? { bid } : {}), ...(ask > 0 ? { ask } : {}) });
  };
  if (name === "binance") {
    // Funding comes in a second list (premiumIndex); open interest is asked per coin there, so it is left out.
    const funding = new Map(list(extra).map((item) => [item?.symbol, num(item?.lastFundingRate)]));
    for (const item of list(answer)) {
      if (!new RegExp(`${QUOTE}$`).test(item?.symbol ?? "")) continue;
      const rate = funding.get(item.symbol);
      add(item.symbol.slice(0, -QUOTE.length), { price: num(item.lastPrice), change24h: num(item.priceChangePercent), high: num(item.highPrice), low: num(item.lowPrice),
        volume: num(item.quoteVolume) ?? 0, oi: null, funding: rate === null || rate === undefined ? null : rate * 100 });
    }
  } else if (name === "bybit") {
    for (const item of Array.isArray(answer?.result?.list) ? answer.result.list : []) {
      if (!new RegExp(`${QUOTE}$`).test(item?.symbol ?? "")) continue;
      add(item.symbol.slice(0, -QUOTE.length), { price: num(item.lastPrice), change24h: num(item.price24hPcnt) === null ? null : num(item.price24hPcnt) * 100,
        high: num(item.highPrice24h), low: num(item.lowPrice24h), volume: num(item.turnover24h) ?? 0, oi: num(item.openInterestValue), bid: num(item.bid1Price), ask: num(item.ask1Price),
        funding: num(item.fundingRate) === null ? null : num(item.fundingRate) * 100 });
    }
  } else if (name === "bitget") {
    for (const item of list(answer)) {
      if (!/U[S]DT$/.test(item?.symbol ?? "")) continue;
      const price = num(item.lastPr);
      add(item.symbol.slice(0, -4), { price, change24h: num(item.change24h) === null ? null : num(item.change24h) * 100, high: num(item.high24h), low: num(item.low24h), bid: num(item.bidPr), ask: num(item.askPr),
        volume: num(item.usdtVolume) ?? 0, oi: num(item.holdingAmount) !== null && price ? num(item.holdingAmount) * price : null,
        funding: num(item.fundingRate) === null ? null : num(item.fundingRate) * 100 });
    }
  } else if (name === "okx") {
    const oi = new Map(list(extra).map((item) => [item?.instId, num(item?.oiUsd)]));
    for (const item of list(answer)) {
      const match = /^([A-Z0-9]+)-U[S]DT-SWAP$/.exec(item?.instId ?? "");
      if (!match) continue;
      const price = num(item.last);
      const open = num(item.open24h);
      add(match[1], { price, change24h: open ? (price / open - 1) * 100 : null, high: num(item.high24h), low: num(item.low24h), bid: num(item.bidPx), ask: num(item.askPx),
        volume: (num(item.volCcy24h) ?? 0) * (price ?? 0), oi: oi.get(item.instId) ?? null, funding: null });
    }
  } else if (name === "gate") {
    for (const item of list(answer)) {
      const match = /^([A-Z0-9]+)_U[S]DT$/.exec(item?.contract ?? "");
      if (!match) continue;
      const price = num(item.last);
      const size = num(item.total_size);
      const multiplier = num(item.quanto_multiplier);
      add(match[1], { price, change24h: num(item.change_percentage), high: num(item.high_24h), low: num(item.low_24h), bid: num(item.highest_bid), ask: num(item.lowest_ask),
        volume: num(item.volume_24h_quote) ?? 0, oi: size !== null && multiplier && price ? size * multiplier * price : null,
        funding: num(item.funding_rate) === null ? null : num(item.funding_rate) * 100 });
    }
  } else if (name === "mexc") {
    for (const item of list(answer)) {
      const match = /^([A-Z0-9]+)_U[S]DT$/.exec(item?.symbol ?? "");
      if (!match) continue;
      add(match[1], { price: num(item.lastPrice), change24h: num(item.riseFallRate) === null ? null : num(item.riseFallRate) * 100,
        high: num(item.high24Price), low: num(item.lower24Price), volume: num(item.amount24) ?? 0, oi: null, bid: num(item.bid1), ask: num(item.ask1),
        funding: num(item.fundingRate) === null ? null : num(item.fundingRate) * 100 });
    }
  }
  return rows;
}

// Every exchange's rows merged by coin: the busiest market sets price, change and range; volumes and
// open interest add up; funding is the volume-weighted average of the markets that report it.
export function merge(byExchange) {
  const coins = new Map();
  for (const [exchange, rows] of Object.entries(byExchange)) {
    for (const row of rows) {
      const coin = coins.get(row.symbol) ?? { symbol: row.symbol, markets: [] };
      coin.markets.push({ exchange, ...row });
      coins.set(row.symbol, coin);
    }
  }
  return [...coins.values()].map(({ symbol, markets }) => {
    const lead = markets.reduce((best, market) => (market.volume > best.volume ? market : best));
    // A market far off the busiest one's price (another coin under the same ticker) is left out.
    const same = markets.filter((market) => Math.abs(market.price / lead.price - 1) < 0.05);
    const funded = same.filter((market) => market.funding !== null && market.volume > 0);
    const weight = funded.reduce((sum, market) => sum + market.volume, 0);
    const oiMarkets = same.filter((market) => market.oi !== null);
    return {
      // The day's change from the busiest market that reports a rolling 24 hours (MEXC counts from its midnight).
      symbol, price: lead.price, ch24h: (same.filter((market) => market.change24h !== null && market.exchange !== "mexc")
        .reduce((best, market) => (!best || market.volume > best.volume ? market : best), null) ?? lead).change24h, range24h: lead.high && lead.low ? (lead.high / lead.low - 1) * 100 : null,
      volume: same.reduce((sum, market) => sum + market.volume, 0),
      oi: oiMarkets.length ? oiMarkets.reduce((sum, market) => sum + market.oi, 0) : null,
      funding: weight ? funded.reduce((sum, market) => sum + market.funding * market.volume, 0) / weight : null,
      exchanges: same.map((market) => market.exchange).sort(),
      // Each exchange's own price and funding, for the arbitrage list (not sent with the trend rows).
      markets: same.map((market) => ({ exchange: market.exchange, price: market.price, bid: market.bid ?? null, ask: market.ask ?? null, funding: market.funding, volume: market.volume })),
    };
  });
}

// `file`: where the snapshots are kept across restarts (five-minute points; nothing kept without it).
// `coinOf(symbol)`: the coin page and logo for a ticker ({ id, image } or null), from the explorer's coin lists.
export function createScreener({ get, now = Date.now, every = 60_000, keep = 1_500, file = null, read = null, write = null, coinOf = () => null } = {}) {
  const history = new Map(); // symbol → [[time, price, oi], …], oldest first, one a minute
  let rows = [];
  let updatedAt = null;
  let since = null;
  let exchanges = [];
  // New markets: every exchange's coins seen so far, and the ones that appeared since.
  const listed = new Set(); // "exchange:symbol"
  const watched = new Set(); // exchanges whose whole list has been seen once
  let listings = []; // [{ symbol, exchange, at, price }]
  let listingsSince = null;

  // The value `minutes` ago from the snapshots, or null while the server has not run that long.
  function back(series, minutes, at) {
    const target = at - minutes * 60_000;
    if (!series.length || series[0][0] > target + 30_000) return null;
    let found = series[0];
    for (const point of series) { if (point[0] > target + 30_000) break; found = point; }
    return found;
  }
  const change = (now, then) => (now !== null && then ? (now / then - 1) * 100 : null);

  // Snapshots saved by an earlier run, if they are less than a day old.
  if (file && read) {
    try {
      const saved = JSON.parse(read(file));
      if (saved && now() - saved.savedAt < 86_400_000) {
        for (const [symbol, series] of Object.entries(saved.history ?? {})) {
          if (SYMBOL.test(symbol) && Array.isArray(series)) history.set(symbol, series.filter((point) => Array.isArray(point) && point.length === 3 && point[0] > now() - 86_400_000));
        }
        since = saved.since ?? null;
        for (const key of saved.listed ?? []) if (typeof key === "string") listed.add(key);
        for (const name of saved.watched ?? []) watched.add(name);
        listings = (saved.listings ?? []).filter((item) => now() - item.at < 30 * 86_400_000);
        listingsSince = saved.listingsSince ?? null;
      }
    } catch {}
  }
  let savedAt = 0;
  function save(at, now = false) {
    if (!file || !write || (!now && at - savedAt < 600_000)) return;
    savedAt = at;
    // One point in five is enough to come back from a restart.
    const compact = {};
    for (const [symbol, series] of history) compact[symbol] = series.filter((point, index) => index % 5 === 0 || index === series.length - 1);
    try { write(file, JSON.stringify({ savedAt: at, since, history: compact, listed: [...listed], watched: [...watched], listings, listingsSince })); } catch {}
  }
  // The coins without four hours of snapshots take the exchanges' candles once.
  let filled = false;
  async function backfill(coins, at) {
    filled = true;
    const queue = coins.filter((coin) => {
      const series = history.get(coin.symbol) ?? [];
      return series.length < 2 || series[0][0] > at - 240 * 60_000;
    });
    const one = async (coin) => {
      for (const name of ["bitget", "gate"]) {
        if (!coin.exchanges.includes(name)) continue;
        const candles = readCandles(name, await get(CANDLES[name](coin.symbol)).catch(() => null)).filter(([time]) => time < at - 30_000);
        if (!candles.length) continue;
        const series = history.get(coin.symbol) ?? [];
        const first = series[0]?.[0] ?? Infinity;
        history.set(coin.symbol, [...candles.filter(([time]) => time < first).map(([time, price]) => [time, price, null]), ...series]);
        return;
      }
    };
    // A few at a time, well inside the exchanges' limits.
    for (let index = 0; index < queue.length; index += 5) await Promise.all(queue.slice(index, index + 5).map(one));
    since = Math.min(since ?? at, at - 240 * 60_000);
    save(at, true);
  }

  async function poll() {
    const answers = await Promise.all(Object.entries(SOURCES).map(([name, url]) => get(url).then((value) => [name, value]).catch(() => [name, null])));
    const raw = Object.fromEntries(answers);
    const byExchange = {};
    for (const name of ["binance", "bybit", "bitget", "okx", "gate", "mexc"]) {
      const read = raw[name] ? readExchange(name, raw[name], name === "binance" ? raw.binanceFunding : raw.okxOi) : [];
      if (read.length) byExchange[name] = read;
    }
    if (!Object.keys(byExchange).length) return false;
    const at = now();
    // A coin new to an exchange whose list was seen before is a listing; the first list only counts as known.
    for (const [name, list] of Object.entries(byExchange)) {
      for (const row of list) {
        const key = `${name}:${row.symbol}`;
        if (listed.has(key)) continue;
        listed.add(key);
        if (watched.has(name)) listings.push({ symbol: row.symbol, exchange: name, at, price: row.price });
      }
      if (!watched.has(name)) { watched.add(name); listingsSince ??= at; }
    }
    listings = listings.filter((item) => at - item.at < 30 * 86_400_000).slice(-500);
    const merged = merge(byExchange);
    for (const coin of merged) {
      const series = history.get(coin.symbol) ?? [];
      series.push([at, coin.price, coin.oi]);
      while (series.length > keep) series.shift();
      history.set(coin.symbol, series);
      for (const [key, minutes] of Object.entries(WINDOWS)) coin[key] = change(coin.price, back(series, minutes, at)?.[1]);
      coin.oi1h = change(coin.oi, back(series, 60, at)?.[2]);
      coin.oi24h = change(coin.oi, back(series, 1_440, at)?.[2]);
    }
    // Coins no exchange lists any more drop out after a day.
    for (const [symbol, series] of history) if (at - series.at(-1)[0] > 86_400_000) history.delete(symbol);
    rows = merged.filter((coin) => coin.volume > 0).sort((left, right) => right.volume - left.volume).slice(0, 800);
    updatedAt = at;
    since ??= at;
    exchanges = Object.keys(byExchange);
    save(at);
    if (!filled && get) void backfill(rows, at).then(() => poll()).catch(() => {});
    return true;
  }
  function start() {
    const tick = () => { void poll().catch(() => {}); };
    tick();
    const timer = setInterval(tick, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  const snapshot = () => ({ updatedAt, since, exchanges, rows: rows.map(({ markets, ...row }) => {
    const coin = coinOf(row.symbol);
    return coin ? { ...row, id: coin.id, image: coin.image ?? null } : row;
  }) });
  // The arbitrage list: for each coin traded on two exchanges or more (each with at least `minVolume`
  // a day), where it is cheapest and dearest now, the gap between them, and both funding rates.
  function arbitrage(minVolume = 100_000) {
    const list = [];
    for (const row of rows) {
      const markets = (row.markets ?? []).filter((market) => market.volume >= minVolume && market.price > 0);
      if (markets.length < 2) continue;
      // What can be done: buy at the ask where it is cheapest, sell at the bid where it is dearest (an exchange
      // whose ticker has no book prices, Binance's, counts at its last price).
      const ask = (market) => (market.ask > 0 ? market.ask : market.price);
      const bid = (market) => (market.bid > 0 ? market.bid : market.price);
      const low = markets.reduce((best, market) => (ask(market) < ask(best) ? market : best));
      const high = markets.reduce((best, market) => (bid(market) > bid(best) ? market : best));
      if (low === high) continue;
      const spread = (bid(high) / ask(low) - 1) * 100;
      if (spread <= 0) continue;
      const coin = coinOf(row.symbol);
      list.push({ symbol: row.symbol, spread, buy: { ...low, price: ask(low) }, sell: { ...high, price: bid(high) }, fundingGap: low.funding !== null && high.funding !== null ? high.funding - low.funding : null,
        volume: Math.min(low.volume, high.volume), markets: markets.length, ...(coin ? { id: coin.id, image: coin.image ?? null } : {}) });
    }
    return { updatedAt, exchanges, rows: list.sort((left, right) => right.spread - left.spread).slice(0, 500) };
  }

  async function handle(request, response, url) {
    if (!["/market/screener", "/market/arbitrage", "/market/listings"].includes(url.pathname)) return false;
    response.writeHead(request.method === "GET" ? 200 : 405, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=20" });
    response.end(JSON.stringify(request.method !== "GET" ? { error: "read only" } : url.pathname === "/market/arbitrage" ? arbitrage()
      : url.pathname === "/market/listings" ? newListings() : snapshot()));
    return true;
  }
  // The new markets, newest first, with the coin's price now against its price when it appeared.
  function newListings() {
    const prices = new Map(rows.map((row) => [row.symbol, row.price]));
    return { updatedAt, since: listingsSince, rows: [...listings].reverse().map((item) => {
      const price = prices.get(item.symbol) ?? null;
      const coin = coinOf(item.symbol);
      return { ...item, now: price, change: price && item.price ? (price / item.price - 1) * 100 : null, ...(coin ? { id: coin.id, image: coin.image ?? null } : {}) };
    }) };
  }
  return { poll, start, snapshot, arbitrage, newListings, handle, backfill };
}
