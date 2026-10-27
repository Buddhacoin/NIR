// The trend screener, /screener/: every futures coin of Bitget, OKX, Gate and MEXC (/market/screener,
// market-screener.mjs) with its change over 5 and 15 minutes, 1 and 4 hours and the day, the day's
// range and volume, open interest and its change over the hour, and funding. Ready-made filters
// (gainers, losers, open interest growing, high funding), a chosen period that sets the order, a
// minimum volume and a search; the table refreshes every half minute. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  title: "Trend screener", colCoin: "Coin", colPrice: "Price", col1h: "1h", col4h: "4h", col24h: "24h", colRange: "24h range",
  colVolume: "24h volume", colOi: "Open interest", colOi1h: "OI 1h", colFunding: "Funding", colExchanges: "Exchanges",
  source: "Data: the open futures markets of Bitget, OKX, Gate and MEXC, updated every minute. Changes over 5 minutes to 4 hours come from the server's own price snapshots, so after a restart they fill in gradually.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { frames: { ch5m: "5м", ch15m: "15м", ch1h: "1ч", ch4h: "4ч", ch24h: "24ч" },
    presets: { all: "Все", up: "Растут", down: "Падают", oi: "Рост OI", funding: "Высокий фандинг", volatile: "Волатильные" },
    volumes: [[0, "Любой объём"], [1e6, "> $1 млн"], [1e7, "> $10 млн"], [1e8, "> $100 млн"]],
    filter: "Монета", loading: "Загружаю рынки…", empty: "Ничего не найдено.", warming: (minutes) => `Сервер собирает историю цен ${minutes} мин; изменения за более долгие периоды появятся позже.`,
    updated: (time, count, list) => `Обновлено ${time} · ${count} монет · биржи: ${list}` },
  en: { frames: { ch5m: "5m", ch15m: "15m", ch1h: "1h", ch4h: "4h", ch24h: "24h" },
    presets: { all: "All", up: "Gainers", down: "Losers", oi: "OI rising", funding: "High funding", volatile: "Volatile" },
    volumes: [[0, "Any volume"], [1e6, "> $1M"], [1e7, "> $10M"], [1e8, "> $100M"]],
    filter: "Coin", loading: "Loading the markets…", empty: "Nothing found.", warming: (minutes) => `The server has collected ${minutes} min of prices; longer changes fill in later.`,
    updated: (time, count, list) => `Updated ${time} · ${count} coins · exchanges: ${list}` },
};
const EXCHANGE_NAMES = { bitget: "Bitget", okx: "OKX", gate: "Gate", mexc: "MEXC" };
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const state = { frame: "ch1h", preset: "all", minVolume: 1e6, query: "" };
const sort = { key: "ch1h", dir: -1 };
let data = null;
let picked = false; // the visitor chose a period; until then a young server sorts by the day
let coins = new Map(); // symbol → { id, image } from the market list, for links and logos

const percent = (value) => (value === null || value === undefined ? "—"
  : `${value > 0 ? "+" : ""}${value.toLocaleString(locale(), { maximumFractionDigits: Math.abs(value) < 1 ? 2 : 1 })}%`);
function changeCell(value, strong) {
  const cell = node("td", `sc-ch ${changeClass(value)}${strong ? " on" : ""}`, percent(value));
  // The colour deepens with the size of the move.
  if (value !== null && value !== undefined) cell.style.setProperty("--heat", Math.min(1, Math.abs(value) / 10).toFixed(2));
  return cell;
}
function priceText(value) {
  if (value === null) return "—";
  return `$${value.toLocaleString(locale(), value >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 })}`;
}

function chosen() {
  const needle = state.query.toUpperCase().replace(/\s+/g, "");
  let rows = (data?.rows ?? []).filter((row) => row.volume >= state.minVolume && (!needle || row.symbol.includes(needle)));
  const frame = state.frame;
  if (state.preset === "up") rows = rows.filter((row) => (row[frame] ?? 0) > 0);
  if (state.preset === "down") rows = rows.filter((row) => (row[frame] ?? 0) < 0);
  if (state.preset === "oi") rows = rows.filter((row) => (row.oi1h ?? 0) > 0);
  if (state.preset === "funding") rows = rows.filter((row) => row.funding !== null && Math.abs(row.funding) >= 0.03);
  if (state.preset === "volatile") rows = rows.filter((row) => (row.range24h ?? 0) >= 10);
  return sortBy(rows, sort, (row, key) => (key === "symbol" ? row.symbol : row[key]));
}

