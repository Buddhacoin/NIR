// Portfolios, /portfolio/, laid out like the market sites': named portfolios
// ("folders") in a side list with an overview of them all; for the chosen one
// the balance and its 24-hour change, the value over time or each coin's
// share, the all-time profit against the BTC trend, profit, cost basis, the
// best and worst coin, and tabs with the assets and the transactions.
//
// A transaction is a buy, a sale, or a transfer in or out: coins kept in a
// wallet elsewhere, added at the day's price so that profit counts from
// then. Signed in, everything lives on the server (/market/me/portfolio);
// signed out, in this browser, and it joins the account on sign-in.
// Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  guestNote: "Portfolios are kept in this browser.", guestSign: "Sign in with Google to have them on all your devices →",
  day: "24h:", allTimeShort: "All time:", editShort: "Edit", addShort: "+ Add",
  overview: "Overview", myPortfolios: "My portfolios", createPortfolio: "+ Create portfolio", addTx: "+ Add transaction", export: "Export",
  holdingsTitle: "Holdings", r1: "24h", r7: "7d", r30: "30d", r90: "90d", rAll: "All", history: "History", allocation: "Allocation",
  performance: "Performance", allTime: "All-time profit", btcTrend: "BTC trend", costBasis: "Cost basis", best: "Best performer",
  worst: "Worst performer", assets: "Assets", transactions: "Transactions", colCoin: "Name", colPrice: "Price", col1h: "1h",
  col24h: "24h", col7d: "7d", colHoldings: "Holdings", colAvg: "Avg. buy price", colPnl: "Profit / loss", colActions: "Actions",
  colType: "Type", colAmount: "Amount", colDate: "Date", colFee: "Fees", colNote: "Notes",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { title: "Портфель — NIR Markets", buy: "Покупка", sell: "Продажа", transfer: "Перевод", in: "Перевод на кошелёк", out: "Перевод с кошелька",
    inShort: "Ввод", outShort: "Вывод", others: "Остальные", noPrice: "нет цены", firstName: "Мой портфель",
    newName: "Название портфеля", rename: "Переименовать", remove: "Удалить портфель", sureFolder: (name) => `Удалить портфель «${name}» со всеми сделками?`,
    sureTx: "Удалить эту сделку?", sureCoin: (name) => `Убрать ${name} из портфеля вместе с его сделками?`,
    viewTx: "Сделки", setAmount: "Изменить количество", removeCoin: "Убрать из портфеля", edit: "Изменить", del: "Удалить",
    addTitle: "Добавить сделку", editTitle: "Изменить сделку", pickCoin: "Выберите монету", search: "Поиск", quantity: "Количество",
    pricePer: "Цена за монету", date: "Дата", fee: "Комиссия", notes: "Заметка", totalSpent: "Потрачено", totalReceived: "Получено",
    totalMoved: "Стоимость сейчас", portfolio: "Портфель", save: "Добавить сделку", saveEdit: "Сохранить",
    noCoin: "Выберите монету.", badNumber: "Введите количество больше нуля.", tooMuch: (amount) => `В портфеле только ${amount}.`,
    failed: "Не сохранилось. Попробуйте ещё раз.", amountNow: (symbol) => `Сколько ${symbol} у вас сейчас`,
    amountHint: "Разница запишется переводом на кошелёк или с кошелька по текущей цене.",
    emptyFolders: "Создайте первый портфель", emptyFoldersText: "Портфель — это папка с монетами. Добавьте покупки или просто количество монет на вашем кошельке, и сайт посчитает баланс, прибыль и доли по текущим ценам.",
    emptyCoins: "В портфеле пока нет монет", emptyCoinsText: "Добавьте покупку, продажу или перевод — например, сколько монет лежит на вашем кошельке.",
    create: "Создать портфель", addButton: "+ Добавить сделку", chartLoading: "Строю график…", chartEmpty: "Нет данных для графика за этот период.",
    hidden: "••••••", txEmpty: "Сделок пока нет.", folderLimit: "Можно создать не больше 20 портфелей." },
  en: { title: "Portfolio — NIR Markets", buy: "Buy", sell: "Sell", transfer: "Transfer", in: "Transfer in", out: "Transfer out",
    inShort: "In", outShort: "Out", others: "Others", noPrice: "no price", firstName: "My portfolio",
    newName: "Portfolio name", rename: "Rename", remove: "Delete portfolio", sureFolder: (name) => `Delete the portfolio “${name}” with all its transactions?`,
    sureTx: "Delete this transaction?", sureCoin: (name) => `Remove ${name} and its transactions from the portfolio?`,
    viewTx: "Transactions", setAmount: "Change holdings", removeCoin: "Remove from portfolio", edit: "Edit", del: "Delete",
    addTitle: "Add transaction", editTitle: "Edit transaction", pickCoin: "Select coin", search: "Search", quantity: "Quantity",
    pricePer: "Price per coin", date: "Date", fee: "Fee", notes: "Notes", totalSpent: "Total spent", totalReceived: "Total received",
    totalMoved: "Value now", portfolio: "Portfolio", save: "Add transaction", saveEdit: "Save",
    noCoin: "Select a coin.", badNumber: "Enter a quantity above zero.", tooMuch: (amount) => `The portfolio holds only ${amount}.`,
    failed: "Not saved. Please try again.", amountNow: (symbol) => `How much ${symbol} you hold now`,
    amountHint: "The difference is recorded as a transfer in or out at the current price.",
    emptyFolders: "Create your first portfolio", emptyFoldersText: "A portfolio is a folder of coins. Add purchases or simply the coins in your wallet, and the site works out the balance, profit and shares at today's prices.",
    emptyCoins: "No coins in this portfolio yet", emptyCoinsText: "Add a buy, a sale or a transfer — for example, how many coins sit in your wallet.",
    create: "Create portfolio", addButton: "+ Add transaction", chartLoading: "Drawing the chart…", chartEmpty: "No data for this period.",
    hidden: "••••••", txEmpty: "No transactions yet.", folderLimit: "Up to 20 portfolios." },
};
const t = () => words[language];
const LOCAL = "nir-portfolios";
const COLORS = ["#3861fb", "#16c784", "#f3a12f", "#8b7bff", "#ea3943", "#2ee6a6", "#f7931a", "#00b8d9", "#c05cff", "#9aa4b5"];
const SVG = "http://www.w3.org/2000/svg";

let market = null;
let portfolios = [];
let records = [];
let loaded = false;
let selected = store.get("nir-portfolio-selected") ?? "all"; // "all" or a portfolio id
let days = "1";
let view = "history";
let tab = "assets";
let editingFolders = false;
let hide = store.get("nir-portfolio-hide") === "1";
const sort = { key: null, dir: 0 };
const coins = new Map(); // id → name, symbol, image, price, change1h/24h/7d
const charts = new Map(); // `${id}:${days}` → [[time, price], ...] or a pending promise

