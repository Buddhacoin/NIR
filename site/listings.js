// New listings, /screener/listings/: futures markets that appeared on Binance, Bybit, OKX, Bitget, Gate or
// MEXC since the server began watching (/market/listings, market-screener.mjs), newest first, with the coin's
// price then and now. Refreshes every minute. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  tabTrends: "Trends", tabDensities: "Order book walls", tabArbitrage: "Arbitrage", tabLiquidations: "Liquidations", tabListings: "Listings",
  title: "New listings", colCoin: "Coin", colExchange: "Exchange", colWhen: "When", colThen: "Price at listing", colNow: "Price now", colChange: "Change",
  source: "Data: the futures market lists of Binance, Bybit, OKX, Bitget, Gate and MEXC, read by the server every minute. A listing is a coin that appeared on an exchange after the server began watching it.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { allExchanges: "Все биржи", filter: "Монета", loading: "Загружаю…", ago: (text) => `${text} назад`,
    empty: (date) => (date ? `С ${date} новых рынков не появлялось. Как только биржа добавит монету, она будет здесь.` : "Сервер только начал следить за биржами: новые рынки появятся здесь."),
    note: (date, count) => `Слежу за биржами с ${date} · новых рынков: ${count}` },
  en: { allExchanges: "All exchanges", filter: "Coin", loading: "Loading…", ago: (text) => `${text} ago`,
    empty: (date) => (date ? `No new markets since ${date}. As soon as an exchange adds a coin, it shows here.` : "The server has just begun watching the exchanges: new markets show here."),
    note: (date, count) => `Watching the exchanges since ${date} · new markets: ${count}` },
};
const EXCHANGE_NAMES = { binance: "Binance", bybit: "Bybit", okx: "OKX", bitget: "Bitget", gate: "Gate", mexc: "MEXC" };
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const state = { exchange: "all", query: "" };
const sort = { key: "at", dir: -1 };
let data = null;

const priceText = (value) => (value === null ? "—" : `$${value.toLocaleString(locale(), value >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 5 })}`);
function render() {
  document.title = `${language === "en" ? en.title : "Новые листинги"} — NIR Markets`;
  $("#filter").placeholder = t().filter;
  const button = (label, on, click) => { const item = node("button", on ? "on" : "", label); item.type = "button"; item.addEventListener("click", () => { click(); render(); }); return item; };
  $("#exchanges").replaceChildren(button(t().allExchanges, state.exchange === "all", () => { state.exchange = "all"; }),
    ...Object.entries(EXCHANGE_NAMES).map(([key, label]) => button(label, state.exchange === key, () => { state.exchange = key; })));
  markSort($("thead"), sort);
  if (!data) { $("#rows").replaceChildren(emptyRow(t().loading)); return; }
  const since = data.since ? new Date(data.since).toLocaleDateString(locale(), { day: "numeric", month: "long" }) : null;
  $("#note").textContent = since ? t().note(since, data.rows.length) : "";
  const needle = state.query.toUpperCase().replace(/\s+/g, "");
  const rows = sortBy(data.rows.filter((row) => (state.exchange === "all" || row.exchange === state.exchange) && (!needle || row.symbol.includes(needle))),
    sort, (row, key) => (key === "symbol" ? row.symbol : row[key]));
  $("#rows").replaceChildren(...(rows.length ? rows.map((row, index) => {
    const tr = node("tr", "coin");
    if (row.id) tr.addEventListener("click", () => { location.href = coinUrl(row); });
    const name = node("td", "left");
    const cell = node("span", "coin-cell");
    cell.append(logo({ id: row.symbol, symbol: row.symbol, image: row.image ?? null }), node("b", "", row.symbol));
    name.append(cell);
    const change = node("td", `sc-ch ${changeClass(row.change)}`, row.change === null ? "—" : `${row.change > 0 ? "+" : ""}${row.change.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`);
    if (row.change !== null) change.style.setProperty("--heat", Math.min(1, Math.abs(row.change) / 30).toFixed(2));
    tr.append(node("td", "rank", String(index + 1)), name, node("td", "left", EXCHANGE_NAMES[row.exchange] ?? row.exchange), node("td", "muted", Date.now() - row.at < 86_400_000 ? t().ago(timeAgo(row.at)) : new Date(row.at).toLocaleDateString(locale(), { day: "numeric", month: "short" })),
      node("td", "", priceText(row.price)), node("td", "", priceText(row.now)), change);
    return tr;
  }) : [emptyRow(t().empty(since))]));
}
function emptyRow(text) {
  const row = node("tr");
  const cell = node("td", "muted ex-empty", text);
  cell.colSpan = 7;
  row.append(cell);
  return row;
}
async function load() {
  const answer = await fetch("/market/listings").then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (answer) data = answer;
  render();
}

sortable($("thead"), sort, render);
$("#filter").addEventListener("input", (event) => { state.query = event.target.value.trim(); render(); });
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render });
void load();
setInterval(() => { if (!document.hidden) void load(); }, 60_000);
