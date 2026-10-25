// All transfers, /transfers/: the live feed of token and coin transfers on the
// tracked networks (/market/chain/feed), as on the analytics sites. Filters by
// dollar size, network and token; 50 rows a page; refreshed every 20 seconds.
// Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navPortfolio: "Portfolio", navNir: "NIR", search: "Search coins or addresses",
  title: "All transfers", refresh: "Refresh", allNetworks: "All networks", tokenFilter: "Token: USDC, ETH…",
  colTime: "Time", colFrom: "From", colTo: "To", colAmount: "Amount", colToken: "Token", colUsd: "USD",
  note: "Transfers on Ethereum and Optimism from the open Blockscout explorers, refreshed every 20 seconds. Names are open labels (ENS, verified contracts, community tags).",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const PAGE = 50;
let items = [];
let networks = [];
let min = Number(store.get("nir-transfers-min")) || 1;
let chain = "";
let tokenQuery = "";
let page = 0;
let loaded = false;
const sort = { key: null, dir: 0 };
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });

function render() {
  document.title = `${language === "en" ? en.title : "Все переводы"} — NIR Markets`;
  $("#token").placeholder = language === "en" ? en.tokenFilter : "Токен: USDC, ETH…";
  for (const button of document.querySelectorAll("#min [data-min]")) button.classList.toggle("on", Number(button.dataset.min) === min);
  $("#chain").replaceChildren(...[["", language === "en" ? en.allNetworks : "Все сети"], ...networks.map((id) => [id, CHAINS[id]?.name ?? id])].map(([id, label]) => {
    const button = node("button", id === chain ? "on" : "", label);
    button.type = "button";
    button.addEventListener("click", () => { chain = id; page = 0; void load(); });
    return button;
  }));
  const needle = tokenQuery.trim().toLowerCase();
  const shown = sortBy(items.filter((item) => !needle || item.token.symbol.toLowerCase().includes(needle) || item.token.name.toLowerCase().includes(needle)), sort, (item, key) => item[key]);
  markSort($("thead"), sort);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  page = Math.min(page, pages - 1);
  $("#page-info").textContent = `${page + 1} / ${pages}`;
  $("#prev").disabled = page === 0;
  $("#next").disabled = page >= pages - 1;
  if (!shown.length) {
    const row = node("tr");
    const cell = node("td", "muted", loaded ? (language === "en" ? "No transfers match." : "Подходящих переводов нет.") : (language === "en" ? "Loading transfers…" : "Загружаю переводы…"));
    cell.colSpan = 6;
    row.append(cell);
    $("#rows").replaceChildren(row);
    return;
  }
  $("#rows").replaceChildren(...shown.slice(page * PAGE, (page + 1) * PAGE).map((item) => {
    const row = node("tr");
    const when = node("td", "left");
    when.append(chainDot(item.chain), " ", Object.assign(node("a", "", timeAgo(item.time)), { href: `${CHAINS[item.chain]?.tx ?? "#"}${item.hash}`, target: "_blank", rel: "noopener" }));
    const from = node("td", "left");
    from.append(walletLink(item.from));
    const to = node("td", "left");
    to.append(walletLink(item.to));
    const coin = node("td", "left");
    const cell = node("span", "coin-cell");
    cell.append(logo({ id: item.token.symbol, symbol: item.token.symbol, image: item.token.icon }), node("b", "", item.token.symbol));
    coin.append(cell);
    row.append(when, from, to, node("td", "", amountShort(item.amount)), coin, node("td", "", usdShort(item.usd)));
    return row;
  }));
}
async function load() {
  $("#live").classList.add("busy");
  const query = new URLSearchParams({ min: String(min), ...(chain ? { chain } : {}) });
  const data = await fetch(`/market/chain/feed?${query}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  $("#live").classList.remove("busy");
  if (data) { items = data.items; networks = data.networks; }
  loaded = true;
  render();
}
for (const button of document.querySelectorAll("#min [data-min]")) {
  button.addEventListener("click", () => { min = Number(button.dataset.min); store.set("nir-transfers-min", String(min)); page = 0; void load(); });
}
$("#token").addEventListener("input", () => { tokenQuery = $("#token").value; page = 0; render(); });
$("#refresh").addEventListener("click", () => void load());
$("#prev").addEventListener("click", () => { page -= 1; render(); });
$("#next").addEventListener("click", () => { page += 1; render(); });
sortable($("thead"), sort, render);
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render });
void load();
setInterval(() => { if (!document.hidden && page === 0) void load(); }, 20_000);