// --- Storage: the server when signed in, this browser otherwise.
function localData() {
  try {
    const data = JSON.parse(store.get(LOCAL) ?? "null");
    if (data && Array.isArray(data.portfolios) && Array.isArray(data.transactions)) return data;
  } catch {}
  // Records kept by the first version of this page join one portfolio.
  let old = [];
  try { old = JSON.parse(store.get("nir-portfolio") ?? "[]"); } catch {}
  const data = { portfolios: [], transactions: [] };
  if (Array.isArray(old) && old.length) {
    data.portfolios.push({ id: 1, name: t().firstName });
    data.transactions = old.map((record) => ({ ...record, portfolioId: 1 }));
  }
  return data;
}
const saveLocal = (data) => { store.set(LOCAL, JSON.stringify(data)); store.set("nir-portfolio", "[]"); };
const localId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

async function load() {
  if (account.user) {
    // Portfolios kept in this browser before signing in join the account once.
    const local = localData();
    for (const folder of local.portfolios) {
      const transactions = local.transactions.filter((record) => record.portfolioId === folder.id)
        .map(({ id, portfolioId, ...record }) => record);
      const { status } = await send("/market/me/portfolios", "POST", { name: folder.name, transactions });
      if (status !== 201) break;
      local.portfolios = local.portfolios.filter((item) => item !== folder);
      saveLocal({ portfolios: local.portfolios, transactions: local.transactions.filter((record) => record.portfolioId !== folder.id) });
    }
    const response = await fetch("/market/me/portfolio", { cache: "no-store" }).catch(() => null);
    const data = response?.ok ? await response.json() : { portfolios: [], transactions: [] };
    ({ portfolios, transactions: records } = data);
  } else {
    ({ portfolios, transactions: records } = localData());
  }
  if (selected !== "all" && !portfolios.some((folder) => String(folder.id) === String(selected))) selected = "all";
  loaded = true;
  await loadPrices();
  render();
}
// Applies a change: on the server it answers the whole state; locally it edits the stored copy.
async function change(server, local) {
  if (account.user) {
    const { status, data } = await server();
    if (status !== 200 && status !== 201) return data.error ?? t().failed;
    ({ portfolios, transactions: records } = data);
    return data;
  }
  const data = localData();
  const result = local(data);
  if (typeof result === "string") return result;
  saveLocal(data);
  ({ portfolios, transactions: records } = data);
  return result ?? data;
}
const createFolder = (name) => change(() => send("/market/me/portfolios", "POST", { name }), (data) => {
  if (data.portfolios.length >= 20) return t().folderLimit;
  const id = localId();
  data.portfolios.push({ id, name });
  return { created: id };
});
const renameFolder = (id, name) => change(() => send(`/market/me/portfolios/${id}`, "PUT", { name }), (data) => {
  data.portfolios.find((folder) => folder.id === id).name = name;
});
const deleteFolder = (id) => change(() => send(`/market/me/portfolios/${id}`, "DELETE"), (data) => {
  data.portfolios = data.portfolios.filter((folder) => folder.id !== id);
  data.transactions = data.transactions.filter((record) => record.portfolioId !== id);
});
const removeCoin = (folderId, coinId) => change(() => send(`/market/me/portfolios/${folderId}/coins/${encodeURIComponent(coinId)}`, "DELETE"), (data) => {
  data.transactions = data.transactions.filter((record) => record.portfolioId !== folderId || record.coinId !== coinId);
});
const addRecord = (record) => change(() => send("/market/me/portfolio", "POST", record), (data) => {
  data.transactions.push({ ...record, id: localId() });
});
const editRecord = (id, record) => change(() => send(`/market/me/portfolio/${id}`, "PUT", record), (data) => {
  Object.assign(data.transactions.find((item) => item.id === id) ?? {}, record);
});
const deleteRecord = (id) => change(() => send(`/market/me/portfolio/${id}`, "DELETE"), (data) => {
  data.transactions = data.transactions.filter((item) => item.id !== id);
});

// --- Prices: the top coins come with the overview; any other coin is asked for once.
function remember(coin) {
  if (!coin?.id) return;
  coins.set(coin.id, { ...coins.get(coin.id), ...Object.fromEntries(Object.entries(coin).filter(([, value]) => value !== null && value !== undefined)) });
}
async function loadPrices() {
  for (const coin of market?.coins ?? []) remember(coin);
  const missing = [...new Set(records.map((record) => record.coinId))].filter((id) => !Number.isFinite(coins.get(id)?.price));
  await Promise.all(missing.map((id) => fetch(`/market/coin/${encodeURIComponent(id)}`).then((response) => (response.ok ? response.json() : null))
    .then((coin) => { if (coin) remember({ id: coin.id, name: coin.name, symbol: coin.symbol, image: coin.image, price: coin.price,
      change1h: coin.change1h, change24h: coin.change24h, change7d: coin.change7d }); })
    .catch(() => {})));
}

// --- Holdings by the average-cost method. A transfer in adds coins at the price of the day it was
// recorded, so profit counts from then; a transfer out takes coins away at the average cost.
const chosen = () => (selected === "all" ? records : records.filter((record) => String(record.portfolioId) === String(selected)));
const byTime = (list) => [...list].sort((left, right) => left.at - right.at || left.id - right.id);
function apply(item, record) {
  if (record.kind === "buy" || record.kind === "in") {
    const cost = record.amount * record.price + (record.kind === "buy" ? record.fee : 0);
    item.amount += record.amount;
    item.cost += cost;
    item.invested += cost;
    if (record.kind === "in") item.realized -= record.fee;
  } else {
    const average = item.amount > 0 ? item.cost / item.amount : 0;
    const taken = Math.min(record.amount, item.amount);
    item.cost -= average * taken;
    item.amount -= taken;
    if (record.kind === "sell") item.realized += taken * record.price - record.fee - average * taken;
    else { item.invested -= average * taken; item.realized -= record.fee; }
  }
}
const blank = (id) => ({ id, amount: 0, cost: 0, realized: 0, invested: 0, records: [] });
function holdings(list = chosen()) {
  const byCoin = new Map();
  for (const record of byTime(list)) {
    const item = byCoin.get(record.coinId) ?? blank(record.coinId);
    apply(item, record);
    item.records.push(record);
    byCoin.set(record.coinId, item);
  }
  return [...byCoin.values()].map((item) => {
    const coin = coins.get(item.id) ?? {};
    const value = Number.isFinite(coin.price) ? item.amount * coin.price : null;
    // A day ago: what was held then at the price then, plus what was bought (less what was sold) since, at its own price.
    const then = Number.isFinite(coin.price) && Number.isFinite(coin.change24h) ? coin.price / (1 + coin.change24h / 100) : coin.price;
    let recent = 0;
    let recentCost = 0;
    for (const record of item.records) {
      if (record.at < Date.now() - 86_400_000) continue;
      const sign = record.kind === "buy" || record.kind === "in" ? 1 : -1;
      recent += sign * record.amount;
      recentCost += sign * record.amount * (record.price || then);
    }
    const before = value === null ? null : (item.amount - recent) * then + recentCost;
    const profit = value === null ? null : value - item.cost + item.realized;
    return { ...item, coin, price: coin.price ?? null, change1h: coin.change1h ?? null, change24h: coin.change24h ?? null,
      change7d: coin.change7d ?? null, name: coin.name ?? item.id, value, dayChange: value === null ? 0 : value - before, profit,
      profitPct: profit === null || item.invested <= 0 ? null : profit / item.invested * 100,
      average: item.amount > 1e-12 ? item.cost / item.amount : null };
  }).filter((item) => item.amount > 1e-12 || Math.abs(item.realized) > 1e-9 || item.records.length);
}
const totals = (list) => {
  const value = list.reduce((sum, item) => sum + (item.value ?? 0), 0);
  const day = list.reduce((sum, item) => sum + item.dayChange, 0);
  return { value, day, dayPct: value - day ? day / (value - day) * 100 : 0,
    cost: list.reduce((sum, item) => sum + item.cost, 0), invested: list.reduce((sum, item) => sum + item.invested, 0),
    profit: list.reduce((sum, item) => sum + (item.profit ?? 0), 0) };
};

