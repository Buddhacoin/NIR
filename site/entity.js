// An organisation's page, /entity/?name=<name>: every wallet the open labels' book knows for it
// (/market/chain/entity, market-names.mjs members), plus the well-known ones in the popular list, each
// with its balance (/market/chain/address, a few at a time), the total, and the assets of all of them
// added up by token. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  note: "The sum of the organisation's wallets known to the open labels. Big organisations have more wallets than the open book knows, so the real sum may be higher.",
  portfolio: "Portfolio", wallets: "Wallets", colAsset: "Asset", colAmount: "Amount", colValue: "Value", colWallet: "Wallet",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { satoshiCount: (keys, checked) => (checked < keys ? `${keys.toLocaleString("ru")} адресов · проверено ${checked.toLocaleString("ru")}` : `${keys.toLocaleString("ru")} адресов`),
    satoshiNote: (keys, checked, moved) => `Монеты из ${keys.toLocaleString("ru")} ранних блоков, которые по исследованию Сергио Лернера («Patoshi») добыл Сатоши Накамото; каждый блок принёс 50 BTC. Сервер проверяет каждый адрес в сети: проверено ${checked.toLocaleString("ru")}, потрачено с ${moved.toLocaleString("ru")}. Ещё не проверенные считаются по 50 BTC — почти все они никогда не двигались. Принадлежность Сатоши — вывод исследования, а не доказанный факт.`,
    count: (done, all) => (done < all ? `${all} адресов · загружено ${done}` : `${all} адресов`), loading: "загружаю…", none: "Адресов этой организации не найдено.", failed: "—" },
  en: { satoshiCount: (keys, checked) => (checked < keys ? `${keys.toLocaleString("en")} wallets · ${checked.toLocaleString("en")} checked` : `${keys.toLocaleString("en")} wallets`),
    satoshiNote: (keys, checked, moved) => `Coins from ${keys.toLocaleString("en")} early blocks that, by Sergio Lerner's research (“Patoshi”), Satoshi Nakamoto mined; each block paid 50 BTC. The server checks every address on the network: ${checked.toLocaleString("en")} checked, ${moved.toLocaleString("en")} spent from. The ones not checked yet count as 50 BTC: almost none have ever moved. That they are Satoshi's is the research's conclusion, not a proven fact.`,
    count: (done, all) => (done < all ? `${all} wallets · ${done} loaded` : `${all} wallets`), loading: "loading…", none: "No wallets of this organisation were found.", failed: "—" },
};
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const entity = (new URLSearchParams(location.search).get("name") ?? "").trim().slice(0, 60);
let members = null; // [{ address, name, logo }]
const balances = new Map(); // address → holdings answer, or "failed"

