// The portfolio, /portfolio/: buy and sell records turned into holdings at
// today's prices, with the balance and its 24-hour change, profit and loss
// for all time, the average buy price and each coin's share. Signed in, the
// records live on the server (/market/me/portfolio) and follow the visitor;
// signed out, they stay in this browser and join the account on sign-in.
// Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navPortfolio: "Portfolio", navNir: "NIR", search: "Search coins",
  guestNote: "The portfolio is kept in this browser.", guestSign: "Sign in with Google to have it on all your devices →",
  balance: "Current balance", addTx: "+ Add transaction", allTime: "All-time profit", costBasis: "Cost basis",
  best: "Best in 24h", worst: "Worst in 24h", assets: "Assets", colCoin: "Coin", colPrice: "Price", col24h: "24h",
  colHoldings: "Holdings", colAvg: "Avg. buy price", colPnl: "Profit / loss",
  emptyTitle: "Your portfolio will be here",
  emptyText: "Add a coin you bought and the site works out the balance, the average buy price and the profit at today's prices.",
  close: "Close", addTxTitle: "Transaction", buy: "Buy", sell: "Sell", fieldCoin: "Coin", fieldAmount: "Quantity",
  fieldPrice: "Price per coin, $", fieldDate: "Date and time", fieldFee: "Fee, $", fieldNote: "Note", total: "Total", save: "Save",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { others: "Остальные", spent: "Потрачено", received: "Получено", buy: "Покупка", sell: "Продажа", edit: "Изменить",
    remove: "Удалить", sure: "Удалить эту сделку?", history: (name) => `Сделки: ${name}`, add: "Добавить сделку", deals: "Сделки",
    fee: "комиссия", pickCoin: "Выберите монету из списка.", badNumber: "Введите количество и цену числами больше нуля.",
    tooMuch: (amount) => `В портфеле только ${amount}.`, failed: "Не сохранилось. Попробуйте ещё раз.",
    title: "Портфель — NIR Markets", noPrice: "нет цены" },
  en: { others: "Others", spent: "Spent", received: "Received", buy: "Buy", sell: "Sell", edit: "Edit", remove: "Delete",
    sure: "Delete this transaction?", history: (name) => `Transactions: ${name}`, add: "Add transaction", deals: "Transactions",
    fee: "fee", pickCoin: "Pick a coin from the list.", badNumber: "Enter the quantity and price as numbers above zero.",
    tooMuch: (amount) => `The portfolio holds only ${amount}.`, failed: "Not saved. Please try again.",
    title: "Portfolio — NIR Markets", noPrice: "no price" },
};
const t = () => words[language];
const LOCAL = "nir-portfolio";
const COLORS = ["#3861fb", "#16c784", "#f3a12f", "#8b7bff", "#ea3943", "#2ee6a6", "#f7931a"];

let market = null;
let records = [];
let loaded = false;
const coins = new Map(); // id → name, symbol, image, price, change24h
let opened = null; // the coin whose transactions are shown
let editing = null; // the record being edited, or null for a new one
let kind = "buy";
let picked = null; // the coin chosen in the form

// --- Records: on the server when signed in, in this browser otherwise.
const localRecords = () => { try { return JSON.parse(store.get(LOCAL) ?? "[]").filter((item) => item && typeof item === "object"); } catch { return []; } };
const saveLocal = (list) => store.set(LOCAL, JSON.stringify(list));
async function loadRecords() {
  if (account.user) {
    // Records kept in this browser before signing in join the account once.
    const local = localRecords();
    if (local.length) {
      const { status } = await send("/market/me/portfolio", "POST", { transactions: local.map(({ id, ...record }) => record) });
      if (status === 201) store.set(LOCAL, "[]");
    }
    const response = await fetch("/market/me/portfolio", { cache: "no-store" }).catch(() => null);
    records = response?.ok ? (await response.json()).transactions : [];
  } else {
    records = localRecords();
  }
  loaded = true;
  await loadPrices();
  render();
}
async function save(record) {
  if (account.user) {
    const { status, data } = editing
      ? await send(`/market/me/portfolio/${editing.id}`, "PUT", record)
      : await send("/market/me/portfolio", "POST", record);
    if (status !== 200 && status !== 201) return data.error ?? t().failed;
    records = data.transactions;
  } else {
    const list = localRecords();
    if (editing) Object.assign(list.find((item) => item.id === editing.id) ?? {}, record);
    else list.push({ ...record, id: Date.now() * 1000 + Math.floor(Math.random() * 1000) });
    saveLocal(list);
    records = list;
  }
  return null;
}
async function remove(record) {
  if (account.user) {
    const { status, data } = await send(`/market/me/portfolio/${record.id}`, "DELETE");
    if (status === 200) records = data.transactions;
  } else {
    records = localRecords().filter((item) => item.id !== record.id);
    saveLocal(records);
  }
  render();
}

