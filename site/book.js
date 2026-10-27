// The order book screener, /screener/book/, in the manner of the order-book tools for traders. One mode
// shows a pair on one exchange: a candle chart with the big orders drawn as levels (green under the price,
// red above), the bids and asks gathered into price steps — only the levels of at least the smallest order
// within the depth, the big ones in bold — and the trades feed. The constructor shows the pair's books on
// several exchanges side by side. Data: /market/book (blockchain/market-book.mjs), every two seconds.
// The settings are kept in this browser. Shared helpers are in common.js; the chart is TradingView's
// Lightweight Charts (site/vendor/lightweight-charts.js, Apache 2.0; its attribution is the link in the page's footer).

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  tabTrends: "Trends", tabDensities: "Order book walls", tabBook: "Order book", tabArbitrage: "Arbitrage", tabLiquidations: "Liquidations", tabListings: "Listings", tabHeatmap: "Heatmap",
  title: "Order book", exchange: "Exchange", exchanges: "Exchanges", pair: "Pair", market: "Market", tools: "Tools",
  settings: "⚙ Settings", chartSettings: "📈 Chart", tradesFeed: "⚡ Trades feed",
  source: "The book, trades and candles come from the exchanges' open APIs, every 2 seconds. Prices are gathered by a step; the levels shown are at least the smallest order within the depth, big orders in bold. Not financial advice.",
  exchangesCredit: "the exchanges' open APIs",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { modes: { single: "Одиночный режим", multi: "Конструктор" }, bid: "Покупка (BID)", ask: "Продажа (ASK)", price: "Цена", amount: "Объём", time: "Время", type: "Тип",
    buy: "BUY", sell: "SELL", loading: "Загружаю стакан…", failed: (name) => `${name}: этой пары нет или биржа не ответила`, none: "Нет уровней больше минимального ордера в пределах глубины.",
    noTrades: "Нет сделок больше минимальной.", total: "Всего в пределах глубины", exchangeCol: "Биржа",
    settingsTitle: "Настройки", chartTitle: "Настройки графика", bookHead: "Стакан", tradesHead: "Лента сделок", more: "Дополнительно",
    depth: "Глубина стакана", minOrder: "Миним. ордер", bigOrder: "Большой ордер", tradesCount: "Показ сделок", minTrade: "Миним. сделка", bigTrade: "Большая сделка",
    step: "Шаг цены", auto: "авто", amountDigits: "Знаков после запятой (объём)", priceDigits: "Знаков после запятой (цена)",
    usdMode: "Режим в долларах", usdHint: "Все объёмы задаются и показываются в долларах.", save: "Сохранить", reset: "Сбросить",
    showChart: "Показывать график", showChartHint: "Свечи пары с уровнями крупных ордеров.", hideLevels: "Скрыть уровни", hideLevelsHint: "Не рисовать крупные ордера на графике.",
    levelDepth: "Глубина показа уровней", levelDepthHint: "Насколько далеко от цены рисовать уровни.", reverse: "Реверсия цветов", reverseHint: "Поменять местами цвета уровней поддержки и сопротивления.",
    config: (cfg) => `Глубина ${cfg.depth}% · ордер от ${cfg.min} · крупный от ${cfg.big} · сделка от ${cfg.minTrade} · шаг ${cfg.step}`,
    reach: (down, up, full) => `Стакан биржи: −${down}% / +${up}% от цены${full ? " · полная глубина из потока" : ""}`,
    pickMore: "Выберите до 4 бирж", pct: "%", pcs: "шт." },
  en: { modes: { single: "Single", multi: "Constructor" }, bid: "Bids", ask: "Asks", price: "Price", amount: "Amount", time: "Time", type: "Type",
    buy: "BUY", sell: "SELL", loading: "Loading the book…", failed: (name) => `${name}: no such pair, or the exchange did not answer`, none: "No levels above the smallest order within the depth.",
    noTrades: "No trades above the smallest.", total: "Total within the depth", exchangeCol: "Exchange",
    settingsTitle: "Settings", chartTitle: "Chart settings", bookHead: "Order book", tradesHead: "Trades feed", more: "More",
    depth: "Book depth", minOrder: "Smallest order", bigOrder: "Big order", tradesCount: "Trades shown", minTrade: "Smallest trade", bigTrade: "Big trade",
    step: "Price step", auto: "auto", amountDigits: "Decimals (amount)", priceDigits: "Decimals (price)",
    usdMode: "Dollar mode", usdHint: "All amounts are set and shown in dollars.", save: "Save", reset: "Reset",
    showChart: "Show the chart", showChartHint: "The pair's candles with the big orders' levels.", hideLevels: "Hide levels", hideLevelsHint: "Do not draw the big orders on the chart.",
    levelDepth: "Levels depth", levelDepthHint: "How far from the price levels are drawn.", reverse: "Reverse colours", reverseHint: "Swap the colours of support and resistance levels.",
    config: (cfg) => `Depth ${cfg.depth}% · orders from ${cfg.min} · big from ${cfg.big} · trades from ${cfg.minTrade} · step ${cfg.step}`,
    reach: (down, up, full) => `The exchange's book: −${down}% / +${up}% of the price${full ? " · full depth from its stream" : ""}`,
    pickMore: "Pick up to 4 exchanges", pct: "%", pcs: "pcs" },
};
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const TFS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const DEFAULTS = { mode: "single", ex: "binance", exs: ["binance", "okx", "coinbase"], base: "ETH", quote: "U" + "SDT", depth: 90, minOrder: null, bigOrder: null,
  usd: false, tradesCount: 100, minTrade: null, bigTrade: null, step: null, amountDigits: null, priceDigits: null, tf: "1h", chart: true, hideLevels: false,
  levelDepth: 20, reverse: false, trades: true };
