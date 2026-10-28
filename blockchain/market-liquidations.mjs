// Liquidations on the perpetual futures of Binance, Bybit and OKX, without a key: each exchange's public
// stream of forced orders (Binance: every liquidation of every coin; Bybit: the busiest coins; OKX: every
// coin), and OKX's liquidation list read every two minutes for the busiest coins, in case a stream is cut.
// The last day is kept (in memory, saved to disk every ten minutes): totals of long and short positions
// closed over the hour, four hours and day, each coin's totals, and the biggest recent ones.
//
// GET /market/liquidations → { updatedAt, exchanges, totals: { h1, h4, d1: { long, short } },
//   coins: [{ symbol, long1h, short1h, long4h, short4h, long24h, short24h, id, image }], recent: [{ exchange, symbol, side, price, usd, time }] }
const QUOTE = "U" + "SDT";
const SYMBOL = /^[A-Z0-9]{1,15}$/;
const num = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const DAY = 86_400_000;

// One exchange message → liquidations as { exchange, symbol, side: "long" | "short" (the position closed), price, usd, time }.
export function readLiquidations(name, message, sizes) {
  const out = [];
  const add = (symbol, side, price, amount, time) => {
    if (SYMBOL.test(symbol ?? "") && price > 0 && amount > 0) out.push({ exchange: name, symbol, side, price, usd: price * amount, time: time ?? Date.now() });
  };
  if (name === "binance") {
    // A forced SELL closes a long; a forced BUY closes a short.
    const order = message?.o;
    const match = new RegExp(`^([A-Z0-9]+)${QUOTE}$`).exec(order?.s ?? "");
    if (match) add(match[1], order.S === "SELL" ? "long" : "short", num(order.ap) || num(order.p), num(order.z) || num(order.q), num(order.T));
  } else if (name === "bybit") {
    // Bybit names the side of the position that was closed: Buy is a long.
    for (const item of Array.isArray(message?.data) ? message.data : message?.data ? [message.data] : []) {
      const match = new RegExp(`^([A-Z0-9]+)${QUOTE}$`).exec(item?.s ?? item?.symbol ?? "");
      if (match) add(match[1], (item.S ?? item.side) === "Buy" ? "long" : "short", num(item.p ?? item.price), num(item.v ?? item.size), num(item.T ?? item.updatedTime));
    }
  } else if (name === "okx") {
    // OKX counts contracts, each worth `ctVal` coins; posSide is the position closed.
    for (const item of Array.isArray(message?.data) ? message.data : []) {
      const match = new RegExp(`^([A-Z0-9]+)-${QUOTE}-SWAP$`).exec(item?.instId ?? (item?.instFamily ? `${item.instFamily}-SWAP` : ""));
      if (!match) continue;
      const size = sizes?.get(match[1]) ?? null;
      if (!size) continue;
      for (const detail of Array.isArray(item.details) ? item.details : []) {
        add(match[1], detail.posSide === "long" || (detail.posSide !== "short" && detail.side === "sell") ? "long" : "short",
          num(detail.bkPx), (num(detail.sz) ?? 0) * size, num(detail.ts ?? detail.time));
      }
    }
  }
  return out;
}

