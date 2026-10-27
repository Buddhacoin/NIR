// A profile, /u/<username>: the name, bio and join date, the activity anyone
// may see (joining; comments come next) and, for its owner, the dashboard of their own wallets
// (dashboard.js), the full activity,
// the watchlist and a form to change name, username and bio. /u/me opens the
// visitor's own profile. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  nirOpen: "NIR network is open", nirMiners: "Miners online", nirPioneers: "Pioneers", nirMined: "Mined",
  nirPool: "🏆 210,000 NIR for pioneers", nirCta: "Mine NIR with one button →",
  navCoins: "Cryptocurrencies", navMine: "NIR mining", search: "Search coins or addresses",
  edit: "Edit", logout: "Sign out", editTitle: "Profile", fieldName: "Name", fieldUsername: "Username (once a week)",
  fieldBio: "About", save: "Save", cancel: "Cancel", tabActivity: "Activity", tabWatch: "Watchlist", tabTracking: "Tracking", tabWallets: "My addresses", tabTracked: "Tracked", tabModeration: "Moderation", tabComments: "Comments", deleteAccount: "Delete account",
  photoChange: "Change photo", photoRemove: "Remove photo",
  barMarkets: "Markets", barMine: "Mining", pricesBy: "Prices:", chartsBy: "Charts:", notAdvice: "Not financial advice",
  aboutNir: "About the NIR blockchain →", privacy: "Privacy", terms: "Terms", dataBy: "Data:", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR",
};
const words = {
  ru: { loading: "Загружаю профиль…", missing: "Такого профиля нет.", unavailable: "Профиль временно недоступен.",
    since: (date) => `на NIR Markets с ${date}`, joined: "Присоединился к NIR Markets", profile: "Обновил профиль",
    watch: "Добавил в избранное", comment: "Написал о", noComments: "Комментариев пока нет.", noActivity: "Пока здесь пусто.", noWatch: "В избранном пока ничего нет. Нажмите ☆ у монеты.",
    title: (user) => `${user.displayName} (@${user.username}) — NIR Markets`,
    addAddress: "Адрес кошелька (0x… или bc1…)", addLabel: "Подпись (необязательно)", add: "Добавить", badAddress: "Это не адрес кошелька.",
    walletsTotal: "Всего на моих адресах", noWallets: "Добавьте адреса своих кошельков — сайт сложит их балансы по всем сетям в один портфель. Адреса видите только вы.",
    noTracked: "Вы пока не отслеживаете адреса. Откройте любой кошелёк (через поиск или ленту «Все переводы») и нажмите «☆ Следить за кошельком» — он появится здесь.",
    remove: "Убрать", loadingWallet: "загружаю…", asset: "Актив", amount: "Количество", value: "Сумма",
    noSuggestions: "Новых подписей на проверку нет.", approve: "Одобрить", reject: "Отклонить", source: "источник", by: "от" },
  en: { loading: "Loading the profile…", missing: "There is no such profile.", unavailable: "The profile is unavailable right now.",
    since: (date) => `on NIR Markets since ${date}`, joined: "Joined NIR Markets", profile: "Updated the profile",
    watch: "Added to the watchlist", comment: "Commented on", noComments: "No comments yet.", noActivity: "Nothing here yet.", noWatch: "The watchlist is empty. Tap ☆ next to a coin.",
    title: (user) => `${user.displayName} (@${user.username}) — NIR Markets`,
    addAddress: "Wallet address (0x… or bc1…)", addLabel: "Label (optional)", add: "Add", badAddress: "This is not a wallet address.",
    walletsTotal: "Total on my addresses", noWallets: "Add your wallets' addresses and the site adds up their balances on every network into one portfolio. Only you see them.",
    noTracked: "You do not track any address yet. Open a wallet (from search or All transfers) and press “☆ Watch wallet”: it shows up here.",
    remove: "Remove", loadingWallet: "loading…", asset: "Asset", amount: "Amount", value: "Value",
    noSuggestions: "No names waiting for review.", approve: "Approve", reject: "Reject", source: "source", by: "by" },
};

const name = decodeURIComponent(location.pathname.split("/")[2] ?? "").toLowerCase();
let page = null;
let market = null;
// A link such as /u/<name>#tracked opens that tab (the wallet page sends visitors there after "Watch").
let view = ["dash", "tracked", "wallets", "watch", "comments", "activity"].includes(location.hash.slice(1)) ? location.hash.slice(1) : null; // null: "Tracking" on one's own profile, else the activity
let failure = "";
const t = () => words[language];
const coinsById = () => new Map((market?.coins ?? []).map((coin) => [coin.id, coin]));

