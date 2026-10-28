// A wallet's page, /address/<address>, in the manner of the analytics sites:
// its open name and tags, what it holds on every network and the total, the
// network coin's balance by day, its transfers (all, in or out) a page at a
// time, and the wallets it deals with most. Signed in, the visitor can track
// it (a bookmark kept on the server) or mark it as their own, so the profile
// adds it to their holdings. Data comes from /market/chain (market-chain.mjs).

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  loading: "Loading the address… a large wallet can take up to half a minute.", copy: "Copy", share: "Share", portfolio: "Portfolio", networks: "Assets by network",
  colAsset: "Asset", colChain: "Network", colPrice: "Price", colAmount: "Amount", colValue: "Value", colAssets: "Assets", colShare: "Share",
  history: "Balance history", shares: "Asset shares", counterparties: "Top counterparties", counterNote: "From the loaded transfers: who this address deals with most.",
  colWallet: "Address", colIn: "Received from", colOut: "Sent to", colCount: "Transfers", dirAll: "Transfers", dirIn: "Inflow", dirOut: "Outflow",
  colTime: "Time", colFrom: "From", colTo: "To", colUsd: "USD", colValue2: "Value", colToken: "Token", more: "Show more", suggest: "✎ Suggest a name", visualize: "Bubbles: links",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { title: (name) => `${name} — кошелёк на NIR Markets`, wallet: "Кошелёк", contract: "Контракт", track: "☆ Следить за кошельком", tracked: "★ Слежу",
    trackHint: "Кошелёк появится в профиле во вкладке «Отслеживаемые»: видно его баланс и новые переводы.",
    mineHint: "Для своих кошельков: их монеты прибавятся к вашему портфелю в профиле.",
    addresses: (count) => (count >= 1000 ? `${(count / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} тыс. адресов` : `${count} ${plural(count, "адрес", "адреса", "адресов")}`),
    entityHint: (name) => `Все адреса: ${name}`, guessed: "по поведению",
    mineDone: "Готово: монеты этого кошелька теперь считаются в вашем портфеле (профиль → «Мои адреса»).",
    trackDone: "Готово: кошелёк добавлен в ваш профиль, вкладка «Отслеживаемые» — там его баланс и новые переводы.", openTracked: "Открыть →",
    mine: "＋ Это мой кошелёк", isMine: "✓ Мой кошелёк", copied: "Скопировано", missing: "Это не адрес кошелька.",
    unavailable: "Обозреватель сейчас не отвечает. Попробуйте через минуту.", empty: "Активов не найдено.",
    listed: (names) => `В сети ${names} у адреса слишком много токенов для обозревателя: показаны токены 1000 крупнейших монет, прочитанные напрямую из сети; мелкие и редкие токены могут не войти.`,
    partial: (names) => `Не удалось загрузить токены в сети ${names}: у адреса слишком много токенов, обозреватель не успел ответить. Показан баланс монеты сети.`,
    failed: (names) => `Сеть ${names} сейчас не отвечает.`, noTransfers: "Переводов не найдено.", noMatch: "Под фильтр ничего не подходит.", clearFilters: "Сбросить фильтры",
    rangeFrom: "от", rangeTo: "до", rangeMin: "Минимум", rangeMax: "Максимум", rangeLabel: "Диапазон", rangeAny: "Любой", apply: "Применить", close: "Закрыть", rangeUsd: "Сумма в долларах", rangeAmount: "Количество токена", sortBy: "Порядок",
    sortDesc: "↓ Сначала крупные", sortAsc: "↑ Сначала мелкие", resetRange: "Сбросить",
    allTokens: "Все токены", partyFilter: "Адрес или имя", noCounter: "Пока нечего показать.",
    emptyWallet: "На шести сетях у адреса сейчас нет монет и токенов.", activity: (list) => `Активность: ${list}.`,
    txs: (count) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? "транзакция" : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? "транзакции" : "транзакций"}`,
    noActivity: "Следов активности нет: адрес не получал и не отправлял монеты на этих сетях.", openIn: "Смотреть в обозревателе:",
    noHistoryYet: "Истории пока нет: на кошельке ничего нет, и переводов не найдено.",
    signIn: "Войдите через Google, чтобы отслеживать адреса.",
    sharesNote: "Из чего состоит кошелёк, по стоимости в долларах.", others: "Остальные", allChains: "Все", loadingTransfers: "Загружаю переводы по всем сетям…",
    ranges: [[7, "1н"], [30, "1м"], [90, "3м"], [365, "1г"], [0, "Все"]],
    historyFrom: (date) => `Стоимость по текущим ценам, восстановлена по переводам с ${date}. Более ранние дни появятся по мере загрузки переводов.`,
    historyAll: "Стоимость по текущим ценам, восстановлена по переводам.", historyWait: "Собираю историю по переводам…",
    hiddenDust: (count) => `Скрыто переводов дешевле $1: ${count} (чаще всего это спам).`, showAll: "Показать все",
    nodeNote: "Эта сеть читается с открытого узла: видны переводы токенов примерно за последние сутки, переводы самой монеты сети не видны.",
    askName: "Как называется этот кошелёк? (2–40 символов, например «Биржа Olympus — горячий кошелёк»)",
    askLink: "Ссылка, где это опубликовано (необязательно, https://…)", sent: "Спасибо! Подпись появится после проверки модератором.",
    signInSuggest: "Войдите через Google, чтобы предлагать подписи." },
  en: { title: (name) => `${name} — wallet on NIR Markets`, wallet: "Wallet", contract: "Contract", track: "☆ Watch wallet", tracked: "★ Watching",
    trackHint: "The wallet shows in your profile under Tracked, with its balance and new transfers.",
    mineHint: "For your own wallets: their coins add up in your profile's portfolio.",
    addresses: (count) => `${count >= 1000 ? `${(count / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : count} addresses`,
    entityHint: (name) => `All addresses: ${name}`, guessed: "by behaviour",
    mineDone: "Done: this wallet's coins now count in your portfolio (profile → My addresses).",
    trackDone: "Done: the wallet is in your profile under Tracked, with its balance and new transfers.", openTracked: "Open →",
    mine: "＋ This is my wallet", isMine: "✓ My wallet", copied: "Copied", missing: "This is not a wallet address.",
    unavailable: "The explorer is not answering. Try again in a minute.", empty: "No assets found.",
    listed: (names) => `On ${names} the address holds too many tokens for the explorer: the tokens of the 1,000 largest coins are shown, read from the network itself; small and rare tokens may be missing.`,
    partial: (names) => `Tokens on ${names} did not load: the address holds too many and the explorer timed out. The network coin balance is shown.`,
    failed: (names) => `${names} is not answering right now.`, noTransfers: "No transfers found.", noMatch: "Nothing matches the filter.", clearFilters: "Clear filters",
    rangeFrom: "from", rangeTo: "to", rangeMin: "Minimum", rangeMax: "Maximum", rangeLabel: "Range", rangeAny: "Any", apply: "Apply", close: "Close", rangeUsd: "Dollar value", rangeAmount: "Token amount", sortBy: "Order",
    sortDesc: "↓ Largest first", sortAsc: "↑ Smallest first", resetRange: "Reset",
    allTokens: "All tokens", partyFilter: "Address or name", noCounter: "Nothing to show yet.",
    emptyWallet: "The address holds no coins or tokens on the six networks right now.", activity: (list) => `Activity: ${list}.`,
    txs: (count) => `${count} transaction${count === 1 ? "" : "s"}`,
    noActivity: "No trace of activity: the address has not received or sent coins on these networks.", openIn: "See it in the explorer:",
    noHistoryYet: "No history yet: the wallet holds nothing and no transfers were found.",
    signIn: "Sign in with Google to track addresses.",
    sharesNote: "What the wallet is made of, by dollar value.", others: "Others", allChains: "All", loadingTransfers: "Loading transfers on every network…",
    ranges: [[7, "1W"], [30, "1M"], [90, "3M"], [365, "1Y"], [0, "All"]],
    historyFrom: (date) => `Value at today's prices, rebuilt from transfers since ${date}. Earlier days appear as more transfers load.`,
    historyAll: "Value at today's prices, rebuilt from transfers.", historyWait: "Rebuilding the history from transfers…",
    hiddenDust: (count) => `Transfers under $1 hidden: ${count} (mostly spam).`, showAll: "Show all",
    nodeNote: "This network is read from a public node: token transfers of about the last day are visible, the network coin's own transfers are not.",
    askName: "What is this wallet? (2–40 characters, e.g. “Olympus exchange hot wallet”)",
    askLink: "A link where this is published (optional, https://…)", sent: "Thank you! The name shows once a moderator approves it.",
    signInSuggest: "Sign in with Google to suggest names." },
};
const t = () => words[language];
// A known wallet's page is /w/<id>: its address stays on the server, only its first half is shown.
const address = (location.pathname.startsWith("/w/") ? "w:" : "") + decodeURIComponent(location.pathname.split("/")[2] ?? "");
const masked = MASKED_ID.test(address);
let utxo = /^(?:bc1|[13])/.test(WHALE.get(address)?.short ?? address);
let data = null;
let failure = "";
let saved = null; // this address in the visitor's saved list, or null
let view = "assets";
let chart = "history"; // "history": the wallet's value by day; "shares": its split by asset
let range = 90; // days shown by the history chart; 0: everything loaded
let direction = "all";
let transferChain = "all";
let dust = true; // hide transfers worth under $1 (mostly spam tokens)
// The transfers table, as on the analytics sites: time, value and dollars sort; sender, receiver and token filter.
const tsort = { key: "time", dir: -1 };
const tfilter = { from: "", to: "", token: null, amount: null, usd: null }; // amount and usd: { min, max } or null
let transfers = [];
// Every transfer loaded in either direction-less view, by id: the history and counterparties come from it.
const ledger = new Map();
const reached = {}; // network → the oldest transfer time loaded into the ledger, or 0 once its last page is in
let cursors = {}; // network → the next page's cursor; missing: not asked yet, null: no more pages
let loadingMore = false;
let generation = 0; // a new filter starts a new generation; answers to an older one are dropped
const sort = { key: null, dir: 0 };
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const chainName = (chain) => CHAINS[chain]?.name ?? chain;
// Networks where the address left a trace, and the explorer pages to look further.
const activeChains = () => (data?.networks ?? []).filter((item) => item.ok && item.active).map((item) => item.chain);
const explorerLinks = () => (masked ? [] : activeChains()).map((chain) => Object.assign(node("a", "pill", chainName(chain)),
  { href: `${(CHAINS[chain]?.tx ?? "").replace(/\/tx\/$/, "/address/")}${address}`, target: "_blank", rel: "noopener" }));