const amountText = (value) => (value >= 1e6 ? big(value, "") : value.toLocaleString(locale(), { maximumFractionDigits: value >= 1 ? 2 : 6 }));
let satoshi = null; // Satoshi Nakamoto's early coins (/market/chain/satoshi), on his page only
function renderSatoshi() {
  const { keys, checked, moved, estimate, price: rate } = satoshi;
  $("#total").textContent = rate ? price(estimate * rate) : `${estimate.toLocaleString(locale(), { maximumFractionDigits: 0 })} BTC`;
  $("#count").textContent = t().satoshiCount(keys, checked);
  $("#note").textContent = t().satoshiNote(keys, checked, moved);
  const tr = node("tr");
  const name = node("td", "left");
  const cell = node("span", "coin-cell");
  cell.append(logo({ id: "bitcoin", symbol: "BTC", image: null }), node("b", "", "BTC"));
  name.append(cell);
  tr.append(name, node("td", "", `${estimate.toLocaleString(locale(), { maximumFractionDigits: 0 })} BTC`), node("td", "", rate ? price(estimate * rate) : "—"));
  $("#assets").replaceChildren(tr);
}
function render() {
  document.title = `${entity || "—"} — NIR Markets`;
  $("#name").textContent = entity || "—";
  if (satoshi) { renderSatoshi(); }
  if (!members) return;
  const first = members.find((item) => item.logo) ?? members[0];
  if (first) {
    const face = walletAvatar({ address: first.address, name: entity, logo: first.logo });
    $("#avatar").replaceChildren(...face.childNodes);
    $("#avatar").style.background = face.style.background;
  }
  const loaded = members.filter((item) => balances.has(item.address));
  const total = loaded.reduce((sum, item) => sum + (balances.get(item.address)?.assets?.reduce((all, asset) => all + (asset.usd ?? 0), 0) ?? 0), 0);
  if (!satoshi) {
    $("#total").textContent = price(total);
    $("#count").textContent = t().count(loaded.length, members.length);
  }
  // Every asset of every wallet, added up by token.
  const tokens = new Map();
  for (const item of loaded) {
    for (const asset of balances.get(item.address)?.assets ?? []) {
      const key = asset.token.coinId ?? `${asset.token.symbol}`;
      const entry = tokens.get(key) ?? { token: asset.token, amount: 0, usd: 0 };
      entry.amount += asset.amount;
      entry.usd += asset.usd ?? 0;
      tokens.set(key, entry);
    }
  }
  const assets = [...tokens.values()].sort((left, right) => right.usd - left.usd).slice(0, 100);
  if (!satoshi) $("#assets").replaceChildren(...assets.map((row) => {
    const tr = node("tr");
    const name = node("td", "left");
    const cell = node("span", "coin-cell");
    cell.append(logo({ id: row.token.coinId ?? row.token.symbol, symbol: row.token.symbol, image: row.token.icon ?? null }), node("b", "", row.token.symbol));
    name.append(cell);
    tr.append(name, node("td", "", `${amountText(row.amount)} ${row.token.symbol}`), node("td", "", price(row.usd)));
    return tr;
  }));
  const rows = [...members].sort((left, right) => sum(right) - sum(left));
  $("#wallets").replaceChildren(...(rows.length ? rows.map((item) => {
    const tr = node("tr");
    const who = node("td", "left");
    who.append(walletLink({ address: item.address, name: item.name, logo: item.logo }));
    const data = balances.get(item.address);
    tr.append(who, node("td", "", data === undefined ? t().loading : data === "failed" ? t().failed : price(sum(item))));
    return tr;
  }) : [(() => { const tr = node("tr"); const cell = node("td", "muted ex-empty", t().none); cell.colSpan = 2; tr.append(cell); return tr; })()]));
}
function sum(item) {
  const data = balances.get(item.address);
  return data && data !== "failed" ? data.assets.reduce((all, asset) => all + (asset.usd ?? 0), 0) : -1;
}

async function load() {
  if (!entity) { members = []; render(); return; }
  // Satoshi Nakamoto: his early blocks' coins, counted by the server.
  if (/^satoshi nakamoto$/i.test(entity)) {
    satoshi = await fetch("/market/chain/satoshi").then((response) => (response.ok ? response.json() : null)).catch(() => null);
    if (satoshi && !satoshi.keys) satoshi = null;
  }
  const answer = await fetch(`/market/chain/entity?name=${encodeURIComponent(entity)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  // The popular list's well-known wallets of the organisation join the open book's.
  const known = WHALES.filter((item) => entityName(item.name) === entity).map((item) => ({ address: item.address, name: item.name, logo: null }));
  const seen = new Set();
  members = [...known, ...(answer?.members ?? [])].filter((item) => !seen.has(item.address.toLowerCase()) && seen.add(item.address.toLowerCase()));
  render();
  // A few wallets at a time, so the explorers are not flooded.
  let next = 0;
  const pump = async () => {
    while (next < members.length) {
      const item = members[next++];
      const data = await fetch(`/market/chain/address/${encodeURIComponent(item.address)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      balances.set(item.address, data ?? "failed");
      render();
    }
  };
  await Promise.all([pump(), pump(), pump()]);
}

$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render });
void load();
