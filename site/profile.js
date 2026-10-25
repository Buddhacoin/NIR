// A profile, /u/<username>: the name, bio and join date, the activity anyone
// may see (joining; comments come next) and, for its owner, the full activity,
// the watchlist and a form to change name, username and bio. /u/me opens the
// visitor's own profile. Shared helpers are in common.js.

const en = {
  nirOpen: "NIR network is open", nirMiners: "Miners online", nirPioneers: "Pioneers", nirMined: "Mined",
  nirPool: "🏆 210,000 NIR for pioneers", nirCta: "Mine NIR with one button →",
  navCoins: "Cryptocurrencies", navNir: "About NIR", navMine: "NIR mining", search: "Search coins",
  edit: "Edit", logout: "Sign out", editTitle: "Profile", fieldName: "Name", fieldUsername: "Username (once a week)",
  fieldBio: "About", save: "Save", cancel: "Cancel", tabActivity: "Activity", tabWatch: "Watchlist", tabComments: "Comments", deleteAccount: "Delete account",
  barMarkets: "Markets", barMine: "Mining", pricesBy: "Prices:", chartsBy: "Charts:", notAdvice: "Not financial advice",
  aboutNir: "About the NIR blockchain →", privacy: "Privacy", terms: "Terms",
};
const words = {
  ru: { loading: "Загружаю профиль…", missing: "Такого профиля нет.", unavailable: "Профиль временно недоступен.",
    since: (date) => `на NIR Markets с ${date}`, joined: "Присоединился к NIR Markets", profile: "Обновил профиль",
    watch: "Добавил в избранное", comment: "Написал о", noComments: "Комментариев пока нет.", noActivity: "Пока здесь пусто.", noWatch: "В избранном пока ничего нет. Нажмите ☆ у монеты.",
    title: (user) => `${user.displayName} (@${user.username}) — NIR Markets` },
  en: { loading: "Loading the profile…", missing: "There is no such profile.", unavailable: "The profile is unavailable right now.",
    since: (date) => `on NIR Markets since ${date}`, joined: "Joined NIR Markets", profile: "Updated the profile",
    watch: "Added to the watchlist", comment: "Commented on", noComments: "No comments yet.", noActivity: "Nothing here yet.", noWatch: "The watchlist is empty. Tap ☆ next to a coin.",
    title: (user) => `${user.displayName} (@${user.username}) — NIR Markets` },
};

const name = decodeURIComponent(location.pathname.split("/")[2] ?? "").toLowerCase();
let page = null;
let market = null;
let view = "activity";
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

function renderView() {
  const box = $("#view");
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
  $("#avatar").replaceChildren(avatar(user, 72));
  $("#display-name").textContent = user.displayName;
  $("#username").textContent = user.username;
  $("#joined").textContent = t().since(new Date(user.joinedAt).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" }));
  $("#bio").textContent = user.bio;
  $("#bio").hidden = !user.bio;
  $("#own-actions").hidden = !own;
  $("#tab-watch").hidden = !own;
  for (const item of document.querySelectorAll(".tabbar a")) item.classList.toggle("on", own && item.id === "tab-account");
  for (const button of document.querySelectorAll("[data-view]")) button.classList.toggle("on", button.dataset.view === view);
  renderView();
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
  button.addEventListener("click", () => { view = button.dataset.view; render(); });
}
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});

setupSearch({ overview: () => market });
setupPage({ en, render });
fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).then((data) => { market = data; render(); }).catch(() => {});
void load();
