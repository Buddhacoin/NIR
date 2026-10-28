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
// The account as last seen in this browser draws the menus at once (signed in, the full bottom bar); the
// server's answer follows. Nothing private beyond the name is kept.
let account = (() => { try { return JSON.parse(store.get("nir-account") ?? "null") ?? { signIn: false, user: null }; } catch { return { signIn: false, user: null }; } })();
let accountChanged = () => {};

// --- Pages open at once, as in an app: the last answers of the data a page starts from (the market, the
// visitor's portfolio, wallets and profile) are kept in this browser for a minute or two and given to the
// page straight away, while a fresh copy is fetched behind them for the next look. Anything the visitor
// changes (a POST, PUT, PATCH or DELETE of their own) drops their kept copies, so they never see an old one.
const FAST = [[/^\/market\/overview$/, 120_000], [/^\/market\/stats$/, 300_000], [/^\/market\/sentiment$/, 300_000],
  [/^\/market\/me\/(portfolio|addresses)$/, 90_000], [/^\/market\/u\/[^/]+$/, 90_000], [/^\/market\/chart\/[^/]+$/, 300_000],
  // A wallet's holdings: a profile's own wallets and the wallet lists open with the last answer, refreshed behind.
  [/^\/market\/chain\/address\/[^/]+$/, 300_000]];