// --- Small drawing helpers.
const money = (value) => (hide ? t().hidden : price(value));
const signedMoney = (value) => (value === null ? "—" : hide ? t().hidden : `${value > 0 ? "+" : value < 0 ? "−" : ""}${price(Math.abs(value))}`);
const amountText = (value, symbol = "") => `${value.toLocaleString(locale(), { maximumFractionDigits: value >= 1 ? 4 : 8 })}${symbol ? ` ${symbol}` : ""}`;
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
function setChange(target, value, text = percentText(value)) {
  target.className = changeClass(value);
  target.textContent = value === null || value === undefined ? "" : text;
}
// A coloured square with the portfolio's first letter, the same colour every time.
function folderIcon(name, size = 40) {
  const hue = [...name].reduce((sum, char) => sum + char.charCodeAt(0) * 7, 0) % 360;
  const icon = node("span", "pf-icon", [...name][0]?.toUpperCase() ?? "•");
  icon.style.cssText = `width:${size}px;height:${size}px;background:linear-gradient(135deg,hsl(${hue} 80% 55%),hsl(${(hue + 50) % 360} 80% 45%))`;
  return icon;
}
function coinCell(item) {
  const link = node("a", "coin-cell");
  link.href = coinUrl({ id: item.id });
  link.title = `${item.coin.name ?? item.id}${item.coin.symbol ? ` (${item.coin.symbol})` : ""}`;
  link.append(logo({ id: item.id, symbol: item.coin.symbol ?? item.id.slice(0, 1).toUpperCase(), image: item.coin.image ?? null }),
    node("b", "", item.coin.name ?? item.id), node("span", "", item.coin.symbol ?? ""));
  return link;
}
function closeMenus(except = null) {
  for (const menu of document.querySelectorAll(".pf-menu")) if (menu !== except) menu.hidden = true;
}
// A "⋯" button that opens a small menu of [label, action] items.
function menuButton(items) {
  const wrap = node("span", "pf-menu-wrap");
  const button = node("button", "pill", "⋯");
  button.type = "button";
  const menu = node("span", "pf-menu");
  menu.hidden = true;
  for (const [label, action, danger] of items) {
    const item = node("button", danger ? "danger-text" : "", label);
    item.type = "button";
    item.addEventListener("click", (event) => { event.stopPropagation(); menu.hidden = true; action(); });
    menu.append(item);
  }
  button.addEventListener("click", (event) => { event.stopPropagation(); closeMenus(menu); menu.hidden = !menu.hidden; });
  wrap.append(button, menu);
  return wrap;
}

// --- The side list of portfolios.
function renderFolders() {
  const all = totals(holdings(records));
  $("#overview-value").textContent = money(all.value);
  $("#overview").classList.toggle("on", selected === "all");
  $("#folder-count").textContent = String(portfolios.length);
  $("#edit-folders").classList.toggle("on", editingFolders);
  $("#folders").replaceChildren(...portfolios.map((folder) => {
    const row = node("div", `pf-folder${String(selected) === String(folder.id) ? " on" : ""}`);
    const value = totals(holdings(records.filter((record) => record.portfolioId === folder.id))).value;
    const text = node("span");
    text.append(node("b", "", folder.name), node("small", "", money(value)));
    row.append(folderIcon(folder.name), text);
    row.tabIndex = 0;
    row.addEventListener("click", () => { selected = folder.id; store.set("nir-portfolio-selected", String(folder.id)); render(); });
    if (editingFolders) {
      const tools = node("span", "pf-folder-tools");
      const rename = node("button", "pill", "✎");
      rename.type = "button";
      rename.title = t().rename;
      rename.addEventListener("click", (event) => { event.stopPropagation(); void askRename(folder); });
      const drop = node("button", "pill danger-text", "✕");
      drop.type = "button";
      drop.title = t().remove;
      drop.addEventListener("click", (event) => { event.stopPropagation(); void askDelete(folder); });
      tools.append(rename, drop);
      row.append(tools);
    }
    return row;
  }));
}
async function askCreate() {
  const name = prompt(t().newName, portfolios.length ? "" : t().firstName)?.replace(/\s+/g, " ").trim();
  if (!name) return;
  const result = await createFolder(name.slice(0, 40));
  if (typeof result === "string") { alert(result); return; }
  selected = result.created;
  store.set("nir-portfolio-selected", String(selected));
  render();
}
async function askRename(folder) {
  const name = prompt(t().newName, folder.name)?.replace(/\s+/g, " ").trim();
  if (!name || name === folder.name) return;
  await renameFolder(folder.id, name.slice(0, 40));
  render();
}
async function askDelete(folder) {
  if (!confirm(t().sureFolder(folder.name))) return;
  await deleteFolder(folder.id);
  if (String(selected) === String(folder.id)) selected = "all";
  render();
}

