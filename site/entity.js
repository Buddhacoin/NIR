// An organisation's page, /entity/?name=<name>: the organisation as one wallet, as on the analytics sites.
// The server adds up the holdings of every address it knows for it (/market/chain/entity, market-chain.mjs
// entitySummary) and gives its recent transfers with its own side shown as its name. The addresses stay on
// the server: the page shows how many there are and one of them half hidden, and a visitor follows the
// organisation as a whole (it joins their portfolio of wallets as "entity:<name>"). Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  portfolio: "Portfolio", transfers: "Transfers", colAsset: "Asset", colAmount: "Amount", colValue: "Value", colTime: "Time", colFrom: "From", colTo: "To", colUsd: "USD",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { addresses: (count) => (count >= 1000 ? `${(count / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} тыс. адресов` : `${count} ${plural(count, "адрес", "адреса", "адресов")}`),
    hidden: (sample, more) => `Адреса скрыты: ${sample}${more ? ` и ещё ${more.toLocaleString("ru-RU")}` : ""}`,
    loaded: (done, all) => `загружено ${done} из ${all}`,
    note: "Сумма по адресам организации, которые знает NIR Markets: открытые базы меток, подписи пользователей и распознавание по поведению. У больших организаций адресов бывает больше, поэтому настоящая сумма может быть выше.",
    satoshiNote: (keys, checked, moved) => `Монеты из ${keys.toLocaleString("ru")} ранних блоков, которые по исследованию Сергио Лернера («Patoshi») добыл Сатоши Накамото; каждый блок принёс 50 BTC. Сервер проверяет каждый адрес в сети: проверено ${checked.toLocaleString("ru")}, потрачено с ${moved.toLocaleString("ru")}. Ещё не проверенные считаются по 50 BTC — почти все они никогда не двигались. Принадлежность Сатоши — вывод исследования, а не доказанный факт.`,
    follow: "＋ В портфель", following: "✓ В портфеле", signIn: "Войдите, чтобы следить за организацией.",
    followed: "Организация в вашем портфеле: её баланс и переводы видны на вкладке «Слежка».", open: "Открыть →",
    noAssets: "Загружаю балансы…", none: "Адресов этой организации не найдено.", noTransfers: "Переводов пока нет: они появятся, когда сервер прочтёт историю её адресов." },
  en: { addresses: (count) => (count >= 1000 ? `${(count / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k addresses` : `${count} address${count === 1 ? "" : "es"}`),
    hidden: (sample, more) => `Addresses hidden: ${sample}${more ? ` and ${more.toLocaleString("en-US")} more` : ""}`,
    loaded: (done, all) => `${done} of ${all} loaded`,
    note: "The sum of the organisation's addresses NIR Markets knows: open label books, users' labels and recognition by behaviour. Big organisations may have more addresses, so the real sum may be higher.",
    satoshiNote: (keys, checked, moved) => `Coins from ${keys.toLocaleString("en")} early blocks that, by Sergio Lerner's research (“Patoshi”), Satoshi Nakamoto mined; each block paid 50 BTC. The server checks every address on the network: ${checked.toLocaleString("en")} checked, ${moved.toLocaleString("en")} spent from. The ones not checked yet count as 50 BTC: almost none have ever moved. That they are Satoshi's is the research's conclusion, not a proven fact.`,
    follow: "＋ Add to portfolio", following: "✓ In your portfolio", signIn: "Sign in to follow the organisation.",
    followed: "The organisation is in your portfolio: its balance and transfers are on the Tracking tab.", open: "Open →",
    noAssets: "Loading balances…", none: "No addresses of this organisation were found.", noTransfers: "No transfers yet: they appear once the server reads its addresses' history." },
};
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
// Russian plural: 1 адрес, 2 адреса, 5 адресов.
const plural = (count, one, few, many) => { const ten = count % 10; const hundred = count % 100;
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many; };
const entity = (new URLSearchParams(location.search).get("name") ?? "").trim().slice(0, 60);
const key = `entity:${entity}`;
const amountText = (value) => (value >= 1e6 ? big(value, "") : value.toLocaleString(locale(), { maximumFractionDigits: value >= 1 ? 2 : 6 }));
let summary = null; // /market/chain/entity
let satoshi = null; // Satoshi Nakamoto's early coins (/market/chain/satoshi), for the note on his page
let saved = null; // the visitor's saved addresses (/market/me/addresses), once signed in

