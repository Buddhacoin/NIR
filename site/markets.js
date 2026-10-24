// NIR Markets: the top 100 coins from the server's cached copy (/market/overview,
// refreshed every minute), NIR's own network figures (/api/v1/stats), day and
// night themes, Russian and English, a watchlist kept in this browser and a
// TradingView chart under any coin.

const STABLE = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "USDS", "PYUSD", "USDD", "BUSD", "USD1"]);
const en = {
  nirOpen: "NIR network is open", nirMiners: "Miners online", nirPioneers: "Pioneers", nirMined: "Mined",
  nirPool: "🏆 210,000 NIR for pioneers", nirCta: "Mine NIR with one button →",
  navCoins: "Cryptocurrencies", navMovers: "Gainers & losers", navNir: "About NIR", navMine: "NIR mining",
  search: "Search coins", marketStatus: "Market status", fearGreed: "Fear & Greed", marketCap: "Market cap",
  volume24: "Volume 24h", dominance: "BTC dominance", trending: "Trending", gainers24: "Top gainers 24h",
  briefTag: "✦ MARKET SUMMARY", briefNote: "Built automatically from the last 24 hours of prices. Not financial advice.",
  tabTop: "Top", tabWatch: "Watchlist", tabGainers: "Top gainers", tabLosers: "Top losers", tabStable: "Stablecoins",
  colCoin: "Coin", colPrice: "Price", col1h: "1h", col24h: "24h", col7d: "7d", colCap: "Market cap",
  colVolume: "Volume 24h", col7days: "7 days", nirRow: "test network · mined with intelligence",
  nirNoPrice: "No price yet — pioneers are mining now", nirMinedShort: "NIR mined", mine: "Mine",
  loading: "Loading prices…", pricesBy: "Prices:", chartsBy: "Charts:", updated: "Updated",
  noTrackers: "No sign-up, no trackers", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { chart: "График", close: "Скрыть", empty: "Ничего не найдено", watchEmpty: "Нажмите ☆ у монеты, чтобы добавить её в избранное.",
    unavailable: "Курсы временно недоступны. Попробуйте обновить страницу через минуту.",
    fear: { "Extreme Fear": "Сильный страх", Fear: "Страх", Neutral: "Нейтрально", Greed: "Жадность", "Extreme Greed": "Сильная жадность" },
    brief: (d) => `Рынок за сутки ${d.cap >= 0 ? "вырос" : "снизился"} на ${d.capPct}: капитализация ${d.capValue}. ` +
      `Bitcoin стоит ${d.btc} (${d.btcPct}), доминация — ${d.dom}. Сильнее всех растёт ${d.top} (${d.topPct}), ` +
      `сильнее всех падает ${d.low} (${d.lowPct}).${d.fg ? ` Индекс страха и жадности — ${d.fg}.` : ""}` },
  en: { chart: "Chart", close: "Hide", empty: "Nothing found", watchEmpty: "Tap ☆ next to a coin to add it to your watchlist.",
    unavailable: "Prices are unavailable right now. Try reloading in a minute.",
    fear: {},
    brief: (d) => `The market ${d.cap >= 0 ? "rose" : "fell"} ${d.capPct} in 24 hours to a ${d.capValue} market cap. ` +
      `Bitcoin trades at ${d.btc} (${d.btcPct}) with ${d.dom} dominance. The top gainer is ${d.top} (${d.topPct}), ` +
      `the biggest loser ${d.low} (${d.lowPct}).${d.fg ? ` Fear & Greed stands at ${d.fg}.` : ""}` },
};

const $ = (selector) => document.querySelector(selector);
const store = { get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} } };
let language = store.get("nir-site-language") === "en" ||
  (!store.get("nir-site-language") && !/^(ru|be|uk|kk)/i.test(navigator.language || "")) ? "en" : "ru";
let data = null;
let tab = "top";
let query = "";
let openChart = null;
let watch = new Set((store.get("nir-markets-watch") ?? "").split(",").filter(Boolean));