// --- Prices: the top coins come with the overview; any other coin is asked for once.
function remember(coin) {
  if (!coin?.id) return;
  coins.set(coin.id, { ...coins.get(coin.id), ...Object.fromEntries(Object.entries(coin).filter(([, value]) => value !== null && value !== undefined)) });
}
async function loadPrices() {
  for (const coin of market?.coins ?? []) remember(coin);
  const missing = [...new Set(records.map((record) => record.coinId))].filter((id) => !Number.isFinite(coins.get(id)?.price));
  await Promise.all(missing.map((id) => fetch(`/market/coin/${encodeURIComponent(id)}`).then((response) => (response.ok ? response.json() : null))
    .then((coin) => { if (coin) remember({ id: coin.id, name: coin.name, symbol: coin.symbol, image: coin.image, price: coin.price, change24h: coin.change24h }); })
    .catch(() => {})));
}

// --- Holdings by the average-cost method: a sale takes coins at the average price paid.
function holdings() {
  const byCoin = new Map();
  for (const record of [...records].sort((left, right) => left.at - right.at || left.id - right.id)) {
    const item = byCoin.get(record.coinId) ?? { id: record.coinId, amount: 0, cost: 0, realized: 0, invested: 0, records: [] };
    if (record.kind === "buy") {
      item.amount += record.amount;
      item.cost += record.amount * record.price + record.fee;
      item.invested += record.amount * record.price + record.fee;
    } else {
      const average = item.amount > 0 ? item.cost / item.amount : 0;
      const sold = Math.min(record.amount, item.amount);
      item.cost -= average * sold;
      item.realized += sold * record.price - record.fee - average * sold;
      item.amount -= sold;
    }
    item.records.push(record);
    byCoin.set(record.coinId, item);
  }
  return [...byCoin.values()].map((item) => {
    const coin = coins.get(item.id) ?? {};
    const value = Number.isFinite(coin.price) ? item.amount * coin.price : null;
    const before = value !== null && Number.isFinite(coin.change24h) ? value / (1 + coin.change24h / 100) : value;
    const profit = value === null ? null : value - item.cost + item.realized;
    return { ...item, coin, value, dayChange: value === null ? 0 : value - before, profit,
      profitPct: profit === null || !item.invested ? null : profit / item.invested * 100,
      average: item.amount > 1e-12 ? item.cost / item.amount : null };
  }).sort((left, right) => (right.value ?? 0) - (left.value ?? 0));
}