const COLORS = ["#3861fb", "#16c784", "#f3a12f", "#8b7bff", "#ea3943", "#2ee6a6", "#f7931a", "#00b8d9", "#c05cff", "#9aa4b5"];

// --- The head: name, address, total, tags and the buttons.
// Russian plural: 1 адрес, 2 адреса, 5 адресов.
const plural = (count, one, few, many) => { const ten = count % 10; const hundred = count % 100;
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many; };
let entityCount = 0;
let entityAsked = "";
async function loadEntityCount() {
  const entity = data?.name ? entityName(data.name) : "";
  if (!entity || GENERIC_LABEL.test(entity) || entity === entityAsked) return;
  entityAsked = entity;
  if (entity === "Satoshi Nakamoto") {
    const answer = await fetch("/market/chain/satoshi").then((response) => (response.ok ? response.json() : null)).catch(() => null);
    entityCount = answer?.keys ?? 0;
  } else {
    const answer = await fetch(`/market/chain/entities?names=${encodeURIComponent(entity)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
    entityCount = Math.max(answer?.counts?.[entity] ?? 0, WHALES.filter((item) => entityName(item.name) === entity).length);
  }
  if (entityCount > 1) renderHead();
}
function renderHead() {
  // A well-known wallet keeps the name it has in the popular list, also where the explorer gives none.
  if (!data.name && knownName(address)) data.name = knownName(address);
  // An address of an organisation or a person with several known addresses: beside the name, how many
  // there are, linking to the page where they all add up (as on the analytics sites).
  void loadEntityCount();
  const entityLink = $("#entity-link");
  entityLink.hidden = !(entityCount > 1);
  if (entityCount > 1) {
    entityLink.href = entityUrl(entityName(data.name));
    entityLink.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
    entityLink.append(node("span", "", t().addresses(entityCount)));
    entityLink.title = t().entityHint(entityName(data.name));
  }
  // A hand-picked wallet whose labels give no name keeps the one the list shows.
  if (!data.name && knownName(address)) data.name = knownName(address);
  const name = data.name ?? (data.contract ? t().contract : t().wallet);
  document.title = t().title(data.name ?? shortAddress(address));
  $("#name").textContent = name;
  $("#address").textContent = masked ? data.short ?? "" : address;
  $("#copy").hidden = masked;
  $("#suggest").hidden = masked;
  $("#visualize").href = bubblesUrl(address);
  if (!$("#visualize svg")) $("#visualize").insertAdjacentHTML("afterbegin", BUBBLES_ICON);
  const hue = [...address.toLowerCase()].reduce((sum, char) => sum + char.charCodeAt(0) * 13, 0) % 360;
  $("#avatar").style.background = `linear-gradient(135deg,hsl(${hue} 70% 55%),hsl(${(hue + 70) % 360} 70% 40%))`;
  $("#avatar").textContent = (data.name ?? "◎")[0].toUpperCase();
  const face = walletAvatar({ address, name: data.name, logo: data.logo }).querySelector("img");
  if (face) $("#avatar").append(face);
  $("#total").textContent = price(data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0));
  $("#tags").replaceChildren(...data.networks.filter((item) => item.ok && item.active).map((item) => {
    const chip = node("span", "ex-chip");
    chip.append(chainDot(item.chain), chainName(item.chain), ...(item.sent ? [node("span", "muted", `· ${t().txs(item.sent)}`)] : []));
    return chip;
  }),
    ...data.tags.map((tag) => node("span", "ex-chip tag", tag)),
    // The owner's kind from NIR Markets' book; a guess from the wallet's behaviour says so.
    ...(categoryName(fixedCategory(data.name) ?? data.category) ? [node("span", "ex-chip tag", fixedCategory(data.name) ? categoryName(fixedCategory(data.name))
      : data.guessed ? `${categoryName(data.category)} · ${t().guessed}` : categoryName(data.category))] : []));
  $("#track").textContent = saved ? t().tracked : t().track;
  $("#track").classList.toggle("on", Boolean(saved));
  $("#track").title = t().trackHint;
  const partial = data.networks.filter((item) => item.partial && !item.listed).map((item) => chainName(item.chain));
  const listed = data.networks.filter((item) => item.partial && item.listed).map((item) => chainName(item.chain));
  const failed = data.networks.filter((item) => !item.ok).map((item) => chainName(item.chain));
  $("#partial").hidden = !partial.length && !listed.length && !failed.length;
  $("#partial").textContent = [partial.length ? t().partial(partial.join(", ")) : "", listed.length ? t().listed(listed.join(", ")) : "",
    failed.length ? t().failed(failed.join(", ")) : ""].filter(Boolean).join(" ");
}

// --- Holdings, and their split by network.
function renderAssets() {
  for (const button of document.querySelectorAll("#assets-tabs [data-view]")) button.classList.toggle("on", button.dataset.view === view);
  $("#assets-table").hidden = view !== "assets";
  $("#networks-table").hidden = view !== "networks";
  markSort($("#assets-table thead"), sort);
  const rows = sortBy(data.assets, sort, (asset, key) => (key === "symbol" ? asset.token.symbol.toLowerCase() : key === "price" ? asset.token.price : asset[key]));
  if (!rows.length) {
    const row = node("tr");
    const active = data.networks.filter((item) => item.ok && item.active);
    const cell = node("td", "muted ex-empty", data.networks.length > 1 ? `${t().emptyWallet} ${active.length
      ? t().activity(active.map((item) => (item.sent ? `${chainName(item.chain)} — ${t().txs(item.sent)}` : chainName(item.chain))).join(", ")) : t().noActivity}` : t().empty);
    cell.colSpan = 5;
    row.append(cell);
    $("#assets").replaceChildren(row);
  } else {
    $("#assets").replaceChildren(...rows.map((asset) => {
      const row = node("tr");
      const name = node("td", "left");
      // A coin we list opens its page with the chart and description.
      const cell = asset.token.coinId ? Object.assign(node("a", "coin-cell"), { href: `/coin/${encodeURIComponent(asset.token.coinId)}` }) : node("span", "coin-cell");
      cell.append(logo({ id: asset.token.symbol, symbol: asset.token.symbol, image: asset.token.icon }), node("b", "", asset.token.symbol), node("span", "", asset.token.name));
      name.append(cell);
      if (asset.token.coinId) { row.classList.add("coin"); row.addEventListener("click", (event) => { if (!event.target.closest("a")) location.href = cell.href; }); }
      const network = node("td", "left ex-net");
      network.append(chainDot(asset.chain), node("span", "", CHAINS[asset.chain]?.short ?? asset.chain));
      row.append(name, network, node("td", "", asset.token.price === null ? "—" : price(asset.token.price)),
        node("td", "", `${amountShort(asset.amount)} ${asset.token.symbol}`), node("td", "", asset.usd === null ? "—" : price(asset.usd)));
      return row;
    }));
  }
  const total = data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0);
  $("#networks").replaceChildren(...data.networks.map((item) => {
    const assets = data.assets.filter((asset) => asset.chain === item.chain);
    const value = assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0);
    const row = node("tr");
    const name = node("td", "left");
    name.append(chainDot(item.chain), " ", chainName(item.chain));
    row.append(name, node("td", "", String(assets.length)), node("td", "", price(value)), node("td", "", total ? `${(value / total * 100).toFixed(1)}%` : "—"));
    return row;
  }));
}

// --- The wallet's value by day, rebuilt from its transfers: today's holdings,
// with each transfer undone going back in time, at today's prices. Tokens
// without a price (mostly spam) weigh nothing.
const keyOf = (chain, token) => `${chain}:${(token.address ?? "native").toLowerCase()}`;
function valueSteps() {
  const own = address.toLowerCase();
  const book = new Map(data.assets.map((asset) => [keyOf(asset.chain, asset.token), { amount: asset.amount, price: asset.token.price }]));
  let total = [...book.values()].reduce((sum, entry) => sum + Math.max(0, entry.amount) * (entry.price ?? 0), 0);
  const steps = [[Date.now(), total]]; // newest first: [time of a transfer, value just before it]
  for (const item of [...ledger.values()].sort((left, right) => right.time - left.time)) {
    const incoming = item.to.address?.toLowerCase() === own;
    if (incoming === (item.from.address?.toLowerCase() === own)) continue;
    const key = keyOf(item.chain, item.token);
    if (!book.has(key)) book.set(key, { amount: 0, price: item.token.price ?? (item.usd && item.amount ? item.usd / item.amount : null) });
    const entry = book.get(key);
    if (!entry.price) continue;
    const before = Math.max(0, entry.amount);
    entry.amount += incoming ? -item.amount : item.amount;
    total += (Math.max(0, entry.amount) - before) * entry.price;
    steps.push([item.time, total]);
  }
  return steps;
}
// The time from which the transfers are loaded. The public nodes reach back only hours, so when the
// wallet holds anything on a network with an explorer, the explorers' reach decides; the node
// networks then count with what they have.
function coverage() {
  const chains = transferChainsAll();
  const explored = chains.filter((chain) => !CHAINS[chain]?.node);
  const leading = explored.length && data.assets.some((asset) => !CHAINS[asset.chain]?.node) ? explored : chains;
  const times = leading.map((chain) => reached[chain]).filter((time) => time !== undefined);
  return times.length ? Math.max(...times) : Date.now();
}

function renderChart() {
  for (const button of document.querySelectorAll("#chart-tabs [data-chart]")) button.classList.toggle("on", button.dataset.chart === chart);
  $("#ranges").hidden = chart !== "history";
  if (chart === "shares") { $("#history-note").textContent = t().sharesNote; drawShares($("#plot")); return; }
  $("#ranges").replaceChildren(...t().ranges.map(([days, label]) => {
    const button = node("button", days === range ? "on" : "", label);
    button.type = "button";
    button.addEventListener("click", () => { range = days; renderChart(); void reachBack(); });
    return button;
  }));
  drawHistory($("#plot"));
}
let drawPending = false;
function scheduleChart() {
  if (drawPending || chart !== "history" || !data) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; renderChart(); });
}
// Loads older transfers until the chosen period is covered (eight pages at most).
let reaching = false;
async function reachBack() {
  if (reaching || direction !== "all" || transferChain !== "all") return;
  reaching = true;
  for (let page = 0; page < 8 && hasMore(); page += 1) {
    const start = range ? Date.now() - range * 86_400_000 : 0;
    if (coverage() <= start) break;
    await loadTransfers();
  }
  reaching = false;
}

function drawHistory(box) {
  if (!data.assets.length && !ledger.size && !loadingMore) {
    $("#history-note").textContent = "";
    box.replaceChildren(node("p", "status muted ex-blank", t().noHistoryYet));
    return;
  }
  const steps = valueSteps();
  const covered = coverage();
  const now = Date.now();
  // The chart spans the chosen period, or the part of it the loaded transfers cover.
  const start = Math.min(now - 3_600_000, range ? Math.max(now - range * 86_400_000, covered) : covered || (steps.length > 1 ? steps.at(-1)[0] : now - 30 * 86_400_000));
  const from = start;
  const short = now - from < 2 * 86_400_000;
  if (!ledger.size && loadingMore) { $("#history-note").textContent = t().historyWait; }
  else $("#history-note").textContent = covered > (range ? now - range * 86_400_000 : 0) ? t().historyFrom(new Date(covered).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })) : t().historyAll;
  // The value from each moment on, oldest first, inside the shown period.
  const ascending = [];
  for (let index = steps.length - 1; index >= 1; index -= 1) ascending.push([steps[index][0], steps[index - 1][1]]);
  // At the start: the value after the last transfer before it, or before the oldest one.
  const points = [[start, ascending.findLast(([time]) => time <= start)?.[1] ?? steps.at(-1)[1]]];
  points.push(...ascending.filter(([time]) => time > start && time <= now));
  points.push([now, steps[0][1]]);
  const width = Math.max(280, box.clientWidth);
  const height = Math.max(180, box.clientHeight);
  const right = width - 64;
  const values = points.map(([, value]) => value);
  const pad = (Math.max(...values) - Math.min(...values)) * 0.15 || Math.max(...values) * 0.05 || 1;
  const low = Math.max(0, Math.min(...values) - pad);
  const high = Math.max(...values) + pad;
  const x = (time) => (time - from) / ((now - from) || 1) * right;
  const y = (value) => 10 + (high - value) / (high - low) * (height - 34);
  // Steps: the value holds until the next transfer, then jumps.
  let line = `M${x(points[0][0]).toFixed(1)},${y(points[0][1]).toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) line += `H${x(points[index][0]).toFixed(1)}V${y(points[index][1]).toFixed(1)}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => low + (high - low) * share);
  // Short labels, or longer ones when a narrow range makes the short ones all alike.
  let labels = ticks.map(usdShort);
  for (let digits = 3; new Set(labels).size < labels.length && digits <= 6; digits += 1) labels = ticks.map((value) => big(value, "$", digits));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const left = x(points[0][0]).toFixed(1);
  svg.innerHTML = `<defs><linearGradient id="ex-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".3"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((value, index) => `<line class="grid" x1="0" x2="${right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text class="tick" x="${right + 8}" y="${(y(value) + 4).toFixed(1)}">${labels[index]}</text>`).join("")}
    <path d="${line}V${height - 24}H${left}Z" fill="url(#ex-fill)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${[0, 0.25, 0.5, 0.75, 1].map((share) => { const time = from + (now - from) * share; return `<text class="tick" text-anchor="${share === 0 ? "start" : share === 1 ? "end" : "middle"}" x="${(share * right).toFixed(1)}" y="${height - 6}">${(short ? new Date(time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : new Date(time).toLocaleDateString(locale(), { day: "numeric", month: "short" }))}</text>`; }).join("")}
    <line class="ex-cursor" x1="0" x2="0" y1="0" y2="${height - 24}" visibility="hidden"/>`;
  const tip = node("div", "ex-tip");
  tip.hidden = true;
  box.replaceChildren(svg, tip);
  // Hover: the value on that day.
  svg.addEventListener("pointermove", (event) => {
    const scale = width / svg.getBoundingClientRect().width;
    const at = Math.min(right, Math.max(0, (event.clientX - svg.getBoundingClientRect().left) * scale));
    const time = from + at / right * (now - from);
    if (time < points[0][0]) { tip.hidden = true; return; }
    const value = points.findLast((point) => point[0] <= time)?.[1] ?? points[0][1];
    const cursor = svg.querySelector(".ex-cursor");
    cursor.setAttribute("x1", at); cursor.setAttribute("x2", at); cursor.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.replaceChildren(node("small", "", new Date(time).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })), node("b", "", price(value)));
    tip.style.left = `${Math.min(box.clientWidth - 140, at / scale + 12)}px`;
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; svg.querySelector(".ex-cursor").setAttribute("visibility", "hidden"); });
}

// The wallet's split by asset, as a ring with a legend.
function drawShares(box) {
  const held = data.assets.filter((asset) => (asset.usd ?? 0) > 0).sort((left, right) => right.usd - left.usd);
  const total = held.reduce((sum, asset) => sum + asset.usd, 0);
  if (!total) { box.replaceChildren(node("p", "status muted", t().empty)); return; }
  const parts = held.slice(0, COLORS.length - 1).map((asset) => ({ name: asset.token.symbol, chain: asset.chain, share: asset.usd / total, usd: asset.usd }));
  const rest = held.slice(COLORS.length - 1).reduce((sum, asset) => sum + asset.usd, 0);
  if (rest > 0) parts.push({ name: t().others, chain: null, share: rest / total, usd: rest });
  let angle = -Math.PI / 2;
  const arc = (share) => {
    const startAngle = angle;
    angle += share * Math.PI * 2;
    const point = (value, radius) => `${(90 + radius * Math.cos(value)).toFixed(2)},${(90 + radius * Math.sin(value)).toFixed(2)}`;
    const large = share > 0.5 ? 1 : 0;
    if (share >= 0.9999) return "M90,10 A80,80 0 1 1 89.99,10 L89.99,42 A48,48 0 1 0 90,42 Z";
    return `M${point(startAngle, 80)} A80,80 0 ${large} 1 ${point(angle, 80)} L${point(angle, 48)} A48,48 0 ${large} 0 ${point(startAngle, 48)} Z`;
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 180 180");
  svg.setAttribute("class", "pf-donut");
  svg.innerHTML = parts.map((part, index) => `<path d="${arc(part.share)}" fill="${COLORS[index]}"><title>${part.name.replace(/[<&]/g, "")} ${(part.share * 100).toFixed(1)}%</title></path>`).join("");
  const legend = node("div", "pf-alloc-legend");
  legend.append(...parts.map((part, index) => {
    const row = node("span");
    const dot = node("i");
    dot.style.background = COLORS[index];
    const label = node("b");
    label.append(...(part.chain ? [chainDot(part.chain)] : []), part.name);
    const share = part.share * 100;
    row.append(dot, label, node("span", "muted", `${share < 0.01 ? `<${(0.01).toLocaleString(locale())}` : share.toLocaleString(locale(), { maximumFractionDigits: share < 1 ? 2 : 1 })}% · ${usdShort(part.usd)}`));
    return row;
  }));
  const wrap = node("div", "pf-alloc ex-alloc-wide");
  wrap.append(svg, legend);
  box.replaceChildren(wrap);
}

// --- Transfers: a page at a time; spam-sized ones hidden by default.
const worth = (item) => !dust || (item.usd ?? 0) >= 1;
function renderTransfers() {
  for (const button of document.querySelectorAll("#direction [data-dir]")) button.classList.toggle("on", button.dataset.dir === direction);
  $("#dust").classList.toggle("on", dust);
  $("#transfer-chain").replaceChildren(...(utxo ? [] : ["all", ...Object.keys(CHAINS).filter((chain) => chain !== "btc")].map((chain) => {
    const button = node("button", chain === transferChain ? "on" : "", chain === "all" ? t().allChains : "");
    if (chain !== "all") button.append(chainDot(chain), CHAINS[chain].short);
    button.type = "button";
    button.title = chain === "all" ? t().allChains : chainName(chain);
    button.addEventListener("click", () => { transferChain = chain; void loadTransfers(true); });
    return button;
  })));
  $("#node-note").hidden = !CHAINS[transferChain]?.node;
  $("#node-note").textContent = t().nodeNote;
  // Pages from several networks arrive separately: shown together, newest first unless sorted otherwise.
  const matches = (party, text) => !text || [party?.address, party?.name, knownName(party?.address)].some((value) => value?.toLowerCase().includes(text.toLowerCase()));
  const within = (value, band) => !band || (value !== null && value !== undefined && (band.min === null || value >= band.min) && (band.max === null || value <= band.max));
  const passes = (item) => matches(item.from, tfilter.from) && matches(item.to, tfilter.to) && (!tfilter.token || item.token.symbol === tfilter.token)
    && within(item.amount, tfilter.amount) && within(item.usd, tfilter.usd);
  const shown = transfers.filter((item) => worth(item) && passes(item)).sort((left, right) => ((left[tsort.key] ?? -1) - (right[tsort.key] ?? -1)) * tsort.dir);
  for (const head of document.querySelectorAll(".ex-transfers [data-tsort]")) head.dataset.dir = head.dataset.tsort === tsort.key ? (tsort.dir > 0 ? "asc" : "desc") : "";
  for (const head of document.querySelectorAll(".ex-transfers [data-tfilter]")) head.classList.toggle("on", Boolean(tfilter[head.dataset.tfilter]));
  const hidden = transfers.length - shown.length;
  const own = address.toLowerCase();
  const message = (text, button) => {
    const row = node("tr");
    const cell = node("td", "muted ex-empty", text);
    cell.colSpan = 6;
    if (button) cell.append(" ", button);
    row.append(cell);
    return row;
  };
  const reveal = () => { const button = node("button", "pill", t().showAll); button.type = "button"; button.addEventListener("click", () => { dust = false; renderTransfers(); }); return button; };
  $("#transfers").replaceChildren(...shown.map((item) => {
    const row = node("tr");
    const when = node("td", "left");
    when.append(chainDot(item.chain), " ", Object.assign(node("a", "", timeAgo(item.time)), { href: `${CHAINS[item.chain]?.tx ?? "#"}${item.hash}`, target: "_blank", rel: "noopener" }));
    const from = node("td", "left");
    from.append(walletLink(item.from));
    const to = node("td", "left");
    to.append(walletLink(item.to));
    const incoming = item.to.address?.toLowerCase() === own;
    const token = node("td", "left ex-token-cell");
    const coin = node("span", "coin-cell");
    coin.append(logo({ id: item.token.symbol, symbol: item.token.symbol, image: item.token.icon }), node("b", "", item.token.symbol));
    token.append(coin);
    row.append(when, from, to, node("td", incoming ? "up" : "down", `${incoming ? "+" : "−"}${amountShort(item.amount)}`), token,
      node("td", "", usdShort(item.usd)));
    return row;
  }), ...(shown.length ? [] : [message(loadingMore ? t().loadingTransfers : filtered() ? t().noMatch : hidden ? t().hiddenDust(hidden) : t().noTransfers,
    !loadingMore && filtered() ? clearButton() : !loadingMore && hidden ? reveal() : null)]),
    ...(!shown.length && !hidden && !loadingMore && explorerLinks().length ? [(() => { const row = message(t().openIn); row.firstChild.append(" ", ...explorerLinks()); return row; })()] : []),
    ...(shown.length && hidden && !hasMore() ? [message(t().hiddenDust(hidden), reveal())] : []));
  $("#more").hidden = !hasMore();
  renderCounterparties();
  scheduleChart();
  // With spam hidden a page can leave the panel half empty: the next pages come until it fills (five at most).
  const box = $(".ex-transfers").closest(".table-wrap");
  if (started && hasMore() && !loadingMore && autoPages < 5 && box.scrollHeight <= box.clientHeight + 80) { autoPages += 1; void loadTransfers(); }
}
let autoPages = 0;
const filtered = () => Boolean(tfilter.from || tfilter.to || tfilter.token || tfilter.amount || tfilter.usd);
const clearButton = () => { const button = node("button", "pill", t().clearFilters); button.type = "button";
  button.addEventListener("click", () => { tfilter.from = tfilter.to = ""; tfilter.token = tfilter.amount = tfilter.usd = null; renderTransfers(); }); return button; };
// Value and dollars, as on the analytics sites: a minimum and a maximum, a two-handled slider over the loaded
// transfers' range (on a log scale), quick thresholds for dollars, the order, and Reset / Close / Apply.
function rangeFilter(key, pop) {
  const band = tfilter[key] ?? { min: null, max: null };
  const number = (text) => { const value = Number(String(text).replace(/[\s$]/g, "").replace(",", ".")); return String(text).trim() && Number.isFinite(value) ? value : null; };
  const short = (value) => (key === "usd" ? usdShort(value) : amountShort(value));
  const top = Math.max(1, ...transfers.filter(worth).map((item) => item[key] ?? 0));
  // Slider position 0…1000 ↔ value 0…top, log-spaced so small and large sums both get room.
  const toValue = (position) => (position <= 0 ? 0 : position >= 1000 ? top : 10 ** (position / 1000 * Math.log10(top + 1)) - 1);
  const toPosition = (value) => (value === null ? null : Math.round(Math.log10(Math.max(0, value) + 1) / Math.log10(top + 1) * 1000));
  const box = (label, value) => {
    const wrap = node("label", "ex-field");
    const input = Object.assign(node("input", ""), { type: "text", inputMode: "decimal", value: value ?? "", placeholder: label });
    wrap.append(node("small", "muted", label), node("span", "ex-field-box"));
    if (key === "usd") wrap.lastChild.append(node("i", "", "$"));
    wrap.lastChild.append(input);
    return [wrap, input];
  };
  const [minWrap, from] = box(t().rangeMin, band.min);
  const [maxWrap, to] = box(t().rangeMax, band.max);
  const fields = node("div", "ex-range2");
  fields.append(minWrap, maxWrap);
  const low = Object.assign(node("input", ""), { type: "range", min: 0, max: 1000, step: 1, value: toPosition(band.min) ?? 0 });
  const high = Object.assign(node("input", ""), { type: "range", min: 0, max: 1000, step: 1, value: toPosition(band.max) ?? 1000 });
  const slider = node("div", "ex-slider");
  const fill = node("i", "");
  slider.append(fill, low, high);
  const label = node("b", "");
  const paint = () => {
    const left = Number(low.value) / 10;
    const right = Number(high.value) / 10;
    fill.style.left = `${left}%`;
    fill.style.right = `${100 - right}%`;
    const min = number(from.value);
    const max = number(to.value);
    label.textContent = min === null && max === null ? t().rangeAny : `${min === null ? "0" : short(min)} – ${max === null ? "∞" : short(max)}`;
  };
  // The handles fill the fields, the fields move the handles.
  const slide = (handle) => {
    if (Number(low.value) > Number(high.value)) (handle === low ? low : high).value = handle === low ? high.value : low.value;
    from.value = Number(low.value) <= 0 ? "" : String(Number(toValue(Number(low.value)).toPrecision(2)));
    to.value = Number(high.value) >= 1000 ? "" : String(Number(toValue(Number(high.value)).toPrecision(2)));
    paint();
  };
  low.addEventListener("input", () => slide(low));
  high.addEventListener("input", () => slide(high));
  for (const [input, handle, empty] of [[from, low, 0], [to, high, 1000]]) {
    input.addEventListener("input", () => { handle.value = toPosition(number(input.value)) ?? empty; paint(); });
  }
  const apply = () => {
    const min = number(from.value);
    const max = number(to.value);
    tfilter[key] = min === null && max === null ? null : { min, max };
    renderTransfers();
    pop.remove();
  };
  for (const input of [from, to]) input.addEventListener("keydown", (event) => { if (event.key === "Enter") apply(); if (event.key === "Escape") pop.remove(); });
  const range = node("div", "ex-range-head");
  range.append(node("small", "muted", t().rangeLabel), label);
  const quick = node("div", "ex-quick");
  if (key === "usd") {
    quick.append(...[[1_000, "$1K"], [10_000, "$10K"], [100_000, "$100K"], [1_000_000, "$1M"]].map(([value, text]) => {
      const button = node("button", band.min === value && band.max === null ? "on" : "", `≥ ${text}`);
      button.type = "button";
      button.addEventListener("click", () => { from.value = String(value); to.value = ""; low.value = toPosition(value); high.value = 1000; paint(); });
      return button;
    }));
  }
  const order = node("div", "ex-quick");
  order.append(...[[-1, t().sortDesc], [1, t().sortAsc]].map(([dir, text]) => {
    const button = node("button", tsort.key === key && tsort.dir === dir ? "on" : "", text);
    button.type = "button";
    button.addEventListener("click", () => { tsort.key = key; tsort.dir = dir; renderTransfers(); pop.remove(); });
    return button;
  }));
  const foot = node("div", "ex-pop-foot");
  const action = (text, className, click) => { const button = node("button", className, text); button.type = "button"; button.addEventListener("click", click); return button; };
  foot.append(action(t().resetRange, "", () => { tfilter[key] = null; renderTransfers(); pop.remove(); }), node("span", ""),
    action(t().close, "", () => pop.remove()), action(t().apply, "primary", apply));
  pop.classList.add("wide", "range");
  pop.append(fields, range, slider, ...(key === "usd" ? [quick] : []), node("small", "muted", t().sortBy), order, foot);
  paint();
  setTimeout(() => from.focus());
}
// A header's filter: a field for the sender or receiver, the loaded tokens for the token column.
function openFilter(head) {
  document.querySelector(".ex-pop")?.remove();
  const key = head.dataset.tfilter;
  const pop = node("div", "ex-pop");
  if (key === "amount" || key === "usd") rangeFilter(key, pop);
  else if (key === "token") {
    const counts = new Map();
    for (const item of transfers.filter(worth)) counts.set(item.token.symbol, (counts.get(item.token.symbol) ?? 0) + 1);
    const choose = (symbol) => { tfilter.token = symbol; pop.remove(); renderTransfers(); };
    const all = node("button", tfilter.token ? "" : "on", t().allTokens);
    all.type = "button";
    all.addEventListener("click", () => choose(null));
    pop.append(all, ...[...counts].sort((left, right) => right[1] - left[1]).slice(0, 30).map(([symbol, count]) => {
      const button = node("button", tfilter.token === symbol ? "on" : "");
      button.type = "button";
      button.append(node("b", "", symbol), node("span", "muted", String(count)));
      button.addEventListener("click", () => choose(symbol));
      return button;
    }));
  } else {
    const field = Object.assign(node("input", "ex-token"), { type: "search", value: tfilter[key], placeholder: t().partyFilter });
    field.addEventListener("input", () => { tfilter[key] = field.value.trim(); renderTransfers(); });
    field.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === "Escape") pop.remove(); });
    pop.append(field);
    setTimeout(() => field.focus());
  }
  head.append(pop);
}
// "All" asks the explorer networks and the node networks where the wallet holds something, all at once;
// each one's rows show as soon as it answers.
const transferChainsAll = () => (utxo ? ["btc"] : Object.keys(CHAINS).filter((chain) => chain !== "btc"
  && (!CHAINS[chain].node || data?.assets.some((asset) => asset.chain === chain) || activeChains().includes(chain))));