// --- Numbers in the visitor's language: $80 183,42 or $80,183.42; 1,59 трлн or 1.59T.
const locale = () => (language === "en" ? "en-US" : "ru-RU");
function price(value) {
  if (value === null || value === undefined) return "—";
  const digits = value >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumSignificantDigits: 4 };
  return `$${value.toLocaleString(locale(), digits)}`;
}
function big(value) {
  if (value === null || value === undefined) return "—";
  const units = language === "en" ? [[1e12, "T"], [1e9, "B"], [1e6, "M"]] : [[1e12, " трлн"], [1e9, " млрд"], [1e6, " млн"]];
  for (const [size, unit] of units) {
    if (Math.abs(value) >= size) return `$${(value / size).toLocaleString(locale(), { maximumFractionDigits: 2 })}${unit}`;
  }
  return `$${value.toLocaleString(locale())}`;
}
const percentText = (value) => (value === null || value === undefined ? "—"
  : `${value > 0 ? "▲" : value < 0 ? "▼" : ""} ${Math.abs(value).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`.trim());
const changeClass = (value) => (value > 0 ? "up" : value < 0 ? "down" : "flat");
function percentCell(value) {
  const cell = document.createElement("td");
  cell.className = changeClass(value);
  cell.textContent = percentText(value);
  return cell;
}

function logo(coin) {
  if (coin.image) {
    const image = document.createElement("img");
    image.className = "logo";
    image.src = coin.image;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    // A logo that fails to load becomes the coin's first letter.
    image.addEventListener("error", () => image.replaceWith(logo({ ...coin, image: null })), { once: true });
    return image;
  }
  const letter = document.createElement("i");
  letter.className = "logo";
  letter.textContent = coin.symbol.slice(0, 1);
  return letter;
}