// --- Drawing.
const amountText = (value, symbol = "") => `${value.toLocaleString(locale(), { maximumFractionDigits: value >= 1 ? 4 : 8 })}${symbol ? ` ${symbol}` : ""}`;
const signed = (value) => (value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${price(Math.abs(value))}`);
function setChange(node, value, text = percentText(value)) {
  node.className = changeClass(value);
  node.textContent = value === null ? "" : text;
}
function coinName(item) {
  const link = document.createElement("a");
  link.className = "coin-cell";
  link.href = coinUrl({ id: item.id });
  const name = item.coin.name ?? item.id;
  link.title = `${name}${item.coin.symbol ? ` (${item.coin.symbol})` : ""}`;
  link.append(logo({ id: item.id, symbol: item.coin.symbol ?? item.id.slice(0, 1).toUpperCase(), image: item.coin.image ?? null }),
    Object.assign(document.createElement("b"), { textContent: name }),
    Object.assign(document.createElement("span"), { textContent: item.coin.symbol ?? "" }));
  return link;
}
function cell(text, className = "") {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}
function render() {
  document.title = t().title;
  $("#guest").hidden = Boolean(account.user) || !account.signIn;
  $("#guest-sign").href = signInUrl();
  if (!loaded) return;
  const list = holdings();
  const held = list.filter((item) => item.amount > 1e-12 || item.realized);
  const total = held.reduce((sum, item) => sum + (item.value ?? 0), 0);
  const day = held.reduce((sum, item) => sum + item.dayChange, 0);
  const cost = held.reduce((sum, item) => sum + item.cost, 0);
  const invested = held.reduce((sum, item) => sum + item.invested, 0);
  const profit = held.reduce((sum, item) => sum + (item.profit ?? 0), 0);
  $("#balance").textContent = price(total);
  const dayPct = total - day ? day / (total - day) * 100 : 0;
  setChange($("#balance-change"), held.length ? day : null, `${signed(day)} (${percentText(dayPct)}) · ${language === "en" ? "24h" : "24 ч"}`);
  $("#cost").textContent = held.length ? price(cost) : "—";
  setChange($("#pnl"), held.length ? profit : null, signed(profit));
  if (!held.length) $("#pnl").textContent = "—";
  setChange($("#pnl-pct"), held.length && invested ? profit / invested * 100 : null);
  const moving = held.filter((item) => item.amount > 1e-12 && Number.isFinite(item.coin.change24h));
  const best = moving.reduce((top, item) => (!top || item.coin.change24h > top.coin.change24h ? item : top), null);
  const worst = moving.reduce((low, item) => (!low || item.coin.change24h < low.coin.change24h ? item : low), null);
  for (const [key, item] of [["best", best], ["worst", worst]]) {
    $(`#${key}`).textContent = item ? item.coin.symbol ?? item.id : "—";
    setChange($(`#${key}-pct`), item ? item.coin.change24h : null);
  }
  // Each coin's share of the balance; the smallest are joined as "Others".
  const parts = held.filter((item) => item.value > 0).map((item) => ({ name: item.coin.symbol ?? item.id, share: item.value / total * 100 }));
  const shown = parts.slice(0, COLORS.length - 1);
  const rest = parts.slice(COLORS.length - 1).reduce((sum, part) => sum + part.share, 0);
  if (rest) shown.push({ name: t().others, share: rest });
  $("#alloc-bar").replaceChildren(...shown.map((part, index) => Object.assign(document.createElement("i"),
    { title: `${part.name} ${part.share.toFixed(1)}%`, style: `width:${part.share.toFixed(2)}%;background:${COLORS[index]}` })));
  $("#alloc-legend").replaceChildren(...shown.map((part, index) => {
    const item = document.createElement("span");
    item.append(Object.assign(document.createElement("i"), { style: `background:${COLORS[index]}` }),
      Object.assign(document.createElement("b"), { textContent: part.name }), ` ${part.share.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`);
    return item;
  }));
  $("#alloc-bar").hidden = $("#alloc-legend").hidden = !shown.length;

  $("#empty").hidden = held.length > 0;
  $("#holdings-table").hidden = !held.length;
  $("#holdings").replaceChildren(...held.map((item) => {
    const row = document.createElement("tr");
    row.className = "coin";
    const name = document.createElement("td");
    name.className = "left";
    name.append(coinName(item));
    const amount = document.createElement("td");
    amount.append(Object.assign(document.createElement("b"), { textContent: item.value === null ? t().noPrice : price(item.value) }),
      Object.assign(document.createElement("small"), { className: "muted pf-sub", textContent: amountText(item.amount, item.coin.symbol) }));
    const result = document.createElement("td");
    result.className = "hide-s";
    result.append(Object.assign(document.createElement("b"), { className: changeClass(item.profit), textContent: signed(item.profit) }),
      Object.assign(document.createElement("small"), { className: `pf-sub ${changeClass(item.profitPct)}`, textContent: percentText(item.profitPct) }));
    const actions = document.createElement("td");
    actions.className = "hide-s";
    const buttons = document.createElement("span");
    buttons.className = "pf-actions";
    const plus = Object.assign(document.createElement("button"), { type: "button", className: "pill", textContent: "+", title: t().add });
    plus.addEventListener("click", (event) => { event.stopPropagation(); openDialog(null, item.id); });
    const more = Object.assign(document.createElement("button"), { type: "button", className: "pill", textContent: t().deals });
    more.addEventListener("click", (event) => { event.stopPropagation(); showHistory(item.id); });
    buttons.append(plus, more);
    actions.append(buttons);
    const day24 = percentCell(item.coin.change24h ?? null);
    day24.classList.add("hide-s");
    row.append(name, cell(Number.isFinite(item.coin.price) ? price(item.coin.price) : "—"), day24, amount,
      cell(item.average === null ? "—" : price(item.average), "hide-s"), result, actions);
    row.addEventListener("click", (event) => { if (!event.target.closest("a")) showHistory(item.id); });
    return row;
  }));
  renderHistory(list);
}

