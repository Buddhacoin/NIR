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
  source: "The book, trades and candles come from the exchanges' open APIs and streams, every 2 seconds. Prices are the exchange's own levels; orders of at least the smallest within the depth show, big ones with a lighter bold row; the totals on top are every order within the depth. Point at a row for the volume from the price through it. Not financial advice.",
  exchangesCredit: "the exchanges' open APIs",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { modes: { single: "Одиночный режим", multi: "Конструктор", stats: "Статистика" }, bid: "Покупка (BID)", ask: "Продажа (ASK)", price: "Цена", amount: "Объём", time: "Время", type: "Тип",
    buy: "BUY", sell: "SELL", loading: "Загружаю стакан…", failed: (name) => `${name}: этой пары нет или биржа не ответила`, none: "Нет уровней больше минимального ордера в пределах глубины.",
    noTrades: "Нет сделок больше минимальной.", total: "Всего в пределах глубины", exchangeCol: "Биржа",
    settingsTitle: "Настройки", chartTitle: "Настройки графика", bookHead: "Стакан", tradesHead: "Лента сделок", more: "Дополнительно",
    depth: "Глубина стакана", minOrder: "Миним. ордер", bigOrder: "Большой ордер", tradesCount: "Показ сделок", minTrade: "Миним. сделка", bigTrade: "Большая сделка",
    step: "Шаг цены", auto: "авто", amountDigits: "Знаков после запятой (объём)", priceDigits: "Знаков после запятой (цена)",
    usdMode: "Режим в долларах", usdHint: "Все объёмы задаются и показываются в долларах.", save: "Сохранить", reset: "Сбросить",
    showChart: "Показывать график", showChartHint: "Свечи пары с уровнями крупных ордеров.", hideLevels: "Скрыть уровни", hideLevelsHint: "Не рисовать крупные ордера на графике.",
    levelDepth: "Глубина показа уровней", levelDepthHint: "Насколько далеко от цены рисовать уровни.", reverse: "Реверсия цветов", reverseHint: "Поменять местами цвета уровней поддержки и сопротивления.",
    config: (cfg) => `Глубина ${cfg.depth} · ордер от ${cfg.min} · крупный от ${cfg.big} · сделка от ${cfg.minTrade} · шаг ${cfg.step}`,
    reach: (down, up, full) => `Стакан биржи: −${down}% / +${up}% от цены${full ? " · полная глубина из потока" : ""}`,
    ownHint: "Свои пороги этой биржи", ownNote: "Минимальный и большой ордер только для этой биржи; пустое поле — общие настройки.",
    stats: { days: (count) => `${count} дней`, open: "Открытие", close: "Закрытие", low: "Минимум", high: "Максимум", volatility: "Средняя волатильность", volume: "Средний объём за день",
      expected: "Ожидаемая цена на сегодня", expectedNote: "Открытие дня ± средняя волатильность за 7 дней (UTC)", today: "Открытие сегодня", history: "По дням",
      date: "Дата", change: "Изменение", range: "Волатильность", loading: "Загружаю дневные свечи…" },
    pickMore: "Выберите до 4 бирж", pct: "%", pcs: "шт.", rawStep: "цены биржи", max: "MAX", bars: "свечей",
    tools: { cursor: "Курсор", hline: "Горизонтальная линия: нажмите на график", trend: "Трендовая линия: две точки на графике", ruler: "Линейка: две точки — изменение в % и цене",
      clear: "Стереть рисунки", fit: "Весь график", indicator: "Индикатор" },
    through: (amount) => `Всего от цены до этого уровня: ${amount}` },
  en: { modes: { single: "Single", multi: "Constructor", stats: "Statistics" }, bid: "Bids", ask: "Asks", price: "Price", amount: "Amount", time: "Time", type: "Type",
    buy: "BUY", sell: "SELL", loading: "Loading the book…", failed: (name) => `${name}: no such pair, or the exchange did not answer`, none: "No levels above the smallest order within the depth.",
    noTrades: "No trades above the smallest.", total: "Total within the depth", exchangeCol: "Exchange",
    settingsTitle: "Settings", chartTitle: "Chart settings", bookHead: "Order book", tradesHead: "Trades feed", more: "More",
    depth: "Book depth", minOrder: "Smallest order", bigOrder: "Big order", tradesCount: "Trades shown", minTrade: "Smallest trade", bigTrade: "Big trade",
    step: "Price step", auto: "auto", amountDigits: "Decimals (amount)", priceDigits: "Decimals (price)",
    usdMode: "Dollar mode", usdHint: "All amounts are set and shown in dollars.", save: "Save", reset: "Reset",
    showChart: "Show the chart", showChartHint: "The pair's candles with the big orders' levels.", hideLevels: "Hide levels", hideLevelsHint: "Do not draw the big orders on the chart.",
    levelDepth: "Levels depth", levelDepthHint: "How far from the price levels are drawn.", reverse: "Reverse colours", reverseHint: "Swap the colours of support and resistance levels.",
    config: (cfg) => `Depth ${cfg.depth} · orders from ${cfg.min} · big from ${cfg.big} · trades from ${cfg.minTrade} · step ${cfg.step}`,
    reach: (down, up, full) => `The exchange's book: −${down}% / +${up}% of the price${full ? " · full depth from its stream" : ""}`,
    ownHint: "This exchange's own thresholds", ownNote: "The smallest and big order for this exchange only; empty means the common settings.",
    stats: { days: (count) => `${count} days`, open: "Open", close: "Close", low: "Low", high: "High", volatility: "Average volatility", volume: "Average daily volume",
      expected: "Expected price today", expectedNote: "Today's open ± the 7-day average volatility (UTC)", today: "Today's open", history: "By day",
      date: "Date", change: "Change", range: "Volatility", loading: "Loading daily candles…" },
    pickMore: "Pick up to 4 exchanges", pct: "%", pcs: "pcs", rawStep: "the exchange's prices", max: "MAX", bars: "candles",
    tools: { cursor: "Cursor", hline: "Horizontal line: click the chart", trend: "Trend line: two points on the chart", ruler: "Ruler: two points, the change in % and price",
      clear: "Erase the drawings", fit: "The whole chart", indicator: "Indicator" },
    through: (amount) => `Everything from the price through this level: ${amount}` },
};
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const TFS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const DEFAULTS = { mode: "single", ex: "binance", exs: ["binance", "okx", "coinbase"], base: "ETH", quote: "U" + "SDT", depth: 100, minOrder: null, bigOrder: null,
  usd: false, tradesCount: 100, minTrade: null, bigTrade: null, step: null, amountDigits: null, priceDigits: null, tf: "1h", chart: true, hideLevels: false,
  levelDepth: 20, reverse: false, trades: true, ind: { volume: true } };