function sparkline(points, rising) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 120 38");
  svg.setAttribute("preserveAspectRatio", "none");
  if (points.length > 1) {
    const low = Math.min(...points);
    const high = Math.max(...points);
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", points.map((value, index) =>
      `${(index / (points.length - 1) * 120).toFixed(1)},${(36 - (value - low) / ((high - low) || 1) * 34).toFixed(1)}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", rising ? "var(--up)" : "var(--down)");
    line.setAttribute("stroke-width", "1.8");
    svg.append(line);
  }
  return svg;
}

// --- The TradingView chart opens under a coin's row.
function chartRow(coin) {
  const row = document.createElement("tr");
  row.className = "chart";
  const cell = document.createElement("td");
  cell.colSpan = 11;
  const box = document.createElement("div");
  box.className = "chart-box tradingview-widget-container";
  const inner = document.createElement("div");
  inner.className = "tradingview-widget-container__widget";
  inner.style.height = "100%";
  const script = document.createElement("script");
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.async = true;
  script.textContent = JSON.stringify({ autosize: true, symbol: `BINANCE:${coin.symbol}USDT`, interval: "60",
    timezone: "Etc/UTC", theme: isLight() ? "light" : "dark", style: "1", locale: language,
    allow_symbol_change: true, hide_side_toolbar: true, support_host: "https://www.tradingview.com" });
  box.append(inner, script);
  cell.append(box);
  row.append(cell);
  return row;
}

function visibleCoins() {
  let coins = data?.coins ?? [];
  if (tab === "watch") coins = coins.filter((coin) => watch.has(coin.id));
  if (tab === "stable") coins = coins.filter((coin) => STABLE.has(coin.symbol));
  if (tab === "gainers" || tab === "losers") {
    coins = coins.filter((coin) => coin.change24h !== null && !STABLE.has(coin.symbol))
      .sort((a, b) => (tab === "gainers" ? b.change24h - a.change24h : a.change24h - b.change24h)).slice(0, 30);
  }
  if (query) {
    const needle = query.toLowerCase();
    coins = coins.filter((coin) => coin.name.toLowerCase().includes(needle) || coin.symbol.toLowerCase().includes(needle));
  }
  return coins;
}

function renderTable() {
  const body = $("#rows");
  const nirRow = body.querySelector("tr.nir");
  body.replaceChildren(nirRow);
  nirRow.hidden = Boolean(query) || tab !== "top";
  const t = words[language];
  const coins = visibleCoins();
  for (const coin of coins) {
    const row = document.createElement("tr");
    row.className = "coin";
    const star = document.createElement("td");
    star.className = `star${watch.has(coin.id) ? " on" : ""}`;
    star.textContent = watch.has(coin.id) ? "★" : "☆";
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      if (watch.has(coin.id)) watch.delete(coin.id); else watch.add(coin.id);
      store.set("nir-markets-watch", [...watch].join(","));
      renderTable();
    });
    const rank = document.createElement("td");
    rank.className = "rank";
    rank.textContent = coin.rank ?? "";
    const name = document.createElement("td");
    name.className = "left";
    const cell = document.createElement("div");
    cell.className = "coin-cell";
    const title = document.createElement("b");
    title.textContent = coin.name;
    const symbol = document.createElement("span");
    symbol.textContent = coin.symbol;
    cell.append(logo(coin), title, symbol);
    name.append(cell);
    const value = document.createElement("td");
    value.textContent = price(coin.price);
    const cap = document.createElement("td");
    cap.className = "hide-s";
    cap.textContent = big(coin.marketCap);
    const volume = document.createElement("td");
    volume.className = "hide-s";
    volume.textContent = big(coin.volume);
    const spark = document.createElement("td");
    spark.className = "hide-s";
    spark.append(sparkline(coin.sparkline, (coin.change7d ?? 0) >= 0));
    const action = document.createElement("td");
    const charted = !STABLE.has(coin.symbol);
    if (charted) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `act${openChart === coin.id ? "" : " ghost"}`;
      button.textContent = openChart === coin.id ? t.close : t.chart;
      action.append(button);
      row.addEventListener("click", () => { openChart = openChart === coin.id ? null : coin.id; renderTable(); });
    }
    row.append(star, rank, name, value, percentCell(coin.change1h), percentCell(coin.change24h),
      percentCell(coin.change7d), cap, volume, spark, action);
    body.append(row);
    if (openChart === coin.id && charted) body.append(chartRow(coin));
  }
  $("#status").textContent = !data ? $("#status").textContent
    : coins.length ? "" : tab === "watch" && !query ? t.watchEmpty : t.empty;
}

function renderCards() {
  const t = words[language];
  const g = data.global;
  $("#g-cap").textContent = big(g?.marketCap);
  const capChange = $("#g-cap-change");
  capChange.className = changeClass(g?.marketCapChange24h);
  capChange.textContent = percentText(g?.marketCapChange24h);
  $("#g-volume").textContent = big(g?.volume);
  $("#g-btc").textContent = g?.btcDominance === null || g?.btcDominance === undefined ? "—"
    : `${g.btcDominance.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`;
  $("#g-eth").textContent = g?.ethDominance ? `ETH ${g.ethDominance.toLocaleString(locale(), { maximumFractionDigits: 1 })}%` : "";
  const fg = data.fearGreed;
  $("#fg-value").textContent = fg ? String(fg.value) : "—";
  $("#fg-label").textContent = fg ? (t.fear[fg.label] ?? fg.label) : "";
  if (fg) {
    // The dot rides the arc from 0 (left) to 100 (right).
    const angle = Math.PI * (1 - fg.value / 100);
    $("#fg-dot").setAttribute("cx", (55 + 47 * Math.cos(angle)).toFixed(1));
    $("#fg-dot").setAttribute("cy", (56 - 47 * Math.sin(angle)).toFixed(1));
  }
  const list = (target, coins, withPrice) => {
    $(target).replaceChildren(...coins.slice(0, 4).map((coin, index) => {
      const item = document.createElement("li");
      const number = document.createElement("span");
      number.className = "n";
      number.textContent = String(index + 1);
      const name = document.createElement("b");
      name.textContent = coin.symbol;
      item.append(number, logo(coin), name);
      if (withPrice) {
        const value = document.createElement("span");
        value.textContent = price(coin.price);
        item.append(value);
      }
      const change = document.createElement("span");
      change.className = changeClass(coin.change24h);
      change.textContent = percentText(coin.change24h);
      item.append(change);
      return item;
    }));
  };
  list("#trending", data.trending ?? [], true);
  list("#gainers", (data.gainers ?? []).filter((coin) => !STABLE.has(coin.symbol)), false);
  const btc = data.coins.find((coin) => coin.symbol === "BTC");
  const top = data.gainers?.[0];
  const low = data.losers?.[0];
  $("#brief").textContent = g && btc && top && low ? t.brief({
    cap: g.marketCapChange24h ?? 0, capPct: `${Math.abs(g.marketCapChange24h ?? 0).toLocaleString(locale(), { maximumFractionDigits: 2 })}%`,
    capValue: big(g.marketCap), btc: price(btc.price), btcPct: percentText(btc.change24h).replace("▲ ", "+").replace("▼ ", "−"),
    dom: `${(g.btcDominance ?? 0).toLocaleString(locale(), { maximumFractionDigits: 1 })}%`,
    top: top.name, topPct: `+${top.change24h.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`,
    low: low.name, lowPct: `${low.change24h.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`,
    fg: fg ? `${fg.value} (${(t.fear[fg.label] ?? fg.label).toLowerCase()})` : "",
  }) : "";
  $("#updated").textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString(locale(),
    { hour: "2-digit", minute: "2-digit" }) : "—";
}

async function load() {
  try {
    const response = await fetch("/market/overview", { cache: "no-store" });
    if (!response.ok) throw new Error("market data unavailable");
    data = await response.json();
    renderCards();
    renderTable();
  } catch {
    if (!data) $("#status").textContent = words[language].unavailable;
  }
}

// NIR's own network: miners, pioneers and NIR mined, from the test network.
async function loadNir() {
  try {
    const stats = await fetch("/api/v1/stats", { cache: "no-store" }).then((response) => response.json());
    const count = (value) => (Number.isSafeInteger(value) ? value.toLocaleString(locale()) : "—");
    const mined = Number(/^([0-9]+)\./.exec(stats.minedNir ?? "")?.[1] ?? NaN);
    for (const node of document.querySelectorAll("[data-nir]")) {
      const key = node.dataset.nir;
      node.textContent = key === "mined" ? (Number.isFinite(mined) ? mined.toLocaleString(locale()) : "—") : count(stats[key]);
    }
  } catch { /* The page works without NIR's figures. */ }
}

// --- Language and theme, shared with the NIR page.
const textNodes = [...document.querySelectorAll("[data-i18n]")];
const ru = Object.fromEntries(textNodes.map((node) => [node.dataset.i18n, node.textContent]));
const search = $("#search");
const ruPlaceholder = search.placeholder;
function applyLanguage() {
  document.documentElement.lang = language;
  for (const node of textNodes) node.textContent = (language === "en" ? en : ru)[node.dataset.i18n] ?? node.textContent;
  search.placeholder = language === "en" ? en.search : ruPlaceholder;
  $("#lang").textContent = language === "en" ? "RU" : "EN";
  if (data) { renderCards(); renderTable(); }
  void loadNir();
}
$("#lang").addEventListener("click", () => {
  language = language === "en" ? "ru" : "en";
  store.set("nir-site-language", language);
  applyLanguage();
});
function isLight() {
  return document.documentElement.dataset.theme === "light" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: light)").matches);
}
function renderTheme() { $("#theme").textContent = isLight() ? "☾" : "☀︎"; }
$("#theme").addEventListener("click", () => {
  const next = isLight() ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  store.set("nir-site-theme", next);
  renderTheme();
  if (openChart) renderTable(); // the chart follows the theme
});

for (const button of document.querySelectorAll("[data-tab]")) {
  button.addEventListener("click", () => {
    tab = button.dataset.tab;
    for (const other of document.querySelectorAll(".tabs [data-tab]")) other.classList.toggle("on", other.dataset.tab === tab);
    renderTable();
  });
}
search.addEventListener("input", () => { query = search.value.trim(); renderTable(); });

renderTheme();
applyLanguage();
void load();
setInterval(load, 60_000);
setInterval(loadNir, 60_000);