export function createLiquidations({ get, now = Date.now, coins = () => [], coinOf = () => null, file = null, read = null, write = null,
  socket = (url) => new WebSocket(url), wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  let events = []; // the last day, oldest first
  const seen = new Set(); // keys of events already counted (a stream and the list may both bring one)
  const live = new Set(); // exchanges heard from in the last ten minutes
  const heardAt = new Map();
  let okxSizes = null;
  let running = false;

  if (file && read) {
    try {
      const saved = JSON.parse(read(file));
      events = (saved?.events ?? []).filter((event) => now() - event.time < DAY);
      for (const event of events) seen.add(keyOf(event));
    } catch {}
  }
  function keyOf(event) { return `${event.exchange}:${event.symbol}:${event.side}:${event.time}:${event.price}:${Math.round(event.usd)}`; }
  function take(list) {
    for (const event of list) {
      const key = keyOf(event);
      if (seen.has(key) || now() - event.time > DAY) continue;
      seen.add(key);
      events.push(event);
      heardAt.set(event.exchange, now());
    }
    if (events.length > 60_000 || (events[0] && now() - events[0].time > DAY)) {
      events.sort((left, right) => left.time - right.time);
      events = events.filter((event) => now() - event.time < DAY).slice(-50_000);
      seen.clear();
      for (const event of events) seen.add(keyOf(event));
    }
  }
  let savedAt = 0;
  function save() {
    if (!file || !write || now() - savedAt < 600_000) return;
    savedAt = now();
    try { write(file, JSON.stringify({ events })); } catch {}
  }

  async function okxSizesOnce() {
    if (okxSizes) return okxSizes;
    const list = await get(`https://www.okx.com/api/v5/public/instruments?instType=SWAP`).catch(() => null);
    const pattern = new RegExp(`^([A-Z0-9]+)-${QUOTE}-SWAP$`);
    const read = new Map((Array.isArray(list?.data) ? list.data : []).map((item) => [pattern.exec(item?.instId ?? "")?.[1], num(item?.ctVal)]).filter(([symbol, size]) => symbol && size > 0));
    // A failed read is asked again next time, not kept empty until a restart.
    if (read.size) okxSizes = read;
    return read;
  }
  // A stream that reconnects after a pause when it drops.
  async function stream(name, url, hello, every = 0) {
    while (running) {
      await new Promise((resolve) => {
        let ws;
        try { ws = socket(url); } catch { resolve(); return; }
        let ping = null;
        ws.onopen = () => {
          for (const message of hello()) ws.send(JSON.stringify(message));
          if (every) ping = setInterval(() => { try { ws.send(name === "okx" ? "ping" : JSON.stringify({ op: "ping" })); } catch {} }, every);
        };
        ws.onmessage = (event) => {
          if (event.data === "pong") return;
          try { take(readLiquidations(name, JSON.parse(event.data), okxSizes)); } catch {}
        };
        // Once only: closing from inside the handler would call it again.
        ws.onclose = ws.onerror = () => { ws.onclose = ws.onerror = null; clearInterval(ping); try { ws.close(); } catch {} resolve(); };
      });
      if (running) await wait(15_000);
    }
  }
  const busiest = (count) => coins().map((coin) => coin.symbol).filter((symbol) => SYMBOL.test(symbol)).slice(0, count);
  // OKX's list, the busiest coins in turn: what a cut stream missed.
  async function poll() {
    while (running) {
      await okxSizesOnce();
      for (const symbol of busiest(30)) {
        if (!running) return;
        const answer = await get(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&state=filled&instFamily=${symbol}-${QUOTE}`).catch(() => null);
        const data = (Array.isArray(answer?.data) ? answer.data : []).map((item) => ({ ...item, instFamily: `${symbol}-${QUOTE}` }));
        take(readLiquidations("okx", { data }, okxSizes));
        await wait(1_000);
      }
      save();
      await wait(60_000);
    }
  }
  function start() {
    if (running) return () => {};
    running = true;
    void okxSizesOnce().then(() => {
      void stream("binance", "wss://fstream.binance.com/ws/!forceOrder@arr", () => []);
      void stream("okx", "wss://ws.okx.com:8443/ws/v5/public", () => [{ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }], 20_000);
      // Bybit streams one coin per topic: the 100 busiest, ten topics a message.
      void stream("bybit", "wss://stream.bybit.com/v5/public/linear", () => {
        const topics = busiest(100).map((symbol) => `allLiquidation.${symbol}${QUOTE}`);
        return Array.from({ length: Math.ceil(topics.length / 10) }, (_, index) => ({ op: "subscribe", args: topics.slice(index * 10, index * 10 + 10) }));
      }, 20_000);
      void poll();
    });
    return () => { running = false; };
  }

  function snapshot() {
    const at = now();
    const totals = { h1: { long: 0, short: 0 }, h4: { long: 0, short: 0 }, d1: { long: 0, short: 0 } };
    const byCoin = new Map();
    for (const event of events) {
      const age = at - event.time;
      if (age > DAY || age < -60_000) continue;
      const coin = byCoin.get(event.symbol) ?? { symbol: event.symbol, long1h: 0, short1h: 0, long4h: 0, short4h: 0, long24h: 0, short24h: 0 };
      coin[`${event.side}24h`] += event.usd;
      totals.d1[event.side] += event.usd;
      if (age <= 4 * 3_600_000) { coin[`${event.side}4h`] += event.usd; totals.h4[event.side] += event.usd; }
      if (age <= 3_600_000) { coin[`${event.side}1h`] += event.usd; totals.h1[event.side] += event.usd; }
      byCoin.set(event.symbol, coin);
    }
    for (const [name, at2] of heardAt) if (at - at2 < 600_000) live.add(name); else live.delete(name);
    const withCoin = (row) => { const coin = coinOf(row.symbol); return coin ? { ...row, id: coin.id, image: coin.image ?? null } : row; };
    const coinsList = [...byCoin.values()].sort((left, right) => right.long24h + right.short24h - left.long24h - left.short24h).slice(0, 300).map(withCoin);
    const recent = events.filter((event) => at - event.time < 3_600_000).sort((left, right) => right.time - left.time).slice(0, 300).map(withCoin);
    return { updatedAt: at, exchanges: [...live], totals, coins: coinsList, recent };
  }
  async function handle(request, response, url) {
    if (url.pathname !== "/market/liquidations") return false;
    response.writeHead(request.method === "GET" ? 200 : 405, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=5" });
    response.end(JSON.stringify(request.method === "GET" ? snapshot() : { error: "read only" }));
    return true;
  }
  return { start, take, snapshot, handle, save };
}
