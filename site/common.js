// Shared by the NIR Markets pages (markets.js, coin.js): numbers in the
// visitor's language, coin logos, the watchlist, day and night themes,
// Russian and English, and NIR's own network figures.

const $ = (selector) => document.querySelector(selector);
const store = { get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} } };
let language = store.get("nir-site-language") === "en" ||
  (!store.get("nir-site-language") && !/^(ru|be|uk|kk)/i.test(navigator.language || "")) ? "en" : "ru";
const STABLE = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "USDS", "PYUSD", "USDD", "BUSD", "USD1"]);
const watch = new Set((store.get("nir-markets-watch") ?? "").split(",").filter(Boolean));
function toggleWatch(id) {
  if (watch.has(id)) watch.delete(id); else watch.add(id);
  store.set("nir-markets-watch", [...watch].join(","));
}
const coinUrl = (coin) => `/coin/${encodeURIComponent(coin.id)}`;

// --- Numbers in the visitor's language: $80 183,42 or $80,183.42; 1,59 трлн or 1.59T.
const locale = () => (language === "en" ? "en-US" : "ru-RU");
function price(value) {
  if (value === null || value === undefined) return "—";
  const digits = value >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumSignificantDigits: 4 };
  return `$${value.toLocaleString(locale(), digits)}`;
}
function big(value, prefix = "$", digits = 2) {
  if (value === null || value === undefined) return "—";
  const units = language === "en" ? [[1e12, "T"], [1e9, "B"], [1e6, "M"]] : [[1e12, " трлн"], [1e9, " млрд"], [1e6, " млн"]];
  for (const [size, unit] of units) {
    if (Math.abs(value) >= size) return `${prefix}${(value / size).toLocaleString(locale(), { maximumFractionDigits: digits })}${unit}`;
  }
  return `${prefix}${value.toLocaleString(locale())}`;
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

// --- The TradingView chart: the coin's main Binance pair.
function tradingView(symbol) {
  const box = document.createElement("div");
  box.className = "chart-box tradingview-widget-container";
  const inner = document.createElement("div");
  inner.className = "tradingview-widget-container__widget";
  inner.style.height = "100%";
  const script = document.createElement("script");
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.async = true;
  script.textContent = JSON.stringify({ autosize: true, symbol, interval: "60",
    timezone: "Etc/UTC", theme: isLight() ? "light" : "dark", style: "1", locale: language,
    allow_symbol_change: true, hide_side_toolbar: true, support_host: "https://www.tradingview.com" });
  box.append(inner, script);
  return box;
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

// --- Language and theme, shared with the NIR page. `render` redraws the
// page's own content; `onTheme` lets a page redraw what follows the theme.
function isLight() {
  return document.documentElement.dataset.theme === "light" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: light)").matches);
}
function setupPage({ en, render, onTheme = () => {} }) {
  const textNodes = [...document.querySelectorAll("[data-i18n]")];
  const ru = Object.fromEntries(textNodes.map((node) => [node.dataset.i18n, node.textContent]));
  const search = $("#search");
  const ruPlaceholder = search.placeholder;
  function applyLanguage() {
    document.documentElement.lang = language;
    for (const node of textNodes) node.textContent = (language === "en" ? en : ru)[node.dataset.i18n] ?? node.textContent;
    search.placeholder = language === "en" ? en.search : ruPlaceholder;
    $("#lang").textContent = language === "en" ? "RU" : "EN";
    render();
    void loadNir();
  }
  $("#lang").addEventListener("click", () => {
    language = language === "en" ? "ru" : "en";
    store.set("nir-site-language", language);
    applyLanguage();
  });
  const renderTheme = () => { $("#theme").textContent = isLight() ? "☾" : "☀︎"; };
  $("#theme").addEventListener("click", () => {
    const next = isLight() ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set("nir-site-theme", next);
    renderTheme();
    onTheme();
  });
  renderTheme();
  applyLanguage();
  setInterval(loadNir, 60_000);
}

// --- Search over every coin: recent searches and trending coins before typing,
// then the top 100 instantly and the rest from /market/search. Arrow keys move,
// Enter opens, Escape closes. `overview()` returns the page's market data, if any.
function setupSearch({ overview = () => null }) {
  const input = $("#search");
  const box = document.createElement("div");
  box.className = "suggest";
  box.hidden = true;
  box.setAttribute("role", "listbox");
  const wrap = document.createElement("div");
  wrap.className = "search-wrap";
  input.before(wrap);
  wrap.append(input, box);
  input.setAttribute("aria-autocomplete", "list");
  let market = null;
  let items = [];
  let active = -1;
  let timer = null;
  let asked = "";
  const recent = () => { try { return JSON.parse(store.get("nir-recent-searches") ?? "[]").slice(0, 5); } catch { return []; } };
  const remember = (coin) => store.set("nir-recent-searches", JSON.stringify([{ id: coin.id, symbol: coin.symbol,
    name: coin.name, image: coin.image ?? null, rank: coin.rank ?? null }, ...recent().filter((item) => item.id !== coin.id)].slice(0, 5)));
  const data = async () => {
    market = overview() ?? market;
    if (!market) market = await fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).catch(() => null);
    return market;
  };
  const open = (coin) => { remember(coin); location.href = coinUrl(coin); };
  function draw(groups) {
    items = groups.flatMap(([, coins]) => coins);
    active = -1;
    box.replaceChildren(...groups.filter(([, coins]) => coins.length).flatMap(([title, coins]) => [
      Object.assign(document.createElement("small"), { textContent: title }),
      ...coins.map((coin) => {
        const row = document.createElement("a");
        row.href = coinUrl(coin);
        row.setAttribute("role", "option");
        const name = Object.assign(document.createElement("b"), { textContent: coin.name });
        const symbol = Object.assign(document.createElement("span"), { textContent: coin.symbol });
        const rank = Object.assign(document.createElement("em"), { textContent: coin.rank ? `#${coin.rank}` : "" });
        row.append(logo(coin), name, symbol, rank);
        row.addEventListener("click", (event) => { event.preventDefault(); open(coin); });
        return row;
      }),
    ]));
    box.hidden = !items.length;
  }
  const t = () => (language === "en"
    ? { recent: "Recent searches", trending: "Trending", coins: "Coins", none: "Nothing found" }
    : { recent: "Недавние", trending: "В тренде", coins: "Монеты", none: "Ничего не найдено" });
  async function update() {
    const query = input.value.trim().toLowerCase();
    const market = await data();
    if (!query) {
      draw([[t().recent, recent()], [t().trending, (market?.trending ?? []).slice(0, 7)]]);
      return;
    }
    const local = (market?.coins ?? []).filter((coin) => coin.name.toLowerCase().includes(query) ||
      coin.symbol.toLowerCase().startsWith(query)).slice(0, 8);
    draw([[t().coins, local]]);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      asked = query;
      const found = await fetch(`/market/search?q=${encodeURIComponent(query)}`)
        .then((response) => (response.ok ? response.json() : { coins: [] })).catch(() => ({ coins: [] }));
      if (asked !== input.value.trim().toLowerCase()) return; // a newer query is on its way
      const seen = new Set(local.map((coin) => coin.id));
      const merged = [...local, ...found.coins.filter((coin) => !seen.has(coin.id))].slice(0, 10);
      draw([[t().coins, merged]]);
      if (!merged.length) {
        box.replaceChildren(Object.assign(document.createElement("p"), { textContent: t().none }));
        box.hidden = false;
      }
    }, 250);
  }
  function move(step) {
    const rows = [...box.querySelectorAll("a")];
    if (!rows.length) return;
    active = (active + step + rows.length) % rows.length;
    rows.forEach((row, index) => row.classList.toggle("on", index === active));
    rows[active].scrollIntoView({ block: "nearest" });
  }
  input.addEventListener("focus", () => { void update(); });
  input.addEventListener("input", () => { void update(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "Escape") { box.hidden = true; input.blur(); }
    else if (event.key === "Enter" && items.length && (active >= 0 || input.value.trim())) {
      event.preventDefault();
      open(items[Math.max(active, 0)]);
    }
  });
  document.addEventListener("click", (event) => { if (event.target !== input && !box.contains(event.target)) box.hidden = true; });
}