(() => {
  const native = window.fetch.bind(window);
  const keyOf = (url) => `nir-fast:${url.pathname}${url.search}`;
  const forgetOwn = () => {
    try { for (const key of Object.keys(localStorage)) if (/^nir-fast:\/market\/(me|u)\//.test(key)) localStorage.removeItem(key); } catch {}
  };
  window.fetch = (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === "string" ? input : input.url, location.origin); } catch { return native(input, init); }
    if (url.origin !== location.origin) return native(input, init);
    const method = String(init.method ?? (typeof input === "string" ? "GET" : input.method) ?? "GET").toUpperCase();
    if (method !== "GET") {
      if (/^\/market\/(me|auth|labels|comments)/.test(url.pathname)) forgetOwn();
      if (/^\/market\/auth/.test(url.pathname)) store.set("nir-account", "null");
      return native(input, init);
    }
    const rule = FAST.find(([pattern]) => pattern.test(url.pathname));
    if (!rule) return native(input, init);
    const live = native(input, init).then(async (response) => {
      if (response.ok) {
        // A partial answer (a big wallet's tokens still being counted) is not kept: the next ask gets the whole one.
        try { const text = await response.clone().text(); if (text.length < 600_000 && !text.includes('"partial":true')) localStorage.setItem(keyOf(url), JSON.stringify({ at: Date.now(), text })); } catch {}
      }
      return response;
    });
    let kept = null;
    try { kept = JSON.parse(localStorage.getItem(keyOf(url)) ?? "null"); } catch {}
    if (kept && Date.now() - kept.at < rule[1]) {
      live.catch(() => {});
      return Promise.resolve(new Response(kept.text, { status: 200, headers: { "content-type": "application/json" } }));
    }
    return live;
  };
})();
// The last answer of a kept address (FAST above), read at once: a page draws its first frame from it, before
// anything is fetched, so it never shows empty and then fills (the blink on moving between pages).
function keptJson(path, maxAge = 10 * 60_000) {
  try {
    const kept = JSON.parse(localStorage.getItem(`nir-fast:${path}`) ?? "null");
    return kept && Date.now() - kept.at < maxAge ? JSON.parse(kept.text) : null;
  } catch { return null; }
}
const saveWatch = () => store.set("nir-markets-watch", [...watch].join(","));
// The watchlist belongs to an account: signed out, a star leads to signing in.
function toggleWatch(id) {
  if (!account.user) {
    if (account.signIn) location.href = signInUrl();
    else alert(language === "en" ? "The watchlist needs an account; sign-in is off on this site." : "Избранное доступно после входа, а вход на сайте сейчас выключен.");
    return false;
  }
  const adding = !watch.has(id);
  if (adding) watch.add(id); else watch.delete(id);
  saveWatch();
  void send(`/market/me/watchlist/${encodeURIComponent(id)}`, adding ? "PUT" : "DELETE");
  return true;
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
  // Kept for the next page's first draw: whether sign-in is on, and the visitor's public name and picture.
  store.set("nir-account", JSON.stringify({ signIn: Boolean(account.signIn),
    user: account.user ? { username: account.user.username, name: account.user.name ?? null, avatar: account.user.avatar ?? null } : null }));
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
  // The picture the user chose, over their letter (which shows if it fails to load).
  if (user.avatar) {
    const picture = Object.assign(document.createElement("img"), { src: user.avatar, alt: "", loading: "lazy" });
    picture.addEventListener("error", () => picture.remove(), { once: true });
    circle.append(picture);
  }
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
  // Watchlist and portfolio links: for signed-in visitors only.
  for (const link of document.querySelectorAll("[data-member]")) link.hidden = !account.user;
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
      // Words and ranks start A→Z / 1→N; figures start with the largest.
      const first = ["name", "rank", "symbol"].includes(th.dataset.sort) ? 1 : -1;
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
const LOGOS = "https://coin-images.coingecko.com/coins/images/";
const CHAINS = {
  eth: { name: "Ethereum", short: "ETH", color: "#2f3034", tx: "https://eth.blockscout.com/tx/", history: true },
  optimism: { name: "Optimism", short: "OP", color: "#ff0420", tx: "https://explorer.optimism.io/tx/", history: true, logo: `${LOGOS}25244/small/Token.png` },
  base: { name: "Base", short: "BASE", color: "#0052ff", tx: "https://basescan.org/tx/", node: true },
  arbitrum: { name: "Arbitrum", short: "ARB", color: "#28a0f0", tx: "https://arbiscan.io/tx/", node: true, logo: `${LOGOS}16547/small/arb.jpg` },
  polygon: { name: "Polygon", short: "POL", color: "#8247e5", tx: "https://polygonscan.com/tx/", node: true, logo: `${LOGOS}32440/small/pol.png` },
  bsc: { name: "BNB Chain", short: "BNB", color: "#f0b90b", tx: "https://bscscan.com/tx/", node: true, logo: `${LOGOS}825/small/bnb-icon2_2x.png` },
  btc: { name: "Bitcoin", short: "BTC", color: "#f7931a", tx: "https://mempool.space/tx/", logo: `${LOGOS}1/small/bitcoin.png` },
};
// A known wallet goes by its id ("w:vitalik-buterin", market-masks.mjs): its address stays on the server and its
// page is /w/<id>; only the first half of its address is shown.
const MASKED_ID = /^w:[a-z0-9-]{2,40}$/;
const ADDRESS = /^(?:0x[0-9a-fA-F]{40}|bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|w:[a-z0-9-]{2,40})$/;
const addressUrl = (address) => (MASKED_ID.test(address ?? "") ? `/w/${address.slice(2)}` : `/address/${encodeURIComponent(address)}`);
const shortAddress = (address, short) => (MASKED_ID.test(address ?? "") ? short ?? WHALE.get(address)?.short ?? "…"
  : address && address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address ?? "—");
// The network's logo (Base's blue square is drawn here), titled with its name; its initial if the logo fails.
function chainDot(chain) {
  const info = CHAINS[chain] ?? { name: chain, short: chain, color: "#888" };
  const dot = Object.assign(document.createElement("span"), { className: "chain-dot", title: info.name });
  dot.style.background = info.color;
  if (info.logo) {
    const image = Object.assign(document.createElement("img"), { src: info.logo, alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
    image.addEventListener("error", () => { image.remove(); dot.textContent = info.short[0]; }, { once: true });
    dot.append(image);
  } else if (chain === "eth") {
    dot.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#c4c4c4" d="M9 2.2 4.8 9.2 9 11.7l4.2-2.5z"/><path fill="#8a8a8a" d="M9 2.2v9.5l4.2-2.5z"/><path fill="#c4c4c4" d="M4.8 10 9 15.8V12.5z"/><path fill="#8a8a8a" d="M9 12.5v3.3l4.2-5.8z"/></svg>';
  } else if (chain === "base") {
    dot.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="4.5" y="4.5" width="9" height="9" rx="1.5" fill="#fff"/></svg>';
  } else {
    dot.textContent = info.short[0];
  }
  return dot;
}
// Well-known public wallets ("whales"), offered in the search and on /wallets/. Names and pictures
// of wallets come by themselves from the open labels (/market/chain/names, market-names.mjs): the
// owner's name, logo or site icon. Networks without open labels (the UTXO one) give the owner's site.
const FAVICON = "https://www.google.com/s2/favicons?sz=64&domain=";
const ENS_AVATAR = "https://metadata.ens.domains/mainnet/avatar/";
// Each is the entity's own published or widely reported address, kept on the server (data/featured-wallets.json).
const WHALES = [
  { address: "w:binance", short: "0xF977814e90dA44bFA03…", name: "Binance", site: "binance.com", kind: { ru: "Биржа", en: "Exchange" } },
  { address: "w:binance-btc", short: "34xp4vRoCGJym3xR7…", name: "Binance: BTC", site: "binance.com", kind: { ru: "Биржа", en: "Exchange" } },
  { address: "w:u-s-government", short: "bc1qa5wkgaew2dkv56kfv…", name: "U.S. Government", site: "justice.gov", kind: { ru: "Государство", en: "Government" } },
  { address: "w:satoshi-nakamoto", short: "1A1zP1eP5QGefi2DM…", name: "Satoshi Nakamoto", site: "bitcoin.org", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:vitalik-buterin", short: "0xd8dA6BF26964aF9D7eE…", name: "Vitalik Buterin", ens: "vitalik.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:ethereum-foundation", short: "0xde0B295669a9FD93d5F…", name: "Ethereum Foundation", site: "ethereum.org", kind: { ru: "Фонд", en: "Foundation" } },
  { address: "w:jump-trading", short: "0xf584f8728b874a6a5c7…", name: "Jump Trading", site: "jumptrading.com", kind: { ru: "Маркет-мейкер", en: "Market maker" } },
  { address: "w:wintermute", short: "0xDBF5E9c5206d0dB70a9…", name: "Wintermute", site: "wintermute.com", kind: { ru: "Маркет-мейкер", en: "Market maker" } },
  { address: "w:coinbase", short: "0x71660c4005BA85c37cc…", name: "Coinbase", site: "coinbase.com", kind: { ru: "Биржа", en: "Exchange" } },
  { address: "w:binance-14", short: "0x28C6c06298d514Db089…", name: "Binance 14", site: "binance.com", kind: { ru: "Биржа", en: "Exchange" } },
  { address: "w:kraken", short: "0x267be1c1d684f78cb4f…", name: "Kraken", site: "kraken.com", kind: { ru: "Биржа", en: "Exchange" } },
  { address: "w:okx", short: "0x6cC5F688a315f3dC28A…", name: "OKX", site: "okx.com", kind: { ru: "Биржа", en: "Exchange" } },
  // Well-known people by the name-service name they set on their own wallet (each resolves to this address).
  { address: "w:james-wynn", short: "0x8589cd7a7B9E0C3eA35…", name: "James Wynn", ens: "jwynn.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:machi-big-brother", short: "0x020cA66C30beC2c4Fe3…", name: "Machi Big Brother", ens: "machibigbrother.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:anthony-sassano", short: "0x648aA14e4424e0825A5…", name: "Anthony Sassano", ens: "sassal.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:punk6529", short: "0xfD22004806A6846EA67…", name: "punk6529", ens: "punk6529.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:pranksy", short: "0xD387A6E4e84a6C86bd9…", name: "Pranksy", ens: "pranksy.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:gary-vaynerchuk", short: "0x0109731B26B26b33De2…", name: "Gary Vaynerchuk", ens: "garyvee.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:nick-johnson", short: "0xb8c2C29ee19D8307cb7…", name: "Nick Johnson", ens: "nick.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:stani-kulechov", short: "0x2E21f5d32841cf8C7da…", name: "Stani Kulechov", ens: "stani.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:hayden-adams", short: "0x50EC05ADe8280758E20…", name: "Hayden Adams", ens: "hayden.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:kain-warwick", short: "0x42f9134E9d3Bf7eEE1f…", name: "Kain Warwick", ens: "kain.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:dan-romero", short: "0xD64aA5F70F228dC486b…", name: "Dan Romero", ens: "dwr.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:balaji-srinivasan", short: "0x0916C04994849c676ab…", name: "Balaji Srinivasan", ens: "balajis.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:jesse-pollak", short: "0x849151d7D0bF1F34b70…", name: "Jesse Pollak", ens: "jessepollak.eth", kind: { ru: "Персона", en: "Individual" } },
  { address: "w:brantly-millegan", short: "0x983110309620D911731…", name: "Brantly Millegan", ens: "brantly.eth", kind: { ru: "Персона", en: "Individual" } },
];
const WHALE = new Map(WHALES.map((item) => [item.address.toLowerCase(), item]));
const knownName = (address) => WHALE.get(String(address ?? "").toLowerCase())?.name ?? null;
// An organisation's name from a wallet's label: "Binance 14" or "Binance: Hot Wallet" → "Binance".
const entityName = (name) => String(name ?? "").split(/[:(]/)[0].replace(/\s+\d+$/, "").trim();
const entityUrl = (name) => `/entity/?name=${encodeURIComponent(name)}`;
// Open labels fetched by the page: lower-case address → { name, logo, site, entity }.
const openNames = new Map();
async function loadOpenNames(addresses) {
  const wanted = [...new Set(addresses.filter((address) => /^0x[0-9a-fA-F]{40}$/.test(address ?? "") && !openNames.has(address.toLowerCase())))].slice(0, 50);
  if (!wanted.length) return;
  for (const address of wanted) openNames.set(address.toLowerCase(), null);
  const answer = await fetch(`/market/chain/names?addresses=${wanted.join(",")}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  for (const [address, value] of Object.entries(answer?.names ?? {})) openNames.set(address, value);
}
// A wallet's picture: the logo its label gives, the owner's site icon, or its name-service avatar.
// Pictures of our own for a few names. Satoshi: the bust in Budapest, photo by Fekist, CC BY-SA 4.0
// (commons.wikimedia.org/wiki/File:Bust_of_Satoshi_Nakamoto_in_Budapest.jpg), cropped.
const NAME_PICTURES = { "Satoshi Nakamoto": "/satoshi.jpg" };
function walletPicture(party) {
  const lower = party.address.toLowerCase();
  const whale = WHALE.get(lower);
  if (NAME_PICTURES[party.name ?? whale?.name]) return NAME_PICTURES[party.name ?? whale?.name];
  if (party.logo) return party.logo;
  // An organisation followed as one wallet: the site of one of its well-known wallets.
  if (/^entity:/.test(party.address)) {
    const known = WHALES.find((item) => item.site && entityName(item.name) === party.address.slice(7));
    return known ? `${FAVICON}${known.site}` : null;
  }
  if (openNames.get(lower)?.logo) return openNames.get(lower).logo;
  if (whale?.site) return `${FAVICON}${whale.site}`;
  const ens = whale?.ens ?? (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(party.name ?? "") ? party.name : null);
  return ens ? `${ENS_AVATAR}${encodeURIComponent(ens)}` : null;
}

// A wallet's face: its name-service picture when it has one, else a colour of its own with a letter.
function walletAvatar(party, className = "w-avatar") {
  const face = document.createElement("span");
  face.className = className;
  const hue = [...party.address.toLowerCase()].reduce((sum, char) => sum + char.charCodeAt(0) * 13, 0) % 360;
  face.style.background = `linear-gradient(135deg,hsl(${hue} 70% 55%),hsl(${(hue + 70) % 360} 70% 40%))`;
  face.textContent = (party.name?.replace(/[^\p{L}\p{N}]/gu, "")[0] ?? "").toUpperCase();
  const source = walletPicture(party);
  if (source) {
    const picture = Object.assign(document.createElement("img"), { src: source, alt: "", loading: "lazy" });
    picture.addEventListener("error", () => picture.remove());
    face.append(picture);
  }
  return face;
}
// A small round button to a wallet's bubbles (/visualizer/): who it exchanged coins with.
const BUBBLES_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="7" r="2.2"/><circle cx="18" cy="18.5" r="2.2"/><circle cx="5.5" cy="18" r="2.2"/><path d="m6.8 7.3 2.6 2.6m4.9-.8 3-1.4m-3.6 6.6 2.9 2.7M9.6 14l-2.4 2.6"/></svg>';
const bubblesUrl = (address) => `/visualizer/?address=${encodeURIComponent(address)}`;
function bubblesLink(address, withText = false) {
  const link = Object.assign(document.createElement("a"), { className: withText ? "pill viz-link wide" : "viz-link", href: bubblesUrl(address),
    title: language === "en" ? "Bubbles: this wallet's links" : "Пузыри: связи кошелька" });
  link.innerHTML = BUBBLES_ICON;
  if (withText) link.append(language === "en" ? "Bubbles" : "Пузыри");
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}
// A link to a wallet's page: its open name if it has one, else the short address, and the round
// button to its bubbles beside it (`bubbles: false` leaves it out where room is short).
// What kind of owner a wallet has (the book's categories, market-names.mjs).
const CATEGORY_NAMES = {
  exchange: ["Биржа", "Exchange"], fund: ["Фонд", "Fund"], "market-maker": ["Маркетмейкер", "Market maker"], bridge: ["Мост", "Bridge"],
  defi: ["DeFi", "DeFi"], government: ["Государство", "Government"], miner: ["Майнер", "Miner"], custodian: ["Кастодиан", "Custodian"],
  company: ["Компания", "Company"], individual: ["Персона", "Individual"], whale: ["Кит", "Whale"],
};
const categoryName = (category) => CATEGORY_NAMES[category]?.[language === "en" ? 1 : 0] ?? null;
const ENTITY_KEY = /^entity:/;
function walletLink(party, { bubbles = true } = {}) {
  if (!party?.address) return Object.assign(document.createElement("span"), { className: "muted", textContent: "—" });
  // An organisation followed as one wallet ("entity:Binance"): its name, linking to its page; no address.
  if (ENTITY_KEY.test(party.address)) {
    const name = party.name || party.address.replace(ENTITY_KEY, "");
    const link = Object.assign(document.createElement("a"), { className: "wallet", href: entityUrl(party.address.replace(ENTITY_KEY, "")), title: name });
    link.append(walletAvatar({ ...party, name }), Object.assign(document.createElement("b"), { textContent: name }));
    return link;
  }
  if (!party.name && knownName(party.address)) party = { ...party, name: knownName(party.address) };
  const link = Object.assign(document.createElement("a"), { className: "wallet", href: addressUrl(party.address), title: party.address });
  // A picture only for a wallet with a name; a bare address gets a copy button instead.
  if (party.name || party.logo) link.append(walletAvatar(party));
  if (party.name) link.append(Object.assign(document.createElement("b"), { textContent: party.name }), " ");
  const masked = MASKED_ID.test(party.address);
  const shown = party.short ?? WHALE.get(party.address)?.short ?? (masked ? "" : party.address);
  if (masked) link.title = party.name ?? shown;
  if (shown) link.append(Object.assign(document.createElement("span"), { className: party.name ? "muted" : "", textContent: party.name ? `(${shown.slice(0, 5)})` : masked ? shown : shortAddress(shown) }));
  const all = document.createDocumentFragment();
  all.append(link);
  if (!party.name && !masked) all.append(copyButton(party.address));
  if (bubbles && ADDRESS.test(party.address)) all.append(bubblesLink(party.address));
  return all;
}
// A one-click copy of an address, with a tick for a moment after.
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/></svg>';
function copyButton(text) {
  const button = Object.assign(document.createElement("button"), { type: "button", className: "copy-link", title: language === "en" ? "Copy address" : "Скопировать адрес" });
  button.innerHTML = COPY_ICON;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard?.writeText(text).then(() => {
      button.classList.add("done");
      setTimeout(() => button.classList.remove("done"), 1_200);
    }).catch(() => {});
  });
  return button;
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
  // Under $10 four decimals, so a stablecoin at 1.0049 does not read as $1.00.
  const digits = value >= 10 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : value >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 4 }
    : { maximumSignificantDigits: 4 };
  return `$${value.toLocaleString(locale(), digits)}`;
}
function big(value, prefix = "$", digits = 2) {
  if (value === null || value === undefined) return "—";
  const units = language === "en" ? [[1e12, "T"], [1e9, "B"], [1e6, "M"]] : [[1e12, " трлн"], [1e9, " млрд"], [1e6, " млн"]];
  for (const [size, unit] of units) {
    if (Math.abs(value) >= size) return `${prefix}${(value / size).toLocaleString(locale(), { maximumFractionDigits: digits })}${unit}`;
  }
  return `${prefix}${value.toLocaleString(locale(), { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 })}`;
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

// Fresh rows laid over the ones on screen, as the market apps do: a row of the same coin (data-key) is kept
// and only what changed in it is rewritten (a number, a colour), so a refresh changes the figures in place
// instead of drawing the list again (no blink, no pictures loading anew). Rows of other coins come in new.
function patchList(box, fresh) {
  const kept = new Map([...box.children].filter((child) => child.dataset.key).map((child) => [child.dataset.key, child]));
  const rows = fresh.map((row) => {
    const old = row.dataset?.key ? kept.get(row.dataset.key) : null;
    if (!old || old.nodeName !== row.nodeName) return row;
    kept.delete(row.dataset.key);
    patchNode(old, row);
    return old;
  });
  // In order, moving what moved; the rest leaves.
  rows.forEach((row, index) => { if (box.children[index] !== row) box.insertBefore(row, box.children[index] ?? null); });
  while (box.children.length > rows.length) box.lastElementChild.remove();
}
function patchNode(old, row) {
  if (old.nodeType === Node.TEXT_NODE) { if (old.nodeValue !== row.nodeValue) old.nodeValue = row.nodeValue; return; }
  for (const { name } of [...old.attributes]) if (!row.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of [...row.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  const before = [...old.childNodes];
  const after = [...row.childNodes];
  // A picture already shown stays (same address); a different shape is taken whole.
  if (before.length !== after.length || before.some((node, index) => node.nodeName !== after[index].nodeName)) { old.replaceChildren(...after); return; }
  before.forEach((node, index) => {
    if (node.nodeName === "IMG") { if (node.getAttribute("src") !== after[index].getAttribute("src")) node.replaceWith(after[index]); return; }
    patchNode(node, after[index]);
  });
}

// Logos already shown on this page: a list drawn again (fresh data every minute) copies the loaded picture,
// which paints at once, instead of a new one that starts empty.
const shownLogos = new Map();
function logo(coin) {
  if (coin.image) {
    const seen = shownLogos.get(coin.image);
    if (seen?.complete && seen.naturalWidth) {
      const copy = seen.cloneNode();
      copy.className = "logo";
      copy.removeAttribute("style");
      return copy;
    }
    const image = document.createElement("img");
    if (shownLogos.size < 2_000) image.addEventListener("load", () => shownLogos.set(coin.image, image), { once: true });
    image.className = "logo";
    // CoinGecko's pictures come through this site's server, which keeps them and lets the browser reuse
    // them (theirs say nothing about caching, so they were fetched again on every page).
    const kept = /^https:\/\/(?:coin-images|assets)\.coingecko\.com\/coins\/images\/(\d+)\/(thumb|small|large|standard)\/([A-Za-z0-9._-]+)/.exec(coin.image);
    image.src = kept ? `/market/logo/coin/${kept[1]}/large/${kept[3]}` : coin.image; // sharp on phones' dense screens
    image.alt = "";
    // Not lazy and decoded with the page: a lazy or separately decoded picture paints a frame or two after the
    // row, which reads as blinking on every page change (the file itself comes from the browser's cache).
    image.decoding = "sync";
    image.referrerPolicy = "no-referrer";
    // The server without the picture: CoinGecko's own address; that failing too, the coin's first letter.
    let direct = !kept;
    image.addEventListener("error", () => {
      if (direct) { image.replaceWith(logo({ ...coin, image: null })); return; }
      direct = true;
      image.src = coin.image;
    });
    return image;
  }
  // No picture from the lists (a new listing, a tokenised share): the server looks one up by the ticker once.
  if (/^[A-Z0-9]{1,15}$/.test(coin.symbol ?? "") && !coin.tickerTried) {
    const image = document.createElement("img");
    image.className = "logo";
    image.alt = "";
    image.decoding = "sync";
    image.src = `/market/logo/symbol/${coin.symbol}`;
    image.addEventListener("error", () => image.replaceWith(logo({ ...coin, tickerTried: true })), { once: true });
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
  // NIR Markets' own accounts, first in the strip.
  const bar = $(".nirbar");
  if (bar && Number.isFinite(strip.users)) {
    let item = bar.querySelector(".users");
    if (!item) {
      item = Object.assign(document.createElement("span"), { className: "users" });
      item.append(document.createElement("span"), " ", document.createElement("b"));
      bar.prepend(item);
    }
    item.querySelector("span").textContent = language === "en" ? "Users:" : "Пользователей:";
    item.querySelector("b").textContent = strip.users.toLocaleString(locale());
  }
  for (const node of document.querySelectorAll('[data-stat="capChange"]')) {
    node.className = changeClass(g.marketCapChange24h);
    node.textContent = percentText(g.marketCapChange24h);
  }
}
// The market overview, asked once per page load and shared by the strip, the search and the page.
let overviewAsk = null;
let overviewAt = 0;
function marketOverview() {
  // Asked again after a minute: the strip and the heatmap redraw from it and must follow the market.
  if (Date.now() - overviewAt > 60_000) { overviewAsk = null; overviewAt = Date.now(); }
  overviewAsk ??= fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).catch(() => null)
    .then((value) => { if (!value) overviewAsk = null; return value; });
  return overviewAsk;
}
async function loadStrip() {
  const [overview, stats] = await Promise.all([marketOverview(),
    fetch("/market/stats").then((answer) => (answer.ok ? answer.json() : null)).catch(() => null)]);
  if (!overview) return;
  strip = { ...overview, users: stats?.users ?? null };
  renderStrip();
}

// --- Language and theme, shared with the NIR page. `render` redraws the
// page's own content; `onTheme` lets a page redraw what follows the theme.
function isLight() {
  return document.documentElement.dataset.theme === "light" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: light)").matches);
}
// --- The header's sections on wide screens: each opens (on hover or a click) a menu of the pages inside it,
// so the lists, screeners and on-chain tools hidden in tabs can be found from any page.
const MENU = [
  { ru: "Рынок", en: "Market", match: /^\/(?:$|charts\/|coin\/)/, groups: [
    { ru: "Монеты", en: "Coins", items: [
      ["/", "Криптовалюты", "Топ монет по капитализации", "Cryptocurrencies", "Top coins by market cap"],
      ["/#trending", "В тренде", "Что ищут чаще всего", "Trending", "The most searched coins"],
      ["/#gainers", "Рост и падение", "Лидеры роста и падения за сутки", "Gainers & losers", "The day's biggest movers"],
      ["/#stable", "Стейблкоины", "Монеты, привязанные к доллару", "Stablecoins", "Coins pegged to the dollar"]] },
    { ru: "Обзор", en: "Overview", items: [
      ["/charts/", "Обзор рынка", "Капитализация и объём за всё время", "Market overview", "Market cap and volume over time"],
      ["/charts/#fear-greed", "Индекс страха и жадности", "Настроение рынка сегодня и раньше", "Fear & Greed Index", "The market's mood, now and before"],
      ["/charts/#dominance", "Доминация BTC и ETH", "Доля биткоина и эфира в рынке", "BTC and ETH dominance", "Bitcoin's and Ether's share of the market"]] }] },
  { ru: "Ончейн", en: "On-chain", match: /^\/(?:wallets|transfers|address|entity|visualizer)\//, groups: [
    { ru: "Кошельки", en: "Wallets", items: [
      ["/wallets/", "Популярные кошельки", "Биржи, фонды, киты и их балансы", "Popular wallets", "Exchanges, funds, whales and their balances"],
      ["/entity/?name=Satoshi%20Nakamoto", "Монеты Сатоши", "Сколько намайнил создатель биткоина", "Satoshi's coins", "What Bitcoin's creator mined"]] },
    { ru: "Переводы", en: "Transfers", items: [
      ["/transfers/", "Все переводы", "Переводы в сетях в реальном времени", "All transfers", "Transfers across chains, live"]] }] },
  { ru: "Скринеры", en: "Screeners", match: /^\/screener\//, groups: [
    { ru: "Фьючерсы", en: "Futures", items: [
      ["/screener/", "Тренды", "Рост, падение, объём и открытый интерес", "Trends", "Moves, volume and open interest"],
      ["/screener/densities/", "Плотности", "Крупные заявки в стаканах бирж", "Order book walls", "Big orders in the exchanges' books"],
      ["/screener/book/", "Стакан", "Живой стакан, лента сделок и уровни на графике", "Order book", "A live book, the trades feed and levels on the chart"],
      ["/screener/arbitrage/", "Арбитраж", "Разница цен между биржами", "Arbitrage", "Price gaps between exchanges"],
      ["/screener/liquidations/", "Ликвидации", "Закрытые принудительно позиции", "Liquidations", "Positions closed by force"],
      ["/screener/listings/", "Листинги", "Новые монеты на биржах", "Listings", "New coins on the exchanges"],
      ["/screener/heatmap/", "Тепловая карта", "Весь рынок одной картинкой", "Heatmap", "The whole market at a glance"]] }] },
];
function renderMenu() {
  const nav = document.querySelector(".top nav");
  if (!nav) return;
  const en = language === "en";
  const make = (tag, className, text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
  nav.classList.add("menu");
  nav.replaceChildren(...MENU.map((section) => {
    const box = make("div", `menu-item${section.match.test(location.pathname) ? " on" : ""}`);
    const button = make("button", "menu-head", en ? section.en : section.ru);
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    const panel = make("div", "menu-panel");
    for (const group of section.groups) {
      panel.append(make("small", "menu-group", en ? group.en : group.ru));
      for (const [href, ruName, ruNote, enName, enNote] of group.items) {
        const link = make("a", "menu-link");
        link.href = href;
        link.append(make("b", "", en ? enName : ruName), make("span", "", en ? enNote : ruNote));
        panel.append(link);
      }
    }
    // A click (a touch screen has no hover) opens it and closes the others.
    button.addEventListener("click", () => {
      const open = !box.classList.contains("open");
      for (const other of nav.querySelectorAll(".menu-item.open")) { other.classList.remove("open"); other.firstChild.setAttribute("aria-expanded", "false"); }
      box.classList.toggle("open", open);
      button.setAttribute("aria-expanded", String(open));
    });
    box.append(button, panel);
    return box;
  }));
}
document.addEventListener("click", (event) => {
  if (!event.target.closest?.(".menu-item")) for (const box of document.querySelectorAll(".menu-item.open")) box.classList.remove("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") for (const box of document.querySelectorAll(".menu-item.open")) box.classList.remove("open");
});

// The hints on buttons and the names of page regions (read out by screen readers), in English.
const LABELS_EN = {
  "Разделы": "Sections", "Тема": "Theme", "Поиск": "Search", "Мои разделы": "My sections", "Меню": "Menu", "Монета": "Coin",
  "Уведомление о цене": "Price alert", "Токен: USDC, ETH…": "Token: USDC, ETH…", "Имя или адрес": "Name or address", "Страницы": "Pages",
  "Скрыть баланс": "Hide balance", "Система": "System", "Сеть сейчас": "Network now", "Связи кошелька": "Wallet links", "Рынок": "Market",
  "Разделы профиля": "Profile sections", "Разделы монеты": "Coin sections", "Линия": "Line", "Изменить": "Edit", "Избранное": "Watchlist",
  "Ещё": "More", "Добавить сделку": "Add transaction", "Быстрые ссылки": "Quick links", "Назад": "Back",
};
function translateLabels() {
  for (const attribute of ["aria-label", "title", "placeholder"]) {
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      const key = `ru${attribute.replace(/-./, (part) => part[1].toUpperCase()).replace(/^./, (first) => first.toUpperCase())}`;
      const original = element.dataset[key] ?? element.getAttribute(attribute);
      if (!LABELS_EN[original]) continue;
      element.dataset[key] = original;
      element.setAttribute(attribute, language === "en" ? LABELS_EN[original] : original);
    }
  }
}

function addBackButton() {
  const top = document.querySelector(".top");
  if (!top || top.querySelector(".back")) return;
  const back = Object.assign(document.createElement("button"), { type: "button", className: "pill back" });
  back.setAttribute("aria-label", "Назад");
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  // Back where the visitor came from on this site; from outside (a shared link), to the home page.
  back.addEventListener("click", () => {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
    else location.href = "/";
  });
  top.prepend(back);
  document.body.classList.add("inner-page");
}

// The service worker (sw.js) keeps the site's files and pages for instant moves between pages; once the
// page is idle it fetches the bottom menu's pages ahead, and the visitor's own data for them.
function warmUp() {
  const later = window.requestIdleCallback ?? ((callback) => setTimeout(callback, 1_500));
  later(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then((registration) => {
        const pages = [...document.querySelectorAll(".tabbar a[href^='/']")].map((link) => new URL(link.href).pathname).filter((path, index, all) => all.indexOf(path) === index);
        (registration.active ?? registration.installing ?? registration.waiting)?.postMessage({ warm: pages });
      }).catch(() => {});
    }
    // Browsers that can (Chrome, Edge): the bottom menu's pages are fetched ahead, and a page the finger or
    // pointer is on its way to is prepared whole in the background, so the tap shows it at once.
    if (HTMLScriptElement.supports?.("speculationrules") && !document.querySelector("script[type=speculationrules]")) {
      const pages = [...document.querySelectorAll(".tabbar a[href^='/']")].map((link) => new URL(link.href).pathname).filter((path, index, all) => all.indexOf(path) === index);
      const rules = { prefetch: [{ urls: pages, eagerness: "eager" }],
        prerender: [{ where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/market/*" } }, { not: { href_matches: "/api/*" } }] }, eagerness: "moderate" }] };
      document.head.append(Object.assign(document.createElement("script"), { type: "speculationrules", textContent: JSON.stringify(rules) }));
    }
    // The data the next pages start from, into the kept answers (FAST above).
    void fetch("/market/overview").catch(() => {});
    if (account.user) {
      void fetch("/market/me/portfolio", { cache: "no-store" }).catch(() => {});
      void fetch(`/market/u/${encodeURIComponent(account.user.username)}`, { cache: "no-store" }).catch(() => {});
    }
  });
}

function setupPage({ en: own, render, onTheme = () => {}, onAccount = render }) {
  const en = { navScreener: "Screeners", howItWorks: "How it works", ...own }; // words every page's header shares
  accountChanged = onAccount;
  const textNodes = [...document.querySelectorAll("[data-i18n]")];
  const ru = Object.fromEntries(textNodes.map((node) => [node.dataset.i18n, node.textContent]));
  const search = $("#search");
  const ruPlaceholder = search.placeholder;
  const ruTitle = document.title; // a page's render may set its own
  function applyLanguage() {
    document.documentElement.lang = language;
    renderMenu();
    translateLabels();
    document.title = language === "en" && en.docTitle ? en.docTitle : ruTitle;
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
  // A drawn sun or moon: the text glyphs come out tiny and faint on some systems.
  const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
  const renderTheme = () => { $("#theme").innerHTML = isLight() ? MOON : SUN; };
  $("#theme").addEventListener("click", () => {
    const next = isLight() ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set("nir-site-theme", next);
    renderTheme();
    onTheme();
  });
  // Phones: a back button on every page but the home page, where the logo's name gives it room.
  if (location.pathname !== "/") addBackButton();
  renderTheme();
  applyLanguage();
  // A row of section tabs wider than the screen shows the open one.
  const openTab = document.querySelector(".sc-tabs a.on");
  if (openTab) openTab.parentElement.scrollLeft = openTab.offsetLeft - openTab.parentElement.offsetLeft - (openTab.parentElement.clientWidth - openTab.offsetWidth) / 2;
  void loadAccount().finally(warmUp);
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
  // Coins and wallets opened from the search, newest first.
  const remember = (item) => store.set("nir-recent-searches", JSON.stringify([item.address
    ? { address: item.address, name: item.name ?? null }
    : { id: item.id, symbol: item.symbol, name: item.name, image: item.image ?? null, rank: item.rank ?? null },
  ...recent().filter((entry) => (item.address ? entry.address !== item.address : entry.id !== item.id))].slice(0, 5)));
  const data = async () => {
    market = overview() ?? market;
    if (!market) market = await marketOverview();
    return market;
  };
  const open = (item) => {
    remember(item);
    if (item.address) { location.href = addressUrl(item.address); return; }
    location.href = coinUrl(item);
  };
  function draw(groups) {
    items = groups.flatMap(([, coins]) => coins);
    active = -1;
    // A section's title opens the full list when there is one (popular wallets, trending coins).
    box.replaceChildren(...groups.filter(([, coins]) => coins.length).flatMap(([title, coins, href]) => [
      href ? Object.assign(document.createElement("a"), { className: "suggest-title", href, textContent: `${title} ›` })
        : Object.assign(document.createElement("small"), { textContent: title }),
      ...coins.map((coin) => {
        const row = document.createElement("a");
        row.setAttribute("role", "option");
        if (coin.address) {
          // A wallet: its name (if any) and the short address.
          row.href = addressUrl(coin.address);
          const whale = WHALE.get(coin.address.toLowerCase());
          const name = coin.name ?? whale?.name ?? null;
          // The organisation (from the open labels) or the kind on the right, as the analytics sites show entities.
          const side = whale ? whale.kind[language === "en" ? "en" : "ru"] : coin.entity ?? (coin.ens ? "ENS" : coin.contract ? t().contract : null);
          row.append(walletAvatar({ address: coin.address, name: name ?? "◎", logo: coin.logo ?? null }, "w-avatar s-avatar"), Object.assign(document.createElement("b"), { textContent: name ?? shortAddress(coin.address) }),
            Object.assign(document.createElement("span"), { textContent: name ? shortAddress(coin.address) : t().wallet }),
            Object.assign(document.createElement("em"), { textContent: side ?? "" }));
          row.addEventListener("click", (event) => { event.preventDefault(); open(coin); });
          return row;
        }
        row.href = coinUrl(coin);
        const name = Object.assign(document.createElement("b"), { textContent: coin.name });
        const symbol = Object.assign(document.createElement("span"), { textContent: coin.symbol });
        // Trending coins show their price and day's change, the rest their rank.
        const rank = Object.assign(document.createElement("em"), { textContent: coin.rank ? `#${coin.rank}` : "" });
        if (coin.trend && Number.isFinite(coin.change24h)) {
          rank.textContent = `${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toLocaleString(locale(), { maximumFractionDigits: 2 })}%`;
          rank.className = coin.change24h >= 0 ? "up" : "down";
        }
        row.append(logo(coin), name, symbol, rank);
        row.addEventListener("click", (event) => { event.preventDefault(); open(coin); });
        return row;
      }),
    ]));
    box.hidden = !items.length;
  }
  const t = () => (language === "en"
    ? { recent: "Recent searches", trending: "Trending tokens", coins: "Coins", none: "Nothing found", wallets: "Addresses", wallet: "address", whales: "Popular wallets", entities: "Wallets and entities", contract: "Contract" }
    : { recent: "Недавние", trending: "Токены в тренде", coins: "Монеты", none: "Ничего не найдено", wallets: "Адреса", wallet: "адрес", whales: "Популярные кошельки", entities: "Кошельки и организации", contract: "Контракт" });
  async function update() {
    const raw = input.value.trim();
    const query = raw.toLowerCase();
    // A wallet address opens its page; a name like zeus.eth is looked up below.
    if (ADDRESS.test(raw)) { draw([[t().wallets, [{ address: raw, name: null }]]]); return; }
    const market = await data();
    if (!query) {
      draw([[t().recent, recent()], [t().whales, WHALES.slice(0, 6), "/wallets/"],
        [t().trending, (market?.trending ?? []).slice(0, 5).map((coin) => ({ ...coin, trend: true })), "/#trending"]]);
      return;
    }
    const local = (market?.coins ?? []).filter((coin) => coin.name.toLowerCase().includes(query) ||
      coin.symbol.toLowerCase().startsWith(query) || coin.id.includes(query)).slice(0, 8);
    // "black rock" finds BlackRock too: spaces do not count.
    const squeeze = (value) => value.toLowerCase().replace(/\s+/g, "");
    const whales = WHALES.filter((item) => [item.name, item.ens].some((value) => value && squeeze(value).includes(squeeze(query)))).slice(0, 4);
    // Wallets and organisations first, then coins, each its own section, as on the analytics sites.
    draw([[t().entities, whales, "/wallets/"], [t().coins, local]]);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      asked = query;
      const [found, wallets] = await Promise.all([
        fetch(`/market/search?q=${encodeURIComponent(query)}`).then((response) => (response.ok ? response.json() : { coins: [] })).catch(() => ({ coins: [] })),
        query.length >= 3 ? fetch(`/market/chain/search?q=${encodeURIComponent(query)}`).then((response) => (response.ok ? response.json() : { results: [] }))
          .catch(() => ({ results: [] })) : { results: [] },
      ]);
      if (asked !== input.value.trim().toLowerCase()) return; // a newer query is on its way
      const seen = new Set(local.map((coin) => coin.id));
      const merged = [...local, ...found.coins.filter((coin) => !seen.has(coin.id))].slice(0, 10);
      const known = new Set(whales.map((item) => item.address.toLowerCase()));
      const entities = [...whales, ...(wallets.results ?? []).filter((item) => !known.has(item.address.toLowerCase()))].slice(0, 8);
      draw([[t().entities, entities, "/wallets/"], [t().coins, merged]]);
      if (!merged.length && !entities.length) {
        box.replaceChildren(Object.assign(document.createElement("p"), { textContent: t().none }));
        box.hidden = false;
      }
    }, 250);
  }
  function move(step) {
    const rows = [...box.querySelectorAll("a[role=option]")];
    if (!rows.length) return;
    active = (active + step + rows.length) % rows.length;
    rows.forEach((row, index) => row.classList.toggle("on", index === active));
    rows[active].scrollIntoView({ block: "nearest" });
  }
  input.addEventListener("focus", () => { void update(); });
  input.addEventListener("click", () => { if (box.hidden) void update(); });
  // The popular wallets' pictures come from the open labels; the list is drawn again once they are in.
  void loadOpenNames(WHALES.map((item) => item.address)).then(() => { if (!box.hidden && !input.value.trim()) void update(); });
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
  // The phone's search button opens the field and its list; that same click must not close the list.
  document.addEventListener("click", (event) => {
    if (event.target !== input && !box.contains(event.target) && !event.target.closest?.("#find")) box.hidden = true;
  });
}

