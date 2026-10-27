// The arbitrage screener, /screener/arbitrage/: the same coin's futures price on Binance, Bybit, OKX, Bitget,
// Gate and MEXC (/market/arbitrage, market-screener.mjs): where it is cheapest and dearest now, the gap in
// percent, the gap in funding between those two markets, and the smaller of their day volumes. Filters: the
// smallest gap, the smallest volume, an exchange that must be one of the two, and a coin search; the table
// refreshes every fifteen seconds. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  tabTrends: "Trends", tabDensities: "Order book walls", tabArbitrage: "Arbitrage", title: "Arbitrage screener", colCoin: "Coin", colBuy: "Buy",
  colSell: "Sell", colSpread: "Spread", colFunding: "Funding gap", colVolume: "24h volume", colMarkets: "Exchanges",
  source: "Data: the open futures markets of Binance, Bybit, OKX, Bitget, Gate and MEXC, updated every minute. The spread is how much higher the price is on the dearest exchange than on the cheapest; the volume is the smaller of the two. A coin under the same ticker but priced more than 5% away counts as another coin and is not compared. Mind the fees, the transfer between exchanges and the funding: this is not financial advice.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { spreads: [[0.1, "от 0,1%"], [0.3, "от 0,3%"], [0.5, "от 0,5%"], [1, "от 1%"]], volumes: [[1e5, "от $100 тыс"], [1e6, "от $1 млн"], [1e7, "от $10 млн"]],
    allExchanges: "Все биржи", filter: "Монета", loading: "Сравниваю цены бирж…", empty: "Под фильтр ничего не подходит.",
    updated: (time, count, list) => `Обновлено ${time} · ${count} монет на двух биржах и больше · биржи: ${list}` },
  en: { spreads: [[0.1, "≥ 0.1%"], [0.3, "≥ 0.3%"], [0.5, "≥ 0.5%"], [1, "≥ 1%"]], volumes: [[1e5, "≥ $100K"], [1e6, "≥ $1M"], [1e7, "≥ $10M"]],
    allExchanges: "All exchanges", filter: "Coin", loading: "Comparing the exchanges' prices…", empty: "Nothing matches the filter.",
    updated: (time, count, list) => `Updated ${time} · ${count} coins on two exchanges or more · exchanges: ${list}` },
};
const EXCHANGE_NAMES = { binance: "Binance", bybit: "Bybit", okx: "OKX", bitget: "Bitget", gate: "Gate", mexc: "MEXC" };
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const state = { spread: 0.3, volume: 1e6, exchange: "all", query: "" };
const sort = { key: "spread", dir: -1 };
let data = null;

const priceText = (value) => `$${value.toLocaleString(locale(), value >= 1 ? { maximumFractionDigits: value >= 1000 ? 2 : 4 } : { maximumSignificantDigits: 5 })}`;
const percent = (value, digits = 2) => `${value > 0 ? "+" : ""}${value.toLocaleString(locale(), { maximumFractionDigits: digits })}%`;
function chosen() {
  const needle = state.query.toUpperCase().replace(/\s+/g, "");
  const rows = (data?.rows ?? []).filter((row) => row.spread >= state.spread && row.volume >= state.volume && (!needle || row.symbol.includes(needle))
    && (state.exchange === "all" || row.buy.exchange === state.exchange || row.sell.exchange === state.exchange));
  return sortBy(rows, sort, (row, key) => (key === "symbol" ? row.symbol : row[key]));
}
function market(side) {
  const cell = node("td", "left ar-market");
  cell.append(node("b", "", EXCHANGE_NAMES[side.exchange] ?? side.exchange), node("span", "muted", priceText(side.price)));
  return cell;
}
function render() {
  document.title = `${language === "en" ? en.title : "Скринер арбитража"} — NIR Markets`;
  $("#filter").placeholder = t().filter;
  const button = (label, on, click) => { const item = node("button", on ? "on" : "", label); item.type = "button"; item.addEventListener("click", () => { click(); render(); }); return item; };
  $("#spreads").replaceChildren(...t().spreads.map(([value, label]) => button(label, value === state.spread, () => { state.spread = value; })));
  $("#volumes").replaceChildren(...t().volumes.map(([value, label]) => button(label, value === state.volume, () => { state.volume = value; })));
  const exchanges = data?.exchanges?.length ? data.exchanges : Object.keys(EXCHANGE_NAMES);
  $("#exchanges").replaceChildren(button(t().allExchanges, state.exchange === "all", () => { state.exchange = "all"; }),
    ...exchanges.map((name) => button(EXCHANGE_NAMES[name] ?? name, state.exchange === name, () => { state.exchange = name; })));
  markSort($("thead"), sort);
  if (!data?.rows) { $("#rows").replaceChildren(emptyRow(t().loading)); return; }
  $("#note").textContent = t().updated(new Date(data.updatedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }),
    data.rows.length, data.exchanges.map((name) => EXCHANGE_NAMES[name] ?? name).join(", "));
  const rows = chosen().slice(0, 300);
  $("#rows").replaceChildren(...(rows.length ? rows.map((row, index) => {
    const tr = node("tr", "coin");
    if (row.id) tr.addEventListener("click", () => { location.href = coinUrl(row); });
    const name = node("td", "left");
    const cell = node("span", "coin-cell");
    cell.append(logo({ id: row.symbol, symbol: row.symbol, image: row.image ?? null }), node("b", "", row.symbol),
      node("small", "sc-mobile", `${EXCHANGE_NAMES[row.buy.exchange] ?? row.buy.exchange} → ${EXCHANGE_NAMES[row.sell.exchange] ?? row.sell.exchange}`));
    name.append(cell);
    const spread = node("td", "sc-ch up on", percent(row.spread));
    spread.style.setProperty("--heat", Math.min(1, row.spread / 3).toFixed(2));
    tr.append(node("td", "rank", String(index + 1)), name, market(row.buy), market(row.sell), spread,
      node("td", row.fundingGap === null ? "muted" : "", row.fundingGap === null ? "—" : percent(row.fundingGap, 3)), node("td", "", big(row.volume)), node("td", "muted", String(row.markets)));
    return tr;
  }) : [emptyRow(t().empty)]));
}
function emptyRow(text) {
  const row = node("tr");
  const cell = node("td", "muted ex-empty", text);
  cell.colSpan = 8;
  row.append(cell);
  return row;
}
async function load() {
  const answer = await fetch("/market/arbitrage").then((response) => (response.ok ? response.json() : null)).catch(() => null);
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
setInterval(() => { if (!document.hidden) void load(); }, 15_000);
