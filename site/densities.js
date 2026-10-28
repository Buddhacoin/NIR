// The order-book density screener, /screener/densities/: big resting limit orders ("walls") in the futures
// books of Binance, Bybit, OKX and Bitget (/market/densities, market-densities.mjs), with their size, how far
// they stand from the price, how much bigger they are than the levels around them and how long they have
// stood. Filters: side, exchange, smallest size, largest distance, shortest lifetime, and a coin search;
// the table refreshes every ten seconds. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  tabTrends: "Trends", tabDensities: "Order book walls", tabBook: "Order book", tabArbitrage: "Arbitrage", tabLiquidations: "Liquidations", tabListings: "Listings", tabHeatmap: "Heatmap", title: "Order book walls", colCoin: "Coin", colExchange: "Exchange", colSide: "Order",
  colPrice: "Price", colSize: "Size", colDistance: "To price", colRatio: "× average", colAge: "Standing",
  source: "Data: the open futures order books of Binance, Bybit, OKX and Bitget; the server reads the books of the 100 most traded coins in turn, each about once a minute. A wall is a book level within 5% of the price, several times the average level around it and at least $100K. “Standing” is how long the order has held that price.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { sides: { all: "Все", bid: "Покупка", ask: "Продажа" }, bid: "Покупка", ask: "Продажа", allExchanges: "Все биржи",
    sizes: [[1e5, "от $100 тыс"], [5e5, "от $500 тыс"], [1e6, "от $1 млн"], [5e6, "от $5 млн"]],
    distances: [[5, "до 5%"], [2, "до 2%"], [1, "до 1%"], [0.5, "до 0,5%"]],
    ages: [[0, "Любые"], [300_000, "от 5 мин"], [1_800_000, "от 30 мин"], [3_600_000, "от 1 ч"]],
    filter: "Монета", loading: "Читаю стаканы бирж… первые плотности появятся через минуту.", empty: "Под фильтр ничего не подходит.",
    updated: (time, count, list) => `Обновлено ${time} · ${count} плотностей · биржи: ${list}`, minutes: (value) => `${value} мин`, hours: (h, m) => `${h} ч ${m} мин` },
  en: { sides: { all: "All", bid: "Bids", ask: "Asks" }, bid: "Bid", ask: "Ask", allExchanges: "All exchanges",
    sizes: [[1e5, "≥ $100K"], [5e5, "≥ $500K"], [1e6, "≥ $1M"], [5e6, "≥ $5M"]],
    distances: [[5, "≤ 5%"], [2, "≤ 2%"], [1, "≤ 1%"], [0.5, "≤ 0.5%"]],
    ages: [[0, "Any age"], [300_000, "≥ 5 min"], [1_800_000, "≥ 30 min"], [3_600_000, "≥ 1 h"]],
    filter: "Coin", loading: "Reading the exchanges' books… the first walls show within a minute.", empty: "Nothing matches the filter.",
    updated: (time, count, list) => `Updated ${time} · ${count} walls · exchanges: ${list}`, minutes: (value) => `${value} min`, hours: (h, m) => `${h} h ${m} min` },
};
const EXCHANGE_NAMES = { binance: "Binance", bybit: "Bybit", okx: "OKX", bitget: "Bitget" };
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const state = { side: "all", exchange: "all", size: 1e5, distance: 5, age: 0, query: "" };
const sort = { key: "usd", dir: -1 };
let data = null;