const KEY = "nir-book-settings";
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch {}
const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} };
let exchanges = [{ id: "binance", name: "Binance", quotes: [DEFAULTS.quote, "BTC"] }];
const books = new Map(); // exchange → { at, data } or { failed }
let trades = []; // newest first, with their exchange
let candles = [];

// --- Numbers: the step the book is shown in, the thresholds (automatic from the book when not set), the formats.
const niceStep = (raw) => { const power = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((step) => step >= raw * 0.999); };
// The step follows how far the book reaches within the depth: a short book (a few hundred levels near the
// price) shows its own prices, a full one gathers into round steps.
function stepOf(data) {
  if (cfg.step) return cfg.step;
  const range = data.price * cfg.depth / 100;
  const far = (list) => list.map(([price]) => Math.abs(price - data.price)).filter((distance) => distance <= range);
  const span = Math.max(data.step, ...far(data.bids), ...far(data.asks));
  return Math.max(data.step, niceStep(span / 300));
}
// A level's size in the unit the settings use: coins, or dollars in dollar mode.
const sizeOf = (price, amount) => (cfg.usd ? price * amount : amount);
function regroup(levels, step, down) {
  const sums = new Map();
  for (const [price, amount] of levels) {
    const key = Math.round((down ? Math.floor(price / step + 1e-9) : Math.ceil(price / step - 1e-9)) * step * 1e8) / 1e8;
    sums.set(key, (sums.get(key) ?? 0) + amount);
  }
  return [...sums].sort((left, right) => (down ? right[0] - left[0] : left[0] - right[0]));
}
// The thresholds a book suggests when none are set, rounded down: the smallest order lets about forty
// levels show, a big one is among the eight biggest.
const roundDown = (value) => { if (!(value > 0)) return 0; const power = 10 ** Math.floor(Math.log10(value)); return Math.floor(value / power * 2) / 2 * power; };
function thresholds(view) {
  const sizes = [...view.bids, ...view.asks].map(([price, amount]) => sizeOf(price, amount)).sort((left, right) => right - left);
  const nth = (index) => sizes[Math.min(sizes.length - 1, index)] ?? 0;
  const min = cfg.minOrder ?? roundDown(nth(40));
  return { min, big: cfg.bigOrder ?? Math.max(min * 2, roundDown(nth(8))) };
}
const digitsFor = (step) => Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
const priceText = (value, step) => value.toLocaleString(locale(), { minimumFractionDigits: cfg.priceDigits ?? digitsFor(step), maximumFractionDigits: cfg.priceDigits ?? digitsFor(step) });
const amountText = (value) => {
  const digits = cfg.amountDigits ?? (Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 4);
  return value.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: cfg.amountDigits ?? 0 });
};
const unitText = (value, base) => (cfg.usd ? usdShort(value) : `${amountText(value)} ${base.toLowerCase()}`);

