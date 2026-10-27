// Price alerts, /alerts/: the visitor's alerts (switch on or off, delete, add),
// notifications in this browser, and the alerts that fired. Opening the page
// marks fired alerts as seen. Signed out, it asks to sign in with Google.
// Shared helpers are in common.js and alerts-ui.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  loading: "Loading alerts…", title: "Price alerts", add: "+ New alert", browserTitle: "In this browser", mine: "My alerts",
  history: "Fired", barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { above: "выше", below: "ниже", rise: "рост за 24 ч на", fall: "падение за 24 ч на", once: "один раз", every: "каждый раз",
    noAlerts: "Уведомлений пока нет. Нажмите «+ Новое уведомление» или колокольчик на странице монеты.", noEvents: "Пока ничего не сработало.",
    remove: "Удалить", signIn: "Войдите через Google, чтобы создавать уведомления о цене.", signInButton: "Войти через Google",
    off: "Уведомления недоступны: вход на сайте выключен.", turnOff: "Выключить в этом браузере", fired: "сработало",
    title: "Уведомления о цене — NIR Markets" },
  en: { above: "above", below: "below", rise: "24h rise of", fall: "24h fall of", once: "once", every: "every time",
    noAlerts: "No alerts yet. Tap “+ New alert” or the bell on a coin's page.", noEvents: "Nothing has fired yet.",
    remove: "Delete", signIn: "Sign in with Google to create price alerts.", signInButton: "Sign in with Google",
    off: "Alerts are unavailable: sign-in is off on this site.", turnOff: "Turn off in this browser", fired: "fired",
    title: "Price alerts — NIR Markets" },
};
const t = () => words[language];
let market = null;
let data = null;
let marked = false;

const when = (time) => new Date(time).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function condition(item) {
  const percent = item.kind === "rise" || item.kind === "fall";
  const amount = percent ? `${item.value.toLocaleString(locale(), { maximumFractionDigits: 2 })}%` : price(item.value);
  return `${t()[item.kind]} ${amount}`;
}

function renderAlerts() {
  const box = $("#alerts");
  if (!data.alerts.length) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().noAlerts })); return; }
  box.replaceChildren(...data.alerts.map((item) => {
    const row = document.createElement("div");
    row.className = `alert-row${item.active ? "" : " off"}`;
    const what = document.createElement("div");
    what.className = "what";
    const coin = (market?.coins ?? []).find((entry) => entry.id === item.coinId) ?? { id: item.coinId, symbol: item.symbol, name: item.name, image: null };
    const link = Object.assign(document.createElement("a"), { className: "coin-cell", href: coinUrl(coin) });
    link.append(logo(coin), Object.assign(document.createElement("b"), { textContent: item.name }));
    what.append(link, Object.assign(document.createElement("span"), { textContent: condition(item) }),
      Object.assign(document.createElement("small"), { textContent: `${item.repeat ? t().every : t().once}${item.firedAt ? ` · ${t().fired} ${when(item.firedAt)}` : ""}` }));
    const controls = document.createElement("div");
    controls.className = "pf-actions";
    const toggle = Object.assign(document.createElement("button"), { type: "button", className: `switch${item.active ? " on" : ""}`,
      ariaLabel: item.active ? "on" : "off" });
    toggle.addEventListener("click", async () => {
      const { status, data: next } = await send(`/market/me/alerts/${item.id}`, "PUT", { active: !item.active });
      if (status === 200) { data = next; render(); }
    });
    const drop = Object.assign(document.createElement("button"), { type: "button", className: "pill", textContent: t().remove });
    drop.addEventListener("click", async () => {
      const { status, data: next } = await send(`/market/me/alerts/${item.id}`, "DELETE");
      if (status === 200) { data = next; render(); }
    });
    controls.append(toggle, drop);
    row.append(what, controls);
    return row;
  }));
}

function renderEvents() {
  const box = $("#events");
  if (!data.events.length) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: t().noEvents })); return; }
  box.replaceChildren(...data.events.map((event) => {
    const row = Object.assign(document.createElement("a"), { className: `alert-event${event.seen ? "" : " new"}`, href: `/coin/${encodeURIComponent(event.coinId)}` });
    row.append(Object.assign(document.createElement("b"), { textContent: event.title }),
      Object.assign(document.createElement("span"), { textContent: event.body }),
      Object.assign(document.createElement("small"), { className: "muted", textContent: when(event.at) }));
    return row;
  }));
}

async function renderPush() {
  const box = $("#push");
  const state = await pushControl(box);
  if (state === "on") {
    const off = Object.assign(document.createElement("button"), { type: "button", className: "act ghost", textContent: t().turnOff });
    off.addEventListener("click", async () => { await disablePush(); await load(); });
    box.append(off);
  }
}

function render() {
  document.title = t().title;
  if (!data) return;
  $("#status").hidden = true;
  $("#page").hidden = false;
  renderAlerts();
  renderEvents();
}

async function load() {
  if (!account.user) {
    const status = $("#status");
    status.replaceChildren(Object.assign(document.createElement("p"), { textContent: account.signIn ? t().signIn : t().off }));
    if (account.signIn) status.append(Object.assign(document.createElement("a"), { className: "act", href: signInUrl(), textContent: t().signInButton }));
    return;
  }
  const response = await fetch("/market/me/alerts", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  data = await response.json();
  pushKey = data.push.key;
  render();
  await renderPush();
  // Opening the page counts as seeing what fired; the dots stay until the next visit.
  if (!marked && data.unseen) {
    marked = true;
    await send("/market/me/alerts/seen", "POST");
    account.alertsUnseen = 0;
    renderBell();
  }
}

$("#add").addEventListener("click", () => openAlertDialog(null, { overview: () => market, onSaved: (next) => { data = next; render(); } }));
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({ overview: () => market });
setupPage({ en, render, onAccount: () => { void load(); } });
fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).then((next) => { market = next; render(); }).catch(() => {});