// --- The charts: value over time from each coin's price history and the transactions,
// all-time profit against the BTC trend, and each coin's share.
function chartFor(id, range) {
  const key = `${id}:${range}`;
  if (!charts.has(key)) {
    charts.set(key, fetch(`/market/chart/${encodeURIComponent(id)}?days=${range}`).then((response) => (response.ok ? response.json() : null))
      .then((data) => { const points = data?.prices ?? []; charts.set(key, points); return points; })
      .catch(() => { charts.delete(key); return []; }));
  }
  return charts.get(key);
}
// The price at a moment: the last known point before it.
function priceAt(points, time) {
  let low = 0;
  let high = points.length - 1;
  if (!points.length || time < points[0][0]) return points[0]?.[1] ?? null;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (points[middle][0] <= time) low = middle; else high = middle - 1;
  }
  return points[low][1];
}
let drawn = 0;
async function renderCharts(list) {
  const ticket = ++drawn;
  if (view === "allocation") drawAllocation(list);
  const held = list.filter((item) => item.amount > 1e-12).sort((left, right) => (right.value ?? 0) - (left.value ?? 0));
  if (!held.length && !list.length) return;
  // A chart already drawn stays until the new one is ready (a refresh does not blank it); only an empty box says it is building.
  // "Building the chart" shows only if it takes a moment (a kept chart is drawn before the eye sees an empty box).
  const empty = (box) => !box.querySelector("svg");
  setTimeout(() => {
    if (ticket !== drawn) return;
    if (view === "history" && empty($("#plot"))) $("#plot").replaceChildren(node("p", "status", t().chartLoading));
    if (empty($("#perf"))) $("#perf").replaceChildren(node("p", "status", t().chartLoading));
  }, 400);
  // "All" reaches back to the first transaction, up to a year.
  const first = Math.min(...chosen().map((record) => record.at));
  const range = days === "all" ? ["1", "7", "30", "90", "365"].find((option) => Date.now() - Number(option) * 86_400_000 <= first) ?? "365" : days;
  // The largest holdings are drawn from their price history; the rest at today's price.
  const traced = [...new Set([...held.slice(0, 15).map((item) => item.id), ...list.slice(0, 15).map((item) => item.id)])];
  const [series, btc] = await Promise.all([Promise.all(traced.map((id) => chartFor(id, range))), chartFor("bitcoin", range)]);
  if (ticket !== drawn) return;
  const history = new Map(traced.map((id, index) => [id, series[index]]));
  const start = Math.max(Date.now() - Number(range) * 86_400_000, days === "all" ? first : 0);
  const steps = 120;
  const times = Array.from({ length: steps + 1 }, (_, index) => start + (Date.now() - start) * index / steps);
  const ordered = byTime(chosen());
  const values = [];
  const profits = [];
  for (const time of times) {
    const state = new Map();
    for (const record of ordered) {
      if (record.at > time) break;
      const item = state.get(record.coinId) ?? blank(record.coinId);
      apply(item, record);
      state.set(record.coinId, item);
    }
    let value = 0;
    let cost = 0;
    let realized = 0;
    let invested = 0;
    for (const item of state.values()) {
      const points = history.get(item.id);
      const at = points?.length ? priceAt(points, time) : coins.get(item.id)?.price;
      value += item.amount * (Number.isFinite(at) ? at : 0);
      cost += item.cost;
      realized += item.realized;
      invested += item.invested;
    }
    values.push([time, value]);
    profits.push([time, invested > 0 ? (value - cost + realized) / invested * 100 : null]);
  }
  const btcStart = priceAt(btc, times[0]);
  const trend = btc.length && btcStart ? times.map((time) => [time, (priceAt(btc, time) / btcStart - 1) * 100]) : [];
  if (view === "history") {
    const shown = values.filter(([time]) => time >= first);
    lineChart($("#plot"), [{ points: shown.length > 1 ? shown : values, area: true, color: (shown.at(-1)?.[1] ?? 0) >= (shown[0]?.[1] ?? 0) ? "var(--up)" : "var(--down)" }],
      (value) => (hide ? "" : `$${shortNumber(value)}`), (value) => money(value));
  }
  const ownProfit = profits.filter(([time, value]) => time >= first && value !== null);
  lineChart($("#perf"), [{ points: ownProfit, color: "var(--accent)" }, { points: trend.filter(([time]) => time >= (ownProfit[0]?.[0] ?? 0)), color: "#f3a12f" }],
    (value) => `${value.toFixed(0)}%`, (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`, true);
}
function shortNumber(value) {
  for (const [size, unit] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (Math.abs(value) >= size) return `${(value / size).toLocaleString(locale(), { maximumFractionDigits: 2 })}${unit}`;
  }
  return value.toLocaleString(locale(), { maximumFractionDigits: value < 10 ? 2 : 0 });
}
// A line chart with a scale on the right, dates below and a crosshair; `series` share one scale.
function lineChart(box, series, tick, label, zeroLine = false) {
  const lines = series.filter((line) => line.points.length > 1);
  if (!lines.length) { box.replaceChildren(node("p", "status", t().chartEmpty)); return; }
  const width = Math.max(280, box.clientWidth);
  const height = Math.max(180, box.clientHeight);
  const right = width - 62;
  const top = 10;
  const bottom = height - 24;
  const all = lines.flatMap((line) => line.points.map(([, value]) => value));
  let low = Math.min(...all, ...(zeroLine ? [0] : []));
  let high = Math.max(...all, ...(zeroLine ? [0] : []));
  const pad = (high - low) * 0.08 || Math.abs(high) * 0.02 || 1;
  low -= pad;
  high += pad;
  const from = Math.min(...lines.map((line) => line.points[0][0]));
  const to = Math.max(...lines.map((line) => line.points.at(-1)[0]));
  const x = (time) => (to === from ? 0 : (time - from) / (to - from) * right);
  const y = (value) => top + (high - value) / (high - low) * (bottom - top);
  const step = (() => { const raw = (high - low) / 4; const power = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((size) => size >= raw); })();
  const grid = [];
  for (let value = Math.ceil(low / step) * step + 0; value <= high; value += step) {
    grid.push(`<line class="grid" x1="0" x2="${right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text class="tick" x="${right + 8}" y="${(y(value) + 4).toFixed(1)}">${tick(value)}</text>`);
  }
  const span = to - from;
  const dateText = (time) => new Date(time).toLocaleString(locale(), span <= 2 * 86_400_000 ? { hour: "2-digit", minute: "2-digit" }
    : span > 200 * 86_400_000 ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
  const dates = [0, 0.25, 0.5, 0.75, 1].map((share) => `<text class="tick" text-anchor="${share === 0 ? "start" : share === 1 ? "end" : "middle"}" x="${(share * right).toFixed(1)}" y="${height - 6}">${dateText(from + span * share)}</text>`);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const path = (points) => points.map(([time, value], index) => `${index ? "L" : "M"}${x(time).toFixed(1)},${y(value).toFixed(1)}`).join("");
  svg.innerHTML = `<defs><linearGradient id="pf-fill-${box.id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${lines[0].color}" stop-opacity=".25"/><stop offset="1" stop-color="${lines[0].color}" stop-opacity="0"/></linearGradient></defs>
    ${grid.join("")}${zeroLine ? `<line class="base" x1="0" x2="${right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : ""}
    ${lines.map((line, index) => `${line.area && index === 0 ? `<path d="${path(line.points)}L${x(line.points.at(-1)[0]).toFixed(1)},${bottom}L${x(line.points[0][0]).toFixed(1)},${bottom}Z" fill="url(#pf-fill-${box.id})"/>` : ""}<path d="${path(line.points)}" fill="none" stroke="${line.color}" stroke-width="2"/>`).join("")}
    ${dates.join("")}`;
  const cursor = node("span", "cursor");
  const tip = node("span", "tip");
  const dots = lines.map((line) => { const dot = node("span", "dot"); dot.style.background = line.color; return dot; });
  box.replaceChildren(svg, cursor, ...dots, tip);
  box.onpointermove = (event) => {
    const rect = box.getBoundingClientRect();
    const time = from + Math.min(1, Math.max(0, (event.clientX - rect.left) / right)) * span;
    cursor.style.left = `${x(time)}px`;
    const values = lines.map((line, index) => {
      const value = priceAt(line.points, time);
      dots[index].style.left = `${x(time)}px`;
      dots[index].style.top = `${y(value)}px`;
      return value;
    });
    tip.replaceChildren(node("small", "", new Date(time).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
      ...values.map((value, index) => { const line = node("b", "", label(value)); line.style.color = lines[index].color === "var(--up)" || lines[index].color === "var(--down)" ? "" : lines[index].color; return line; }));
    tip.style.left = `${Math.min(right - tip.offsetWidth - 6, Math.max(6, x(time) + 12))}px`;
    box.classList.add("hover");
  };
  box.onpointerleave = () => box.classList.remove("hover");
}
function drawAllocation(list) {
  const held = list.filter((item) => item.value > 0).sort((left, right) => right.value - left.value);
  const total = held.reduce((sum, item) => sum + item.value, 0);
  if (!total) { $("#plot").replaceChildren(node("p", "status", t().chartEmpty)); return; }
  const parts = held.slice(0, COLORS.length - 1).map((item) => ({ name: item.coin.symbol ?? item.id, share: item.value / total }));
  const rest = held.slice(COLORS.length - 1).reduce((sum, item) => sum + item.value / total, 0);
  if (rest > 0) parts.push({ name: t().others, share: rest });
  // A ring: each coin's arc in turn, starting at the top.
  let angle = -Math.PI / 2;
  const arc = (share) => {
    const startAngle = angle;
    angle += share * Math.PI * 2;
    const point = (value, radius) => `${(90 + radius * Math.cos(value)).toFixed(2)},${(90 + radius * Math.sin(value)).toFixed(2)}`;
    const large = share > 0.5 ? 1 : 0;
    if (share >= 0.9999) return "M90,10 A80,80 0 1 1 89.99,10 L89.99,42 A48,48 0 1 0 90,42 Z";
    return `M${point(startAngle, 80)} A80,80 0 ${large} 1 ${point(angle, 80)} L${point(angle, 48)} A48,48 0 ${large} 0 ${point(startAngle, 48)} Z`;
  };
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 180 180");
  svg.setAttribute("class", "pf-donut");
  svg.innerHTML = parts.map((part, index) => `<path d="${arc(part.share)}" fill="${COLORS[index]}"><title>${part.name.replace(/[<&]/g, "")} ${(part.share * 100).toFixed(1)}%</title></path>`).join("");
  const legend = node("div", "pf-alloc-legend");
  legend.append(...parts.map((part, index) => {
    const row = node("span");
    const dot = node("i");
    dot.style.background = COLORS[index];
    row.append(dot, node("b", "", part.name), node("span", "muted", `${(part.share * 100).toLocaleString(locale(), { maximumFractionDigits: 2 })}%`));
    return row;
  }));
  const wrap = node("div", "pf-alloc");
  wrap.append(svg, legend);
  $("#plot").replaceChildren(wrap);
}

// --- The assets and transactions tables.
function sortValue(item, key) {
  return key === "name" ? (item.coin.name ?? item.id).toLowerCase() : item[key];
}
function renderAssets(list) {
  const rows = sortBy(list.filter((item) => item.amount > 1e-12 || item.records.length), sort, sortValue);
  markSort($("#assets-table thead"), sort);
  $("#assets").replaceChildren(...rows.map((item) => {
    const row = node("tr", "coin");
    const name = node("td", "left");
    name.append(coinCell(item));
    const holding = node("td");
    holding.append(node("b", "", item.value === null ? t().noPrice : money(item.value)), node("small", "muted pf-sub", hide ? t().hidden : amountText(item.amount, item.coin.symbol)));
    const result = node("td", "hide-s");
    result.append(node("b", changeClass(item.profit), signedMoney(item.profit)), node("small", `pf-sub ${changeClass(item.profitPct)}`, percentText(item.profitPct)));
    const actions = node("td");
    const tools = node("span", "pf-actions");
    const plus = node("button", "pill", "+");
    plus.type = "button";
    plus.title = t().addTitle;
    plus.addEventListener("click", (event) => { event.stopPropagation(); openTransaction({ coinId: item.id }); });
    const folderId = selected === "all" ? (item.records.length && item.records.every((record) => record.portfolioId === item.records[0].portfolioId) ? item.records[0].portfolioId : null) : Number(selected);
    tools.append(plus, menuButton([
      [t().addTitle, () => openTransaction({ coinId: item.id })],
      [t().viewTx, () => { tab = "transactions"; txCoin = item.id; render(); }],
      [t().setAmount, () => openAmount(item)],
      ...(folderId !== null ? [[t().removeCoin, async () => { if (confirm(t().sureCoin(item.coin.name ?? item.id))) { await removeCoin(folderId, item.id); render(); } }, true]] : []),
    ]));
    actions.append(tools);
    const cells = [percentCell(item.change1h), percentCell(item.change24h), percentCell(item.change7d)];
    for (const cell of cells) cell.classList.add("hide-s");
    // The price with the day's change under it (seen on a phone, where the change columns hide).
    const priceCell = node("td");
    priceCell.append(node("b", "pf-price", Number.isFinite(item.price) ? price(item.price) : "—"), node("small", `pf-sub m-only ${changeClass(item.change24h)}`, percentText(item.change24h)));
    row.append(name, priceCell, ...cells, holding,
      node("td", "hide-s", item.average === null ? "—" : hide ? t().hidden : price(item.average)), result, actions);
    row.addEventListener("click", (event) => { if (!event.target.closest("a, button")) { tab = "transactions"; txCoin = item.id; render(); } });
    return row;
  }));
}
let txCoin = null; // the transactions tab shows one coin's records when set
function renderTransactions() {
  const list = [...chosen()].filter((record) => !txCoin || record.coinId === txCoin).sort((left, right) => right.at - left.at || right.id - left.id);
  if (!list.length) {
    const row = node("tr");
    const cell = node("td", "muted", t().txEmpty);
    cell.colSpan = 8;
    row.append(cell);
    $("#txs").replaceChildren(row);
    return;
  }
  $("#txs").replaceChildren(...list.map((record) => {
    const coin = coins.get(record.coinId) ?? {};
    const row = node("tr");
    const kind = node("td", "left");
    kind.append(node("b", record.kind === "buy" || record.kind === "in" ? "up" : "down",
      { buy: t().buy, sell: t().sell, in: t().inShort, out: t().outShort }[record.kind]));
    if (selected === "all") kind.append(node("small", "muted pf-sub", portfolios.find((folder) => folder.id === record.portfolioId)?.name ?? ""));
    const name = node("td", "left");
    name.append(coinCell({ id: record.coinId, coin }));
    const amount = node("td");
    const sign = record.kind === "buy" || record.kind === "in" ? "+" : "−";
    amount.append(node("b", "", hide ? t().hidden : `${sign}${amountText(record.amount, coin.symbol)}`),
      node("small", "muted pf-sub", hide ? "" : price(record.amount * record.price)));
    const tools = node("td");
    const wrap = node("span", "pf-actions");
    wrap.append(menuButton([[t().edit, () => openTransaction(record)],
      [t().del, async () => { if (confirm(t().sureTx)) { await deleteRecord(record.id); render(); } }, true]]));
    tools.append(wrap);
    row.append(kind, name, node("td", "", record.price ? price(record.price) : "—"), amount,
      node("td", "hide-s", new Date(record.at).toLocaleString(locale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })),
      node("td", "hide-s", record.fee ? price(record.fee) : "—"), node("td", "hide-s left muted", record.note), tools);
    return row;
  }));
}

function render() {
  document.title = t().title;
  $("#guest").hidden = Boolean(account.user) || !account.signIn;
  $("#guest-sign").href = signInUrl();
  if (!loaded) return;
  renderFolders();
  const folder = portfolios.find((item) => String(item.id) === String(selected));
  $("#folder-icon").replaceChildren(folder ? folderIcon(folder.name, 56) : $("#overview .pf-icon").cloneNode(true));
  $("#folder-name").textContent = folder?.name ?? (language === "en" ? "Overview" : "Обзор");
  const list = holdings();
  const sum = totals(list);
  $("#balance").textContent = money(sum.value);
  // Under the total, as in the market apps: the day's change and the result for all time, in dollars and percent.
  const lineText = (dollars, pct) => (list.length ? `${signedMoney(dollars)} ${percentText(pct)}` : "—");
  $("#day-line").textContent = lineText(sum.day, sum.dayPct);
  $("#day-line").className = changeClass(sum.day);
  $("#all-line").textContent = lineText(sum.profit, sum.invested > 0 ? sum.profit / sum.invested * 100 : null);
  $("#all-line").className = changeClass(sum.profit);
  $("#add-round").hidden = !portfolios.length;
  if (!$("#sheet").hidden) renderSheet();
  setChange($("#balance-change"), list.length ? sum.dayPct : null, `${percentText(sum.dayPct)} (24 ${language === "en" ? "h" : "ч"})`);
  $("#eye").classList.toggle("on", hide);
  $("#export").hidden = !chosen().length;
  // The menu next to the buttons: rename and delete the chosen portfolio.
  $("#more").parentElement.hidden = !folder;
  if (folder) {
    $("#more-menu").replaceChildren(...[[t().rename, () => askRename(folder)], [t().remove, () => askDelete(folder), true]].map(([label, action, danger]) => {
      const item = node("button", danger ? "danger-text" : "", label);
      item.type = "button";
      item.addEventListener("click", () => { $("#more-menu").hidden = true; void action(); });
      return item;
    }));
  }
  // Nothing yet: a portfolio to create, or coins to add.
  const empty = !portfolios.length || !chosen().length;
  $("#empty").hidden = !empty;
  $("#filled").hidden = empty;
  $("#add").hidden = !portfolios.length;
  if (empty) {
    const none = !portfolios.length;
    $("#empty-title").textContent = none ? t().emptyFolders : t().emptyCoins;
    $("#empty-text").textContent = none ? t().emptyFoldersText : t().emptyCoinsText;
    $("#empty-action").textContent = none ? t().create : t().addButton;
    $("#empty-action").onclick = none ? () => void askCreate() : () => openTransaction({});
    return;
  }
  $("#pnl").textContent = signedMoney(sum.profit);
  $("#pnl").className = changeClass(sum.profit);
  setChange($("#pnl-pct"), sum.invested > 0 ? sum.profit / sum.invested * 100 : null);
  $("#cost").textContent = money(sum.cost);
  const moving = list.filter((item) => item.amount > 1e-12 && item.profitPct !== null);
  const best = moving.reduce((top, item) => (!top || item.profitPct > top.profitPct ? item : top), null);
  // With one coin (or all alike) there is no worst apart from the best.
  const lowest = moving.reduce((low, item) => (!low || item.profitPct < low.profitPct ? item : low), null);
  const worst = lowest && lowest !== best && lowest.profitPct !== best.profitPct ? lowest : null;
  for (const [key, item] of [["best", best], ["worst", worst]]) {
    $(`#${key}`).replaceChildren(...(item ? [logo({ id: item.id, symbol: item.coin.symbol ?? "?", image: item.coin.image ?? null }), item.coin.symbol ?? item.id] : ["—"]));
    setChange($(`#${key}-pct`), item ? item.profitPct : null);
  }
  for (const button of document.querySelectorAll("#range [data-days]")) button.classList.toggle("on", button.dataset.days === days);
  for (const button of document.querySelectorAll("#view [data-view]")) button.classList.toggle("on", button.dataset.view === view);
  $("#range").hidden = view === "allocation";
  for (const button of document.querySelectorAll("#tabs [data-tab]")) button.classList.toggle("on", button.dataset.tab === tab);
  $("#assets-table").hidden = tab !== "assets";
  $("#tx-table").hidden = tab !== "transactions";
  if (tab === "assets") txCoin = null;
  renderAssets(list);
  renderTransactions();
  void renderCharts(list);
}

// --- The portfolio list on a phone: a sheet from the bottom with every portfolio, its value and day's change.
function renderSheet() {
  $("#sheet-edit").hidden = !portfolios.some((item) => String(item.id) === String(selected)); // "All portfolios" has nothing to rename
  const line = (icon, label, list, chosenHere, choose) => {
    const sum = totals(list);
    const row = node("button", `pf-sheet-row${chosenHere ? " on" : ""}`);
    row.type = "button";
    const right = node("span", "pf-sheet-sum");
    right.append(node("b", "", money(sum.value)), node("small", changeClass(sum.day), list.length ? `${signedMoney(sum.day)} ${percentText(sum.dayPct)}` : ""));
    row.append(icon, node("span", "pf-sheet-name", label), right);
    row.addEventListener("click", () => { choose(); $("#sheet").hidden = true; render(); });
    return row;
  };
  $("#sheet-list").replaceChildren(
    line($("#overview .pf-icon").cloneNode(true), language === "en" ? "All portfolios" : "Все портфели", holdings(records), selected === "all",
      () => { selected = "all"; store.set("nir-portfolio-selected", "all"); }),
    node("small", "pf-sheet-title", language === "en" ? "Mine" : "Моё"),
    ...portfolios.map((folder) => line(folderIcon(folder.name), folder.name, holdings(records.filter((record) => record.portfolioId === folder.id)),
      String(selected) === String(folder.id), () => { selected = folder.id; store.set("nir-portfolio-selected", String(folder.id)); })));
}
$("#switch").addEventListener("click", () => { if (!matchMedia("(max-width: 700px)").matches) return; renderSheet(); $("#sheet").hidden = false; });
$("#sheet").addEventListener("click", (event) => { if (event.target === $("#sheet")) $("#sheet").hidden = true; });
$("#sheet-add").addEventListener("click", () => { $("#sheet").hidden = true; void askCreate(); });
$("#sheet-edit").addEventListener("click", () => { $("#sheet").hidden = true; editingFolders = true; const folder = portfolios.find((item) => String(item.id) === String(selected)); if (folder) void askRename(folder); });
$("#add-round").addEventListener("click", () => $("#add").click());

// --- The transaction dialog, as on the market sites: Buy, Sell or Transfer; the coin from a list
// with search; quantity, price per coin, date, fee and notes; and the total.
let dialog = null;
function openTransaction(record) {
  if (!portfolios.length) { void askCreate(); return; }
  dialog?.remove();
  const editing = record.id ? record : null;
  let kind = record.kind === "in" || record.kind === "out" ? "transfer" : record.kind ?? "buy";
  let direction = record.kind === "out" ? "out" : "in";
  let coin = record.coinId ? { id: record.coinId, ...coins.get(record.coinId) } : null;
  let folderId = editing ? editing.portfolioId : selected === "all" ? portfolios[0].id : Number(selected);
  const box = dialog = document.createElement("dialog");
  box.className = "pf-dialog";
  const form = document.createElement("form");
  const head = node("div", "pf-dialog-top");
  const close = node("button", "pill", "✕");
  close.type = "button";
  close.addEventListener("click", () => box.close());
  head.append(node("h2", "", editing ? t().editTitle : t().addTitle), close);
  const kinds = node("div", "seg pf-kinds");
  const coinButton = node("button", "pf-coin-button");
  coinButton.type = "button";
  const directionSelect = document.createElement("select");
  directionSelect.className = "pf-select";
  for (const value of ["in", "out"]) directionSelect.append(Object.assign(document.createElement("option"), { value, textContent: t()[value] }));
  const folderSelect = document.createElement("select");
  folderSelect.className = "pf-select";
  for (const folder of portfolios) folderSelect.append(Object.assign(document.createElement("option"), { value: folder.id, textContent: folder.name }));
  folderSelect.value = String(folderId);
  folderSelect.addEventListener("change", () => { folderId = Number(folderSelect.value); });
  const field = (label, input) => { const wrap = node("label"); wrap.append(node("span", "", label), input); return wrap; };
  const quantity = Object.assign(document.createElement("input"), { inputMode: "decimal", placeholder: "0.00", autocomplete: "off" });
  const priceInput = Object.assign(document.createElement("input"), { inputMode: "decimal", autocomplete: "off" });
  const dateInput = Object.assign(document.createElement("input"), { type: "datetime-local" });
  const feeInput = Object.assign(document.createElement("input"), { inputMode: "decimal", placeholder: "0", autocomplete: "off" });
  const noteInput = Object.assign(document.createElement("input"), { maxLength: 200, autocomplete: "off" });
  const priceField = field(`${t().pricePer}, $`, priceInput);
  const two = node("div", "pf-two");
  two.append(field(t().quantity, quantity), priceField);
  const extra = node("div", "pf-two");
  extra.append(field(t().date, dateInput), field(`${t().fee}, $`, feeInput));
  const notes = field(t().notes, noteInput);
  const totalBox = node("div", "pf-total");
  const totalLabel = node("small");
  const totalValue = node("b");
  totalBox.append(totalLabel, totalValue);
  const error = node("p", "form-error");
  const save = node("button", "act pf-save", editing ? t().saveEdit : t().save);
  save.type = "submit";

  const number = (text) => Number(String(text).replace(/\s/g, "").replace(",", "."));
  const localTime = (time) => { const date = new Date(time); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };
  function update() {
    for (const button of kinds.children) button.classList.toggle("on", button.dataset.kind === kind);
    directionSelect.parentElement.hidden = kind !== "transfer";
    coinButton.replaceChildren(...(coin ? [logo({ id: coin.id, symbol: coin.symbol ?? "?", image: coin.image ?? null }), node("b", "", coin.name ?? coin.id), node("span", "muted", coin.symbol ?? "")]
      : [node("span", "muted", t().pickCoin)]), node("i", "", "⌄"));
    const amount = number(quantity.value) || 0;
    const each = number(priceInput.value) || 0;
    const fee = number(feeInput.value) || 0;
    totalLabel.textContent = kind === "sell" ? t().totalReceived : kind === "transfer" ? t().totalMoved : t().totalSpent;
    totalValue.textContent = price(kind === "sell" ? amount * each - fee : kind === "transfer" ? amount * each : amount * each + fee);
  }
  for (const [value, label] of [["buy", t().buy], ["sell", t().sell], ["transfer", t().transfer]]) {
    const button = node("button", "", label);
    button.type = "button";
    button.dataset.kind = value;
    button.addEventListener("click", () => { kind = value; update(); });
    kinds.append(button);
  }
  directionSelect.value = direction;
  directionSelect.addEventListener("change", () => { direction = directionSelect.value; });
  coinButton.addEventListener("click", () => pickCoin((next) => {
    coin = next;
    remember(next);
    if (Number.isFinite(next.price)) priceInput.value = String(next.price);
    else {
      fetch(`/market/coin/${encodeURIComponent(next.id)}`).then((response) => (response.ok ? response.json() : null)).then((data) => {
        if (data && coin?.id === next.id) { coin = { ...coin, price: data.price }; remember({ id: next.id, price: data.price, change24h: data.change24h }); priceInput.value = String(data.price); update(); }
      }).catch(() => {});
    }
    update();
    quantity.focus();
  }));
  for (const input of [quantity, priceInput, feeInput]) input.addEventListener("input", update);
  quantity.value = record.amount ? String(record.amount) : "";
  priceInput.value = record.price !== undefined ? String(record.price) : Number.isFinite(coin?.price) ? String(coin.price) : "";
  feeInput.value = record.fee ? String(record.fee) : "";
  noteInput.value = record.note ?? "";
  dateInput.value = localTime(record.at ?? Date.now());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!coin) { error.textContent = t().noCoin; return; }
    const amount = number(quantity.value);
    if (!(amount > 0)) { error.textContent = t().badNumber; return; }
    const realKind = kind === "transfer" ? direction : kind;
    // Coins cannot leave a portfolio that does not hold them.
    if (realKind === "sell" || realKind === "out") {
      const own = holdings(records.filter((item) => item.portfolioId === folderId && item.id !== editing?.id)).find((item) => item.id === coin.id)?.amount ?? 0;
      if (amount > own + 1e-12) { error.textContent = t().tooMuch(amountText(own, coin.symbol)); return; }
    }
    const next = { coinId: coin.id, kind: realKind, amount, price: number(priceInput.value) || 0, fee: number(feeInput.value) || 0,
      at: new Date(dateInput.value).getTime() || Date.now(), note: noteInput.value.trim() };
    const result = editing ? await editRecord(editing.id, next) : await addRecord({ ...next, portfolioId: folderId });
    if (typeof result === "string") { error.textContent = result; return; }
    box.close();
    await loadPrices();
    render();
  });
  form.append(head, kinds);
  if (!editing && portfolios.length > 1) form.append(field(t().portfolio, folderSelect));
  form.append(field(t().transfer, directionSelect), coinButton, two, extra, notes, totalBox, error, save);
  box.append(form);
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  update();
  box.showModal();
  if (!coin) coinButton.click();
}

