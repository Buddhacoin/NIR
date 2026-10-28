// Popular wallets, /wallets/: the hand-picked well-known wallets of common.js, and thousands more
// from the open labels (/market/chain/popular: exchanges, funds, hot wallets, fifty a page), each
// with its name and picture, organisation, networks and balance, and a button to track it.
// Balances come from /market/chain/address (market-chain.mjs), two at a time, for the rows on
// screen only. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  title: "Popular wallets", colWallet: "Wallet", colKind: "Type and owner", colNetworks: "Networks", colTotal: "Balance", more: "Show more",
  intro: "Thousands of known wallets: exchanges, funds, market makers, a government and well-known people. Names and logos come from the open labels. Open any to see its assets, history and transfers, and tap “Track” to keep it in your profile.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { groups: { all: "Все", featured: "Известные", whales: "Киты", exchange: "Биржи", fund: "Фонды", "hot-wallet": "Горячие кошельки", found: "Найдено" },
    moved: (usd) => `${usdShort(usd)} за 30 дней`, byBehaviour: "определено по поведению", whaleIntro: "Кошельки, через которые за 30 дней прошли самые крупные переводы (по нашей ленте переводов). Список обновляется сам.",
    foundIntro: "Новые подписи, которые сервер нашёл сам по поведению кошельков: адреса пополнения бирж и вероятные горячие кошельки. Каждый час добавляются новые.",
    kinds: { exchange: "Биржа", fund: "Фонд", "hot-wallet": "Горячий кошелёк" }, filter: "Имя или адрес",
    loading: "загружаю…", unknown: "—", track: "☆ Следить", tracked: "★ Слежу", wallets: (count) => `${count} адресов →`, empty: "Ничего не найдено.",
    loadingList: "Загружаю список…", contract: "Контракт", wallet: "Кошелёк", signIn: "Войдите через Google, чтобы отслеживать адреса." },
  en: { groups: { all: "All", featured: "Well known", whales: "Whales", exchange: "Exchanges", fund: "Funds", "hot-wallet": "Hot wallets", found: "Found" },
    moved: (usd) => `${usdShort(usd)} in 30 days`, byBehaviour: "found by behaviour", whaleIntro: "The wallets the largest transfers went through over 30 days (from our transfer feed). The list updates itself.",
    foundIntro: "New labels the server found itself from wallets' behaviour: exchange deposit addresses and likely hot wallets. New ones come every hour.",
    kinds: { exchange: "Exchange", fund: "Fund", "hot-wallet": "Hot wallet" }, filter: "Name or address",
    loading: "loading…", unknown: "—", track: "☆ Watch", tracked: "★ Watching", wallets: (count) => `${count} wallets →`, empty: "Nothing found.",
    loadingList: "Loading the list…", contract: "Contract", wallet: "Wallet", signIn: "Sign in with Google to track addresses." },
};
const t = () => words[language === "en" ? "en" : "ru"];
// How many known wallets each organisation has (/market/chain/entities), asked for the rows shown.
const entityCounts = new Map();
let satoshi = null; // /market/chain/satoshi, for Satoshi Nakamoto's row
const askCounts = new Set();
async function loadCounts() {
  const wanted = [...askCounts].filter((name) => name.length >= 2 && !entityCounts.has(name)).slice(0, 60);
  askCounts.clear();
  if (!wanted.length) return;
  for (const name of wanted) entityCounts.set(name, 0);
  const answer = await fetch(`/market/chain/entities?names=${wanted.map(encodeURIComponent).join(",")}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  // The popular list's own wallets of an organisation count too.
  for (const name of wanted) entityCounts.set(name, Math.max(answer?.counts?.[name] ?? 0, WHALES.filter((item) => entityName(item.name) === name).length));
  // Satoshi Nakamoto's early blocks count as his wallets.
  if (wanted.includes("Satoshi Nakamoto")) {
    satoshi = await fetch("/market/chain/satoshi").then((response) => (response.ok ? response.json() : null)).catch(() => null);
    if (satoshi?.keys) entityCounts.set("Satoshi Nakamoto", satoshi.keys);
  }
  if (wanted.some((name) => entityCounts.get(name) > 1)) render();
}
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const balances = new Map(); // address → { total, chains } once loaded, null if it failed
const retried = new Map(); // address → how many times a partial answer was asked again
const lists = {}; // group → { items, next, loading }
let group = "all";
const LABELED = ["exchange", "fund", "hot-wallet"]; // the groups from the open labels; "all" holds them and the hand-picked ones
let query = "";
let saved = new Set();
const sort = { key: null, dir: 0 };

// The rows of the chosen list: the hand-picked wallets, or a group from the open labels.
function rowsOf() {
  const lang = language === "en" ? "en" : "ru";
  const featured = () => WHALES.map((item) => ({ address: item.address, short: item.short, name: item.name, kind: item.kind[lang], logo: null }));
  const labeled = (key) => (lists[key]?.items ?? []).map((item) => ({ address: item.address, name: item.name ?? shortAddress(item.address, item.short), short: item.short,
    // Whales: how much went through and what the book knows of them; finds: marked as found by behaviour.
    kind: key === "whales" ? [t().moved(item.moved), categoryName(item.category), item.entity, item.guessed ? t().byBehaviour : null].filter(Boolean).join(" · ")
      : key === "found" ? [categoryName(item.category), item.entity, t().byBehaviour].filter(Boolean).join(" · ")
        : [t().kinds[key], item.entity].filter(Boolean).join(" · "), logo: item.logo ?? null }));
  if (group === "featured") return featured();
  if (group !== "all") return labeled(group);
  const seen = new Set();
  return [...featured(), ...LABELED.flatMap(labeled)].filter((item) => !seen.has(item.address.toLowerCase()) && seen.add(item.address.toLowerCase()));
}

function render() {
  document.title = `${language === "en" ? en.title : "Популярные кошельки"} — NIR Markets`;
  $("#group-note").hidden = !["whales", "found"].includes(group);
  $("#group-note").textContent = group === "whales" ? t().whaleIntro : group === "found" ? t().foundIntro : "";
  $("#filter").placeholder = t().filter;
  $("#kinds").replaceChildren(...Object.entries(t().groups).map(([key, label]) => {
    const button = node("button", key === group ? "on" : "", label);
    button.type = "button";
    button.addEventListener("click", () => { group = key; render(); if (key === "all" ? LABELED.some((name) => !lists[name]) : key !== "featured" && !lists[key]) void loadGroup(); });
    return button;
  }));
  markSort($("thead"), sort);
  const needle = query.toLowerCase();
  const squeeze = (value) => value.toLowerCase().replace(/\s+/g, ""); // "black rock" finds BlackRock
  const shown = rowsOf().filter((item) => !needle || [item.name, item.address, item.kind].some((value) => value && squeeze(value).includes(squeeze(needle))));
  // Wallets the open labels know by that name, beyond the lists loaded so far (BlackRock, a fund's wallet…).
  if (needle && found.query === needle) {
    const have = new Set(shown.map((item) => item.address.toLowerCase()));
    shown.push(...found.items.filter((item) => !have.has(item.address.toLowerCase())).map((item) => ({ address: item.address, name: item.name ?? shortAddress(item.address, item.short), short: item.short,
      kind: item.entity ?? (item.contract ? t().contract : t().wallet), logo: item.logo ?? null })));
  }
  const rows = sortBy(shown, sort, (item) => balances.get(item.address)?.total ?? null);
  const list = group === "all" ? { loading: LABELED.some((key) => lists[key]?.loading), next: LABELED.some((key) => lists[key]?.next || !lists[key]) } : lists[group];
  $("#rows").replaceChildren(...(rows.length ? rows.map((item, index) => {
    const row = node("tr", "coin");
    row.dataset.address = item.address;
    row.addEventListener("click", (event) => { if (!event.target.closest("a, button")) location.href = item.name === "Satoshi Nakamoto" && satoshi?.price ? entityUrl(item.name) : addressUrl(item.address); });
    const who = node("td", "left");
    // Satoshi Nakamoto's row counts all his early blocks' coins, not only the one address.
    const balance = item.name === "Satoshi Nakamoto" && satoshi?.price ? { total: satoshi.estimate * satoshi.price, chains: ["btc"] } : balances.get(item.address);
    // Satoshi's row shows all his early coins, so it leads to the page that adds them up (one address holds few).
    const whole = item.name === "Satoshi Nakamoto" && satoshi?.price;
    const link = Object.assign(node("a", "ex-whale"), { href: whole ? entityUrl(item.name) : addressUrl(item.address) });
    // On a phone the balance stands under the name, so nothing hides past the screen's edge.
    const mobile = node("small", "w-mobile-balance", balance === undefined ? t().loading : balance === null ? t().unknown : price(balance.total));
    const label = node("span", "w-label");
    label.append(node("b", "", item.name), mobile);
    link.append(walletAvatar({ address: item.address, name: item.name, logo: item.logo }, "w-avatar ex-whale-logo"), label, node("span", "muted w-short", shortAddress(item.address, item.short)));
    who.append(link);
    const networks = node("td", "left");
    networks.append(...(balance?.chains ?? []).map((chain) => chainDot(chain)));
    const tracked = saved.has(item.address.toLowerCase());
    const track = node("button", `pill w-track${tracked ? " on" : ""}`, tracked ? t().tracked : t().track);
    track.type = "button";
    track.addEventListener("click", () => void toggle(item.address));
    const action = node("td");
    action.append(bubblesLink(item.address, true), track);
    // An organisation with several known wallets links to its page, where they all add up.
    const kind = node("td", "left muted", item.kind);
    const org = entityName(item.name);
    // Only a named organisation: a generic label ("Fund: 0x…") is no organisation of its own.
    if (GENERIC_LABEL.test(org)) { /* no organisation page */ }
    else if ((entityCounts.get(org) ?? 0) > 1) kind.append(" · ", Object.assign(node("a", "w-entity", t().wallets(entityCounts.get(org))), { href: entityUrl(org) }));
    else if (!entityCounts.has(org)) askCounts.add(org);
    row.append(node("td", "rank", String(index + 1)), who, kind, networks,
      node("td", "", balance === undefined ? t().loading : balance === null ? t().unknown : price(balance.total)), action);
    return row;
  }) : [(() => { const row = node("tr"); const cell = node("td", "muted ex-empty", list?.loading ? t().loadingList : t().empty); cell.colSpan = 6; row.append(cell); return row; })()]));
  $("#more").hidden = group === "featured" || !list?.next;
  watchRows();
  void loadCounts();
}

// A group's next page of fifty from the open labels; "all" takes the next page of each.
async function loadGroup(asked = group) {
  if (asked === "featured") return;
  if (asked === "all") { await Promise.all(LABELED.map((key) => loadGroup(key))); return; }
  const list = lists[asked] ??= { items: [], next: null, loading: false, done: false };
  if (list.loading || list.done) return;
  list.loading = true;
  render();
  const answer = await fetch(`/market/chain/popular?group=${encodeURIComponent(asked)}${list.next ? `&cursor=${list.next}` : ""}`)
    .then((response) => (response.ok ? response.json() : null)).catch(() => null);
  list.loading = false;
  if (answer) {
    list.items.push(...answer.items);
    list.next = answer.next;
    list.done = !answer.next;
  } else if ((list.failed = (list.failed ?? 0) + 1) <= 3) {
    // A failed answer is asked again a little later, the list showing it is loading meanwhile.
    list.loading = true;
    setTimeout(() => { list.loading = false; void loadGroup(asked); }, 4000 * list.failed);
  }
  render();
}

// Balances for the rows on screen, two at a time; each row fills in as its answer comes.
const queue = [];
let working = 0;
const seen = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const address = entry.target.dataset.address;
    if (entry.isIntersecting && !balances.has(address) && !queue.includes(address)) queue.push(address);
  }
  pump();
}, { rootMargin: "200px" });
function watchRows() {
  seen.disconnect();
  const rows = [...document.querySelectorAll("#rows tr[data-address]")];
  void loadTotals(rows.map((row) => row.dataset.address));
  // A wallet the server has no sum for yet is read on its own when its row comes into view.
  for (const row of rows) if (!balances.has(row.dataset.address) && totalsAsked.get(row.dataset.address) === false) seen.observe(row);
}
// The sums the server keeps for the lists (/market/chain/totals): shown at once, and kept fresh there.
const totalsAsked = new Map(); // address → true while asking, false once the server had none
async function loadTotals(addresses) {
  const wanted = addresses.filter((address) => !balances.has(address) && !totalsAsked.has(address)).slice(0, 200);
  if (!wanted.length) return;
  for (const address of wanted) totalsAsked.set(address, true);
  const answer = await fetch(`/market/chain/totals?addresses=${wanted.map(encodeURIComponent).join(",")}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  for (const address of wanted) {
    const known = answer?.totals?.[address];
    if (known) balances.set(address, { total: known.total, chains: known.chains });
    totalsAsked.set(address, false);
  }
  render();
}
function pump() {
  while (working < 4 && queue.length) {
    const address = queue.shift();
    working += 1;
    // A wallet that takes over half a minute shows "—" instead of loading for ever.
    void fetch(`/market/chain/address/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(30_000) }).then((response) => (response.ok ? response.json() : null)).catch(() => null)
      .then((data) => {
        // A big wallet's first answer can lack the tokens the explorer has not counted yet, or a network that
        // did not answer: it does not replace a whole sum already shown, and is asked again until whole, so the
        // list shows the same sum as the page. A failed answer is asked again too.
        const incomplete = !data || data.networks?.some((item) => item.partial || !item.ok);
        const had = balances.get(address);
        if (!incomplete || !had) balances.set(address, data ? { total: data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0),
          chains: [...new Set(data.assets.map((asset) => asset.chain))] } : had ?? null);
        const tries = retried.get(address) ?? 0;
        if (incomplete && tries < 4) {
          retried.set(address, tries + 1);
          setTimeout(() => { queue.push(address); pump(); }, 15_000);
        }
        working -= 1;
        render();
        pump();
      });
  }
}

async function loadSaved() {
  if (!account.user) { saved = new Set(); render(); return; }
  const answer = await fetch("/market/me/addresses", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  saved = new Set((answer?.addresses ?? []).map((item) => item.address.toLowerCase()));
  render();
}
async function toggle(address) {
  if (!account.user) {
    if (account.signIn) location.href = signInUrl();
    else alert(t().signIn);
    return;
  }
  // Into one of the visitor's portfolios, only tracked, or off (portfolioSheet in common.js).
  await portfolioSheet(address, (data) => { saved = new Set(data.addresses.map((item) => item.address.toLowerCase())); render(); });
}

sortable($("thead"), sort, render);
const found = { query: "", items: [] };
let findTimer = null;
$("#filter").addEventListener("input", (event) => {
  query = event.target.value.trim();
  render();
  clearTimeout(findTimer);
  const needle = query.toLowerCase();
  if (needle.length < 3) return;
  findTimer = setTimeout(async () => {
    const answer = await fetch(`/market/chain/search?q=${encodeURIComponent(needle)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
    if (needle !== query.toLowerCase()) return;
    Object.assign(found, { query: needle, items: (answer?.results ?? []).filter((item) => /^(?:0x[0-9a-fA-F]{40}|w:[a-z0-9-]{2,40})$/.test(item.address)) });
    render();
  }, 300);
});
$("#more").addEventListener("click", () => void loadGroup());
// The next page comes by itself when the "show more" button scrolls into view.
new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting) && group !== "featured") void loadGroup(); }).observe($("#more"));
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render, onAccount: () => { void loadSaved(); } });
void loadGroup("all");
void loadOpenNames(WHALES.map((item) => item.address)).then(render);