const KEY = "nir-book-settings";
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch {}
const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} };
let exchanges = [{ id: "binance", name: "Binance", quotes: [DEFAULTS.quote, "BTC"] }];
const books = new Map(); // exchange → { at, data } or { failed }
let trades = []; // newest first, with their exchange
let candles = [];

// --- Numbers. The book shows the exchange's own price levels, as the order-book tools do; a price step
// set in the settings gathers them instead. Thresholds left empty follow the book; the formats.
const niceStep = (raw) => { const power = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((step) => step >= raw * 0.999); };
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
// In the constructor each exchange may have its own (cfg.per[exchange]), as books differ in size.
function thresholds(view, ex, price) {
  const sorted = (list) => list.map(([level, amount]) => sizeOf(level, amount)).sort((left, right) => right - left);
  const sizes = sorted([...view.bids, ...view.asks]);
  // The smallest order shown is set by the levels next to the price (about twenty a side within 1%), as on
  // the order-book tools, so the book starts at the market's price and not at the first far wall.
  const close = sorted([...view.bids, ...view.asks].filter(([level]) => !price || Math.abs(level - price) / price <= 0.01));
  const nth = (list, index) => list[Math.min(list.length - 1, index)] ?? 0;
  const own = cfg.mode === "multi" ? cfg.per?.[ex] ?? {} : {};
  const min = own.minOrder ?? cfg.minOrder ?? roundDown(nth(close.length ? close : sizes, 40));
  return { min, big: own.bigOrder ?? cfg.bigOrder ?? Math.max(min * 2, roundDown(nth(sizes, 8))) };
}
// Decimals of the exchange's prices (its tick), read off the levels; a set step or setting wins.
const decimalsOf = (value) => { const text = String(value); return text.includes("e-") ? Number(text.split("e-")[1]) : (text.split(".")[1] ?? "").length; };
const digitsFor = (step) => Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
const priceText = (value, digits) => value.toLocaleString(locale(), { minimumFractionDigits: cfg.priceDigits ?? digits, maximumFractionDigits: cfg.priceDigits ?? digits });
const amountText = (value) => {
  const digits = cfg.amountDigits ?? (Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 4);
  return value.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: cfg.amountDigits ?? 0 });
};
const unitText = (value, base) => (cfg.usd ? usdShort(value) : `${amountText(value)} ${base.toLowerCase()}`);