function showHistory(id) {
  opened = id;
  render();
  $("#history").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function renderHistory(list) {
  const item = list.find((entry) => entry.id === opened);
  $("#history").hidden = !item;
  if (!item) return;
  $("#history-title").textContent = t().history(item.coin.name ?? item.id);
  $("#history-list").replaceChildren(...[...item.records].reverse().map((record) => {
    const row = document.createElement("div");
    row.className = "feed-row pf-record";
    const what = Object.assign(document.createElement("b"), { className: record.kind === "buy" ? "up" : "down", textContent: t()[record.kind] });
    const when = Object.assign(document.createElement("small"), { className: "muted",
      textContent: new Date(record.at).toLocaleString(locale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) });
    const detail = Object.assign(document.createElement("span"), {
      textContent: `${amountText(record.amount, item.coin.symbol)} × ${price(record.price)}${record.fee ? ` · ${t().fee} ${price(record.fee)}` : ""}` });
    const sum = Object.assign(document.createElement("b"), { textContent: `${record.kind === "buy" ? t().spent : t().received} ${price(record.amount * record.price + (record.kind === "buy" ? record.fee : -record.fee))}` });
    const edit = Object.assign(document.createElement("button"), { type: "button", className: "pill", textContent: t().edit });
    edit.addEventListener("click", () => openDialog(record));
    const drop = Object.assign(document.createElement("button"), { type: "button", className: "pill", textContent: t().remove });
    drop.addEventListener("click", () => { if (confirm(t().sure)) void remove(record); });
    row.append(what, when, detail, sum);
    if (record.note) row.append(Object.assign(document.createElement("p"), { className: "muted", textContent: record.note }));
    const buttons = document.createElement("span");
    buttons.className = "pf-actions";
    buttons.append(edit, drop);
    row.append(buttons);
    return row;
  }));
}

// --- The transaction form.
const number = (text) => Number(String(text).replace(/\s/g, "").replace(",", "."));
const localTime = (time) => { const date = new Date(time); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };
function setKind(next) {
  kind = next;
  for (const button of document.querySelectorAll("#kind [data-kind]")) button.classList.toggle("on", button.dataset.kind === kind);
  updateTotal();
}
function pick(coin) {
  picked = coin;
  remember(coin);
  $("#f-coin").value = coin ? `${coin.name} (${coin.symbol})` : "";
  $("#f-suggest").hidden = true;
  if (coin && !editing && Number.isFinite(coins.get(coin.id)?.price)) $("#f-price").value = String(coins.get(coin.id).price);
  updateTotal();
}
function openDialog(record, coinId = null) {
  editing = record;
  setKind(record?.kind ?? "buy");
  const id = record?.coinId ?? coinId;
  const coin = id ? { id, ...coins.get(id) } : null;
  picked = null;
  $("#f-amount").value = record ? String(record.amount) : "";
  $("#f-price").value = record ? String(record.price) : "";
  $("#f-fee").value = record?.fee ? String(record.fee) : "";
  $("#f-note").value = record?.note ?? "";
  $("#f-date").value = localTime(record?.at ?? Date.now());
  $("#f-error").textContent = "";
  pick(coin?.name ? coin : null);
  $("#dialog").showModal();
  (coin ? $("#f-amount") : $("#f-coin")).focus();
}
function updateTotal() {
  const amount = number($("#f-amount").value) || 0;
  const cost = amount * (number($("#f-price").value) || 0);
  const fee = number($("#f-fee").value) || 0;
  $("#f-total").textContent = price(kind === "buy" ? cost + fee : cost - fee);
}
// Coin suggestions: the top coins at once, any other coin from /market/search.
let searchTimer = null;
function suggest() {
  const query = $("#f-coin").value.trim().toLowerCase();
  picked = null;
  const box = $("#f-suggest");
  if (!query) { box.hidden = true; return; }
  const draw = (list) => {
    box.replaceChildren(...list.slice(0, 8).map((coin) => {
      const option = document.createElement("a");
      option.href = "#";
      option.append(logo(coin), Object.assign(document.createElement("b"), { textContent: coin.name }),
        Object.assign(document.createElement("span"), { className: "muted", textContent: coin.symbol }));
      option.addEventListener("mousedown", (event) => { event.preventDefault(); pick(coin); $("#f-amount").focus(); });
      return option;
    }));
    box.hidden = !list.length;
  };
  const local = (market?.coins ?? []).filter((coin) => coin.name.toLowerCase().includes(query) || coin.symbol.toLowerCase().startsWith(query));
  draw(local);
  clearTimeout(searchTimer);
  if (query.length < 2) return;
  searchTimer = setTimeout(async () => {
    const found = await fetch(`/market/search?q=${encodeURIComponent(query)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
    if ($("#f-coin").value.trim().toLowerCase() !== query || !found?.coins) return;
    const seen = new Set(local.map((coin) => coin.id));
    draw([...local, ...found.coins.filter((coin) => !seen.has(coin.id))]);
  }, 300);
}

$("#f-coin").addEventListener("input", suggest);
$("#f-coin").addEventListener("blur", () => setTimeout(() => { $("#f-suggest").hidden = true; }, 150));
for (const field of ["#f-amount", "#f-price", "#f-fee"]) $(field).addEventListener("input", updateTotal);
for (const button of document.querySelectorAll("#kind [data-kind]")) button.addEventListener("click", () => setKind(button.dataset.kind));
$("#dialog-close").addEventListener("click", () => $("#dialog").close());
$("#tx-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!picked) { $("#f-error").textContent = t().pickCoin; return; }
  const record = { coinId: picked.id, kind, amount: number($("#f-amount").value), price: number($("#f-price").value),
    fee: number($("#f-fee").value || "0"), at: new Date($("#f-date").value).getTime(), note: $("#f-note").value.trim() };
  if (!(record.amount > 0) || !(record.price >= 0) || !Number.isFinite(record.price) || !(record.fee >= 0) || !Number.isFinite(record.at)) {
    $("#f-error").textContent = t().badNumber;
    return;
  }
  // A sale cannot take more than the portfolio holds.
  if (kind === "sell") {
    const have = holdings().find((item) => item.id === record.coinId)?.amount ?? 0;
    const back = editing?.kind === "sell" && editing.coinId === record.coinId ? editing.amount : 0;
    if (record.amount > have + back + 1e-12) { $("#f-error").textContent = t().tooMuch(amountText(have + back, picked.symbol)); return; }
  }
  const error = await save(record);
  if (error) { $("#f-error").textContent = error; return; }
  $("#dialog").close();
  await loadPrices();
  render();
});
$("#add").addEventListener("click", () => openDialog(null));
$("#add-first").addEventListener("click", () => openDialog(null));
$("#history-close").addEventListener("click", () => { opened = null; render(); });
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});

setupSearch({ overview: () => market });
setupPage({ en, render, onAccount: () => { void loadRecords(); } });
// Without an answer about the account, the records kept in this browser are shown.
setTimeout(() => { if (!loaded) void loadRecords(); }, 5000);
fetch("/market/overview").then((response) => (response.ok ? response.json() : null))
  .then(async (data) => { market = data; if (loaded) { await loadPrices(); render(); } }).catch(() => {});
setInterval(async () => {
  market = await fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).catch(() => market) ?? market;
  if (loaded) { for (const coin of market?.coins ?? []) remember(coin); render(); }
}, 60_000);
