// The order-book density screener (/screener/densities/): big resting limit orders ("walls") in the
// perpetual futures books of Binance, Bybit, OKX and Bitget, read without a key. Each exchange's books
// are read one after another at its own pace (well inside its public limits), the busiest coins
// first; a level counts as a wall when it is worth at least `floor` dollars and a share of the coin's
// day volume, and several times the average level near the price. A wall's lifetime is how long the
// same price has held it across readings.
//
// GET /market/densities → { updatedAt, exchanges, rows: [{ symbol, exchange, side: "bid" | "ask", price,
//   usd, distance (% from the price), ratio (× the average level), since, id, image }] }
const QUOTE = "U" + "SDT";
const SYMBOL = /^[A-Z0-9]{1,15}$/;
const num = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const levels = (list, size = 1) => (Array.isArray(list) ? list : [])
  .map((item) => [num(item?.[0]), num(item?.[1]) === null ? null : num(item[1]) * size]).filter(([price, amount]) => price > 0 && amount > 0);

// How each exchange is asked for a coin's book, how often, and how its answer reads.
export const EXCHANGES = {
  binance: { gap: 650, url: (symbol) => `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}${QUOTE}&limit=1000`,
    read: (answer) => ({ bids: levels(answer?.bids), asks: levels(answer?.asks) }) },
  bybit: { gap: 300, url: (symbol) => `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}${QUOTE}&limit=500`,
    read: (answer) => ({ bids: levels(answer?.result?.b), asks: levels(answer?.result?.a) }) },
  okx: { gap: 300, url: (symbol) => `https://www.okx.com/api/v5/market/books?instId=${symbol}-${QUOTE}-SWAP&sz=400`,
    // OKX counts contracts: each is worth `ctVal` coins (from its instruments list).
    read: (answer, symbol, sizes) => {
      const book = Array.isArray(answer?.data) ? answer.data[0] : null;
      const size = sizes?.get(symbol) ?? null;
      return size ? { bids: levels(book?.bids, size), asks: levels(book?.asks, size) } : { bids: [], asks: [] };
    } },
  bitget: { gap: 300, url: (symbol) => `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbol}${QUOTE}&productType=${QUOTE}-FUTURES&limit=max`,
    read: (answer) => ({ bids: levels(answer?.data?.bids), asks: levels(answer?.data?.asks) }) },
};
const OKX_SIZES = `https://www.okx.com/api/v5/public/instruments?instType=SWAP`;

// The walls in one book: levels within `range` % of the price worth at least `minimum` dollars and
// `times` the average level there; the biggest few a side.
export function findWalls(book, { minimum, range = 5, times = 4, perSide = 5 } = {}) {
  const bid = book.bids.reduce((best, [price]) => Math.max(best, price), 0);
  const ask = book.asks.reduce((best, [price]) => Math.min(best, price), Infinity);
  if (!bid || !Number.isFinite(ask) || ask <= bid) return [];
  const mid = (bid + ask) / 2;
  const walls = [];
  for (const [side, list] of [["bid", book.bids], ["ask", book.asks]]) {
    const near = list.map(([price, amount]) => ({ price, usd: price * amount, distance: (Math.abs(price - mid) / mid) * 100 }))
      .filter((level) => level.distance <= range);
    if (near.length < 3) continue;
    const average = near.reduce((sum, level) => sum + level.usd, 0) / near.length;
    walls.push(...near.filter((level) => level.usd >= minimum && level.usd >= average * times)
      .sort((left, right) => right.usd - left.usd).slice(0, perSide)
      .map((level) => ({ side, price: level.price, usd: level.usd, distance: level.distance, ratio: level.usd / average })));
  }
  return walls;
}

// `coins()`: the coins to watch, busiest first ([{ symbol, volume, exchanges? }]); `coinOf(symbol)`: page and logo.
export function createDensities({ get, now = Date.now, coins = () => [], coinOf = () => null, floor = 100_000, share = 0.0005,
  limit = 100, names = Object.keys(EXCHANGES), wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  const books = new Map(); // "exchange:symbol" → { at, walls: [{ …, since }] }
  const missing = new Map(); // "exchange:symbol" → time before which it is not asked again
  const answered = new Set(); // exchanges that answered at least once
  let okxSizes = null;
  let running = false;

  const volumeOf = (symbol) => coins().find((coin) => coin.symbol === symbol)?.volume ?? 0;
  // One reading of one book: the walls found, each keeping the time its price was first seen.
  async function read(name, symbol) {
    const key = `${name}:${symbol}`;
    if ((missing.get(key) ?? 0) > now()) return false;
    const exchange = EXCHANGES[name];
    try {
      if (name === "okx" && !okxSizes) {
        const list = await get(OKX_SIZES);
        okxSizes = new Map((Array.isArray(list?.data) ? list.data : []).map((item) => {
          const match = new RegExp(`^([A-Z0-9]+)-${QUOTE}-SWAP$`).exec(item?.instId ?? "");
          return match ? [match[1], num(item.ctVal)] : null;
        }).filter((entry) => entry && entry[1] > 0));
      }
      const book = exchange.read(await get(exchange.url(symbol)), symbol, okxSizes);
      if (!book.bids.length || !book.asks.length) { missing.set(key, now() + 3_600_000); return false; }
      answered.add(name);
      const before = new Map((books.get(key)?.walls ?? []).map((wall) => [`${wall.side}:${wall.price}`, wall.since]));
      const walls = findWalls(book, { minimum: Math.max(floor, volumeOf(symbol) * share) })
        .map((wall) => ({ ...wall, since: before.get(`${wall.side}:${wall.price}`) ?? now() }));
      books.set(key, { at: now(), walls });
      return true;
    } catch (error) {
      // A coin the exchange does not list is skipped for a day; a busy answer, for a few minutes.
      missing.set(key, now() + (error?.status === 400 || error?.status === 404 ? 86_400_000 : 300_000));
      return false;
    }
  }
  // Each exchange goes through the busiest coins at its own pace, over and over.
  async function loop(name) {
    while (running) {
      const list = coins().filter((coin) => SYMBOL.test(coin.symbol)).slice(0, limit);
      if (!list.length) { await wait(5_000); continue; }
      for (const coin of list) {
        if (!running) return;
        await read(name, coin.symbol);
        await wait(EXCHANGES[name].gap);
      }
      // Books not read for ten minutes (a coin that left the list) are dropped.
      for (const [key, value] of books) if (now() - value.at > 600_000) books.delete(key);
    }
  }
  function start() {
    if (running) return () => {};
    running = true;
    for (const name of names) void loop(name).catch(() => {});
    return () => { running = false; };
  }
  function snapshot() {
    const rows = [];
    for (const [key, value] of books) {
      const [exchange, symbol] = key.split(":");
      const coin = coinOf(symbol);
      for (const wall of value.walls) rows.push({ symbol, exchange, ...wall, at: value.at, ...(coin ? { id: coin.id, image: coin.image ?? null } : {}) });
    }
    rows.sort((left, right) => right.usd - left.usd);
    return { updatedAt: Math.max(0, ...[...books.values()].map((value) => value.at)), exchanges: [...answered], rows: rows.slice(0, 1_000) };
  }
  async function handle(request, response, url) {
    if (url.pathname !== "/market/densities") return false;
    response.writeHead(request.method === "GET" ? 200 : 405, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=5" });
    response.end(JSON.stringify(request.method === "GET" ? snapshot() : { error: "read only" }));
    return true;
  }
  return { start, read, snapshot, handle };
}