// A book as shown: gathered into the step, within the depth, the totals there, the levels of at least the smallest order.
function view(data) {
  const step = stepOf(data);
  const range = cfg.depth / 100;
  const near = (price) => Math.abs(price - data.price) / data.price <= range;
  const bids = regroup(data.bids, step, true).filter(([price]) => near(price));
  const asks = regroup(data.asks, step, false).filter(([price]) => near(price));
  const sum = (list) => list.reduce((all, [price, amount]) => ({ coin: all.coin + amount, usd: all.usd + price * amount }), { coin: 0, usd: 0 });
  const all = { bids, asks };
  const limits = thresholds(all);
  const keep = (list) => list.filter(([price, amount]) => sizeOf(price, amount) >= limits.min).slice(0, 60);
  return { step, price: data.price, totals: { bids: sum(bids), asks: sum(asks) }, bids: keep(bids), asks: keep(asks), limits };
}

// --- Drawing.
function renderControls() {
  document.title = `${language === "en" ? en.title : "Стакан"} ${cfg.base}/${cfg.quote} — NIR Markets`;
  const seg = (box, items, on, click) => box.replaceChildren(...items.map(([key, label]) => {
    const button = node("button", key === on ? "on" : "", label);
    button.type = "button";
    button.addEventListener("click", () => { click(key); saveCfg(); restart(); });
    return button;
  }));
  seg($("#modes"), Object.entries(t().modes), cfg.mode, (key) => { cfg.mode = key; });
  seg($("#quotes"), [[DEFAULTS.quote, DEFAULTS.quote], ["BTC", "BTC"]], cfg.quote, (key) => { cfg.quote = key; });
  seg($("#tfs"), TFS.map((tf) => [tf, tf]), cfg.tf, (key) => { cfg.tf = key; });
  $("#single-pick").hidden = cfg.mode !== "single";
  $("#multi-pick").hidden = cfg.mode !== "multi";
  $("#exchange").replaceChildren(...exchanges.map((item) => Object.assign(node("option", "", item.name), { value: item.id, selected: item.id === cfg.ex })));
  $("#multi").replaceChildren(...exchanges.map((item) => {
    const button = node("button", `pill${cfg.exs.includes(item.id) ? " on" : ""}`, item.name);
    button.type = "button";
    button.addEventListener("click", () => {
      cfg.exs = cfg.exs.includes(item.id) ? cfg.exs.filter((id) => id !== item.id) : [...cfg.exs, item.id].slice(-4);
      if (!cfg.exs.length) cfg.exs = [item.id];
      saveCfg();
      restart();
    });
    return button;
  }));
  $("#pair").value = cfg.base;
  $("#toggle-trades").classList.toggle("on", cfg.trades);
  $("#chart-box").hidden = !cfg.chart || cfg.mode !== "single";
  $("#chart-title").textContent = `${exchanges.find((item) => item.id === cfg.ex)?.name ?? cfg.ex} · ${cfg.base}/${cfg.quote}`;
}
function renderConfig() {
  const first = [...books.values()].find((item) => item.data)?.data;
  if (!first) { $("#config").textContent = ""; return; }
  const shown = view(first);
  $("#config").textContent = t().config({ depth: cfg.depth, min: unitText(shown.limits.min, cfg.base), big: unitText(shown.limits.big, cfg.base),
    minTrade: unitText(tradeLimits().min, cfg.base), step: priceText(shown.step, shown.step) });
  // How far the exchange's book reaches: the open answers of some stop a few per cent from the price.
  const low = first.bids.at(-1)?.[0];
  const high = first.asks.at(-1)?.[0];
  if (low && high) {
    const pct = (value) => Math.round(Math.abs(value - first.price) / first.price * 100);
    $("#config").append(node("br"), t().reach(pct(low), pct(high), first.full));
  }
}
function sideTable(kind, shown, base) {
  const list = kind === "bid" ? shown.bids : shown.asks;
  const total = kind === "bid" ? shown.totals.bids : shown.totals.asks;
  const table = node("table", `ex-table bk-side ${kind}`);
  const head = node("thead");
  head.innerHTML = `<tr><th class="left"></th><th></th></tr>`;
  head.querySelector("th").textContent = kind === "bid" ? t().bid : t().ask;
  head.querySelectorAll("th")[1].textContent = t().amount;
  const body = node("tbody");
  const sum = node("tr", "bk-total");
  sum.title = t().total;
  sum.append(node("td", "left", usdShort(total.usd)), node("td", "", `${amountText(total.coin)} ${base.toLowerCase()}`));
  body.append(sum);
  const biggest = Math.max(1e-12, ...list.map(([price, amount]) => sizeOf(price, amount)));
  if (!list.length) { const row = node("tr"); const cell = node("td", "muted ex-empty", t().none); cell.colSpan = 2; row.append(cell); body.append(row); }
  for (const [price, amount] of list) {
    const size = sizeOf(price, amount);
    const row = node("tr", size >= shown.limits.big ? "big" : "");
    row.style.setProperty("--fill", `${Math.round((size / biggest) * 100)}%`);
    row.append(node("td", "left", priceText(price, shown.step)), node("td", "", cfg.usd ? usdShort(size) : amountText(amount)));
    body.append(row);
  }
  table.append(head, body);
  return table;
}
// The trades shown: at least the smallest trade; when not set, about the biggest third of the latest
// trades show, and the biggest few in a hundred are big.
function tradeLimits() {
  const sizes = trades.map((item) => sizeOf(item.price, item.amount)).sort((left, right) => right - left);
  const share = (part) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * part))] ?? 0;
  const min = cfg.minTrade ?? roundDown(share(0.33));
  return { min, big: cfg.bigTrade ?? Math.max(min * 2, roundDown(share(0.03))) };
}
function tradesTable(shown, withExchange) {
  const limits = tradeLimits();
  const table = node("table", "ex-table bk-trades");
  const head = node("thead");
  const row = node("tr");
  for (const [label, left] of [[t().time, true], ...(withExchange ? [[t().exchangeCol, true]] : []), [t().price], [t().amount], [t().type]]) row.append(node("th", left ? "left" : "", label));
  head.append(row);
  const body = node("tbody");
  const list = trades.filter((item) => sizeOf(item.price, item.amount) >= limits.min).slice(0, cfg.tradesCount);
  if (!list.length) { const empty = node("tr"); const cell = node("td", "muted ex-empty", t().noTrades); cell.colSpan = withExchange ? 5 : 4; empty.append(cell); body.append(empty); }
  for (const item of list) {
    const line = node("tr", sizeOf(item.price, item.amount) >= limits.big ? "big" : "");
    line.append(node("td", "left muted", new Date(item.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })),
      ...(withExchange ? [node("td", "left", exchanges.find((entry) => entry.id === item.ex)?.name ?? item.ex)] : []),
      node("td", "", price(item.price)), node("td", "", cfg.usd ? usdShort(item.price * item.amount) : amountText(item.amount)),
      node("td", item.side === "buy" ? "up" : "down", item.side === "buy" ? t().buy : t().sell));
    body.append(line);
  }
  table.append(head, body);
  return table;
}
function renderBooks() {
  const box = $("#books");
  const ids = cfg.mode === "single" ? [cfg.ex] : cfg.exs;
  const failed = ids.filter((id) => books.get(id)?.failed).map((id) => exchanges.find((item) => item.id === id)?.name ?? id);
  const loaded = ids.filter((id) => books.get(id)?.data);
  $("#status").textContent = failed.map((name) => t().failed(name)).join(" · ") || (loaded.length ? "" : t().loading);
  box.className = `bk-books ${cfg.mode}`;
  const parts = loaded.map((id) => {
    const data = books.get(id).data;
    const shown = view(data);
    const panel = node("section", "bk-book");
    if (cfg.mode === "multi") {
      const title = node("h3", "bk-book-title", `${exchanges.find((item) => item.id === id)?.name ?? id} `);
      title.append(node("b", "", `(${priceText(data.price, shown.step)})`));
      panel.append(title);
    }
    const sides = node("div", "bk-sides");
    sides.append(sideTable("bid", shown, data.base), sideTable("ask", shown, data.base));
    panel.append(sides);
    return panel;
  });
  if (cfg.trades && loaded.length) {
    const first = view(books.get(loaded[0]).data);
    const feed = node("section", "bk-book bk-feed");
    if (cfg.mode === "multi") feed.append(node("h3", "bk-book-title", t().tradesHead));
    feed.append(tradesTable(first, cfg.mode === "multi"));
    parts.push(feed);
  }
  box.replaceChildren(...parts);
  renderConfig();
  drawLevels();
}

