// Popular wallets, /wallets/: the hand-picked well-known wallets of common.js, and thousands more
// from the open labels (/market/chain/popular: exchanges, funds, hot wallets, fifty a page), each
// with its name and picture, organisation, networks and balance, and a button to track it.
// Balances come from /market/chain/address (market-chain.mjs), two at a time, for the rows on
// screen only. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  title: "Popular wallets", colWallet: "Wallet", colKind: "Type and owner", colNetworks: "Networks", colTotal: "Balance", more: "Show more",
  intro: "Thousands of known wallets: exchanges, funds, market makers, a government and well-known people. Names and logos come from the open labels. Open any to see its assets, history and transfers, and tap “Track” to keep it in your profile.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { groups: { featured: "Известные", exchange: "Биржи", fund: "Фонды", "hot-wallet": "Горячие кошельки" },
    kinds: { exchange: "Биржа", fund: "Фонд", "hot-wallet": "Горячий кошелёк" }, filter: "Имя или адрес",
    loading: "загружаю…", unknown: "—", track: "☆ Отследить", tracked: "★ Отслеживается", empty: "Ничего не найдено.",
    loadingList: "Загружаю список…", signIn: "Войдите через Google, чтобы отслеживать адреса." },
  en: { groups: { featured: "Well known", exchange: "Exchanges", fund: "Funds", "hot-wallet": "Hot wallets" },
    kinds: { exchange: "Exchange", fund: "Fund", "hot-wallet": "Hot wallet" }, filter: "Name or address",
    loading: "loading…", unknown: "—", track: "☆ Track", tracked: "★ Tracked", empty: "Nothing found.",
    loadingList: "Loading the list…", signIn: "Sign in with Google to track addresses." },
};
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const balances = new Map(); // address → { total, chains } once loaded, null if it failed
const lists = {}; // group → { items, next, loading }
let group = "featured";
let query = "";
let saved = new Set();
const sort = { key: null, dir: 0 };

// The rows of the chosen list: the hand-picked wallets, or a group from the open labels.
function rowsOf() {
  const lang = language === "en" ? "en" : "ru";
  if (group === "featured") return WHALES.map((item) => ({ address: item.address, name: item.name, kind: item.kind[lang], logo: null }));
  return (lists[group]?.items ?? []).map((item) => ({ address: item.address, name: item.name ?? shortAddress(item.address),
    kind: [t().kinds[group], item.entity].filter(Boolean).join(" · "), logo: item.logo }));
}

function render() {
  document.title = `${language === "en" ? en.title : "Популярные кошельки"} — NIR Markets`;
  $("#filter").placeholder = t().filter;
  $("#kinds").replaceChildren(...Object.entries(t().groups).map(([key, label]) => {
    const button = node("button", key === group ? "on" : "", label);
    button.type = "button";
    button.addEventListener("click", () => { group = key; render(); if (key !== "featured" && !lists[key]) void loadGroup(); });
    return button;
  }));
  markSort($("thead"), sort);
  const needle = query.toLowerCase();
  const rows = sortBy(rowsOf().filter((item) => !needle || [item.name, item.address, item.kind].some((value) => value?.toLowerCase().includes(needle))),
    sort, (item) => balances.get(item.address)?.total ?? null);
  const list = lists[group];
  $("#rows").replaceChildren(...(rows.length ? rows.map((item, index) => {
    const row = node("tr", "coin");
    row.dataset.address = item.address;
    row.addEventListener("click", (event) => { if (!event.target.closest("a, button")) location.href = addressUrl(item.address); });
    const who = node("td", "left");
    const link = Object.assign(node("a", "ex-whale"), { href: addressUrl(item.address) });
    link.append(walletAvatar({ address: item.address, name: item.name, logo: item.logo }, "w-avatar ex-whale-logo"), node("b", "", item.name), node("span", "muted", shortAddress(item.address)));
    who.append(link);
    const balance = balances.get(item.address);
    const networks = node("td", "left");
    networks.append(...(balance?.chains ?? []).map((chain) => chainDot(chain)));
    const tracked = saved.has(item.address.toLowerCase());
    const track = node("button", `pill${tracked ? " on" : ""}`, tracked ? t().tracked : t().track);
    track.type = "button";
    track.addEventListener("click", () => void toggle(item.address));
    const action = node("td");
    action.append(track);
    row.append(node("td", "rank", String(index + 1)), who, node("td", "left muted", item.kind), networks,
      node("td", "", balance === undefined ? t().loading : balance === null ? t().unknown : price(balance.total)), action);
    return row;
  }) : [(() => { const row = node("tr"); const cell = node("td", "muted ex-empty", list?.loading ? t().loadingList : t().empty); cell.colSpan = 6; row.append(cell); return row; })()]));
  $("#more").hidden = group === "featured" || !list?.next;
  watchRows();
}

// A group's next page of fifty from the open labels.
async function loadGroup() {
  const list = lists[group] ??= { items: [], next: null, loading: false, done: false };
  if (list.loading || list.done) return;
  list.loading = true;
  const asked = group;
  render();
  const answer = await fetch(`/market/chain/popular?group=${encodeURIComponent(asked)}${list.next ? `&cursor=${list.next}` : ""}`)
    .then((response) => (response.ok ? response.json() : null)).catch(() => null);
  list.loading = false;
  if (answer) {
    list.items.push(...answer.items);
    list.next = answer.next;
    list.done = !answer.next;
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
  for (const row of document.querySelectorAll("#rows tr[data-address]")) if (!balances.has(row.dataset.address)) seen.observe(row);
}
function pump() {
  while (working < 2 && queue.length) {
    const address = queue.shift();
    working += 1;
    void fetch(`/market/chain/address/${encodeURIComponent(address)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null)
      .then((data) => {
        balances.set(address, data ? { total: data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0),
          chains: [...new Set(data.assets.map((asset) => asset.chain))] } : null);
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
  const tracked = saved.has(address.toLowerCase());
  const { status, data } = tracked ? await send(`/market/me/addresses/${encodeURIComponent(address)}`, "DELETE")
    : await send(`/market/me/addresses/${encodeURIComponent(address)}`, "PUT", { mine: false });
  if (status === 200) saved = new Set(data.addresses.map((item) => item.address.toLowerCase()));
  render();
}

sortable($("thead"), sort, render);
$("#filter").addEventListener("input", (event) => { query = event.target.value.trim(); render(); });
$("#more").addEventListener("click", () => void loadGroup());
// The next page comes by itself when the "show more" button scrolls into view.
new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting) && group !== "featured") void loadGroup(); }).observe($("#more"));
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render, onAccount: () => { void loadSaved(); } });
void loadOpenNames(WHALES.map((item) => item.address)).then(render);