function render() {
  document.title = `${entity || "—"} — NIR Markets`;
  $("#name").textContent = entity || "—";
  const face = walletAvatar({ address: key, name: entity, logo: summary?.logo ?? null });
  $("#avatar").replaceChildren(...face.childNodes);
  $("#avatar").style.background = face.style.background;
  const shield = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
  $("#count").hidden = !summary?.count;
  if (summary?.count) { $("#count").innerHTML = shield; $("#count").append(node("span", "", t().addresses(summary.count))); }
  $("#category").hidden = !categoryName(summary?.category);
  $("#category").textContent = categoryName(summary?.category) ?? "";
  // The addresses stay on the server: one shows half hidden.
  $("#hidden").hidden = !summary?.sample;
  if (summary?.sample) {
    $("#hidden").innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
    $("#hidden").append(node("span", "", t().hidden(summary.sample, Math.max(0, summary.count - 1))));
  }
  $("#total").textContent = summary?.total ? price(summary.total) : "—";
  if (summary && !summary.done && summary.count) $("#total").append(node("small", "muted", ` · ${t().loaded(summary.loaded, summary.count)}`));
  $("#note").textContent = satoshi ? t().satoshiNote(satoshi.keys, satoshi.checked, satoshi.moved) : summary?.count ? t().note : summary ? t().none : "";
  if (satoshi) {
    // The picture's licence asks for its author.
    $("#note").append(" · ", Object.assign(node("a", "muted", language === "en" ? "Photo: Fekist, CC BY-SA 4.0" : "Фото: Fekist, CC BY-SA 4.0"),
      { href: "https://commons.wikimedia.org/wiki/File:Bust_of_Satoshi_Nakamoto_in_Budapest.jpg", target: "_blank", rel: "noopener" }));
  }
  const following = saved?.some((item) => item.address === key);
  $("#follow").textContent = following ? t().following : t().follow;
  $("#follow").classList.toggle("ghost", Boolean(following));
  const assets = summary?.assets ?? [];
  $("#assets").replaceChildren(...(assets.length ? assets.map((row) => {
    const tr = node("tr");
    const name = node("td", "left");
    const cell = node("span", "coin-cell");
    cell.append(logo({ id: row.token.coinId ?? row.token.symbol, symbol: row.token.symbol, image: row.token.icon ?? (row.chain === "btc" ? CHAINS.btc.logo : null) }),
      node("b", "", row.token.symbol), chainDot(row.chain));
    name.append(cell);
    tr.append(name, node("td", "", `${amountText(row.amount)} ${row.token.symbol}`), node("td", "", row.usd === null ? "—" : price(row.usd)));
    return tr;
  }) : [message(summary && !summary.count ? t().none : t().noAssets, 3)]));
  const transfers = summary?.transfers ?? [];
  $("#transfers").replaceChildren(...(transfers.length ? transfers.map((item) => {
    const tr = node("tr");
    const from = node("td", "left");
    from.append(walletLink(item.from, { bubbles: false }));
    const to = node("td", "left");
    to.append(walletLink(item.to, { bubbles: false }));
    const incoming = item.to.address === key;
    tr.append(node("td", "left muted", timeAgo(item.time)), from, to,
      node("td", incoming ? "up" : "down", `${incoming ? "+" : "−"}${item.usd === null ? `${amountText(item.amount ?? 0)} ${item.token.symbol}` : usdShort(item.usd)}`));
    return tr;
  }) : [message(summary ? t().noTransfers : t().noAssets, 4)]));
}
function message(text, span) {
  const tr = node("tr");
  const cell = node("td", "muted ex-empty", text);
  cell.colSpan = span;
  tr.append(cell);
  return tr;
}

// The organisation joins the visitor's first portfolio of wallets (made if there is none), as one wallet.
async function follow() {
  if (!account.user) {
    if (account.signIn) location.href = signInUrl();
    else alert(t().signIn);
    return;
  }
  const following = saved?.some((item) => item.address === key);
  if (following) {
    const { status, data } = await send(`/market/me/addresses/${encodeURIComponent(key)}`, "DELETE");
    if (status === 200) saved = data.addresses;
  } else {
    let portfolios = (await fetch("/market/me/addresses", { cache: "no-store" }).then((response) => response.json()).catch(() => null))?.portfolios ?? [];
    if (!portfolios.length) portfolios = (await send("/market/me/wallet-portfolios", "POST", { name: language === "en" ? "Main" : "Основной" })).data?.portfolios ?? [];
    const { status, data } = await send(`/market/me/addresses/${encodeURIComponent(key)}`, "PUT", { mine: true, label: entity, portfolioId: portfolios[0]?.id ?? null });
    if (status === 200) {
      saved = data.addresses;
      $("#followed").hidden = false;
      $("#followed").replaceChildren(t().followed, " ", Object.assign(node("a", "", t().open), { href: `/u/${encodeURIComponent(account.user.username)}#dash` }));
    }
  }
  render();
}

async function load() {
  if (!entity) { summary = { count: 0, assets: [], transfers: [] }; render(); return; }
  if (/^satoshi nakamoto$/i.test(entity) && !satoshi) {
    satoshi = await fetch("/market/chain/satoshi").then((response) => (response.ok ? response.json() : null)).catch(() => null);
    if (satoshi && !satoshi.keys) satoshi = null;
  }
  // The popular list's well-known wallets of the organisation (public anyway) are counted in too.
  const extra = WHALES.filter((item) => entityName(item.name) === entity).map((item) => item.address);
  const answer = await fetch(`/market/chain/entity?name=${encodeURIComponent(entity)}${extra.length ? `&extra=${extra.join(",")}` : ""}`)
    .then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (answer) summary = answer;
  render();
  // The server reads the addresses' balances in the background: the page asks again until they are all in.
  if (!summary?.done) setTimeout(load, 6_000);
}
async function loadSaved() {
  if (!account.user) return;
  saved = (await fetch("/market/me/addresses", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null))?.addresses ?? null;
  render();
}

$("#follow").addEventListener("click", () => void follow());
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({});
setupPage({ en, render, onAccount: () => { render(); void loadSaved(); } });
void load();