// --- The chart: candles, and the big orders as levels.
let chart = null;
let series = null;
let lines = [];
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function ensureChart() {
  if (chart || !window.LightweightCharts || $("#chart-box").hidden) return;
  chart = LightweightCharts.createChart($("#chart"), { autoSize: true, layout: { background: { color: "transparent" }, textColor: css("--muted") || "#8a93a6", attributionLogo: false },
    grid: { vertLines: { color: "rgba(128,128,128,.08)" }, horzLines: { color: "rgba(128,128,128,.08)" } }, rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 } });
  series = chart.addCandlestickSeries({ upColor: "#16c784", downColor: "#ea3943", borderVisible: false, wickUpColor: "#16c784", wickDownColor: "#ea3943" });
}
function drawCandles() {
  ensureChart();
  if (!series) return;
  series.setData(candles.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
  const last = candles.at(-1);
  if (last) {
    const step = books.get(cfg.ex)?.data ? view(books.get(cfg.ex).data).step : last[4] / 1000;
    series.applyOptions({ priceFormat: { type: "price", precision: digitsFor(step / 10), minMove: 10 ** -digitsFor(step / 10) } });
  }
}
function drawLevels() {
  if (!series) return;
  for (const line of lines) series.removePriceLine(line);
  lines = [];
  const data = books.get(cfg.ex)?.data;
  if (!data || cfg.hideLevels || cfg.mode !== "single") return;
  const shown = view(data);
  const near = (price) => Math.abs(price - data.price) / data.price <= cfg.levelDepth / 100;
  const support = cfg.reverse ? "#ea3943" : "#16c784";
  const resistance = cfg.reverse ? "#16c784" : "#ea3943";
  for (const [list, color] of [[shown.bids, support], [shown.asks, resistance]]) {
    for (const [price, amount] of list) {
      if (!near(price) || sizeOf(price, amount) < shown.limits.big) continue;
      lines.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: cfg.usd ? usdShort(price * amount) : amountText(amount) }));
    }
  }
}

