// Popular wallets, /wallets/: the well-known public wallets of common.js (exchanges,
// funds, market makers, a government, founders) with their networks and balance,
// a filter by kind, and a button to track each one in the visitor's profile.
// Balances come from /market/chain/address (market-chain.mjs), two at a time.
// Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  title: "Popular wallets", colWallet: "Wallet", colKind: "Type", colNetworks: "Networks", colTotal: "Balance",
  intro: "Wallets of exchanges, funds, market makers, a government and well-known people. Open any to see its assets, history and transfers, and tap “Track address” to keep it in your profile.",
  note: "The addresses are published by the organisations themselves or widely reported. Balances come from the open explorers and network nodes and refresh every 10 minutes.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { all: "Все", loading: "загружаю…", unknown: "—", track: "☆ Отследить", tracked: "★ Отслеживается", signIn: "Войдите через Google, чтобы отслеживать адреса." },
  en: { all: "All", loading: "loading…", unknown: "—", track: "☆ Track", tracked: "★ Tracked", signIn: "Sign in with Google to track addresses." },
};
const t = () => words[language];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const balances = new Map(); // address → { total, chains } once loaded, null if it failed
let kind = "";
let saved = new Set();
const sort = { key: null, dir: 0 };

function render() {
  document.title = `${language === "en" ? en.title : "Популярные кошельки"} — NIR Markets`;
  const lang = language === "en" ? "en" : "ru";
  const kinds = [...new Set(WHALES.map((item) => item.kind[lang]))];
  $("#kinds").replaceChildren(...["", ...kinds].map((name) => {
    const button = node("button", name === kind ? "on" : "", name || t().all);
    button.type = "button";
    button.addEventListener("click", () => { kind = name; render(); });
    return button;
  }));
  markSort($("thead"), sort);
  const rows = sortBy(WHALES.filter((item) => !kind || item.kind[lang] === kind), sort, (item) => balances.get(item.address)?.total ?? null);
  $("#rows").replaceChildren(...rows.map((item, index) => {
    const row = node("tr", "coin");
    row.addEventListener("click", (event) => { if (!event.target.closest("a, button")) location.href = addressUrl(item.address); });
    const who = node("td", "left");
    const link = Object.assign(node("a", "ex-whale"), { href: addressUrl(item.address) });
    link.append(walletAvatar({ address: item.address, name: item.name }, "w-avatar ex-whale-logo"), node("b", "", item.name), node("span", "muted", shortAddress(item.address)));
    who.append(link);
    const balance = balances.get(item.address);
    const networks = node("td", "left");
    networks.append(...(balance?.chains ?? []).map((chain) => chainDot(chain)));
    const track = node("button", `pill${saved.has(item.address.toLowerCase()) ? " on" : ""}`, saved.has(item.address.toLowerCase()) ? t().tracked : t().track);
    track.type = "button";
    track.addEventListener("click", () => void toggle(item.address));
    const action = node("td");
    action.append(track);
    row.append(node("td", "rank", String(index + 1)), who, node("td", "left muted", item.kind[lang]), networks,
      node("td", "", balance === undefined ? t().loading : balance === null ? t().unknown : price(balance.total)), action);
    return row;
  }));
}

// Balances, two wallets at a time; each row fills in as its answer comes.
async function loadBalances() {
  const queue = [...WHALES];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const data = await fetch(`/market/chain/address/${encodeURIComponent(item.address)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      balances.set(item.address, data ? { total: data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0),
        chains: [...new Set(data.assets.map((asset) => asset.chain))] } : null);
      render();
    }
  };
  await Promise.all([worker(), worker()]);
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
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render, onAccount: () => { void loadSaved(); } });
void loadBalances();
void loadOpenNames(WHALES.map((item) => item.address)).then(render);