const transferChains = () => (utxo ? ["btc"] : transferChain === "all" ? transferChainsAll() : [transferChain]);
const hasMore = () => transferChains().some((chain) => cursors[chain] !== null);
let started = false; // the first pages were asked for: until then a render must not ask for them too
async function loadTransfers(reset = false) {
  if (reset) started = true;
  if (reset) { transfers = []; cursors = {}; autoPages = 0; generation += 1; loadingMore = false; }
  if (loadingMore) return;
  loadingMore = true;
  const mine = generation;
  await Promise.all(transferChains().filter((chain) => cursors[chain] !== null).map(async (chain) => {
    const query = new URLSearchParams({ dir: direction, ...(utxo ? {} : { chain }), ...(cursors[chain] ? { cursor: cursors[chain] } : {}) });
    const ask = () => fetch(`/market/chain/address/${encodeURIComponent(address)}/transfers?${query}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
    // A busy network may turn a request away: two more tries, a little later each.
    const later = (ms) => new Promise((done) => { setTimeout(done, ms); }).then(ask);
    const answer = await ask() ?? await later(2500) ?? await later(6000);
    if (mine !== generation) return;
    // A page that failed keeps its place: the next scroll or reach back asks for it again.
    if (answer) cursors[chain] = answer.next ?? null;
    if (answer) {
      transfers = [...transfers, ...answer.items];
      // Pages with no direction filter are complete: they feed the history and the counterparties.
      if (direction === "all") {
        for (const item of answer.items) ledger.set(item.id, item);
        // A node page says how far back it read, transfers or not.
        reached[chain] = cursors[chain] === null ? 0 : Math.min(reached[chain] ?? Date.now(), answer.reached ?? Date.now(), ...answer.items.map((item) => item.time));
      }
    }
    renderTransfers();
  }));
  if (mine !== generation) return;
  loadingMore = false;
  renderTransfers();
}
// Who this address deals with most, from the transfers loaded so far (spam-sized ones left out while hidden).
function renderCounterparties() {
  const own = address.toLowerCase();
  const byWallet = new Map();
  for (const item of ledger.values()) {
    if (!worth(item)) continue;
    const incoming = item.to.address?.toLowerCase() === own;
    const other = incoming ? item.from : item.to;
    if (!other?.address || other.address.toLowerCase() === own) continue;
    const entry = byWallet.get(other.address) ?? { party: other, in: 0, out: 0, count: 0 };
    entry[incoming ? "in" : "out"] += item.usd ?? 0;
    entry.count += 1;
    byWallet.set(other.address, entry);
  }
  const top = [...byWallet.values()].sort((left, right) => right.in + right.out - left.in - left.out || right.count - left.count).slice(0, 30);
  $("#counterparties").replaceChildren(...(top.length ? top.map((entry) => {
    const row = node("tr");
    const who = node("td", "left");
    who.append(walletLink(entry.party));
    row.append(who, node("td", "up", entry.in ? usdShort(entry.in) : "—"), node("td", "down", entry.out ? usdShort(entry.out) : "—"), node("td", "", String(entry.count)));
    return row;
  }) : [(() => { const row = node("tr"); const cell = node("td", "muted ex-empty", loadingMore ? t().loadingTransfers : t().noCounter); cell.colSpan = 4; row.append(cell); return row; })()]));
}

function render() {
  if (!data) {
    $("#status").textContent = failure || t().missing;
    if (!failure && ADDRESS.test(address)) $("#status").textContent = language === "en" ? en.loading : "Загружаю адрес… крупный кошелёк может загружаться до полуминуты.";
    return;
  }
  $("#status").hidden = true;
  $("#page").hidden = false;
  renderHead();
  renderAssets();
  renderTransfers();
  renderChart();
}

async function loadSaved() {
  if (!account.user) { saved = null; if (data) renderHead(); return; }
  const answer = await fetch("/market/me/addresses", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  saved = answer?.addresses.find((item) => item.address.toLowerCase() === address.toLowerCase()) ?? null;
  if (data) renderHead();
}
async function save(changes) {
  if (!account.user) {
    if (account.signIn) location.href = signInUrl();
    else alert(t().signIn);
    return;
  }
  const { status, data: answer } = changes === null
    ? await send(`/market/me/addresses/${encodeURIComponent(address)}`, "DELETE")
    : await send(`/market/me/addresses/${encodeURIComponent(address)}`, "PUT", changes);
  if (status === 200) saved = answer.addresses.find((item) => item.address.toLowerCase() === address.toLowerCase()) ?? null;
  renderHead();
  // A word on what the button did, since a phone shows no hints on hover.
  if (status === 200 && changes) {
    const note = $("#action-note");
    note.replaceChildren(t().trackDone, " ", Object.assign(node("a", "", t().openTracked), { href: `/u/${encodeURIComponent(account.user?.username ?? "")}#tracked` }));
    note.hidden = false;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => { note.hidden = true; }, 6_000);
  }
}

async function load() {
  if (!ADDRESS.test(address)) { failure = t().missing; render(); return; }
  if (utxo) transferChain = "btc";
  const response = await fetch(`/market/chain/address/${encodeURIComponent(address)}`).catch(() => null);
  if (!response?.ok) { failure = t().unavailable; render(); return; }
  data = await response.json();
  // A known wallet asked by its id: its network comes with the answer.
  if (masked && data.kind === "utxo") { utxo = true; transferChain = "btc"; }
  render();
  await loadTransfers(true);
  void reachBack();
}

$("#copy").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(address).catch(() => {});
  $("#copy").textContent = t().copied;
  setTimeout(() => { $("#copy").textContent = language === "en" ? en.copy : "Копировать"; }, 1500);
});
$("#share").addEventListener("click", async () => {
  const url = location.href;
  if (navigator.share) await navigator.share({ title: document.title, url }).catch(() => {});
  else {
    await navigator.clipboard?.writeText(url).catch(() => {});
    const label = $("#share").textContent;
    $("#share").textContent = t().copied;
    setTimeout(() => { $("#share").textContent = label; }, 1500);
  }
});
$("#track").addEventListener("click", () => void save(saved ? null : { mine: false }));
// Suggest a name: it shows once a moderator approves it.
$("#suggest").addEventListener("click", async () => {
  if (!account.user) { if (account.signIn) location.href = signInUrl(); else alert(t().signInSuggest); return; }
  const name = prompt(t().askName)?.trim();
  if (!name) return;
  const link = prompt(t().askLink)?.trim() ?? "";
  const { status, data: answer } = await send("/market/labels", "POST", { address, name, link });
  alert(status === 201 ? t().sent : answer.error ?? "Error");
});
for (const button of document.querySelectorAll("#assets-tabs [data-view]")) button.addEventListener("click", () => { view = button.dataset.view; renderAssets(); });
for (const button of document.querySelectorAll("#direction [data-dir]")) button.addEventListener("click", () => { direction = button.dataset.dir; void loadTransfers(true); });
for (const button of document.querySelectorAll("#chart-tabs [data-chart]")) button.addEventListener("click", () => { chart = button.dataset.chart; renderChart(); });
$("#dust").addEventListener("click", () => { dust = !dust; renderTransfers(); });
for (const head of document.querySelectorAll(".ex-transfers [data-tsort]:not([data-tfilter])")) {
  head.addEventListener("click", () => {
    const key = head.dataset.tsort;
    if (tsort.key === key) tsort.dir = -tsort.dir; else { tsort.key = key; tsort.dir = -1; }
    renderTransfers();
  });
}
for (const head of document.querySelectorAll(".ex-transfers [data-tfilter]")) {
  head.addEventListener("click", (event) => { if (!event.target.closest(".ex-pop")) openFilter(head); });
}
document.addEventListener("click", (event) => { if (!event.target.closest(".ex-pop, [data-tfilter]")) document.querySelector(".ex-pop")?.remove(); });
addEventListener("resize", () => scheduleChart());
$("#more").addEventListener("click", () => void loadTransfers());
// Near the bottom of the transfers panel, the next page comes by itself.
$(".ex-transfers").closest(".table-wrap").addEventListener("scroll", (event) => {
  const box = event.currentTarget;
  if (hasMore() && !loadingMore && box.scrollTop + box.clientHeight > box.scrollHeight - 80) void loadTransfers();
});
sortable($("#assets-table thead"), sort, renderAssets);
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});

setupSearch({});
setupPage({ en, render, onAccount: () => { void loadSaved(); } });
void load();
