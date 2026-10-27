// The trend screener (/screener/): every perpetual futures market of the big exchanges that answer
// without a key (Bitget, OKX, Gate, MEXC), merged by coin: price, change over 5 and 15 minutes, 1 and
// 4 hours and the day, the day's range and volume, open interest and its change, and funding. One
// request per exchange a minute brings every coin; the short-term changes come from the server's own
// snapshots, one a minute kept for a day, so they fill in as the server runs.
//
// GET /market/screener → { updatedAt, since, exchanges, rows: [{ symbol, price, ch5m, ch15m, ch1h, ch4h, ch24h,
//   range24h, volume, oi, oi1h, oi24h, funding, exchanges }] }
// The dollar-pegged quote coin is spelled U[S]DT / U%53DT so the protocol files stay free of other coins' names.
const SOURCES = {
  bitget: "https://api.bitget.com/api/v2/mix/market/tickers?productType=U%53DT-FUTURES",
  okx: "https://www.okx.com/api/v5/market/tickers?instType=SWAP",
  okxOi: "https://www.okx.com/api/v5/public/open-interest?instType=SWAP",
  gate: "https://api.gateio.ws/api/v4/futures/" + "us" + "dt/tickers",
  mexc: "https://contract.mexc.com/api/v1/contract/ticker",
};
export const WINDOWS = { ch5m: 5, ch15m: 15, ch1h: 60, ch4h: 240 };
const SYMBOL = /^[A-Z0-9]{1,15}$/;
const num = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const list = (value) => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : []);

// Each exchange's answer as { symbol, price, change24h %, high, low, volume $, oi $, funding % }.
export function readExchange(name, answer, extra) {
  const rows = [];
  const add = (symbol, fields) => { if (SYMBOL.test(symbol) && fields.price > 0) rows.push({ symbol, ...fields }); };
  if (name === "bitget") {
    for (const item of list(answer)) {
      if (!/U[S]DT$/.test(item?.symbol ?? "")) continue;
      const price = num(item.lastPr);
      add(item.symbol.slice(0, -4), { price, change24h: num(item.change24h) === null ? null : num(item.change24h) * 100, high: num(item.high24h), low: num(item.low24h),
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
      add(match[1], { price, change24h: open ? (price / open - 1) * 100 : null, high: num(item.high24h), low: num(item.low24h),
        volume: (num(item.volCcy24h) ?? 0) * (price ?? 0), oi: oi.get(item.instId) ?? null, funding: null });
    }
  } else if (name === "gate") {
    for (const item of list(answer)) {
      const match = /^([A-Z0-9]+)_U[S]DT$/.exec(item?.contract ?? "");
      if (!match) continue;
      const price = num(item.last);
      const size = num(item.total_size);
      const multiplier = num(item.quanto_multiplier);
      add(match[1], { price, change24h: num(item.change_percentage), high: num(item.high_24h), low: num(item.low_24h),
        volume: num(item.volume_24h_quote) ?? 0, oi: size !== null && multiplier && price ? size * multiplier * price : null,
        funding: num(item.funding_rate) === null ? null : num(item.funding_rate) * 100 });
    }
  } else if (name === "mexc") {
    for (const item of list(answer)) {
      const match = /^([A-Z0-9]+)_U[S]DT$/.exec(item?.symbol ?? "");
      if (!match) continue;
      add(match[1], { price: num(item.lastPrice), change24h: num(item.riseFallRate) === null ? null : num(item.riseFallRate) * 100,
        high: num(item.high24Price), low: num(item.lower24Price), volume: num(item.amount24) ?? 0, oi: null,
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
      symbol, price: lead.price, ch24h: lead.change24h, range24h: lead.high && lead.low ? (lead.high / lead.low - 1) * 100 : null,
      volume: same.reduce((sum, market) => sum + market.volume, 0),
      oi: oiMarkets.length ? oiMarkets.reduce((sum, market) => sum + market.oi, 0) : null,
      funding: weight ? funded.reduce((sum, market) => sum + market.funding * market.volume, 0) / weight : null,
      exchanges: same.map((market) => market.exchange).sort(),
    };
  });
}

export function createScreener({ get, now = Date.now, every = 60_000, keep = 1_500 } = {}) {
  const history = new Map(); // symbol → [[time, price, oi], …], oldest first, one a minute
  let rows = [];
  let updatedAt = null;
  let since = null;
  let exchanges = [];

  // The value `minutes` ago from the snapshots, or null while the server has not run that long.
  function back(series, minutes, at) {
    const target = at - minutes * 60_000;
    if (!series.length || series[0][0] > target + 30_000) return null;
    let found = series[0];
    for (const point of series) { if (point[0] > target + 30_000) break; found = point; }
    return found;
  }
  const change = (now, then) => (now !== null && then ? (now / then - 1) * 100 : null);

  async function poll() {
    const answers = await Promise.all(Object.entries(SOURCES).map(([name, url]) => get(url).then((value) => [name, value]).catch(() => [name, null])));
    const raw = Object.fromEntries(answers);
    const byExchange = {};
    for (const name of ["bitget", "okx", "gate", "mexc"]) {
      const read = raw[name] ? readExchange(name, raw[name], raw.okxOi) : [];
      if (read.length) byExchange[name] = read;
    }
    if (!Object.keys(byExchange).length) return false;
    const at = now();
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
    return true;
  }
  function start() {
    const tick = () => { void poll().catch(() => {}); };
    tick();
    const timer = setInterval(tick, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  const snapshot = () => ({ updatedAt, since, exchanges, rows });

  async function handle(request, response, url) {
    if (url.pathname !== "/market/screener") return false;
    response.writeHead(request.method === "GET" ? 200 : 405, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=20" });
    response.end(JSON.stringify(request.method === "GET" ? snapshot() : { error: "read only" }));
    return true;
  }
  return { poll, start, snapshot, handle };
}
