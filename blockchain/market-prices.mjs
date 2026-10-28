// NIR Markets' own prices, so the site does not hang on one data company. Every 20 seconds the spot
// tickers of five exchanges are read in one request each (no key) and each coin's price is the
// volume-weighted average of the markets that agree (within 2 % of their median), turned from the
// stablecoin into dollars at the stablecoin's own price; its day's change from the same markets' prices a
// day ago. The market list (market-service.mjs) takes these over CoinGecko's minute-old figures, and the
// market cap follows the price. When CoinGecko does not answer at all, CoinPaprika's free list stands in
// (readPaprika), matched to the coins the site already knows.

const STABLE = "U" + "SDT";
const SYMBOL = /^[A-Z0-9]{1,15}$/;
const num = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const list = (value) => (Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.result?.list) ? value.result.list
  : Array.isArray(value?.data?.ticker) ? value.data.ticker : []);

// Each exchange: its address and its rows as { symbol, price, open (a day ago), volume (in the stablecoin) }.
export const TICKERS = {
  okx: ["https://www.okx.com/api/v5/market/tickers?instType=SPOT", (item) => {
    const match = new RegExp(`^([A-Z0-9]+)-${STABLE}$`).exec(item?.instId ?? "");
    const price = num(item?.last);
    return match && { symbol: match[1], price, open: num(item?.open24h), volume: (num(item?.vol24h) ?? 0) * (price ?? 0) };
  }],
  gate: ["https://api.gateio.ws/api/v4/spot/tickers", (item) => {
    const match = new RegExp(`^([A-Z0-9]+)_${STABLE}$`).exec(item?.currency_pair ?? "");
    const price = num(item?.last);
    const change = num(item?.change_percentage);
    return match && { symbol: match[1], price, open: price && change !== null ? price / (1 + change / 100) : null, volume: num(item?.quote_volume) ?? 0 };
  }],
  bitget: ["https://api.bitget.com/api/v2/spot/market/tickers", (item) => {
    const match = new RegExp(`^([A-Z0-9]+)${STABLE}$`).exec(item?.symbol ?? "");
    return match && { symbol: match[1], price: num(item?.lastPr), open: num(item?.open), volume: num(item?.quoteVolume) ?? 0 };
  }],
  kucoin: ["https://api.kucoin.com/api/v1/market/allTickers", (item) => {
    const match = new RegExp(`^([A-Z0-9]+)-${STABLE}$`).exec(item?.symbol ?? "");
    return match && { symbol: match[1], price: num(item?.last), open: num(item?.open), volume: num(item?.volValue) ?? 0 };
  }],
  bybit: ["https://api.bybit.com/v5/market/tickers?category=spot", (item) => {
    const match = new RegExp(`^([A-Z0-9]+)${STABLE}$`).exec(item?.symbol ?? "");
    return match && { symbol: match[1], price: num(item?.lastPrice), open: num(item?.prevPrice24h), volume: num(item?.turnover24h) ?? 0 };
  }],
};

export function readTickers(name, answer) {
  return list(answer).map((item) => TICKERS[name][1](item)).filter((row) => row && SYMBOL.test(row.symbol) && row.price > 0);
}

// One coin's price from its markets: those within 2 % of the median, weighted by volume; at least one market
// (two when nothing else vouches for the coin, so a different coin under the same ticker is not taken).
export function combine(markets) {
  const priced = markets.filter((market) => market.price > 0);
  if (!priced.length) return null;
  const sorted = priced.map((market) => market.price).sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const agree = priced.filter((market) => Math.abs(market.price / median - 1) <= 0.02);
  const weight = agree.reduce((sum, market) => sum + Math.max(market.volume, 1), 0);
  const price = agree.reduce((sum, market) => sum + market.price * Math.max(market.volume, 1), 0) / weight;
  const opened = agree.filter((market) => market.open > 0);
  const openWeight = opened.reduce((sum, market) => sum + Math.max(market.volume, 1), 0);
  const open = openWeight ? opened.reduce((sum, market) => sum + market.open * Math.max(market.volume, 1), 0) / openWeight : null;
  return { price, open, volume: agree.reduce((sum, market) => sum + market.volume, 0), markets: agree.length };
}

