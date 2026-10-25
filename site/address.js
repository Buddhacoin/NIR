// A wallet's page, /address/<address>, in the manner of the analytics sites:
// its open name and tags, what it holds on every network and the total, the
// network coin's balance by day, its transfers (all, in or out) a page at a
// time, and the wallets it deals with most. Signed in, the visitor can track
// it (a bookmark kept on the server) or mark it as their own, so the profile
// adds it to their holdings. Data comes from /market/chain (market-chain.mjs).

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navPortfolio: "Portfolio", navNir: "NIR", search: "Search coins or addresses",
  loading: "Loading the address… a large wallet can take up to half a minute.", copy: "Copy", share: "Share", portfolio: "Portfolio", networks: "Assets by network",
  colAsset: "Asset", colChain: "Network", colPrice: "Price", colAmount: "Amount", colValue: "Value", colAssets: "Assets", colShare: "Share",
  history: "Balance history", shares: "Asset shares", counterparties: "Top counterparties", counterNote: "From the loaded transfers: who this address deals with most.",
  colWallet: "Address", colIn: "Received from", colOut: "Sent to", colCount: "Transfers", dirAll: "Transfers", dirIn: "Inflow", dirOut: "Outflow",
  colTime: "Time", colFrom: "From", colTo: "To", colUsd: "USD", more: "Show more", suggest: "✎ Suggest a name",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { title: (name) => `${name} — кошелёк на NIR Markets`, wallet: "Кошелёк", contract: "Контракт", track: "☆ Отследить адрес", tracked: "★ Отслеживается",
    mine: "Это мой адрес", isMine: "✓ Мой адрес", copied: "Скопировано", missing: "Это не адрес кошелька.",
    unavailable: "Обозреватель сейчас не отвечает. Попробуйте через минуту.", empty: "Активов не найдено.",
    partial: (names) => `Не удалось загрузить токены в сети ${names}: у адреса слишком много токенов, обозреватель не успел ответить. Показан баланс монеты сети.`,
    failed: (names) => `Сеть ${names} сейчас не отвечает.`, noTransfers: "Переводов не найдено.", noCounter: "Пока нечего показать.",
    signIn: "Войдите через Google, чтобы отслеживать адреса.", historyNote: (symbol) => `Баланс ${symbol} по дням, по данным обозревателя.`,
    noHistory: "Истории баланса для этой сети нет.", sharesTab: "Доли", sharesTitle: "Доли активов", historyTitle: "История баланса",
    sharesNote: "Из чего состоит кошелёк, по стоимости в долларах.", others: "Остальные", allChains: "Все", loadingTransfers: "Загружаю переводы по всем сетям…",
    nodeNote: "Эта сеть читается с открытого узла: видны переводы токенов примерно за последние сутки, переводы самой монеты сети не видны.",
    askName: "Как называется этот кошелёк? (2–40 символов, например «Биржа Olympus — горячий кошелёк»)",
    askLink: "Ссылка, где это опубликовано (необязательно, https://…)", sent: "Спасибо! Подпись появится после проверки модератором.",
    signInSuggest: "Войдите через Google, чтобы предлагать подписи." },
  en: { title: (name) => `${name} — wallet on NIR Markets`, wallet: "Wallet", contract: "Contract", track: "☆ Track address", tracked: "★ Tracked",
    mine: "This is mine", isMine: "✓ My address", copied: "Copied", missing: "This is not a wallet address.",
    unavailable: "The explorer is not answering. Try again in a minute.", empty: "No assets found.",
    partial: (names) => `Tokens on ${names} did not load: the address holds too many and the explorer timed out. The network coin balance is shown.`,
    failed: (names) => `${names} is not answering right now.`, noTransfers: "No transfers found.", noCounter: "Nothing to show yet.",
    signIn: "Sign in with Google to track addresses.", historyNote: (symbol) => `${symbol} balance by day, from the explorer.`,
    noHistory: "No balance history for this network.", sharesTab: "Shares", sharesTitle: "Asset shares", historyTitle: "Balance history",
    sharesNote: "What the wallet is made of, by dollar value.", others: "Others", allChains: "All", loadingTransfers: "Loading transfers on every network…",
    nodeNote: "This network is read from a public node: token transfers of about the last day are visible, the network coin's own transfers are not.",
    askName: "What is this wallet? (2–40 characters, e.g. “Olympus exchange hot wallet”)",
    askLink: "A link where this is published (optional, https://…)", sent: "Thank you! The name shows once a moderator approves it.",
    signInSuggest: "Sign in with Google to suggest names." },
};
const t = () => words[language];
const address = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const utxo = /^(?:bc1|[13])/.test(address);
let data = null;
let failure = "";
let saved = null; // this address in the visitor's saved list, or null
let view = "assets";
let historyChain = "shares"; // "shares" draws the asset split; a network draws its coin's balance by day
let direction = "all";
let transferChain = "all";
let dust = true; // hide transfers worth under $1 (mostly spam tokens)
let transfers = [];
let cursors = {}; // network → the next page's cursor; missing: not asked yet, null: no more pages
let loadingMore = false;
let generation = 0; // a new filter starts a new generation; answers to an older one are dropped
const sort = { key: null, dir: 0 };
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const chainName = (chain) => CHAINS[chain]?.name ?? chain;
const COLORS = ["#3861fb", "#16c784", "#f3a12f", "#8b7bff", "#ea3943", "#2ee6a6", "#f7931a", "#00b8d9", "#c05cff", "#9aa4b5"];

