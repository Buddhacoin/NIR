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
// Signed in, the watchlist lives on the server (and follows the visitor to any
// device); signed out, it stays in this browser.
let account = { signIn: false, user: null };
let accountChanged = () => {};
const saveWatch = () => store.set("nir-markets-watch", [...watch].join(","));
function toggleWatch(id) {
  const adding = !watch.has(id);
  if (adding) watch.add(id); else watch.delete(id);
  saveWatch();
  if (account.user) void send(`/market/me/watchlist/${encodeURIComponent(id)}`, adding ? "PUT" : "DELETE");
}
async function send(path, method, body) {
  const response = await fetch(path, { method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  return response ? { status: response.status, data: await response.json().catch(() => ({})) } : { status: 0, data: {} };
}
const signInUrl = () => `/market/auth/google?return=${encodeURIComponent(location.pathname + location.search)}`;
async function loadAccount() {
  const response = await fetch("/market/me", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  account = await response.json();
  if (account.user) {
    // Stars set before signing in join the account once, then the server's list is the watchlist.
    const server = new Set(account.watchlist);
    const missing = [...watch].filter((id) => !server.has(id));
    const merged = missing.length ? (await send("/market/me/watchlist", "POST", { ids: missing })).data.watchlist : null;
    watch.clear();
    for (const id of merged ?? account.watchlist) watch.add(id);
    saveWatch();
  }
  renderAccount();
  accountChanged();
}
// A coloured circle with the first letter: no photos, nothing from the Google account.
function avatar(user, size = 30) {
  const circle = document.createElement("span");
  circle.className = "avatar";
  const hue = [...user.username].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  circle.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;background:hsl(${hue} 70% 45%)`;
  circle.textContent = [...(user.displayName || user.username)][0].toUpperCase();
  return circle;
}
function renderAccount() {
  const words = language === "en" ? { signIn: "Sign in", profile: "Profile", about: "About NIR" }
    : { signIn: "Войти", profile: "Профиль", about: "О NIR" };
  const button = $("#account");
  const tab = $("#tab-account");
  if (button) {
    button.hidden = !account.signIn && !account.user;
    button.href = account.user ? `/u/${account.user.username}` : signInUrl();
    button.replaceChildren(...(account.user ? [avatar(account.user, 26)] : [words.signIn]));
    button.classList.toggle("signed", Boolean(account.user));
    button.title = account.user ? `@${account.user.username}` : words.signIn;
  }
  renderBell();
  if (tab && (account.signIn || account.user)) {
    tab.href = account.user ? `/u/${account.user.username}` : signInUrl();
    tab.querySelector("span").textContent = account.user ? words.profile : words.signIn;
    tab.querySelector("svg").innerHTML = '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>';
  }
  if (new URLSearchParams(location.search).get("signin") === "failed" && !document.querySelector(".toast")) {
    const toast = Object.assign(document.createElement("div"), { className: "toast",
      textContent: language === "en" ? "Sign-in did not work. Please try again." : "Войти не получилось. Попробуйте ещё раз." });
    document.body.append(toast);
    setTimeout(() => toast.remove(), 6000);
  }
}
// The bell next to the profile: price alerts that fired and were not opened yet (/alerts/).
function renderBell() {
  let bell = $("#bell");
  if (!account.user) { bell?.remove(); return; }
  if (!bell) {
    bell = Object.assign(document.createElement("a"), { id: "bell", className: "pill bell", href: "/alerts/" });
    bell.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><b></b>';
    $("#account")?.before(bell);
  }
  const count = account.alertsUnseen ?? 0;
  bell.title = language === "en" ? "Price alerts" : "Уведомления о цене";
  bell.querySelector("b").textContent = count > 9 ? "9+" : String(count);
  bell.querySelector("b").hidden = !count;
}
// Signed in, the bell is refreshed every minute; a new firing also shows a note on the page.
async function pollAlerts() {
  if (!account.user || document.hidden) return;
  const me = await fetch("/market/me", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (!me?.user) return;
  const before = account.alertsUnseen ?? 0;
  account.alertsUnseen = me.alertsUnseen ?? 0;
  renderBell();
  if (account.alertsUnseen > before && location.pathname !== "/alerts/") {
    const toast = Object.assign(document.createElement("a"), { className: "toast good", href: "/alerts/",
      textContent: language === "en" ? "🔔 A price alert fired — open" : "🔔 Сработало уведомление о цене — открыть" });
    document.body.append(toast);
    setTimeout(() => toast.remove(), 8000);
  }
}
setInterval(pollAlerts, 60_000);
// --- Sortable table headers, as on the market sites: a click sorts by the column (largest
// first, names A to Z), a second click reverses it, a third goes back to the usual order.
function sortable(head, sort, onChange) {
  for (const th of head.querySelectorAll("th[data-sort]")) {
    th.classList.add("th-sort");
    th.addEventListener("click", () => {
      const first = th.dataset.sort === "name" || th.dataset.sort === "rank" ? 1 : -1;
      if (sort.key !== th.dataset.sort) Object.assign(sort, { key: th.dataset.sort, dir: first });
      else if (sort.dir === first) sort.dir = -first;
      else Object.assign(sort, { key: null, dir: 0 });
      onChange();
    });
  }
}
function markSort(head, sort) {
  for (const th of head.querySelectorAll("th[data-sort]")) {
    th.classList.toggle("asc", th.dataset.sort === sort.key && sort.dir > 0);
    th.classList.toggle("desc", th.dataset.sort === sort.key && sort.dir < 0);
  }
}
// The list in the chosen order; empty values always go last.
function sortBy(list, sort, value) {
  if (!sort.key) return list;
  return [...list].sort((left, right) => {
    const a = value(left, sort.key);
    const b = value(right, sort.key);
    const missing = (item) => item === null || item === undefined || Number.isNaN(item);
    if (missing(a) || missing(b)) return missing(a) - missing(b);
    return sort.dir * (typeof a === "string" ? a.localeCompare(b) : a - b);
  });
}
// --- Wallets and transfers (the explorer, /market/chain): networks, short addresses, links.
// `history`: the explorer keeps the coin's balance by day; `node`: read from a public node (token transfers of about the last day).
const CHAINS = {
  eth: { name: "Ethereum", short: "ETH", color: "#627eea", tx: "https://eth.blockscout.com/tx/", history: true },
  optimism: { name: "Optimism", short: "OP", color: "#ff0420", tx: "https://explorer.optimism.io/tx/", history: true },
  base: { name: "Base", short: "BASE", color: "#0052ff", tx: "https://basescan.org/tx/", node: true },
  arbitrum: { name: "Arbitrum", short: "ARB", color: "#28a0f0", tx: "https://arbiscan.io/tx/", node: true },
  polygon: { name: "Polygon", short: "POL", color: "#8247e5", tx: "https://polygonscan.com/tx/", node: true },
  bsc: { name: "BNB Chain", short: "BNB", color: "#f0b90b", tx: "https://bscscan.com/tx/", node: true },
  btc: { name: "Bitcoin", short: "BTC", color: "#f7931a", tx: "https://mempool.space/tx/" },
};
const ADDRESS = /^(?:0x[0-9a-fA-F]{40}|bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
const addressUrl = (address) => `/address/${encodeURIComponent(address)}`;
const shortAddress = (address) => (address && address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address ?? "—");
// A coloured dot with the network's initial, titled with its name.
function chainDot(chain) {
  const info = CHAINS[chain] ?? { name: chain, short: chain, color: "#888" };
  const dot = Object.assign(document.createElement("span"), { className: "chain-dot", title: info.name, textContent: info.short[0] });
  dot.style.background = info.color;
  return dot;
}
// A link to a wallet's page: its open name if it has one, else the short address.
function walletLink(party) {
  if (!party?.address) return Object.assign(document.createElement("span"), { className: "muted", textContent: "—" });
  const link = Object.assign(document.createElement("a"), { className: "wallet", href: addressUrl(party.address), title: party.address });
  if (party.name) link.append(Object.assign(document.createElement("b"), { textContent: party.name }), " ");
  link.append(Object.assign(document.createElement("span"), { className: party.name ? "muted" : "", textContent: party.name ? `(${party.address.slice(0, 5)})` : shortAddress(party.address) }));
  return link;
}
function timeAgo(time) {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  const en = language === "en";
  if (seconds < 60) return en ? "now" : "сейчас";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${en ? "m" : " мин"}`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}${en ? "h" : " ч"}`;
  return new Date(time).toLocaleDateString(locale(), { day: "numeric", month: "short" });
}
// Amounts and dollar sums in a few characters: 1,25 млн · 38 055 · 4,6759 · 0,00048717.
const amountShort = (value) => (value >= 1e6 ? big(value, "") : value.toLocaleString(locale(), value >= 1000 ? { maximumFractionDigits: 0 }
  : value >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 5 }));
const usdShort = (value) => (value === null || value === undefined ? "—" : value >= 1e6 ? big(value) : value >= 1000 ? `$${Math.round(value).toLocaleString(locale())}` : price(value));
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
// `full` is the coin page's chart: drawing tools on the left, daily candles, volume.
function tradingView(symbol, full = false) {
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
    allow_symbol_change: !full, hide_side_toolbar: !full, withdateranges: full, details: false,
    ...(full ? { interval: "D", hide_volume: false } : {}), support_host: "https://www.tradingview.com" });
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

// The market strip on top of every page: coins, exchanges, market cap, volume,
// dominance and fear & greed, from the server's cached overview.
let strip = null;
function renderStrip() {
  if (!strip) return;
  const g = strip.global ?? {};
  const set = (key, value) => { for (const node of document.querySelectorAll(`[data-stat="${key}"]`)) node.textContent = value; };
  const whole = (value) => (Number.isFinite(value) ? value.toLocaleString(locale()) : "—");
  set("coins", whole(g.coins));
  set("exchanges", whole(g.exchanges));
  set("cap", big(g.marketCap, "$", 2));
  set("volume", big(g.volume, "$", 2));
  set("dominance", g.btcDominance ? `BTC ${g.btcDominance.toLocaleString(locale(), { maximumFractionDigits: 1 })}%` +
    (g.ethDominance ? ` ETH ${g.ethDominance.toLocaleString(locale(), { maximumFractionDigits: 1 })}%` : "") : "—");
  set("fear", strip.fearGreed ? `${strip.fearGreed.value}/100` : "—");
  for (const node of document.querySelectorAll('[data-stat="capChange"]')) {
    node.className = changeClass(g.marketCapChange24h);
    node.textContent = percentText(g.marketCapChange24h);
  }
}
async function loadStrip() {
  const response = await fetch("/market/overview").catch(() => null);
  if (!response?.ok) return;
  strip = await response.json();
  renderStrip();
}

// --- Language and theme, shared with the NIR page. `render` redraws the
// page's own content; `onTheme` lets a page redraw what follows the theme.
function isLight() {
  return document.documentElement.dataset.theme === "light" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: light)").matches);
}
function setupPage({ en, render, onTheme = () => {}, onAccount = render }) {
  accountChanged = onAccount;
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
    renderAccount();
    renderStrip();
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
  void loadAccount();
  void loadStrip();
  setInterval(loadNir, 60_000);
  setInterval(loadStrip, 60_000);
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
  const open = (item) => {
    if (item.address) { location.href = addressUrl(item.address); return; }
    remember(item);
    location.href = coinUrl(item);
  };
  function draw(groups) {
    items = groups.flatMap(([, coins]) => coins);
    active = -1;
    box.replaceChildren(...groups.filter(([, coins]) => coins.length).flatMap(([title, coins]) => [
      Object.assign(document.createElement("small"), { textContent: title }),
      ...coins.map((coin) => {
        const row = document.createElement("a");
        row.setAttribute("role", "option");
        if (coin.address) {
          // A wallet: its name (if any) and the short address.
          row.href = addressUrl(coin.address);
          const icon = Object.assign(document.createElement("span"), { className: "wallet-icon", textContent: "◎" });
          row.append(icon, Object.assign(document.createElement("b"), { textContent: coin.name ?? shortAddress(coin.address) }),
            Object.assign(document.createElement("span"), { textContent: coin.name ? shortAddress(coin.address) : t().wallet }));
          row.addEventListener("click", (event) => { event.preventDefault(); open(coin); });
          return row;
        }
        row.href = coinUrl(coin);
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
    ? { recent: "Recent searches", trending: "Trending", coins: "Coins", none: "Nothing found", wallets: "Addresses", wallet: "address" }
    : { recent: "Недавние", trending: "В тренде", coins: "Монеты", none: "Ничего не найдено", wallets: "Адреса", wallet: "адрес" });
  async function update() {
    const raw = input.value.trim();
    const query = raw.toLowerCase();
    // A wallet address opens its page; a name like zeus.eth is looked up below.
    if (ADDRESS.test(raw)) { draw([[t().wallets, [{ address: raw, name: null }]]]); return; }
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
      const [found, wallets] = await Promise.all([
        fetch(`/market/search?q=${encodeURIComponent(query)}`).then((response) => (response.ok ? response.json() : { coins: [] })).catch(() => ({ coins: [] })),
        query.includes(".") ? fetch(`/market/chain/search?q=${encodeURIComponent(query)}`).then((response) => (response.ok ? response.json() : { results: [] }))
          .catch(() => ({ results: [] })) : { results: [] },
      ]);
      if (asked !== input.value.trim().toLowerCase()) return; // a newer query is on its way
      const seen = new Set(local.map((coin) => coin.id));
      const merged = [...local, ...found.coins.filter((coin) => !seen.has(coin.id))].slice(0, 10);
      draw([[t().wallets, wallets.results ?? []], [t().coins, merged]]);
      if (!merged.length && !wallets.results?.length) {
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