export function createPrices({ get, now = Date.now, every = 20_000 } = {}) {
  let bySymbol = new Map(); // symbol → { price, open, volume, markets } in the stablecoin
  let at = 0;
  let running = null;
  async function refresh() {
    if (running) return running;
    running = (async () => {
      const answers = await Promise.all(Object.entries(TICKERS).map(([name, [url]]) => get(url).then((answer) => readTickers(name, answer), () => [])));
      const grouped = new Map();
      for (const rows of answers) for (const row of rows) grouped.set(row.symbol, [...(grouped.get(row.symbol) ?? []), row]);
      const next = new Map();
      for (const [symbol, markets] of grouped) { const combined = combine(markets); if (combined) next.set(symbol, combined); }
      if (next.size) { bySymbol = next; at = now(); }
    })().finally(() => { running = null; });
    return running;
  }
  // The market list's rows with the exchanges' prices laid over: only where the exchanges agree with the
  // row's own price within 10 % (another coin under the same ticker stays out), the stablecoin itself kept.
  function overlay(coins) {
    if (!bySymbol.size || now() - at > 3 * every + 30_000) return coins;
    const unit = coins.find((coin) => coin.symbol === STABLE)?.price ?? 1;
    return coins.map((coin) => {
      const live = coin.symbol === STABLE ? null : bySymbol.get(coin.symbol);
      if (!live || !coin.price) return coin;
      const price = live.price * unit;
      if (Math.abs(price / coin.price - 1) > 0.1) return coin;
      const change24h = live.open ? (live.price / live.open - 1) * 100 : coin.change24h;
      const marketCap = coin.circulating ? price * coin.circulating : coin.marketCap !== null ? coin.marketCap * (price / coin.price) : null;
      return { ...coin, price: Number(price.toPrecision(10)), change24h, marketCap, source: "exchanges", markets: live.markets };
    });
  }
  let timer = null;
  return {
    refresh, overlay, size: () => bySymbol.size, at: () => at,
    start() { void refresh(); timer = setInterval(() => { void refresh(); }, every); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}

// CoinPaprika's free list as the market list's rows, when CoinGecko does not answer. A coin the site already
// knows keeps its id (the coin pages use CoinGecko's), picture and week line; the rest take an id from the name.
export const PAPRIKA = "https://api.coinpaprika.com/v1/tickers?quotes=USD";
export function readPaprika(answer, known = []) {
  const bySymbolName = new Map(known.map((coin) => [`${coin.symbol}:${coin.name.toLowerCase()}`, coin]));
  const bySymbol = new Map(known.map((coin) => [coin.symbol, coin]));
  return (Array.isArray(answer) ? answer : []).filter((item) => item?.rank > 0 && item?.quotes?.USD?.price > 0)
    .sort((left, right) => left.rank - right.rank).slice(0, 100).map((item) => {
      const symbol = String(item.symbol ?? "").toUpperCase().slice(0, 20);
      const name = String(item.name ?? "").slice(0, 60);
      const was = bySymbolName.get(`${symbol}:${name.toLowerCase()}`) ?? bySymbol.get(symbol);
      const usd = item.quotes.USD;
      return {
        id: was?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), symbol, name: was?.name ?? name, image: was?.image ?? null,
        rank: item.rank, price: num(usd.price), change1h: num(usd.percent_change_1h), change24h: num(usd.percent_change_24h), change7d: num(usd.percent_change_7d),
        marketCap: num(usd.market_cap), volume: num(usd.volume_24h), circulating: num(item.circulating_supply), maxSupply: num(item.max_supply) || null,
        sparkline: was?.sparkline ?? [], source: "coinpaprika",
      };
    }).filter((coin) => coin.id && coin.symbol);
}