// A book as shown: within the depth, its totals there (every order, the small ones too), the levels of at
// least the smallest order, each with the volume from the price through it.
function view(data) {
  const range = cfg.depth / 100;
  const near = ([price]) => Math.abs(price - data.price) / data.price <= range;
  let bids = data.bids.filter(near);
  let asks = data.asks.filter(near);
  if (cfg.step) {
    bids = regroup(bids, cfg.step, true);
    asks = regroup(asks, cfg.step, false);
  }
  const digits = cfg.step ? digitsFor(cfg.step) : Math.min(8, Math.max(0, ...[...bids, ...asks].slice(0, 60).map(([price]) => decimalsOf(price))));
  const within = (list) => { const row = list?.[Math.min(100, Math.max(1, Math.round(cfg.depth))) - 1]; return { coin: row?.[0] ?? 0, usd: row?.[1] ?? 0 }; };
  const limits = thresholds({ bids, asks }, data.ex, data.price);
  const keep = (list) => list.filter(([price, amount]) => sizeOf(price, amount) >= limits.min).slice(0, 400);
  return { digits, step: cfg.step ?? 10 ** -digits, price: data.price, totals: { bids: within(data.totals?.bids), asks: within(data.totals?.asks) },
    bids: keep(bids), asks: keep(asks), limits };
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
  $("#single-pick").hidden = cfg.mode === "multi";
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
  $("#config").textContent = t().config({ depth: cfg.depth >= 100 ? t().max : `${cfg.depth}%`, min: unitText(shown.limits.min, cfg.base), big: unitText(shown.limits.big, cfg.base),
    minTrade: unitText(tradeLimits().min, cfg.base), step: cfg.step ? priceText(cfg.step, shown.digits) : t().rawStep });
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
  // The unit in the head, so it reads plainly: coins (or dollars in dollar mode).
  head.querySelectorAll("th")[1].textContent = `${t().amount}, ${cfg.usd ? "$" : base.toLowerCase()}`;
  const body = node("tbody");
  const sum = node("tr", "bk-total");
  sum.title = t().total;
  sum.append(node("td", "left", usdShort(total.usd)), node("td", "", `${amountText(total.coin)} ${base.toLowerCase()}`));
  body.append(sum);
  const biggest = Math.max(1e-12, ...list.map(([price, amount]) => sizeOf(price, amount)));
  if (!list.length) { const row = node("tr"); const cell = node("td", "muted ex-empty", t().none); cell.colSpan = 2; row.append(cell); body.append(row); }
  for (const [price, amount, through] of list) {
    const size = sizeOf(price, amount);
    const row = node("tr", size >= shown.limits.big ? "big" : "");
    // On a pointer: every order from the price through this level, the small ones too.
    if (through) row.title = t().through(`${amountText(through)} ${base.toLowerCase()}`);
    row.style.setProperty("--fill", `${Math.round((size / biggest) * 100)}%`);
    row.append(node("td", "left", priceText(price, shown.digits)), node("td", "", cfg.usd ? usdShort(size) : amountText(amount)));
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
  for (const [label, left] of [[t().time, true], ...(withExchange ? [[t().exchangeCol, true]] : []), [t().price], [`${t().amount}, ${cfg.usd ? "$" : cfg.base.toLowerCase()}`], [t().type]]) row.append(node("th", left ? "left" : "", label));
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
  $("#stats").hidden = cfg.mode !== "stats";
  box.hidden = cfg.mode === "stats";
  if (cfg.mode === "stats") { renderStats(); return; }
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
      title.append(node("b", "", `(${priceText(data.price, shown.digits)})`));
      // The exchange's own thresholds: shown, and set from its gear.
      const own = node("button", "bk-own", `${unitText(shown.limits.min, data.base)} / ${unitText(shown.limits.big, data.base)} ⚙`);
      own.type = "button";
      own.title = t().ownHint;
      own.addEventListener("click", () => openDrawer("exchange", id));
      title.append(own);
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
  chart.subscribeClick(onChartClick);
  chart.subscribeCrosshairMove(onChartMove);
  renderTools();
}
function drawCandles() {
  ensureChart();
  if (!series) return;
  series.setData(candles.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
  drawIndicators();
  drawDrawings();
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

// --- The chart's tools, as on the trading terminals: a cursor, horizontal and trend lines, a ruler that
// measures the move between two points, clearing the drawings, and indicators (volume, MA 20 and 50,
// EMA 200). Drawings are kept in this browser for each exchange and pair.
const TOOLS = [["cursor", "✛"], ["hline", "─"], ["trend", "╱"], ["ruler", "📏"]];
const INDICATORS = [["volume", "Vol"], ["ma20", "MA 20"], ["ma50", "MA 50"], ["ema200", "EMA 200"]];
let tool = "cursor";
let pending = null; // the first point of a trend line or a ruler: { time, price }
let drawn = { lines: [], series: [] }; // what is on the chart now
let indicatorSeries = [];
const drawingsKey = () => `nir-book-drawings:${cfg.ex}:${cfg.base}:${cfg.quote}`;
const loadDrawings = () => { try { return JSON.parse(localStorage.getItem(drawingsKey()) ?? "null") ?? { h: [], t: [] }; } catch { return { h: [], t: [] }; } };
const saveDrawings = (value) => { try { localStorage.setItem(drawingsKey(), JSON.stringify(value)); } catch {} };
function renderTools() {
  const box = $("#chart-tools");
  const words = t().tools;
  const button = (key, label, title, on, click) => {
    const item = node("button", `bk-tool${on ? " on" : ""}`, label);
    item.type = "button";
    item.title = title;
    item.addEventListener("click", click);
    return item;
  };
  box.replaceChildren(...TOOLS.map(([key, label]) => button(key, label, words[key], tool === key, () => { tool = key; pending = null; $("#measure").hidden = true; renderTools(); })),
    button("clear", "⌫", words.clear, false, () => { saveDrawings({ h: [], t: [] }); drawDrawings(); }),
    button("fit", "⤢", words.fit, false, () => chart?.timeScale().fitContent()),
    node("span", "bk-tool-gap"),
    ...INDICATORS.map(([key, label]) => button(key, label, words.indicator, Boolean(cfg.ind?.[key]), () => {
      cfg.ind = { ...(cfg.ind ?? {}), [key]: !cfg.ind?.[key] };
      saveCfg();
      renderTools();
      drawIndicators();
    })));
  $("#chart").classList.toggle("drawing", tool !== "cursor");
}
const pointOf = (param) => {
  if (!param?.point || param.time === undefined || !series) return null;
  const price = series.coordinateToPrice(param.point.y);
  return price === null ? null : { time: param.time, price };
};
function onChartClick(param) {
  const point = pointOf(param);
  if (!point || tool === "cursor") return;
  const saved = loadDrawings();
  if (tool === "hline") { saved.h.push(point.price); saveDrawings(saved); drawDrawings(); return; }
  if (!pending) { pending = point; return; }
  if (tool === "trend" && point.time !== pending.time) { saved.t.push([pending.time, pending.price, point.time, point.price]); saveDrawings(saved); drawDrawings(); }
  if (tool === "ruler") { showMeasure(pending, point, param.point); pending = null; return; }
  pending = null;
}
function onChartMove(param) {
  if (tool !== "ruler" || !pending) return;
  const point = pointOf(param);
  if (point) showMeasure(pending, point, param.point);
}
// The ruler: the change from the first point to the second, in per cent and in price, and the candles between.
function showMeasure(from, to, at) {
  const box = $("#measure");
  const change = (to.price - from.price) / from.price * 100;
  const bars = candles.filter(([time]) => time > Math.min(from.time, to.time) && time <= Math.max(from.time, to.time)).length;
  box.hidden = false;
  box.className = `bk-measure ${change >= 0 ? "up" : "down"}`;
  box.textContent = `${change >= 0 ? "+" : ""}${change.toLocaleString(locale(), { maximumFractionDigits: 2 })}% · ${change >= 0 ? "+" : "−"}${price(Math.abs(to.price - from.price))} · ${bars} ${t().bars}`;
  box.style.left = `${Math.max(4, at.x + 12)}px`;
  box.style.top = `${Math.max(4, at.y - 30)}px`;
}
function drawDrawings() {
  if (!series) return;
  for (const line of drawn.lines) series.removePriceLine(line);
  for (const item of drawn.series) chart.removeSeries(item);
  drawn = { lines: [], series: [] };
  const saved = loadDrawings();
  const color = css("--accent") || "#4d8dff";
  for (const level of saved.h) drawn.lines.push(series.createPriceLine({ price: level, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true }));
  for (const [t1, p1, t2, p2] of saved.t) {
    const line = chart.addLineSeries({ color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(t1 < t2 ? [{ time: t1, value: p1 }, { time: t2, value: p2 }] : [{ time: t2, value: p2 }, { time: t1, value: p1 }]);
    drawn.series.push(line);
  }
}
function drawIndicators() {
  if (!chart) return;
  for (const item of indicatorSeries) chart.removeSeries(item);
  indicatorSeries = [];
  const on = cfg.ind ?? {};
  if (on.volume) {
    const volume = chart.addHistogramSeries({ priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(candles.map(([time, open, , , close, amount]) => ({ time, value: amount, color: close >= open ? "rgba(22,199,132,.35)" : "rgba(234,57,67,.35)" })));
    indicatorSeries.push(volume);
  }
  const average = (length, exponential) => {
    const out = [];
    let sum = 0;
    let ema = null;
    candles.forEach(([time, , , , close], index) => {
      if (exponential) {
        ema = ema === null ? close : close * (2 / (length + 1)) + ema * (1 - 2 / (length + 1));
        if (index >= length - 1) out.push({ time, value: ema });
        return;
      }
      sum += close;
      if (index >= length) sum -= candles[index - length][4];
      if (index >= length - 1) out.push({ time, value: sum / length });
    });
    return out;
  };
  for (const [key, length, exponential, color] of [["ma20", 20, false, "#f5c45e"], ["ma50", 50, false, "#8b7bff"], ["ema200", 200, true, "#00b8d9"]]) {
    if (!on[key]) continue;
    const line = chart.addLineSeries({ color, lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    line.setData(average(length, exponential));
    indicatorSeries.push(line);
  }
}

// --- Statistics, as the order-book tools give it: for the last 7, 14 and 30 days the open, close, low and
// high, the average daily volatility ((high − low) / open) and volume; today's expected range (its open ±
// the 7-day average volatility); and every day back as far as the exchange's daily candles go.
let daily = null;
async function loadDaily() {
  if (cfg.mode !== "stats") return;
  const mine = generation;
  const answer = await getJson(`/market/book/candles?${query(cfg.ex)}&tf=1d`).catch(() => null);
  if (mine !== generation) return;
  daily = answer?.candles ?? [];
  renderStats();
}
function renderStats() {
  const box = $("#stats");
  const words = t().stats;
  if (!daily) { box.replaceChildren(node("p", "muted", words.loading)); return; }
  if (!daily.length) { box.replaceChildren(node("p", "muted", t().failed(exchanges.find((item) => item.id === cfg.ex)?.name ?? cfg.ex))); return; }
  const last = daily.at(-1);
  const closed = daily.slice(0, -1); // the days that ended
  const digits = Math.min(8, Math.max(0, ...daily.slice(-30).map(([, open]) => decimalsOf(open))));
  const money = (value) => priceText(value, Math.min(digits, value >= 100 ? 2 : digits));
  const card = (label, value, small = "") => { const item = node("div", "bk-stat"); item.append(node("small", "muted", label), node("b", "", value), ...(small ? [node("span", "muted", small)] : [])); return item; };
  const period = (count) => {
    const days = closed.slice(-count);
    if (!days.length) return null;
    const volatility = days.reduce((sum, [, open, high, low]) => sum + (high - low) / open * 100, 0) / days.length;
    const section = node("section", "bk-period");
    section.append(node("h3", "", words.days(count)));
    const grid = node("div", "bk-stats-grid");
    grid.append(card(words.open, money(days[0][1])), card(words.close, money(days.at(-1)[4])), card(words.low, money(Math.min(...days.map((row) => row[3])))),
      card(words.high, money(Math.max(...days.map((row) => row[2])))), card(words.volatility, `${volatility.toLocaleString(locale(), { maximumFractionDigits: 2 })}%`),
      card(words.volume, `${amountText(days.reduce((sum, row) => sum + row[5], 0) / days.length)} ${cfg.base.toLowerCase()}`));
    section.append(grid);
    return { section, volatility };
  };
  const periods = [7, 14, 30].map(period).filter(Boolean);
  const week = periods[0]?.volatility ?? 0;
  const expected = node("section", "bk-period bk-expected");
  expected.append(node("h3", "", words.expected));
  const grid = node("div", "bk-stats-grid");
  grid.append(card(words.today, money(last[1])), card(words.low, money(last[1] * (1 - week / 100))), card(words.high, money(last[1] * (1 + week / 100))));
  expected.append(grid, node("p", "muted", words.expectedNote));
  const table = node("table", "ex-table bk-daily");
  const head = node("tr");
  for (const [label, left] of [[words.date, true], [words.open], [words.high], [words.low], [words.close], [words.change], [words.range], [`${t().amount}, ${cfg.base.toLowerCase()}`]]) head.append(node("th", left ? "left" : "", label));
  const thead = node("thead");
  thead.append(head);
  const body = node("tbody");
  body.append(...[...daily].reverse().map(([time, open, high, low, close, volume]) => {
    const row = node("tr");
    const change = (close - open) / open * 100;
    row.append(node("td", "left", new Date(time * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })),
      node("td", "", money(open)), node("td", "", money(high)), node("td", "", money(low)), node("td", "", money(close)),
      node("td", change >= 0 ? "up" : "down", `${change >= 0 ? "+" : ""}${change.toLocaleString(locale(), { maximumFractionDigits: 2 })}%`),
      node("td", "", `${((high - low) / open * 100).toLocaleString(locale(), { maximumFractionDigits: 2 })}%`), node("td", "", amountText(volume)));
    return row;
  }));
  table.append(thead, body);
  const history = node("section", "bk-period");
  const wrap = node("div", "table-wrap bk-daily-wrap");
  wrap.append(table);
  history.append(node("h3", "", words.history), wrap);
  box.replaceChildren(expected, ...periods.map((item) => item.section), history);
}

// --- Loading: the books and trades every two seconds, the candles every half minute.
const query = (ex) => `ex=${encodeURIComponent(ex)}&base=${encodeURIComponent(cfg.base)}&quote=${encodeURIComponent(cfg.quote)}`;
const fetchJson = (url) => fetch(url).then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))));
// Binance's spot market turns the server's country (the Netherlands) away, so when the server cannot read it
// the visitor's browser reads it straight from Binance's market-data addresses, which allow any site.
const getJson = (url) => {
  const params = new URL(url, location.origin).searchParams;
  if (!url.startsWith("/market/book?") && !url.startsWith("/market/book/") || params.get("ex") !== "binance") return fetchJson(url);
  if (direct.on) return fromBinance(url, params);
  return fetchJson(url).catch((error) => {
    if (error.message !== "502") throw error;
    direct.on = true;
    return fromBinance(url, params);
  });
};
const direct = { on: false, pair: null, far: null, farAt: 0 };
const BINANCE = "https://data-api.binance.vision/api/v3";
const levels = (list) => (Array.isArray(list) ? list : []).map(([price, amount]) => [Number(price), Number(amount)]).filter(([price, amount]) => price > 0 && amount > 0);
async function fromBinance(url, params) {
  const pair = `${params.get("base")}${params.get("quote")}`.toUpperCase();
  if (url.startsWith("/market/book/trades")) {
    const list = await fetchJson(`${BINANCE}/trades?symbol=${pair}&limit=500`);
    return { trades: list.map((item) => ({ time: Number(item.time), price: Number(item.price), amount: Number(item.qty), side: item.isBuyerMaker ? "sell" : "buy" }))
      .sort((left, right) => right.time - left.time) };
  }
  if (url.startsWith("/market/book/candles")) {
    const list = await fetchJson(`${BINANCE}/klines?symbol=${pair}&interval=${params.get("tf") ?? "1h"}&limit=500`);
    return { candles: list.map((row) => [row[0] / 1000, row[1], row[2], row[3], row[4], row[5]].map(Number)) };
  }
  // The whole 5,000 levels every ten seconds, the nearest 1,000 every two: within Binance's limits for one visitor.
  if (direct.pair !== pair || Date.now() - direct.farAt > 10_000) {
    const answer = await fetchJson(`${BINANCE}/depth?symbol=${pair}&limit=5000`);
    Object.assign(direct, { pair, far: { bids: levels(answer.bids), asks: levels(answer.asks) }, farAt: Date.now() });
  }
  const near = await fetchJson(`${BINANCE}/depth?symbol=${pair}&limit=1000`);
  const merge = (far, list, down) => {
    const close = levels(list);
    if (!close.length) return far;
    const edge = close.at(-1)[0];
    return [...close, ...far.filter(([price]) => (down ? price < edge : price > edge))];
  };
  const book = { bids: merge(direct.far.bids, near.bids, true), asks: merge(direct.far.asks, near.asks, false) };
  return { ex: "binance", base: params.get("base"), quote: params.get("quote"), pair, ...gatherBook(book), at: Date.now() };
}
// The server's reading of a book (blockchain/market-book.mjs gatherBook), for a book read in the browser: each
// side's 800 largest levels with the volume from the best price through each, and the totals per whole per cent.
function gatherBook({ bids, asks }, keep = 800) {
  const best = Math.max(0, ...bids.map(([price]) => price));
  const ask = Math.min(...asks.map(([price]) => price));
  const price = best && Number.isFinite(ask) ? (best + ask) / 2 : best || (Number.isFinite(ask) ? ask : 0);
  if (!price) return { price: null, bids: [], asks: [], totals: { bids: [], asks: [] } };
  const totals = {};
  const side = (list, down, name) => {
    const sorted = list.filter(([level]) => Math.abs(level - price) / price <= 1).sort((left, right) => (down ? right[0] - left[0] : left[0] - right[0]));
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
    totals[name] = sums;
    const biggest = new Set([...[...withVolume].sort((left, right) => right[1] - left[1]).slice(0, keep), ...withVolume.slice(0, 200)]);
    return withVolume.filter((row) => biggest.has(row));
  };
  return { price, bids: side(bids, true, "bids"), asks: side(asks, false, "asks"), totals, levels: bids.length + asks.length };
}
let generation = 0;
async function loadBooks() {
  if (cfg.mode === "stats") return;
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
  daily = null;
  void loadBooks();
  void loadCandles();
  void loadDaily();
  bookTimer = setInterval(() => { if (!document.hidden) void loadBooks(); }, 2_000);
  candleTimer = setInterval(() => { if (!document.hidden) void loadCandles(); }, 30_000);
}

// --- The settings drawers: the book and trades, and the chart.
function openDrawer(kind, ex = null) {
  const words = t();
  const exchangeName = exchanges.find((item) => item.id === ex)?.name ?? ex;
  $("#drawer-title").textContent = kind === "book" ? words.settingsTitle : kind === "exchange" ? `${words.settingsTitle}: ${exchangeName}` : words.chartTitle;
  const body = $("#drawer-body");
  const draft = kind === "exchange" ? { ...(cfg.per?.[ex] ?? {}) } : { ...cfg };
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
  // The depth as the order-book tools offer it: 5 to 60 % in fives, 90 %, or all of it.
  const depthField = () => {
    const wrap = node("label", "bk-input");
    const select = node("select", "bk-select");
    for (const value of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 90, 100]) {
      select.append(Object.assign(node("option", "", value === 100 ? words.max : `${value} %`), { value, selected: Number(draft.depth) === value }));
    }
    select.addEventListener("change", () => { draft.depth = Number(select.value); });
    wrap.append(node("small", "muted", words.depth), select);
    return wrap;
  };
  const grid = (...items) => { const box = node("div", "bk-grid"); box.append(...items); return box; };
  const heading = (text) => node("h4", "bk-head", text);
  if (kind === "book") {
    body.replaceChildren(heading(words.bookHead),
      grid(depthField(), field(words.minOrder, "minOrder", unit()), field(words.bigOrder, "bigOrder", unit())),
      heading(words.tradesHead),
      grid(field(words.tradesCount, "tradesCount", words.pcs, { min: 10, step: 10, placeholder: "100" }), field(words.minTrade, "minTrade", unit()), field(words.bigTrade, "bigTrade", unit())),
      heading(words.more),
      grid(field(words.step, "step", cfg.quote), field(words.amountDigits, "amountDigits", "", { step: 1 }), field(words.priceDigits, "priceDigits", "", { step: 1 })),
      toggle(words.usdMode, words.usdHint, "usd"));
  } else if (kind === "exchange") {
    body.replaceChildren(node("p", "muted", words.ownNote), grid(field(words.minOrder, "minOrder", unit()), field(words.bigOrder, "bigOrder", unit())));
  } else {
    body.replaceChildren(toggle(words.showChart, words.showChartHint, "chart"), toggle(words.hideLevels, words.hideLevelsHint, "hideLevels"),
      grid(field(words.levelDepth, "levelDepth", words.pct, { min: 1, placeholder: "20" })), toggle(words.reverse, words.reverseHint, "reverse"));
  }
  const buttons = node("div", "bk-drawer-buttons");
  const reset = node("button", "act ghost", words.reset);
  reset.type = "button";
  reset.addEventListener("click", () => {
    if (kind === "exchange") { const per = { ...(cfg.per ?? {}) }; delete per[ex]; cfg.per = per; saveCfg(); closeDrawer(); restart(); return; }
    const keys = kind === "book" ? ["depth", "minOrder", "bigOrder", "tradesCount", "minTrade", "bigTrade", "step", "amountDigits", "priceDigits", "usd"] : ["chart", "hideLevels", "levelDepth", "reverse"];
    for (const key of keys) cfg[key] = DEFAULTS[key];
    saveCfg(); closeDrawer(); restart();
  });
  const save = node("button", "act", words.save);
  save.type = "button";
  save.addEventListener("click", () => {
    if (kind === "exchange") {
      cfg.per = { ...(cfg.per ?? {}), [ex]: { minOrder: draft.minOrder ?? null, bigOrder: draft.bigOrder ?? null } };
      saveCfg(); closeDrawer(); restart(); return;
    }
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