// Pull to refresh on phones: drawing the page down from its very top reloads it, also in the app
// saved to the home screen, where the browser's own gesture is missing.
(() => {
  if (!("ontouchstart" in window)) return;
  document.documentElement.classList.add("touch");
  const mark = Object.assign(document.createElement("div"), { className: "ptr", textContent: "↻" });
  let start = null;
  let pull = 0;
  const reset = () => { start = null; pull = 0; mark.style.transform = ""; mark.classList.remove("ready", "show"); };
  window.addEventListener("touchstart", (event) => {
    if (window.scrollY > 0 || event.touches.length > 1 || document.body.classList.contains("searching") || event.target.closest?.(".pf-sheet, dialog, .table-wrap, textarea, input, #stage, .suggest, .sc-tabs, .hm")) return;
    start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  window.addEventListener("touchmove", (event) => {
    if (!start) return;
    const dx = event.touches[0].clientX - start.x;
    const dy = event.touches[0].clientY - start.y;
    if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) { reset(); return; }
    if (!mark.isConnected) document.body.append(mark);
    pull = Math.min(110, dy * 0.5);
    mark.classList.add("show");
    mark.classList.toggle("ready", pull >= 64);
    mark.style.transform = `translate(-50%, ${pull}px) rotate(${pull * 4}deg)`;
  }, { passive: true });
  window.addEventListener("touchend", () => {
    if (start && pull >= 64) { mark.classList.add("spin"); location.reload(); return; }
    reset();
  }, { passive: true });
})();

// A squarified treemap (the heatmaps): rows of tiles laid along the shorter side, each row as close to square as it gets.
function squarify(items, x, y, width, height) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const scale = (width * height) / total;
  const rest = items.map((item) => ({ ...item, area: item.weight * scale }));
  const tiles = [];
  const worst = (row, side) => {
    const sum = row.reduce((all, item) => all + item.area, 0);
    const max = Math.max(...row.map((item) => item.area));
    const min = Math.min(...row.map((item) => item.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  let box = { x, y, width, height };
  while (rest.length) {
    const side = Math.min(box.width, box.height);
    const row = [rest.shift()];
    while (rest.length && worst([...row, rest[0]], side) <= worst(row, side)) row.push(rest.shift());
    const sum = row.reduce((all, item) => all + item.area, 0);
    if (box.width >= box.height) {
      // A column on the left.
      const columnWidth = sum / box.height;
      let top = box.y;
      for (const item of row) { const h = item.area / columnWidth; tiles.push({ ...item, x: box.x, y: top, width: columnWidth, height: h }); top += h; }
      box = { x: box.x + columnWidth, y: box.y, width: box.width - columnWidth, height: box.height };
    } else {
      // A row along the top.
      const rowHeight = sum / box.width;
      let left = box.x;
      for (const item of row) { const w = item.area / rowHeight; tiles.push({ ...item, x: left, y: box.y, width: w, height: rowHeight }); left += w; }
      box = { x: box.x, y: box.y + rowHeight, width: box.width, height: box.height - rowHeight };
    }
  }
  return tiles;
}