// --- The head: name, address, total, tags and the buttons.
function renderHead() {
  const name = data.name ?? (data.contract ? t().contract : t().wallet);
  document.title = t().title(data.name ?? shortAddress(address));
  $("#name").textContent = name;
  $("#address").textContent = address;
  const hue = [...address.toLowerCase()].reduce((sum, char) => sum + char.charCodeAt(0) * 13, 0) % 360;
  $("#avatar").style.background = `linear-gradient(135deg,hsl(${hue} 70% 55%),hsl(${(hue + 70) % 360} 70% 40%))`;
  $("#avatar").textContent = (data.name ?? "◎")[0].toUpperCase();
  $("#total").textContent = price(data.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0));
  const held = new Set(data.assets.map((asset) => asset.chain));
  $("#tags").replaceChildren(...data.networks.filter((item) => item.ok && held.has(item.chain)).map((item) => { const chip = node("span", "ex-chip"); chip.append(chainDot(item.chain), chainName(item.chain)); return chip; }),
    ...data.tags.map((tag) => node("span", "ex-chip tag", tag)));
  $("#track").textContent = saved ? t().tracked : t().track;
  $("#track").classList.toggle("ghost", Boolean(saved));
  $("#mine").textContent = saved?.mine ? t().isMine : t().mine;
  $("#mine").classList.toggle("on", Boolean(saved?.mine));
  const partial = data.networks.filter((item) => item.partial).map((item) => chainName(item.chain));
  const failed = data.networks.filter((item) => !item.ok).map((item) => chainName(item.chain));
  $("#partial").hidden = !partial.length && !failed.length;
  $("#partial").textContent = [partial.length ? t().partial(partial.join(", ")) : "", failed.length ? t().failed(failed.join(", ")) : ""].filter(Boolean).join(" ");
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
    const cell = node("td", "muted", t().empty);
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