function coinLink(id) {
  const coin = coinsById().get(id) ?? { id, symbol: id.slice(0, 1).toUpperCase(), name: id, image: null };
  const link = document.createElement("a");
  link.className = "coin-link";
  link.href = coinUrl(coin);
  link.append(logo(coin), Object.assign(document.createElement("b"), { textContent: coin.name }));
  return link;
}

// --- Saved wallet addresses: own ones add up into one portfolio; tracked ones are bookmarks.
let saved = null;
let walletPortfolios = []; // the owner's named portfolios of own wallets ({ id, name }), for dashboard.js
const holdings = new Map(); // address → the explorer's answer, or "loading"
async function loadSaved() {
  const answer = await fetch("/market/me/addresses", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  saved = answer?.addresses ?? [];
  walletPortfolios = answer?.portfolios ?? [];
  renderView();
  renderDashboard(); // dashboard.js
}
function holdingsOf(address) {
  if (!holdings.has(address)) {
    holdings.set(address, "loading");
    fetch(`/market/chain/address/${encodeURIComponent(address)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null)
      .then((data) => { holdings.set(address, data ?? "failed"); if (view === "wallets" || view === "tracked") renderView(); renderDashboard(); });
  }
  const data = holdings.get(address);
  return data === "loading" || data === "failed" ? null : data;
}
const totalOf = (data) => (data ? data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0) : null);
function addressRow(item) {
  const row = document.createElement("div");
  row.className = "feed-row";
  const link = walletLink({ address: item.address, name: item.label || null });
  const data = holdingsOf(item.address);
  const value = Object.assign(document.createElement("b"), { textContent: data ? price(totalOf(data)) : holdings.get(item.address) === "failed" ? "—" : t().loadingWallet });
  const drop = Object.assign(document.createElement("button"), { type: "button", className: "pill", textContent: t().remove });
  drop.addEventListener("click", async () => {
    const { status, data: answer } = await send(`/market/me/addresses/${encodeURIComponent(item.address)}`, "DELETE");
    if (status === 200) { saved = answer.addresses; walletPortfolios = answer.portfolios ?? walletPortfolios; renderView(); renderDashboard(); }
  });
  row.append(link, value, drop);
  return row;
}
const draft = { address: "", label: "" };
function renderWallets(box) {
  const focused = document.activeElement?.dataset?.draft ?? null; // the field being typed in keeps the focus
  const mine = saved.filter((item) => item.mine);
  const form = document.createElement("form");
  form.className = "wallet-form";
  // What is being typed survives the redraws that come as each wallet's balance arrives.
  const input = Object.assign(document.createElement("input"), { placeholder: t().addAddress, autocomplete: "off", spellcheck: false, value: draft.address });
  const label = Object.assign(document.createElement("input"), { placeholder: t().addLabel, maxLength: 40, autocomplete: "off", value: draft.label });
  input.dataset.draft = "address";
  label.dataset.draft = "label";
  input.addEventListener("input", () => { draft.address = input.value; });
  label.addEventListener("input", () => { draft.label = label.value; });
  if (focused === "address") setTimeout(() => input.focus());
  if (focused === "label") setTimeout(() => label.focus());
  const button = Object.assign(document.createElement("button"), { type: "submit", className: "act", textContent: t().add });
  const error = Object.assign(document.createElement("p"), { className: "form-error" });
  form.append(input, label, button, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const address = input.value.trim();
    if (!ADDRESS.test(address)) { error.textContent = t().badAddress; return; }
    const { status, data } = await send(`/market/me/addresses/${encodeURIComponent(address)}`, "PUT", { mine: true, label: label.value.trim() });
    if (status !== 200) { error.textContent = data.error ?? t().badAddress; return; }
    saved = data.addresses;
    walletPortfolios = data.portfolios ?? walletPortfolios;
    draft.address = draft.label = "";
    renderView();
    renderDashboard();
  });
  if (!mine.length) { box.replaceChildren(form, Object.assign(document.createElement("p"), { className: "muted", textContent: t().noWallets })); return; }
  // The holdings of every own address, added up by network and token.
  const merged = new Map();
  let total = 0;
  for (const item of mine) {
    const data = holdingsOf(item.address);
    for (const asset of data?.assets ?? []) {
      const key = `${asset.chain}:${asset.token.address ?? asset.token.symbol}`;
      const entry = merged.get(key) ?? { ...asset, amount: 0, usd: 0 };
      entry.amount += asset.amount;
      entry.usd += asset.usd ?? 0;
      merged.set(key, entry);
      total += asset.usd ?? 0;
    }
  }
  const head = document.createElement("div");
  head.className = "wallets-total";
  head.append(Object.assign(document.createElement("small"), { className: "muted", textContent: t().walletsTotal }), Object.assign(document.createElement("b"), { textContent: price(total) }));
  const table = document.createElement("table");
  table.className = "ex-table pr-assets";
  const header = document.createElement("tr");
  for (const [text, left] of [[t().asset, true], ["", true], [t().amount], [t().value]]) header.append(Object.assign(document.createElement("th"), { className: left ? "left" : "", textContent: text }));
  const thead = document.createElement("thead");
  thead.append(header);
  const body = document.createElement("tbody");
  body.append(...[...merged.values()].sort((left, right) => right.usd - left.usd).slice(0, 50).map((asset) => {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "left";
    const cell = Object.assign(document.createElement("span"), { className: "coin-cell" });
    cell.append(logo({ id: asset.token.symbol, symbol: asset.token.symbol, image: asset.token.icon }), Object.assign(document.createElement("b"), { textContent: asset.token.symbol }));
    name.append(cell);
    const network = document.createElement("td");
    network.className = "left";
    network.append(chainDot(asset.chain));
    row.append(name, network, Object.assign(document.createElement("td"), { textContent: `${amountShort(asset.amount)} ${asset.token.symbol}` }),
      Object.assign(document.createElement("td"), { textContent: price(asset.usd) }));
    return row;
  }));
  table.append(thead, body);
  box.replaceChildren(form, head, ...mine.map(addressRow), table);
}

// --- Moderation: wallet names suggested by visitors, approved or rejected here.
let suggestions = null;
async function loadSuggestions() {
  const answer = await fetch("/market/labels/pending", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  suggestions = answer?.suggestions ?? [];
  renderView();
}
function renderModeration(box) {
  if (suggestions === null) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().loading })); void loadSuggestions(); return; }
  if (!suggestions.length) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().noSuggestions })); return; }
  box.replaceChildren(...suggestions.map((item) => {
    const row = document.createElement("div");
    row.className = "feed-row";
    row.append(walletLink({ address: item.address, name: null }), Object.assign(document.createElement("b"), { textContent: `«${item.name}»` }));
    if (item.link) row.append(Object.assign(document.createElement("a"), { href: item.link, target: "_blank", rel: "noopener nofollow", textContent: t().source }));
    if (item.username) row.append(Object.assign(document.createElement("small"), { className: "muted", textContent: `${t().by} @${item.username}` }));
    for (const [action, label] of [["approve", t().approve], ["reject", t().reject]]) {
      const button = Object.assign(document.createElement("button"), { type: "button", className: action === "approve" ? "act" : "pill", textContent: label });
      button.addEventListener("click", async () => {
        const { status, data } = await send(`/market/labels/${item.id}/${action}`, "POST");
        if (status === 200) { suggestions = data.suggestions; renderView(); }
      });
      row.append(button);
    }
    return row;
  }));
}

function renderView() {
  const box = $("#view");
  if (view === "moderation") { renderModeration(box); return; }
  if (view === "wallets" || view === "tracked") {
    if (saved === null) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().loading })); void loadSaved(); return; }
    if (view === "wallets") { renderWallets(box); return; }
    const tracked = saved.filter((item) => !item.mine);
    box.replaceChildren(...(tracked.length ? tracked.map(addressRow) : [Object.assign(document.createElement("p"), { className: "muted", textContent: t().noTracked })]));
    return;
  }
  if (view === "watch") {
    const ids = [...watch];
    if (!ids.length) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().noWatch })); return; }
    box.replaceChildren(...ids.map((id) => {
      const row = document.createElement("div");
      row.className = "feed-row";
      const coin = coinsById().get(id);
      const change = document.createElement("span");
      if (coin) { change.className = changeClass(coin.change24h); change.textContent = `${price(coin.price)} · ${percentText(coin.change24h)}`; }
      row.append(coinLink(id), change);
      return row;
    }));
    return;
  }
  if (view === "comments") {
    if (!page.comments.length) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().noComments })); return; }
    box.replaceChildren(...page.comments.map((comment) => {
      const row = document.createElement("div");
      row.className = "feed-row comment-row";
      const when = Object.assign(document.createElement("small"), { className: "muted",
        textContent: new Date(comment.createdAt).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) });
      row.append(coinLink(comment.coinId), when, Object.assign(document.createElement("p"), { textContent: comment.body }));
      return row;
    }));
    return;
  }
  const items = page.activity;
  if (!items.length) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().noActivity })); return; }
  box.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = "feed-row";
    const what = Object.assign(document.createElement("span"), { textContent: t()[item.kind] ?? item.kind });
    const when = Object.assign(document.createElement("small"), { className: "muted",
      textContent: new Date(item.at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) });
    row.append(what);
    if (item.coinId) row.append(coinLink(item.coinId));
    row.append(when);
    return row;
  }));
}

function render() {
  if (!page) { $("#status").textContent = failure || t().loading; return; }
  const { user, own } = page;
  document.title = t().title(user);
  $("#status").textContent = "";
  $("#page").hidden = false;
  $("#avatar").replaceChildren(avatar(user, 96));
  $("#photo-remove").hidden = !user.avatar;
  $("#display-name").textContent = user.displayName;
  $("#username").textContent = user.username;
  $("#joined").textContent = t().since(new Date(user.joinedAt).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" }));
  $("#bio").textContent = user.bio;
  $("#bio").hidden = !user.bio;
  $("#own-actions").hidden = !own;
  $("#tab-watch").hidden = !own;
  $("#tab-wallets").hidden = !own;
  $("#tab-tracked").hidden = !own;
  $("#tab-dash").hidden = !own;
  if (!view || (view === "dash" && !own)) view = own ? "dash" : "activity";
  // "Tracking" is the dashboard; any other tab shows its own section in its place.
  $("#view").hidden = view === "dash";
  $("#tab-moderation").hidden = !own || !account.moderator;
  for (const item of document.querySelectorAll(".tabbar a")) item.classList.toggle("on", own && item.id === "tab-account");
  for (const button of document.querySelectorAll("[data-view]")) button.classList.toggle("on", button.dataset.view === view);
  renderView();
  renderDashboard();
}

async function load() {
  // /u/me is the visitor's own profile, or Google sign-in first.
  if (name === "me") {
    const me = await fetch("/market/me", { cache: "no-store" }).then((response) => response.json()).catch(() => null);
    if (me?.user) location.replace(`/u/${me.user.username}`);
    else if (me?.signIn) location.replace(`/market/auth/google?return=${encodeURIComponent("/u/me")}`);
    else { failure = t().missing; render(); }
    return;
  }
  const response = await fetch(`/market/u/${encodeURIComponent(name)}`, { cache: "no-store" }).catch(() => null);
  if (response?.status === 404 || !/^[a-z0-9_]{3,20}$/.test(name)) failure = t().missing;
  else if (!response?.ok) failure = t().unavailable;
  else page = await response.json();
  render();
}

$("#edit").addEventListener("click", () => {
  $("#form").hidden = false;
  $("#f-name").value = page.user.displayName;
  $("#f-username").value = page.user.username;
  $("#f-bio").value = page.user.bio;
  $("#f-error").textContent = "";
  $("#f-name").focus();
});
$("#cancel").addEventListener("click", () => { $("#form").hidden = true; });
$("#form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { status, data } = await send("/market/me", "PATCH",
    { displayName: $("#f-name").value, username: $("#f-username").value, bio: $("#f-bio").value });
  if (status !== 200) { $("#f-error").textContent = data.error ?? "Error"; return; }
  if (data.user.username !== name) { location.replace(`/u/${data.user.username}`); return; }
  $("#form").hidden = true;
  await load();
});
// A new picture: cut to a square in the middle, made 128 px and sent as a small JPEG.
async function choosePhoto(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return;
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement("canvas"), { width: 128, height: 128 });
  canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
  let image = "";
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    image = canvas.toDataURL("image/jpeg", quality);
    if (image.length < 15_000) break;
  }
  const { status, data } = await send("/market/me/avatar", "PUT", { image });
  if (status !== 200) { alert(data?.error ?? "Error"); return; }
  page.user = data.user;
  if (account.user) { account.user.avatar = data.user.avatar; renderAccount(); }
  render();
}
$("#avatar-file").addEventListener("change", (event) => { void choosePhoto(event.target.files?.[0]); event.target.value = ""; });
$("#photo-change").addEventListener("click", () => $("#avatar-file").click());
$("#photo-remove").addEventListener("click", async () => {
  const { status, data } = await send("/market/me/avatar", "DELETE");
  if (status !== 200) return;
  page.user = data.user;
  if (account.user) { account.user.avatar = null; renderAccount(); }
  render();
});
$("#delete-account").addEventListener("click", async () => {
  const ask = language === "en"
    ? "Delete the account for good? Your profile, watchlist, comments and votes will be removed at once."
    : "Удалить аккаунт навсегда? Профиль, избранное, комментарии и голоса удалятся сразу и без возврата.";
  if (!confirm(ask)) return;
  if ((await send("/market/me", "DELETE")).status === 200) location.href = "/";
});
$("#logout").addEventListener("click", async () => {
  await send("/market/auth/logout", "POST");
  location.href = "/";
});
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => { view = button.dataset.view; history.replaceState(null, "", `#${view}`); render(); });
}
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});

setupSearch({ overview: () => market });
setupPage({ en, render });
fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).then((data) => { market = data; render(); }).catch(() => {});
void load();