// --- Loading: the books and trades every two seconds, the candles every half minute.
const query = (ex) => `ex=${encodeURIComponent(ex)}&base=${encodeURIComponent(cfg.base)}&quote=${encodeURIComponent(cfg.quote)}`;
const getJson = (url) => fetch(url).then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))));
let generation = 0;
async function loadBooks() {
  const mine = generation;
  const ids = cfg.mode === "single" ? [cfg.ex] : cfg.exs;
  const answers = await Promise.all(ids.map((ex) => getJson(`/market/book?${query(ex)}`).then((data) => ({ ex, data }), () => ({ ex, failed: true }))));
  const tradeIds = cfg.trades ? ids : [];
  const feeds = await Promise.all(tradeIds.map((ex) => getJson(`/market/book/trades?${query(ex)}`).then((data) => data.trades.map((item) => ({ ...item, ex })), () => [])));
  if (mine !== generation) return;
  for (const answer of answers) books.set(answer.ex, answer.failed ? { failed: true } : { at: Date.now(), data: answer.data });
  trades = feeds.flat().sort((left, right) => right.time - left.time).slice(0, 500);
  renderBooks();
}
async function loadCandles() {
  if (!cfg.chart || cfg.mode !== "single") return;
  const mine = generation;
  const answer = await getJson(`/market/book/candles?${query(cfg.ex)}&tf=${cfg.tf}`).catch(() => null);
  if (mine !== generation || !answer) return;
  candles = answer.candles;
  drawCandles();
  drawLevels();
}
let bookTimer = 0;
let candleTimer = 0;
function restart() {
  generation += 1;
  books.clear();
  trades = [];
  candles = [];
  if (series) series.setData([]);
  renderControls();
  renderBooks();
  clearInterval(bookTimer);
  clearInterval(candleTimer);
  void loadBooks();
  void loadCandles();
  bookTimer = setInterval(() => { if (!document.hidden) void loadBooks(); }, 2_000);
  candleTimer = setInterval(() => { if (!document.hidden) void loadCandles(); }, 30_000);
}

