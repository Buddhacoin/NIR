// The liquidations screener, /screener/liquidations/: long and short positions closed by force on the futures
// of Binance, Bybit and OKX (/market/liquidations, market-liquidations.mjs): the totals over the hour, four hours
// and day, each coin's totals for the chosen period, and the latest big ones. Refreshes every ten seconds.
// Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  tabTrends: "Trends", tabDensities: "Order book walls", tabBook: "Order book", tabArbitrage: "Arbitrage", tabLiquidations: "Liquidations", tabListings: "Listings", tabHeatmap: "Heatmap",
  title: "Liquidations", byCoin: "By coin", recent: "The last hour", colCoin: "Coin", colLongs: "Longs", colShorts: "Shorts", colTotal: "Total",
  colTime: "Time", colPosition: "Position", colPrice: "Price", colSize: "Size",
  source: "Data: the open streams of forced closes on the futures of Binance, Bybit and OKX. A long is a position on a rise closed (the price fell); a short, a position on a fall (the price rose). The server keeps the last day.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { periods: { h1: "1 ч", h4: "4 ч", d1: "24 ч" }, longs: "Лонги", shorts: "Шорты", total: "Всего", long: "Лонг", short: "Шорт",
    sizes: [[0, "Все"], [1e4, "от $10 тыс"], [1e5, "от $100 тыс"], [1e6, "от $1 млн"]], filter: "Монета",
    loading: "Собираю ликвидации… первые появятся в течение минуты.", empty: "Пока ничего.", updated: (time, list) => `Обновлено ${time} · биржи: ${list || "подключаюсь…"}` },
  en: { periods: { h1: "1h", h4: "4h", d1: "24h" }, longs: "Longs", shorts: "Shorts", total: "Total", long: "Long", short: "Short",
    sizes: [[0, "All"], [1e4, "≥ $10K"], [1e5, "≥ $100K"], [1e6, "≥ $1M"]], filter: "Coin",
    loading: "Gathering liquidations… the first show within a minute.", empty: "Nothing yet.", updated: (time, list) => `Updated ${time} · exchanges: ${list || "connecting…"}` },
};
const EXCHANGE_NAMES = { binance: "Binance", bybit: "Bybit", okx: "OKX" };
const SUFFIX = { h1: "1h", h4: "4h", d1: "24h" };
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const state = { period: "d1", size: 1e4, query: "" };
const sort = { key: "total", dir: -1 };
let data = null;

const priceText = (value) => `$${value.toLocaleString(locale(), value >= 1 ? { maximumFractionDigits: value >= 1000 ? 1 : 4 } : { maximumSignificantDigits: 5 })}`;
const usd = (value) => (value >= 1e6 ? big(value) : `$${Math.round(value).toLocaleString(locale())}`);
function coinCell(row) {
  const cell = node("span", "coin-cell");
  cell.append(logo({ id: row.symbol, symbol: row.symbol, image: row.image ?? null }), node("b", "", row.symbol));
  return cell;
}
function render() {
  document.title = `${language === "en" ? en.title : "Ликвидации"} — NIR Markets`;
  $("#filter").placeholder = t().filter;
  const button = (label, on, click) => { const item = node("button", on ? "on" : "", label); item.type = "button"; item.addEventListener("click", () => { click(); render(); }); return item; };
  $("#periods").replaceChildren(...Object.entries(t().periods).map(([key, label]) => button(label, key === state.period, () => { state.period = key; })));
  $("#sizes").replaceChildren(...t().sizes.map(([value, label]) => button(label, value === state.size, () => { state.size = value; })));
  markSort($(".lq-table thead"), sort);
  if (!data) { $("#coins").replaceChildren(emptyRow(t().loading, 5)); return; }
  // The period's totals, with a bar of longs against shorts.
  const totals = data.totals[state.period];
  const all = totals.long + totals.short;
  const box = (label, value, className) => { const item = node("div", `lq-total ${className}`); item.append(node("small", "", label), node("b", "", usd(value))); return item; };
  const bar = node("div", "lq-bar");
  bar.style.setProperty("--long", all ? (totals.long / all).toFixed(3) : "0.5");
  $("#totals").replaceChildren(box(t().longs, totals.long, "down"), box(t().shorts, totals.short, "up"), box(t().total, all, ""), bar);
  $("#note").textContent = t().updated(new Date(data.updatedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    data.exchanges.map((name) => EXCHANGE_NAMES[name] ?? name).join(", "));
  const suffix = SUFFIX[state.period];
  const needle = state.query.toUpperCase().replace(/\s+/g, "");
  const rows = sortBy(data.coins.map((row) => ({ ...row, long: row[`long${suffix}`], short: row[`short${suffix}`], total: row[`long${suffix}`] + row[`short${suffix}`] }))
    .filter((row) => row.total > 0 && (!needle || row.symbol.includes(needle))), sort, (row, key) => (key === "symbol" ? row.symbol : row[key])).slice(0, 200);
  $("#coins").replaceChildren(...(rows.length ? rows.map((row, index) => {
    const tr = node("tr", "coin");
    if (row.id) tr.addEventListener("click", () => { location.href = coinUrl(row); });
    const name = node("td", "left");
    name.append(coinCell(row));
    tr.append(node("td", "rank", String(index + 1)), name, node("td", "down", row.long ? usd(row.long) : "—"), node("td", "up", row.short ? usd(row.short) : "—"), node("td", "lq-strong", usd(row.total)));
    return tr;
  }) : [emptyRow(t().empty, 5)]));
  const recent = data.recent.filter((row) => row.usd >= state.size && (!needle || row.symbol.includes(needle))).slice(0, 100);
  $("#recent").replaceChildren(...(recent.length ? recent.map((row) => {
    const tr = node("tr");
    const name = node("td", "left");
    name.append(coinCell(row), node("small", "muted lq-ex", EXCHANGE_NAMES[row.exchange] ?? row.exchange));
    tr.append(node("td", "left muted", new Date(row.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })), name,
      node("td", `left ${row.side === "long" ? "down" : "up"}`, row.side === "long" ? t().long : t().short), node("td", "", priceText(row.price)), node("td", "lq-strong", usd(row.usd)));
    return tr;
  }) : [emptyRow(t().empty, 5)]));
}
function emptyRow(text, span) {
  const row = node("tr");
  const cell = node("td", "muted ex-empty", text);
  cell.colSpan = span;
  row.append(cell);
  return row;
}
async function load() {
  const answer = await fetch("/market/liquidations").then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (answer) data = answer;
  render();
}

sortable($(".lq-table thead"), sort, render);
$("#filter").addEventListener("input", (event) => { state.query = event.target.value.trim(); render(); });
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render });
void load();
setInterval(() => { if (!document.hidden) void load(); }, 10_000);