function priceText(value) {
  // The exchange's own price as it gives it (up to eight digits), not rounded off its tick.
  return `$${value.toLocaleString(locale(), { maximumSignificantDigits: 8 })}`;
}
function age(since) {
  const minutes = Math.max(0, Math.round((Date.now() - since) / 60_000));
  return minutes < 60 ? t().minutes(minutes) : t().hours(Math.floor(minutes / 60), minutes % 60);
}
function chosen() {
  const needle = state.query.toUpperCase().replace(/\s+/g, "");
  const rows = (data?.rows ?? []).filter((row) => (state.side === "all" || row.side === state.side) && (state.exchange === "all" || row.exchange === state.exchange)
    && row.usd >= state.size && row.distance <= state.distance && Date.now() - row.since >= state.age && (!needle || row.symbol.includes(needle)));
  // "Standing" sorts by age: the oldest first when descending.
  return sortBy(rows, sort, (row, key) => (key === "symbol" ? row.symbol : key === "since" ? -row.since : row[key]));
}
function render() {
  document.title = `${language === "en" ? en.title : "Скринер плотностей"} — NIR Markets`;
  $("#filter").placeholder = t().filter;
  const button = (label, on, click) => { const item = node("button", on ? "on" : "", label); item.type = "button"; item.addEventListener("click", () => { click(); render(); }); return item; };
  $("#sides").replaceChildren(...Object.entries(t().sides).map(([key, label]) => button(label, key === state.side, () => { state.side = key; })));
  const exchanges = data?.exchanges?.length ? data.exchanges : Object.keys(EXCHANGE_NAMES);
  $("#exchanges").replaceChildren(button(t().allExchanges, state.exchange === "all", () => { state.exchange = "all"; }),
    ...exchanges.map((name) => button(EXCHANGE_NAMES[name] ?? name, state.exchange === name, () => { state.exchange = name; })));
  $("#sizes").replaceChildren(...t().sizes.map(([value, label]) => button(label, value === state.size, () => { state.size = value; })));
  $("#distances").replaceChildren(...t().distances.map(([value, label]) => button(label, value === state.distance, () => { state.distance = value; })));
  $("#ages").replaceChildren(...t().ages.map(([value, label]) => button(label, value === state.age, () => { state.age = value; })));
  markSort($("thead"), sort);
  if (!data?.rows?.length) { $("#note").textContent = ""; $("#rows").replaceChildren(emptyRow(t().loading)); return; }
  $("#note").textContent = t().updated(new Date(data.updatedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    data.rows.length, data.exchanges.map((name) => EXCHANGE_NAMES[name] ?? name).join(", "));
  const rows = chosen().slice(0, 300);
  // The rows on screen take the new figures in place (common.js patchList).
  patchList($("#rows"), (rows.length ? rows.map((row, index) => {
    const tr = node("tr", "coin");
    tr.dataset.key = `${row.exchange}:${row.symbol}:${row.side}:${row.price}`;
    if (row.id) tr.addEventListener("click", () => { location.href = coinUrl(row); });
    const name = node("td", "left");
    const cell = node("span", "coin-cell");
    cell.append(logo({ id: row.symbol, symbol: row.symbol, image: row.image ?? null }), node("b", "", row.symbol),
      node("small", `sc-mobile ${row.side === "bid" ? "up" : "down"}`, `${t()[row.side]} · ${EXCHANGE_NAMES[row.exchange] ?? row.exchange}`));
    name.append(cell);
    tr.append(node("td", "rank", String(index + 1)), name, node("td", "left muted", EXCHANGE_NAMES[row.exchange] ?? row.exchange),
      node("td", `left ${row.side === "bid" ? "up" : "down"}`, t()[row.side]), node("td", "", priceText(row.price)),
      node("td", "dn-size", big(row.usd)), node("td", "", `${row.distance.toLocaleString(locale(), { maximumFractionDigits: 2 })}%`),
      node("td", "muted", `×${row.ratio.toLocaleString(locale(), { maximumFractionDigits: 1 })}`), node("td", "", age(row.since)));
    // The bar behind the size shows it against the biggest wall on the page.
    tr.style.setProperty("--dn", Math.min(1, row.usd / rows[0].usd).toFixed(3));
    tr.classList.add(row.side === "bid" ? "dn-bid" : "dn-ask");
    return tr;
  }) : [emptyRow(t().empty)]));
}
function emptyRow(text) {
  const row = node("tr");
  const cell = node("td", "muted ex-empty", text);
  cell.colSpan = 9;
  row.append(cell);
  return row;
}
async function load() {
  const answer = await fetch("/market/densities").then((response) => (response.ok ? response.json() : null)).catch(() => null);
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
setInterval(() => { if (!document.hidden) void load(); }, 10_000);