// --- The settings drawers: the book and trades, and the chart.
function openDrawer(kind) {
  const words = t();
  $("#drawer-title").textContent = kind === "book" ? words.settingsTitle : words.chartTitle;
  const body = $("#drawer-body");
  const draft = { ...cfg };
  const field = (label, key, unit, { step = "any", min = 0, placeholder = words.auto } = {}) => {
    const wrap = node("label", "bk-input");
    const input = Object.assign(node("input"), { type: "number", step, min, value: draft[key] ?? "", placeholder });
    input.addEventListener("input", () => { draft[key] = input.value === "" ? null : Number(input.value); });
    const box = node("span", "bk-input-box");
    box.append(input, node("i", "", unit));
    wrap.append(node("small", "muted", label), box);
    return wrap;
  };
  const toggle = (label, hint, key) => {
    const wrap = node("label", "bk-toggle");
    const input = Object.assign(node("input"), { type: "checkbox", checked: Boolean(draft[key]) });
    input.addEventListener("change", () => { draft[key] = input.checked; });
    const text = node("span", "");
    text.append(node("b", "", label), node("small", "muted", hint));
    wrap.append(input, text);
    return wrap;
  };
  const unit = () => (draft.usd ? "$" : cfg.base.toLowerCase());
  const grid = (...items) => { const box = node("div", "bk-grid"); box.append(...items); return box; };
  const heading = (text) => node("h4", "bk-head", text);
  if (kind === "book") {
    body.replaceChildren(heading(words.bookHead),
      grid(field(words.depth, "depth", words.pct, { min: 1, placeholder: "10" }), field(words.minOrder, "minOrder", unit()), field(words.bigOrder, "bigOrder", unit())),
      heading(words.tradesHead),
      grid(field(words.tradesCount, "tradesCount", words.pcs, { min: 10, step: 10, placeholder: "100" }), field(words.minTrade, "minTrade", unit()), field(words.bigTrade, "bigTrade", unit())),
      heading(words.more),
      grid(field(words.step, "step", cfg.quote), field(words.amountDigits, "amountDigits", "", { step: 1 }), field(words.priceDigits, "priceDigits", "", { step: 1 })),
      toggle(words.usdMode, words.usdHint, "usd"));
  } else {
    body.replaceChildren(toggle(words.showChart, words.showChartHint, "chart"), toggle(words.hideLevels, words.hideLevelsHint, "hideLevels"),
      grid(field(words.levelDepth, "levelDepth", words.pct, { min: 1, placeholder: "20" })), toggle(words.reverse, words.reverseHint, "reverse"));
  }
  const buttons = node("div", "bk-drawer-buttons");
  const reset = node("button", "act ghost", words.reset);
  reset.type = "button";
  reset.addEventListener("click", () => {
    const keys = kind === "book" ? ["depth", "minOrder", "bigOrder", "tradesCount", "minTrade", "bigTrade", "step", "amountDigits", "priceDigits", "usd"] : ["chart", "hideLevels", "levelDepth", "reverse"];
    for (const key of keys) cfg[key] = DEFAULTS[key];
    saveCfg(); closeDrawer(); restart();
  });
  const save = node("button", "act", words.save);
  save.type = "button";
  save.addEventListener("click", () => {
    // The thresholds were in the other unit before the switch: they start over.
    if (draft.usd !== cfg.usd) for (const key of ["minOrder", "bigOrder", "minTrade", "bigTrade"]) if (draft[key] === cfg[key]) draft[key] = null;
    cfg = { ...cfg, ...draft, depth: Math.max(1, Math.min(100, draft.depth ?? DEFAULTS.depth)), levelDepth: Math.max(1, Math.min(100, draft.levelDepth ?? DEFAULTS.levelDepth)),
      tradesCount: Math.max(10, Math.min(500, draft.tradesCount ?? DEFAULTS.tradesCount)) };
    saveCfg(); closeDrawer();
    if (!cfg.chart && chart) { chart.remove(); chart = null; series = null; lines = []; }
    restart();
  });
  buttons.append(reset, save);
  body.append(buttons);
  $("#drawer").hidden = false;
}
const closeDrawer = () => { $("#drawer").hidden = true; };

