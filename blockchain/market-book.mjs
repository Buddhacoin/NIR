// The order book screener (/screener/book/), in the manner of the order-book tools for traders: one pair's
// book on one of eight exchanges, spot or futures (or several side by side), its latest trades and its candles, read from the
// exchanges' public APIs without a key. The server reads each one at most every two seconds whoever asks
// (candles every twenty), so many visitors cost the exchanges no more than one, and it sends the book
// already trimmed to its largest levels (800 a side) with its totals, not the exchanges' full answers.
//
// GET /market/book?ex=<exchange>&base=<coin>&quote=<quote> → { ex, base, quote, pair, price, bids: [[price, amount, volume through it]], asks,
//   totals: { bids: [[coins, quote] within 1 %, 2 %, … 100 %], asks }, levels, full, at }
// GET /market/book/trades?ex=…&base=…&quote=… → { trades: [{ time, price, amount, side: "buy" | "sell" }] } (newest first)
// GET /market/book/candles?ex=…&base=…&quote=…&tf=1m|5m|15m|1h|4h|1d → { candles: [[time (s), open, high, low, close, volume]] } (oldest first)
// GET /market/book/exchanges → { exchanges: [{ id, name, quotes }] }
const STABLE = "U" + "SDT";
const SYMBOL = /^[A-Z0-9]{1,15}$/;
const num = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const pairs = (list, size = 1) => (Array.isArray(list) ? list : [])
  .map((item) => [num(item?.[0] ?? item?.price ?? item?.px), num(item?.[1] ?? item?.size ?? item?.qty ?? item?.sz)])
  .filter(([price, amount]) => price > 0 && amount > 0).map(([price, amount]) => [price, amount * size]);
const TF = ["1m", "5m", "15m", "1h", "4h", "1d"];