function render() {
  document.title = `${language === "en" ? en.title : "Скринер трендов"} — NIR Markets`;
  $("#filter").placeholder = t().filter;
  const button = (label, on, click) => { const item = node("button", on ? "on" : "", label); item.type = "button"; item.addEventListener("click", click); return item; };
  $("#frames").replaceChildren(...Object.entries(t().frames).map(([key, label]) => button(label, key === state.frame, () => {
    state.frame = key;
    picked = true;
    Object.assign(sort, { key, dir: state.preset === "down" ? 1 : -1 });
    render();
  })));
  $("#presets").replaceChildren(...Object.entries(t().presets).map(([key, label]) => button(label, key === state.preset, () => {
    state.preset = key;
    Object.assign(sort, key === "oi" ? { key: "oi1h", dir: -1 } : key === "funding" ? { key: "funding", dir: -1 } : key === "volatile" ? { key: "range24h", dir: -1 }
      : { key: state.frame, dir: key === "down" ? 1 : -1 });
    render();
  })));
  $("#volumes").replaceChildren(...t().volumes.map(([value, label]) => button(label, value === state.minVolume, () => { state.minVolume = value; render(); })));
  markSort($("thead"), sort);
  for (const th of document.querySelectorAll("thead th[data-sort]")) th.classList.toggle("sc-frame", th.dataset.sort === state.frame);

  if (!data) { $("#rows").replaceChildren(emptyRow(t().loading)); return; }
  const minutes = data.since ? Math.round((data.updatedAt - data.since) / 60_000) : 0;
  $("#note").textContent = [minutes < 240 ? t().warming(minutes) : "", t().updated(new Date(data.updatedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }),
    data.rows.length, data.exchanges.map((name) => EXCHANGE_NAMES[name] ?? name).join(", "))].filter(Boolean).join(" ");
  const rows = chosen().slice(0, 300);
  $("#rows").replaceChildren(...(rows.length ? rows.map((row, index) => {
    const tr = node("tr", "coin");
    const coin = coins.get(row.symbol);
    if (coin) tr.addEventListener("click", () => { location.href = coinUrl(coin); });
    const name = node("td", "left");
    const cell = node("span", "coin-cell");
    cell.append(logo({ id: row.symbol, symbol: row.symbol, image: coin?.image ?? null }), node("b", "", row.symbol));
    // On a phone the chosen period's change stands under the name.
    cell.append(node("small", `sc-mobile ${changeClass(row[state.frame])}`, percent(row[state.frame])));
    name.append(cell);
    const exchanges = node("td", "left muted sc-exchanges", row.exchanges.map((item) => EXCHANGE_NAMES[item] ?? item).join(", "));
    tr.append(node("td", "rank", String(index + 1)), name, node("td", "", priceText(row.price)),
      ...["ch5m", "ch15m", "ch1h", "ch4h", "ch24h"].map((key) => changeCell(row[key], key === state.frame)),
      node("td", "", row.range24h === null ? "—" : `${row.range24h.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`),
      node("td", "", big(row.volume)), node("td", "", row.oi === null ? "—" : big(row.oi)), changeCell(row.oi1h, false),
      node("td", row.funding === null ? "" : row.funding > 0.03 ? "up" : row.funding < -0.03 ? "down" : "", row.funding === null ? "—"
        : `${row.funding.toLocaleString(locale(), { minimumFractionDigits: 3, maximumFractionDigits: 3 })}%`), exchanges);
    return tr;
  }) : [emptyRow(t().empty)]));
}
function emptyRow(text) {
  const row = node("tr");
  const cell = node("td", "muted ex-empty", text);
  cell.colSpan = 14;
  row.append(cell);
  return row;
}

async function load() {
  const answer = await fetch("/market/screener").then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (answer?.rows?.length) data = answer;
  // Short-term changes need an hour of the server's snapshots; until then the day's change leads.
  if (data && !picked) {
    const frame = data.updatedAt - data.since < 3_600_000 ? "ch24h" : "ch1h";
    if (frame !== state.frame) { state.frame = frame; Object.assign(sort, { key: frame, dir: -1 }); }
  }
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
void marketOverview().then((overview) => {
  coins = new Map((overview?.coins ?? []).map((coin) => [coin.symbol.toUpperCase(), coin]));
  render();
});
void load();
setInterval(() => { if (!document.hidden) void load(); }, 30_000);