$("#open-settings").addEventListener("click", () => openDrawer("book"));
$("#open-chart").addEventListener("click", () => openDrawer("chart"));
$("#toggle-trades").addEventListener("click", () => { cfg.trades = !cfg.trades; saveCfg(); restart(); });
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer").addEventListener("click", (event) => { if (event.target === $("#drawer")) closeDrawer(); });
addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });
$("#exchange").addEventListener("change", () => { cfg.ex = $("#exchange").value; saveCfg(); restart(); });
$("#pair").addEventListener("change", () => {
  const base = $("#pair").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 15);
  if (base && base !== cfg.base) { cfg.base = base; for (const key of ["minOrder", "bigOrder", "minTrade", "bigTrade", "step"]) cfg[key] = null; saveCfg(); restart(); }
});
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
// A coin's page links here as /screener/book/?coin=ETH.
const asked = new URLSearchParams(location.search).get("coin");
if (asked && /^[A-Za-z0-9]{1,15}$/.test(asked)) cfg.base = asked.toUpperCase();
setupSearch({});
setupPage({ en, render: () => { renderControls(); renderBooks(); } });
void getJson("/market/book/exchanges").then((answer) => { exchanges = answer.exchanges; renderControls(); }).catch(() => {});
void marketOverview().then((overview) => {
  $("#pairs").replaceChildren(...(overview?.coins ?? []).filter((coin) => !STABLE.has(coin.symbol)).slice(0, 200)
    .map((coin) => Object.assign(node("option"), { value: coin.symbol.toUpperCase(), label: coin.name })));
});
restart();