// How each exchange is asked. `quote(q)`: the quote it trades for the asked one (some quote dollars, not the
// stablecoin); `pair(base, q)`: its name for the market; book / trades / candles: the address and the reading.
// Binance's spot market is read from its market-data addresses (data-api / data-stream.binance.vision): its
// main API turns some countries away (the Netherlands among them, where the server is), these do not.
export const BOOK_EXCHANGES = {
  binance: { name: "Binance", quotes: [STABLE, "BTC"], pair: (base, quote) => `${base}${quote}`,
    book: (pair) => `https://data-api.binance.vision/api/v3/depth?symbol=${pair}&limit=5000`, readBook: (answer) => ({ bids: pairs(answer?.bids), asks: pairs(answer?.asks) }),
    trades: (pair) => `https://data-api.binance.vision/api/v3/trades?symbol=${pair}&limit=500`,
    readTrades: (answer) => (Array.isArray(answer) ? answer : []).map((item) => ({ time: num(item.time), price: num(item.price), amount: num(item.qty), side: item.isBuyerMaker ? "sell" : "buy" })),
    candles: (pair, tf) => `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${tf}&limit=500`,
    readCandles: (answer) => (Array.isArray(answer) ? answer : []).map((row) => [row[0] / 1000, row[1], row[2], row[3], row[4], row[5]]) },
  "binance-f": { name: "Binance Futures", quotes: [STABLE], pair: (base) => `${base}${STABLE}`,
    book: (pair) => `https://fapi.binance.com/fapi/v1/depth?symbol=${pair}&limit=1000`, readBook: (answer) => ({ bids: pairs(answer?.bids), asks: pairs(answer?.asks) }),
    trades: (pair) => `https://fapi.binance.com/fapi/v1/trades?symbol=${pair}&limit=500`,
    readTrades: (answer) => (Array.isArray(answer) ? answer : []).map((item) => ({ time: num(item.time), price: num(item.price), amount: num(item.qty), side: item.isBuyerMaker ? "sell" : "buy" })),
    candles: (pair, tf) => `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${tf}&limit=500`,
    readCandles: (answer) => (Array.isArray(answer) ? answer : []).map((row) => [row[0] / 1000, row[1], row[2], row[3], row[4], row[5]]) },
  bybit: { name: "Bybit", quotes: [STABLE, "BTC"], pair: (base, quote) => `${base}${quote}`,
    book: (pair) => `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${pair}&limit=200`, readBook: (answer) => ({ bids: pairs(answer?.result?.b), asks: pairs(answer?.result?.a) }),
    trades: (pair) => `https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${pair}&limit=60`, readTrades: (answer) => bybitTrades(answer),
    candles: (pair, tf) => `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${bybitTf(tf)}&limit=500`, readCandles: (answer) => bybitCandles(answer) },
  "bybit-f": { name: "Bybit Futures", quotes: [STABLE], pair: (base) => `${base}${STABLE}`,
    book: (pair) => `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${pair}&limit=500`, readBook: (answer) => ({ bids: pairs(answer?.result?.b), asks: pairs(answer?.result?.a) }),
    trades: (pair) => `https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${pair}&limit=500`, readTrades: (answer) => bybitTrades(answer),
    candles: (pair, tf) => `https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair}&interval=${bybitTf(tf)}&limit=500`, readCandles: (answer) => bybitCandles(answer) },
  okx: { name: "OKX", quotes: [STABLE, "BTC"], pair: (base, quote) => `${base}-${quote}`,
    book: (pair) => `https://www.okx.com/api/v5/market/books-full?instId=${pair}&sz=5000`,
    readBook: (answer) => ({ bids: pairs(answer?.data?.[0]?.bids), asks: pairs(answer?.data?.[0]?.asks) }),
    trades: (pair) => `https://www.okx.com/api/v5/market/trades?instId=${pair}&limit=500`, readTrades: (answer) => okxTrades(answer),
    candles: (pair, tf) => `https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${okxTf(tf)}&limit=300`, readCandles: (answer) => okxCandles(answer) },
  // OKX's perpetual contracts count contracts, each worth `ctVal` coins (its instruments list).
  "okx-f": { name: "OKX Futures", quotes: [STABLE], pair: (base) => `${base}-${STABLE}-SWAP`, sized: true,
    book: (pair) => `https://www.okx.com/api/v5/market/books?instId=${pair}&sz=400`,
    readBook: (answer, size) => ({ bids: pairs(answer?.data?.[0]?.bids, size), asks: pairs(answer?.data?.[0]?.asks, size) }),
    trades: (pair) => `https://www.okx.com/api/v5/market/trades?instId=${pair}&limit=500`, readTrades: (answer, size) => okxTrades(answer, size),
    candles: (pair, tf) => `https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${okxTf(tf)}&limit=300`, readCandles: (answer) => okxCandles(answer) },
  coinbase: { name: "Coinbase", quotes: ["USD", "BTC"], pair: (base, quote) => `${base}-${quote}`,
    book: (pair) => `https://api.exchange.coinbase.com/products/${pair}/book?level=2`, readBook: (answer) => ({ bids: pairs(answer?.bids), asks: pairs(answer?.asks) }),
    // Coinbase names the resting order's side: the taker did the opposite.
    trades: (pair) => `https://api.exchange.coinbase.com/products/${pair}/trades?limit=500`,
    readTrades: (answer) => (Array.isArray(answer) ? answer : []).map((item) => ({ time: Date.parse(item.time), price: num(item.price), amount: num(item.size), side: item.side === "sell" ? "buy" : "sell" })),
    candles: (pair, tf) => `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${{ "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 21600, "1d": 86400 }[tf]}`,
    readCandles: (answer) => (Array.isArray(answer) ? answer : []).map((row) => [row[0], row[3], row[2], row[1], row[4], row[5]]).reverse() },
  kraken: { name: "Kraken", quotes: ["USD", "BTC"], pair: (base, quote) => `${base === "BTC" ? "XBT" : base}${quote === "BTC" ? "XBT" : quote}`,
    book: (pair) => `https://api.kraken.com/0/public/Depth?pair=${pair}&count=500`,
    readBook: (answer) => { const book = Object.values(answer?.result ?? {})[0]; return { bids: pairs(book?.bids), asks: pairs(book?.asks) }; },
    trades: (pair) => `https://api.kraken.com/0/public/Trades?pair=${pair}&count=500`,
    readTrades: (answer) => (Object.entries(answer?.result ?? {}).find(([key]) => key !== "last")?.[1] ?? [])
      .map((row) => ({ time: num(row[2]) * 1000, price: num(row[0]), amount: num(row[1]), side: row[3] === "s" ? "sell" : "buy" })).reverse(),
    candles: (pair, tf) => `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${{ "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 }[tf]}`,
    readCandles: (answer) => (Object.entries(answer?.result ?? {}).find(([key]) => key !== "last")?.[1] ?? []).map((row) => [row[0], row[1], row[2], row[3], row[4], row[6]]) },
  bitstamp: { name: "Bitstamp", quotes: ["USD", "BTC"], pair: (base, quote) => `${base}${quote}`.toLowerCase(),
    book: (pair) => `https://www.bitstamp.net/api/v2/order_book/${pair}/`, readBook: (answer) => ({ bids: pairs(answer?.bids), asks: pairs(answer?.asks) }),
    trades: (pair) => `https://www.bitstamp.net/api/v2/transactions/${pair}/`,
    readTrades: (answer) => (Array.isArray(answer) ? answer : []).map((item) => ({ time: num(item.date) * 1000, price: num(item.price), amount: num(item.amount), side: String(item.type) === "1" ? "sell" : "buy" })),
    candles: (pair, tf) => `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${{ "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[tf]}&limit=500`,
    readCandles: (answer) => (answer?.data?.ohlc ?? []).map((row) => [num(row.timestamp), row.open, row.high, row.low, row.close, row.volume]) },
  bitfinex: { name: "Bitfinex", quotes: ["USD", "BTC"], pair: (base, quote) => `t${base}${base.length > 3 ? ":" : ""}${quote}`,
    book: (pair, precision = "P0") => `https://api-pub.bitfinex.com/v2/book/${pair}/${precision}?len=250`,
    readBook: (answer) => {
      const rows = Array.isArray(answer) ? answer : [];
      return { bids: rows.filter((row) => row[2] > 0).map((row) => [row[0], row[2]]), asks: rows.filter((row) => row[2] < 0).map((row) => [row[0], -row[2]]) };
    },
    // 250 levels a side at each precision: the exact ones near the price, coarser ones further out (to ±90 % or so).
    loadBook: async (get, pair, exchange) => {
      const [near, middle, far] = (await Promise.all(["P0", "P1", "P2"].map((precision) => get(exchange.book(pair, precision)).catch(() => null)))).map((answer) => exchange.readBook(answer));
      return layered([near, middle, far]);
    },
    trades: (pair) => `https://api-pub.bitfinex.com/v2/trades/${pair}/hist?limit=500`,
    readTrades: (answer) => (Array.isArray(answer) ? answer : []).map((row) => ({ time: row[1], price: row[3], amount: Math.abs(row[2]), side: row[2] < 0 ? "sell" : "buy" })),
    candles: (pair, tf) => `https://api-pub.bitfinex.com/v2/candles/trade:${tf === "1d" ? "1D" : tf}:${pair}/hist?limit=500`,
    readCandles: (answer) => (Array.isArray(answer) ? answer : []).map((row) => [row[0] / 1000, row[1], row[3], row[4], row[2], row[5]]).reverse() },
  hitbtc: { name: "HitBTC", quotes: [STABLE, "BTC"], pair: (base, quote) => `${base}${quote}`,
    book: (pair) => `https://api.hitbtc.com/api/3/public/orderbook/${pair}?depth=0`, readBook: (answer) => ({ bids: pairs(answer?.bid), asks: pairs(answer?.ask) }),
    trades: (pair) => `https://api.hitbtc.com/api/3/public/trades/${pair}?limit=500`,
    readTrades: (answer) => (Array.isArray(answer) ? answer : []).map((item) => ({ time: Date.parse(item.timestamp), price: num(item.price), amount: num(item.qty), side: item.side === "sell" ? "sell" : "buy" })),
    candles: (pair, tf) => `https://api.hitbtc.com/api/3/public/candles/${pair}?period=${{ "1m": "M1", "5m": "M5", "15m": "M15", "1h": "H1", "4h": "H4", "1d": "D1" }[tf]}&limit=500`,
    readCandles: (answer) => (Array.isArray(answer) ? answer : []).map((row) => [Date.parse(row.timestamp) / 1000, row.open, row.max, row.min, row.close, row.volume]).reverse() },
};
// Books read at several precisions: each layer adds the levels beyond the finer one's reach.
export function layered(layers) {
  const out = { bids: [], asks: [] };
  for (const side of ["bids", "asks"]) {
    let reach = null; // the furthest price the finer layers cover
    for (const layer of layers) {
      const list = layer?.[side] ?? [];
      if (!list.length) continue;
      out[side].push(...(reach === null ? list : list.filter(([price]) => (side === "bids" ? price < reach : price > reach))));
      const edge = side === "bids" ? Math.min(...list.map(([price]) => price)) : Math.max(...list.map(([price]) => price));
      reach = reach === null ? edge : side === "bids" ? Math.min(reach, edge) : Math.max(reach, edge);
    }
  }
  return out;
}
function bybitTf(tf) { return { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": "D" }[tf]; }
function bybitTrades(answer) {
  return (answer?.result?.list ?? []).map((item) => ({ time: num(item.time), price: num(item.price), amount: num(item.size), side: item.side === "Sell" ? "sell" : "buy" }));
}
function bybitCandles(answer) { return (answer?.result?.list ?? []).map((row) => [row[0] / 1000, row[1], row[2], row[3], row[4], row[5]]).reverse(); }
function okxTf(tf) { return { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" }[tf]; }
function okxTrades(answer, size = 1) {
  return (answer?.data ?? []).map((item) => ({ time: num(item.ts), price: num(item.px), amount: num(item.sz) * size, side: item.side === "sell" ? "sell" : "buy" }));
}
function okxCandles(answer) { return (answer?.data ?? []).map((row) => [row[0] / 1000, row[1], row[2], row[3], row[4], row[5]]).reverse(); }

// A round step near `raw`: 1, 2, 2.5 or 5 times a power of ten.
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((step) => step >= raw * 0.999);
}
// The book as the order-book tools show it: the exchange's own price levels, not gathered into steps.
// Within the whole reach of the book (`range`, a share of the price), each side keeps its `keep` largest
// levels (the smaller ones only the smallest-order filter would hide anyway), best price first, each with
// the volume of every order from the best price up to it; and the side's totals out to each whole per cent
// of the price (totals[side][n - 1] = [coins, quote] within n %), so a page sums any depth it is set to.
export function gatherBook({ bids, asks }, range = 1, keep = 800) {
  const best = Math.max(0, ...bids.map(([price]) => price));
  const ask = Math.min(...asks.map(([price]) => price));
  const price = best && Number.isFinite(ask) ? (best + ask) / 2 : best || (Number.isFinite(ask) ? ask : 0);
  if (!price) return { price: null, bids: [], asks: [], totals: { bids: [], asks: [] } };
  const totals = {};
  const side = (list, down, name) => {
    const sorted = list.filter(([level]) => Math.abs(level - price) / price <= range).sort((left, right) => (down ? right[0] - left[0] : left[0] - right[0]));
    const sums = Array.from({ length: 100 }, () => [0, 0]);
    let coins = 0;
    const withVolume = sorted.map(([level, amount]) => {
      coins += amount;
      const percent = Math.min(100, Math.max(1, Math.ceil((Math.abs(level - price) / price) * 100 - 1e-9)));
      sums[percent - 1][0] += amount;
      sums[percent - 1][1] += amount * level;
      return [level, amount, coins];
    });
    for (let index = 1; index < 100; index += 1) { sums[index][0] += sums[index - 1][0]; sums[index][1] += sums[index - 1][1]; }
    totals[name] = sums.map(([amount, quote]) => [Number(amount.toPrecision(10)), Number(quote.toPrecision(10))]);
    const biggest = new Set([...withVolume].sort((left, right) => right[1] - left[1]).slice(0, keep));
    return withVolume.filter((row) => biggest.has(row)).map(([level, amount, through]) => [level, Number(amount.toPrecision(10)), Number(through.toPrecision(10))]);
  };
  return { price: Number(price.toPrecision(10)), bids: side(bids, true, "bids"), asks: side(asks, false, "asks"), totals, levels: bids.length + asks.length };
}

// Bybit's books from its stream too, 1,000 levels instead of its REST answer's 200 or 500.
// Binance's books in full depth, as the order-book tools keep them: its open REST answer stops at 5,000
// levels (1,000 on futures), so for a pair someone looks at the server keeps the exchange's stream of
// every change to the book, on top of a snapshot (the exchange's documented way: buffer the stream, read
// the snapshot, drop what it already holds, then apply each change in order). Levels far from the price
// join as soon as they change; a fresh snapshot every ten minutes corrects the near part. A pair nobody
// has looked at for half an hour is let go; the busiest few are kept from the start.
const STREAMS = {
  binance: { socket: (pair) => `wss://data-stream.binance.vision/ws/${pair.toLowerCase()}@depth@100ms`, futures: false },
  "binance-f": { socket: (pair) => `wss://fstream.binance.com/ws/${pair.toLowerCase()}@depth@100ms`, futures: true },
  // Bybit's stream sends the book's first 1,000 levels and then their changes (its REST answer has 200 or 500).
  bybit: { socket: () => "wss://stream.bybit.com/v5/public/spot", bybit: true },
  "bybit-f": { socket: () => "wss://stream.bybit.com/v5/public/linear", bybit: true },
};
const BYBIT_DEPTHS = [1000, 500, 200];
export function createDeep({ get, now = Date.now, socket = (url) => new WebSocket(url), keep = 30 * 60_000, refresh = 10 * 60_000,
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  const books = new Map(); // "ex:pair" → { bids: Map, asks: Map, last, ready, seenAt, ws, buffer, warm }
  const apply = (book, side, list) => {
    for (const [price, amount] of list ?? []) {
      const level = Number(price);
      const size = Number(amount);
      if (!Number.isFinite(level) || !Number.isFinite(size)) continue;
      if (size === 0) book[side].delete(level); else book[side].set(level, size);
    }
  };
  // A snapshot replaces the levels within its own reach; the stream's far levels beyond it stay.
  function snapshot(book, answer) {
    for (const [side, list] of [["bids", answer.bids], ["asks", answer.asks]]) {
      const prices = (list ?? []).map(([price]) => Number(price));
      if (!prices.length) continue;
      const low = Math.min(...prices);
      const high = Math.max(...prices);
      for (const level of book[side].keys()) if (level >= low && level <= high) book[side].delete(level);
      apply(book, side, list);
    }
    book.last = answer.lastUpdateId;
  }
  // One change from the stream, in order; a gap means the book has to be read again.
  function change(book, event, futures) {
    if (book.last === null) { book.buffer.push(event); if (book.buffer.length > 5_000) book.buffer.shift(); return; }
    if (event.u <= book.last) return;
    if (!book.ready) {
      if (event.U > book.last + 1 && !(futures && event.U <= book.last)) { void resync(book); return; }
      book.ready = true;
    } else if (futures ? event.pu !== book.last : event.U !== book.last + 1) { void resync(book); return; }
    apply(book, "bids", event.b);
    apply(book, "asks", event.a);
    book.last = event.u;
  }
  // Bybit: a snapshot replaces the book (also an update numbered 1, after its service restarts); a delta changes it.
  function bybitChange(book, message) {
    const data = message?.data;
    if (!data || !String(message.topic ?? "").startsWith("orderbook.")) return;
    if (message.type === "snapshot" || data.u === 1) {
      book.bids.clear();
      book.asks.clear();
      book.ready = true;
      book.syncedAt = now();
    } else if (!book.ready) return;
    apply(book, "bids", data.b);
    apply(book, "asks", data.a);
  }
  async function resync(book) {
    if (book.syncing) return;
    book.syncing = true;
    book.ready = false;
    book.last = null;
    try {
      const answer = await get(book.snapshotUrl);
      if (!answer?.lastUpdateId) throw new Error("no snapshot");
      snapshot(book, answer);
      book.syncedAt = now();
      const buffered = book.buffer;
      book.buffer = [];
      for (const event of buffered) change(book, event, book.futures);
    } catch {
      book.last = null;
      await wait(5_000);
      book.syncing = false;
      if (book.open) return resync(book);
      return undefined;
    }
    book.syncing = false;
    return undefined;
  }
  function open(ex, pair, snapshotUrl, warm = false) {
    const key = `${ex}:${pair}`;
    let book = books.get(key);
    if (book) { book.seenAt = now(); return book; }
    book = { ex, pair, key, bids: new Map(), asks: new Map(), last: null, ready: false, buffer: [], seenAt: now(), warm, open: true,
      futures: STREAMS[ex].futures, snapshotUrl, syncedAt: 0 };
    books.set(key, book);
    let depth = 0; // Bybit: which of its depths this pair's stream has (the deepest it accepts)
    const connect = () => {
      if (!book.open) return;
      let ws;
      try { ws = socket(STREAMS[ex].socket(pair)); } catch { setTimeout(connect, 15_000).unref?.(); return; }
      book.ws = ws;
      let ping = null;
      const subscribe = () => ws.send(JSON.stringify({ op: "subscribe", args: [`orderbook.${BYBIT_DEPTHS[depth]}.${pair}`] }));
      ws.onopen = () => {
        if (!STREAMS[ex].bybit) { void resync(book); return; }
        subscribe();
        ping = setInterval(() => { try { ws.send(JSON.stringify({ op: "ping" })); } catch {} }, 20_000);
        ping.unref?.();
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (!STREAMS[ex].bybit) { change(book, message, book.futures); return; }
          // A depth the market does not offer: the next smaller one.
          if (message.op === "subscribe" && message.success === false && depth < BYBIT_DEPTHS.length - 1) { depth += 1; subscribe(); return; }
          bybitChange(book, message);
        } catch {}
      };
      ws.onclose = ws.onerror = () => {
        clearInterval(ping);
        try { ws.close(); } catch {}
        if (book.ws !== ws) return;
        book.ws = null;
        book.ready = false;
        book.last = null;
        if (book.open) setTimeout(connect, 15_000).unref?.();
      };
    };
    connect();
    return book;
  }
  function close(book) {
    book.open = false;
    try { book.ws?.close(); } catch {}
    books.delete(book.key);
  }
  // Housekeeping once a minute: let go of books nobody looks at, read the near part afresh now and then.
  function tick() {
    for (const book of [...books.values()]) {
      if (!book.warm && now() - book.seenAt > keep) { close(book); continue; }
      if (book.ready && !STREAMS[book.ex].bybit && now() - book.syncedAt > refresh) void resync(book);
    }
  }
  // The book as plain lists, once it is in step with the stream; null until then.
  function read(ex, pair) {
    const book = books.get(`${ex}:${pair}`);
    if (!book?.ready) return null;
    book.seenAt = now();
    return { bids: [...book.bids], asks: [...book.asks], levels: book.bids.size + book.asks.size };
  }
  return { open, read, tick, close, books, change, snapshot, bybitChange };
}

export function createBook({ get, now = Date.now, bookTtl = 2_000, candleTtl = 20_000, deep = null } = {}) {
  const cache = new Map(); // key → { at, value } or { job }
  let okxSizes = null;
  async function sizeOf(base) {
    if (!okxSizes) {
      const list = await get("https://www.okx.com/api/v5/public/instruments?instType=SWAP").catch(() => null);
      const pattern = new RegExp(`^([A-Z0-9]+)-${STABLE}-SWAP$`);
      okxSizes = new Map((list?.data ?? []).map((item) => [pattern.exec(item?.instId ?? "")?.[1], num(item?.ctVal)]).filter(([symbol, size]) => symbol && size > 0));
    }
    return okxSizes.get(base) ?? null;
  }
  // One answer per key at a time, kept `ttl` milliseconds; a failure is not kept.
  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit?.value && now() - hit.at < ttl) return hit.value;
    if (hit?.job) return hit.job;
    const job = load().then((value) => { cache.set(key, { at: now(), value }); return value; }, (error) => { cache.delete(key); throw error; });
    cache.set(key, { ...hit, job });
    if (cache.size > 2_000) cache.delete(cache.keys().next().value);
    return job;
  }
  const market = (url) => {
    const ex = url.searchParams.get("ex") ?? "";
    const exchange = BOOK_EXCHANGES[ex];
    const base = (url.searchParams.get("base") ?? "").toUpperCase();
    const asked = (url.searchParams.get("quote") ?? STABLE).toUpperCase();
    if (!exchange || !SYMBOL.test(base)) return null;
    // A quote the exchange does not have: its dollars stand in for the stablecoin.
    const quote = exchange.quotes.includes(asked) ? asked : asked === "BTC" ? null : exchange.quotes[0];
    if (!quote || base === quote) return null;
    return { ex, exchange, base, quote, pair: exchange.pair(base, quote) };
  };
  async function book(found) {
    const { ex, exchange, base, quote, pair } = found;
    return cached(`book:${ex}:${pair}`, bookTtl, async () => {
      const size = exchange.sized ? await sizeOf(base) : 1;
      if (!size) throw Object.assign(new Error("no such market"), { status: 404 });
      // Binance in full depth from its stream once it is running (the REST answer meanwhile).
      if (deep && STREAMS[ex]) {
        deep.open(ex, pair, exchange.book(pair));
        const kept = deep.read(ex, pair);
        if (kept && (kept.bids.length || kept.asks.length)) return { ex, base, quote, pair, ...gatherBook(kept), full: true, at: now() };
      }
      const read = exchange.loadBook ? await exchange.loadBook(get, pair, exchange) : exchange.readBook(await get(exchange.book(pair)), size);
      if (!read.bids.length && !read.asks.length) throw Object.assign(new Error("no such market"), { status: 404 });
      return { ex, base, quote, pair, ...gatherBook(read), at: now() };
    });
  }
  async function trades(found) {
    const { ex, exchange, base, pair } = found;
    return cached(`trades:${ex}:${pair}`, bookTtl, async () => {
      const size = exchange.sized ? await sizeOf(base) : 1;
      const list = exchange.readTrades(await get(exchange.trades(pair)), size ?? 1)
        .filter((item) => item.time > 0 && item.price > 0 && item.amount > 0).sort((left, right) => right.time - left.time).slice(0, 500);
      return { trades: list };
    });
  }
  async function candles(found, tf) {
    const { ex, exchange, pair } = found;
    return cached(`candles:${ex}:${pair}:${tf}`, candleTtl, async () => ({
      candles: exchange.readCandles(await get(exchange.candles(pair, tf))).map((row) => row.map(Number))
        .filter((row) => row.every(Number.isFinite) && row[0] > 0).sort((left, right) => left[0] - right[0]),
    }));
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith("/market/book")) return false;
    const reply = (status, body, maxAge = 1) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` });
      response.end(JSON.stringify(body));
      return true;
    };
    if (request.method !== "GET") return reply(405, { error: "read only" });
    if (url.pathname === "/market/book/exchanges") {
      return reply(200, { exchanges: Object.entries(BOOK_EXCHANGES).map(([id, item]) => ({ id, name: item.name, quotes: item.quotes })) }, 3600);
    }
    const found = market(url);
    if (!found) return reply(400, { error: "an exchange, a coin and a quote, please" });
    try {
      if (url.pathname === "/market/book") return reply(200, await book(found));
      if (url.pathname === "/market/book/trades") return reply(200, await trades(found));
      if (url.pathname === "/market/book/candles") {
        const tf = TF.includes(url.searchParams.get("tf")) ? url.searchParams.get("tf") : "1h";
        return reply(200, await candles(found, tf), 10);
      }
    } catch (error) {
      return reply(error?.status === 404 || error?.status === 400 ? 404 : 502, { error: error?.status === 404 || error?.status === 400 ? "no such market" : "the exchange did not answer" });
    }
    return reply(404, { error: "not found" });
  }
  // The busiest pairs' Binance books (`busiest()`: the trend screener's first coins) are kept all the time,
  // so their full depth is there at once.
  function start(busiest = () => []) {
    if (!deep) return () => {};
    const warm = () => {
      for (const base of busiest().filter((symbol) => SYMBOL.test(symbol)).slice(0, 6)) {
        for (const ex of Object.keys(STREAMS)) {
          const exchange = BOOK_EXCHANGES[ex];
          const pair = exchange.pair(base, STABLE);
          deep.open(ex, pair, exchange.book(pair), true);
        }
      }
    };
    const timer = setInterval(() => { warm(); deep.tick(); }, 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  return { handle, book, trades, candles, start };
}