// "Change holdings": the new amount in the wallet; the difference becomes a transfer in or out.
function openAmount(item) {
  const symbol = item.coin.symbol ?? item.id;
  const answer = prompt(`${t().amountNow(symbol)}\n${t().amountHint}`, String(Number(item.amount.toPrecision(12))));
  if (answer === null) return;
  const target = Number(answer.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(target) || target < 0) { alert(t().badNumber); return; }
  const difference = target - item.amount;
  if (Math.abs(difference) < 1e-12) return;
  const folderId = selected === "all" ? item.records.at(-1).portfolioId : Number(selected);
  void addRecord({ portfolioId: folderId, coinId: item.id, kind: difference > 0 ? "in" : "out", amount: Math.abs(difference),
    price: item.price ?? 0, fee: 0, at: Date.now(), note: "" }).then(() => render());
}

// The coin list with search: the top coins at once, any other coin from /market/search.
function pickCoin(onPick) {
  const box = document.createElement("dialog");
  box.className = "pf-dialog pf-picker";
  const head = node("div", "pf-dialog-top");
  const close = node("button", "pill", "✕");
  close.type = "button";
  close.addEventListener("click", () => box.close());
  head.append(node("h2", "", t().pickCoin), close);
  const input = Object.assign(document.createElement("input"), { type: "search", placeholder: t().search, autocomplete: "off" });
  const list = node("div", "pf-pick-list");
  const draw = (items) => list.replaceChildren(...items.slice(0, 40).map((coin) => {
    const row = node("button", "pf-pick");
    row.type = "button";
    row.append(logo(coin), node("b", "", coin.name), node("span", "muted", coin.symbol), node("i", "", "›"));
    row.addEventListener("click", () => { box.close(); onPick(coin); });
    return row;
  }));
  const top = () => market?.coins ?? [];
  let timer = null;
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    const local = top().filter((coin) => !query || coin.name.toLowerCase().includes(query) || coin.symbol.toLowerCase().startsWith(query));
    draw(local);
    clearTimeout(timer);
    if (query.length < 2) return;
    timer = setTimeout(async () => {
      const found = await fetch(`/market/search?q=${encodeURIComponent(query)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      if (input.value.trim().toLowerCase() !== query || !found?.coins) return;
      const seen = new Set(local.map((coin) => coin.id));
      draw([...local, ...found.coins.filter((coin) => !seen.has(coin.id))]);
    }, 300);
  });
  box.append(head, input, list);
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  draw(top());
  box.showModal();
  input.focus();
}

// A CSV of the chosen transactions, for a spreadsheet.
function exportCsv() {
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [["portfolio", "coin", "symbol", "type", "amount", "price_usd", "fee_usd", "date", "note"].join(",")];
  for (const record of byTime(chosen())) {
    lines.push([portfolios.find((folder) => folder.id === record.portfolioId)?.name ?? "", record.coinId, coins.get(record.coinId)?.symbol ?? "",
      record.kind, record.amount, record.price, record.fee, new Date(record.at).toISOString(), record.note].map(quote).join(","));
  }
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })),
    download: `nir-portfolio-${new Date().toISOString().slice(0, 10)}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$("#overview").addEventListener("click", () => { selected = "all"; store.set("nir-portfolio-selected", "all"); render(); });
$("#create").addEventListener("click", () => void askCreate());
$("#edit-folders").addEventListener("click", () => { editingFolders = !editingFolders; render(); });
$("#add").addEventListener("click", () => openTransaction({}));
$("#export").addEventListener("click", exportCsv);
$("#eye").addEventListener("click", () => { hide = !hide; store.set("nir-portfolio-hide", hide ? "1" : "0"); render(); });
$("#more").addEventListener("click", (event) => { event.stopPropagation(); closeMenus($("#more-menu")); $("#more-menu").hidden = !$("#more-menu").hidden; });
document.addEventListener("click", () => closeMenus());
for (const button of document.querySelectorAll("#range [data-days]")) button.addEventListener("click", () => { days = button.dataset.days; render(); });
for (const button of document.querySelectorAll("#view [data-view]")) button.addEventListener("click", () => { view = button.dataset.view; render(); });
for (const button of document.querySelectorAll("#tabs [data-tab]")) button.addEventListener("click", () => { tab = button.dataset.tab; txCoin = null; render(); });
sortable($("#assets-table thead"), sort, render);
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
let resized = null;
new ResizeObserver(() => { clearTimeout(resized); resized = setTimeout(() => { if (loaded && !$("#filled").hidden) void renderCharts(holdings()); }, 200); }).observe($("#plot"));

setupSearch({ overview: () => market });
// The first frame from the last answers (common.js keptJson): the signed-in visitor's portfolio and the market's
// prices, so the page opens with its figures instead of $0 and fills in place when the fresh ones come.
if (account.user) {
  const kept = keptJson("/market/me/portfolio");
  market = keptJson("/market/overview") ?? market;
  if (kept) {
    ({ portfolios, transactions: records } = kept);
    for (const coin of market?.coins ?? []) remember(coin);
    loaded = true;
  }
}
setupPage({ en, render, onAccount: () => { void load(); } });
// Without an answer about the account, the portfolios kept in this browser are shown.
setTimeout(() => { if (!loaded) void load(); }, 5000);
fetch("/market/overview").then((response) => (response.ok ? response.json() : null))
  .then(async (data) => { market = data; if (loaded) { await loadPrices(); render(); } }).catch(() => {});
setInterval(async () => {
  market = await fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).catch(() => market) ?? market;
  if (loaded) { for (const coin of market?.coins ?? []) remember(coin); render(); }
}, 60_000);