// --- The network coin's balance by day, drawn as a line.
async function renderHistory() {
  const box = $("#plot");
  const evm = Object.keys(CHAINS).filter((chain) => CHAINS[chain].history);
  if (historyChain !== "shares" && !CHAINS[historyChain]?.history) historyChain = "shares";
  $("#history-chain").replaceChildren(...["shares", ...(utxo ? [] : evm)].map((chain) => {
    const button = node("button", chain === historyChain ? "on" : "", chain === "shares" ? t().sharesTab : CHAINS[chain].short);
    button.type = "button";
    button.title = chain === "shares" ? t().sharesTitle : chainName(chain);
    button.addEventListener("click", () => { historyChain = chain; void renderHistory(); });
    return button;
  }));
  $("#history-title").textContent = historyChain === "shares" ? t().sharesTitle : t().historyTitle;
  if (historyChain === "shares") { $("#history-note").textContent = t().sharesNote; drawShares(box); return; }
  const answer = await fetch(`/market/chain/address/${encodeURIComponent(address)}/history?chain=${historyChain}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  const points = answer?.points ?? [];
  $("#history-note").textContent = points.length > 1 ? t().historyNote(answer.symbol) : t().noHistory;
  if (points.length < 2) { box.replaceChildren(); return; }
  const width = Math.max(280, box.clientWidth);
  const height = Math.max(180, box.clientHeight);
  const right = width - 64;
  const values = points.map(([, value]) => value);
  let low = Math.min(...values);
  let high = Math.max(...values);
  const pad = (high - low) * 0.1 || high * 0.05 || 1;
  low = Math.max(0, low - pad);
  high += pad;
  const x = (time) => (time - points[0][0]) / ((points.at(-1)[0] - points[0][0]) || 1) * right;
  const y = (value) => 10 + (high - value) / (high - low) * (height - 34);
  const line = points.map(([time, value], index) => `${index ? "L" : "M"}${x(time).toFixed(1)},${y(value).toFixed(1)}`).join("");
  const ticks = [0, 0.33, 0.66, 1].map((share) => low + (high - low) * share);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = `<defs><linearGradient id="ex-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".3"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((value) => `<line class="grid" x1="0" x2="${right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text class="tick" x="${right + 8}" y="${(y(value) + 4).toFixed(1)}">${amountShort(value)}</text>`).join("")}
    <path d="${line}L${right},${height - 24}L0,${height - 24}Z" fill="url(#ex-fill)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${[0, 0.5, 1].map((share) => { const time = points[0][0] + (points.at(-1)[0] - points[0][0]) * share; return `<text class="tick" text-anchor="${share === 0 ? "start" : share === 1 ? "end" : "middle"}" x="${(share * right).toFixed(1)}" y="${height - 6}">${new Date(time).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "2-digit" })}</text>`; }).join("")}`;
  box.replaceChildren(svg);
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

// --- Transfers: a page at a time from the explorer; spam-sized ones hidden by default.
function renderTransfers() {
  for (const button of document.querySelectorAll("#direction [data-dir]")) button.classList.toggle("on", button.dataset.dir === direction);
  $("#dust").classList.toggle("on", dust);
  $("#transfer-chain").replaceChildren(...(utxo ? [] : ["all", ...Object.keys(CHAINS).filter((chain) => chain !== "btc")].map((chain) => {
    const button = node("button", chain === transferChain ? "on" : "", chain === "all" ? t().allChains : CHAINS[chain].short);
    button.type = "button";
    button.title = chain === "all" ? t().allChains : chainName(chain);
    button.addEventListener("click", () => { transferChain = chain; void loadTransfers(true); });
    return button;
  })));
  $("#node-note").hidden = !CHAINS[transferChain]?.node;
  $("#node-note").textContent = t().nodeNote;
  // Pages of token and coin transfers arrive separately: shown together, newest first.
  const shown = transfers.filter((item) => !dust || (item.usd ?? 0) >= 1).sort((left, right) => right.time - left.time);
  const own = address.toLowerCase();
  $("#transfers").replaceChildren(...(shown.length ? shown.map((item) => {
    const row = node("tr");
    const when = node("td", "left");
    when.append(chainDot(item.chain), " ", Object.assign(node("a", "", timeAgo(item.time)), { href: `${CHAINS[item.chain]?.tx ?? "#"}${item.hash}`, target: "_blank", rel: "noopener" }));
    const from = node("td", "left");
    from.append(walletLink(item.from));
    const to = node("td", "left");
    to.append(walletLink(item.to));
    const incoming = item.to.address?.toLowerCase() === own;
    row.append(when, from, to, node("td", incoming ? "up" : "down", `${incoming ? "+" : "−"}${amountShort(item.amount)} ${item.token.symbol}`),
      node("td", "", usdShort(item.usd)));
    return row;
  }) : [(() => { const row = node("tr"); const cell = node("td", "muted", loadingMore ? t().loadingTransfers : t().noTransfers); cell.colSpan = 5; row.append(cell); return row; })()]));
  $("#more").hidden = !hasMore();
  renderCounterparties();
  // With spam hidden a page can leave the panel half empty: the next pages come until it fills (five at most).
  const box = $(".ex-transfers").closest(".table-wrap");
  if (hasMore() && !loadingMore && autoPages < 5 && box.scrollHeight <= box.clientHeight + 80) { autoPages += 1; void loadTransfers(); }
}
let autoPages = 0;
// "All" asks every network at once; each one's rows show as soon as it answers.
const transferChains = () => (utxo ? ["btc"] : transferChain === "all" ? Object.keys(CHAINS).filter((chain) => chain !== "btc") : [transferChain]);
const hasMore = () => transferChains().some((chain) => cursors[chain] !== null);
async function loadTransfers(reset = false) {
  if (reset) { transfers = []; cursors = {}; autoPages = 0; generation += 1; loadingMore = false; }
  if (loadingMore) return;
  loadingMore = true;
  const mine = generation;
  await Promise.all(transferChains().filter((chain) => cursors[chain] !== null).map(async (chain) => {
    const query = new URLSearchParams({ dir: direction, ...(utxo ? {} : { chain }), ...(cursors[chain] ? { cursor: cursors[chain] } : {}) });
    const answer = await fetch(`/market/chain/address/${encodeURIComponent(address)}/transfers?${query}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
    if (mine !== generation) return;
    cursors[chain] = answer?.next ?? null;
    if (answer) transfers = [...transfers, ...answer.items];
    renderTransfers();
  }));
  if (mine !== generation) return;
  loadingMore = false;
  renderTransfers();
}
// Who this address deals with most, from the transfers loaded so far.
function renderCounterparties() {
  const own = address.toLowerCase();
  const byWallet = new Map();
  for (const item of transfers) {
    const incoming = item.to.address?.toLowerCase() === own;
    const other = incoming ? item.from : item.to;
    if (!other?.address || other.address.toLowerCase() === own) continue;
    const entry = byWallet.get(other.address) ?? { party: other, in: 0, out: 0, count: 0 };
    entry[incoming ? "in" : "out"] += item.usd ?? 0;
    entry.count += 1;
    byWallet.set(other.address, entry);
  }
  const top = [...byWallet.values()].sort((left, right) => right.in + right.out - left.in - left.out).slice(0, 8);
  $("#counterparties").replaceChildren(...(top.length ? top.map((entry) => {
    const row = node("tr");
    const who = node("td", "left");
    who.append(walletLink(entry.party));
    row.append(who, node("td", "up", entry.in ? price(entry.in) : "—"), node("td", "down", entry.out ? price(entry.out) : "—"), node("td", "", String(entry.count)));
    return row;
  }) : [(() => { const row = node("tr"); const cell = node("td", "muted", t().noCounter); cell.colSpan = 4; row.append(cell); return row; })()]));
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
}

async function load() {
  if (!ADDRESS.test(address)) { failure = t().missing; render(); return; }
  if (utxo) transferChain = "btc";
  const response = await fetch(`/market/chain/address/${encodeURIComponent(address)}`).catch(() => null);
  if (!response?.ok) { failure = t().unavailable; render(); return; }
  data = await response.json();
  render();
  void renderHistory();
  void loadTransfers(true);
}

$("#copy").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(address).catch(() => {});
  $("#copy").textContent = t().copied;
  setTimeout(() => { $("#copy").textContent = language === "en" ? en.copy : "Копировать"; }, 1500);
});
$("#share").addEventListener("click", async () => {
  const url = location.href;
  if (navigator.share) await navigator.share({ title: document.title, url }).catch(() => {});
  else { await navigator.clipboard?.writeText(url).catch(() => {}); $("#share").textContent = t().copied; }
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
$("#mine").addEventListener("click", () => void save({ mine: !saved?.mine }));
for (const button of document.querySelectorAll("#assets-tabs [data-view]")) button.addEventListener("click", () => { view = button.dataset.view; renderAssets(); });
for (const button of document.querySelectorAll("#direction [data-dir]")) button.addEventListener("click", () => { direction = button.dataset.dir; void loadTransfers(true); });
$("#dust").addEventListener("click", () => { dust = !dust; renderTransfers(); });
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
