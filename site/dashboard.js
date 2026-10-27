// The owner's dashboard on their profile, as on the on-chain analytics sites: four quadrants over the
// wallets they marked as their own — the portfolio (by token, by network, and an archive comparing
// two dates), the balance history and profit and loss, the transactions with inflow and outflow,
// and the accounts with a + to add one (MetaMask or by hand). Choosing an account or a network
// narrows every quadrant. Balances come from /market/chain/address, transfers from its /transfers
// pages; the history and the archive are rebuilt from the loaded transfers at today's prices.
// Uses `page`, `saved`, `holdings`, `holdingsOf` and `loadSaved` from profile.js.

const dashWords = {
  ru: { portfolio: "Портфель", chains: "По сетям", archive: "Архив", history: "История баланса", pnl: "Прибыль и убыток",
    transactions: "Транзакции", inflow: "Входящие", outflow: "Исходящие", accounts: "Все аккаунты", allNetworks: "Все сети",
    asset: "Актив", price: "Цена", holdings: "Количество", value: "Стоимость", network: "Сеть", share: "Доля", account: "Аккаунт",
    time: "Время", from: "От", to: "Кому", amount: "Количество", token: "Токен", usd: "USD", day: "24 ч", week: "7 д",
    ranges: [[7, "1Н"], [30, "1М"], [90, "3М"], [0, "Всё"]], empty: "Пусто", loading: "загружаю…", more: "Загрузить ещё",
    add: "Добавить аккаунт", addShort: "Добавить", metamask: "Подключить MetaMask", noMetamask: "MetaMask не найден в браузере — установите его с metamask.io или вставьте адрес вручную.",
    manual: "Или вставьте адрес вручную", address: "Адрес кошелька (0x… или bc1…)", label: "Подпись (необязательно)", save: "Добавить",
    private: "Добавленные адреса видите только вы.", badAddress: "Это не адрес кошелька.", remove: "Убрать аккаунт",
    others: (count) => `(+${count})`, minUsd: "USD ≥ $0,10", archiveFrom: "Дата 1", archiveTo: "Дата 2", change: "Изменение",
    historyNote: (date) => `По загруженным переводам с ${date}, в сегодняшних ценах.`, archiveNote: "Количества восстановлены по загруженным переводам; стоимость — в сегодняшних ценах.",
    pnlNote: "Прибыль и убыток — по изменению цен за 24 часа и 7 дней на сегодняшние количества.", total: "Итого",
    hint: "Добавьте свои кошельки кнопкой «+» — здесь появятся портфель, история, транзакции и прибыль по всем сетям.",
    newPortfolio: "＋ Новый портфель", askPortfolio: "Название портфеля (например «Долгосрок» или «Трейдинг»)", rename: "Переименовать", removePortfolio: "Удалить портфель",
    confirmRemove: (name) => `Удалить портфель «${name}»? Кошельки из него останутся в «Отслеживаемых».`, firstPortfolio: "Основной" },
  en: { portfolio: "Portfolio", chains: "Holdings by chain", archive: "Portfolio archive", history: "Balances history", pnl: "Profit & loss",
    transactions: "Transactions", inflow: "Inflow", outflow: "Outflow", accounts: "All accounts", allNetworks: "All networks",
    asset: "Asset", price: "Price", holdings: "Holdings", value: "Value", network: "Network", share: "Share", account: "Account",
    time: "Time", from: "From", to: "To", amount: "Amount", token: "Token", usd: "USD", day: "24h", week: "7d",
    ranges: [[7, "1W"], [30, "1M"], [90, "3M"], [0, "All"]], empty: "Empty", loading: "loading…", more: "Load more",
    add: "Add an account", addShort: "Add", metamask: "Connect MetaMask", noMetamask: "MetaMask is not in this browser: install it from metamask.io or paste the address by hand.",
    manual: "Or paste an address", address: "Wallet address (0x… or bc1…)", label: "Label (optional)", save: "Add",
    private: "Only you see the addresses you add.", badAddress: "This is not a wallet address.", remove: "Remove the account",
    others: (count) => `(+${count})`, minUsd: "USD ≥ $0.10", archiveFrom: "Date 1", archiveTo: "Date 2", change: "Change",
    historyNote: (date) => `From the loaded transfers since ${date}, at today's prices.`, archiveNote: "Amounts are rebuilt from the loaded transfers; values are at today's prices.",
    pnlNote: "Profit and loss from the 24-hour and 7-day price change on today's amounts.", total: "Total",
    hint: "Add your wallets with the + button: the portfolio, history, transactions and profit across all networks show here.",
    newPortfolio: "+ New portfolio", askPortfolio: "Portfolio name (say “Long term” or “Trading”)", rename: "Rename", removePortfolio: "Delete portfolio",
    confirmRemove: (name) => `Delete the portfolio “${name}”? Its wallets stay under Tracked.`, firstPortfolio: "Main" },
};
const dw = () => dashWords[language === "en" ? "en" : "ru"];
const dashNode = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const dash = { q1: "portfolio", q2: "history", q3: "all", range: 30, account: null, network: "all", minUsd: true, portfolio: null,
  tsort: { key: "time", dir: -1 }, from: "", to: "" };
const dashLedger = new Map(); // transfer id → the transfer, from any own account
const dashCursors = new Map(); // "address|chain" → the next page's cursor, null once the last page is in
let dashLoading = false;
let dashBuilt = false;

// The chosen portfolio (the first one until another is picked), and its wallets.
const currentPortfolio = () => walletPortfolios.find((item) => item.id === dash.portfolio) ?? walletPortfolios[0] ?? null;
const ownAccounts = () => (saved ?? []).filter((item) => item.mine && (!currentPortfolio() || item.portfolioId === currentPortfolio().id));
const chosenAccounts = () => ownAccounts().filter((item) => !dash.account || item.address === dash.account);
const inNetwork = (chain) => dash.network === "all" || chain === dash.network;
const marketCoin = (token) => (market?.coins ?? []).find((coin) => (token.coinId ? coin.id === token.coinId : coin.symbol === token.symbol)) ?? null;
// The chosen accounts' assets on the chosen network.
function chosenAssets() {
  return chosenAccounts().flatMap((item) => (holdingsOf(item.address)?.assets ?? []).filter((asset) => inNetwork(asset.chain)).map((asset) => ({ ...asset, owner: item.address })));
}
// The same token on every network and account, as one row.
function byToken(assets) {
  const rows = new Map();
  for (const asset of assets) {
    const key = asset.token.coinId ?? asset.token.symbol;
    const row = rows.get(key) ?? { token: asset.token, amount: 0, usd: 0 };
    row.amount += asset.amount;
    row.usd += asset.usd ?? 0;
    rows.set(key, row);
  }
  return [...rows.values()].filter((row) => row.usd > 0 || row.amount > 0).sort((left, right) => right.usd - left.usd);
}
const changeOver = (usd, percent) => (percent === null || percent === undefined ? null : usd - usd / (1 + percent / 100));
function tokenCell(token) {
  const cell = dashNode("span", "coin-cell");
  cell.append(logo({ id: token.symbol, symbol: token.symbol, image: token.icon ?? marketCoin(token)?.image ?? null }), dashNode("b", "", token.symbol));
  return cell;
}
function signedUsd(value) {
  const span = dashNode("small", changeClass(value), value === null ? "" : `${value >= 0 ? "+" : "−"}${usdShort(Math.abs(value))}`);
  return span;
}
function table(heads, rows) {
  const box = dashNode("table", "ex-table dash-table");
  const head = document.createElement("tr");
  for (const [text, left, key] of heads) {
    const th = dashNode("th", left ? "left" : "", text);
    if (key) th.dataset.sort = key;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  const body = document.createElement("tbody");
  body.append(...rows);
  box.append(thead, body);
  return box;
}
const emptyNote = (text) => dashNode("p", "muted dash-empty", text ?? dw().empty);
function tabStrip(items, current, choose) {
  const strip = dashNode("div", "dash-tabs");
  strip.append(...items.map(([key, label]) => {
    const button = dashNode("button", key === current ? "on" : "", label);
    button.type = "button";
    button.addEventListener("click", () => choose(key));
    return button;
  }));
  return strip;
}

// --- 1. Portfolio: by token, by network, or the archive comparing two dates.
function renderPortfolio(box) {
  const words = dw();
  const assets = chosenAssets();
  let content;
  if (dash.q1 === "portfolio") {
    const rows = byToken(assets).map((row) => {
      const coin = marketCoin(row.token);
      const priceNow = row.token.price ?? coin?.price ?? null;
      const tr = document.createElement("tr");
      const priceCell = dashNode("td", "", price(priceNow));
      if (coin?.change24h !== null && coin?.change24h !== undefined && priceNow) priceCell.append(" ", signedUsd(changeOver(priceNow, coin.change24h)));
      const valueCell = dashNode("td", "", usdShort(row.usd));
      if (coin) valueCell.append(" ", signedUsd(changeOver(row.usd, coin.change24h)));
      const name = dashNode("td", "left");
      name.append(tokenCell(row.token));
      tr.append(name, priceCell, dashNode("td", "", `${amountShort(row.amount)} ${row.token.symbol}`), valueCell);
      return tr;
    });
    content = rows.length ? table([[words.asset, true], [words.price], [words.holdings], [words.value]], rows) : emptyNote();
  } else if (dash.q1 === "chains") {
    const sums = new Map();
    for (const asset of assets) sums.set(asset.chain, (sums.get(asset.chain) ?? 0) + (asset.usd ?? 0));
    const total = [...sums.values()].reduce((sum, value) => sum + value, 0) || 1;
    const rows = [...sums].filter(([, value]) => value > 0).sort((left, right) => right[1] - left[1]).map(([chain, value]) => {
      const tr = document.createElement("tr");
      const name = dashNode("td", "left");
      name.append(chainDot(chain), " ", CHAINS[chain]?.name ?? chain);
      const share = dashNode("td", "left");
      const bar = dashNode("div", "bar");
      const fill = document.createElement("i");
      fill.style.width = `${(value / total * 100).toFixed(1)}%`;
      bar.append(fill);
      share.append(bar);
      tr.append(name, share, dashNode("td", "", `${(value / total * 100).toLocaleString(locale(), { maximumFractionDigits: 1 })}%`), dashNode("td", "", usdShort(value)));
      return tr;
    });
    content = rows.length ? table([[words.network, true], [words.share, true], ["%"], [words.value]], rows) : emptyNote();
  } else {
    content = renderArchive(assets);
  }
  box.replaceChildren(tabStrip([["portfolio", words.portfolio], ["chains", words.chains], ["archive", words.archive]], dash.q1,
    (key) => { dash.q1 = key; renderDashboard(); }), dashNode("div", "dash-body"));
  box.lastChild.append(content);
}
// Holdings at a moment: today's, with every loaded transfer after it undone.
function holdingsAt(assets, moment) {
  const own = new Set(chosenAccounts().map((item) => item.address.toLowerCase()));
  const book = new Map();
  for (const asset of assets) {
    const key = asset.token.coinId ?? asset.token.symbol;
    const entry = book.get(key) ?? { token: asset.token, amount: 0, price: asset.token.price };
    entry.amount += asset.amount;
    book.set(key, entry);
  }
  for (const item of dashLedger.values()) {
    if (item.time <= moment || !inNetwork(item.chain)) continue;
    const incoming = own.has(item.to.address?.toLowerCase());
    if (incoming === own.has(item.from.address?.toLowerCase())) continue;
    const key = item.token.coinId ?? item.token.symbol;
    const entry = book.get(key) ?? { token: item.token, amount: 0, price: item.token.price ?? (item.usd && item.amount ? item.usd / item.amount : null) };
    entry.amount += incoming ? -item.amount : item.amount;
    book.set(key, entry);
  }
  return book;
}
const dayInput = (value, change) => {
  const input = Object.assign(document.createElement("input"), { type: "date", value, max: new Date().toISOString().slice(0, 10) });
  input.addEventListener("change", () => change(input.value));
  return input;
};
function renderArchive(assets) {
  const words = dw();
  const today = new Date().toISOString().slice(0, 10);
  dash.from ||= new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  dash.to ||= today;
  const box = dashNode("div", "dash-archive");
  const pick = dashNode("div", "dash-dates");
  pick.append(dashNode("small", "muted", words.archiveFrom), dayInput(dash.from, (value) => { dash.from = value; renderDashboard(); }),
    dashNode("small", "muted", words.archiveTo), dayInput(dash.to, (value) => { dash.to = value; renderDashboard(); }));
  const end = (value) => (value === today ? Date.now() : Date.parse(`${value}T23:59:59`));
  const first = holdingsAt(assets, end(dash.from));
  const second = holdingsAt(assets, end(dash.to));
  const keys = new Set([...first.keys(), ...second.keys()]);
  const rows = [...keys].map((key) => {
    const a = first.get(key) ?? second.get(key);
    const amountA = Math.max(0, first.get(key)?.amount ?? 0);
    const amountB = Math.max(0, second.get(key)?.amount ?? 0);
    return { token: a.token, price: a.price, amountA, amountB };
  }).filter((row) => (row.amountA > 0 || row.amountB > 0) && row.price)
    .sort((left, right) => right.amountB * right.price - left.amountB * left.price).map((row) => {
      const tr = document.createElement("tr");
      const name = dashNode("td", "left");
      name.append(tokenCell(row.token));
      const delta = dashNode("td", "");
      delta.append(signedUsd((row.amountB - row.amountA) * row.price));
      tr.append(name, dashNode("td", "", amountShort(row.amountA)), dashNode("td", "", amountShort(row.amountB)), delta);
      return tr;
    });
  box.append(pick, rows.length ? table([[words.asset, true], [dash.from], [dash.to], [words.change]], rows) : emptyNote(), dashNode("p", "muted dash-note", words.archiveNote));
  return box;
}

// --- 2. Balances history (rebuilt from the transfers) and profit and loss.
function renderHistory(box) {
  const words = dw();
  const strip = tabStrip([["history", words.history], ["pnl", words.pnl]], dash.q2, (key) => { dash.q2 = key; renderDashboard(); });
  const body = dashNode("div", "dash-body");
  box.replaceChildren(strip, body);
  const assets = chosenAssets();
  if (dash.q2 === "pnl") {
    const rows = byToken(assets).map((row) => ({ ...row, coin: marketCoin(row.token) })).filter((row) => row.coin);
    const day = rows.reduce((sum, row) => sum + (changeOver(row.usd, row.coin.change24h) ?? 0), 0);
    const week = rows.reduce((sum, row) => sum + (changeOver(row.usd, row.coin.change7d) ?? 0), 0);
    const lines = rows.map((row) => {
      const tr = document.createElement("tr");
      const name = dashNode("td", "left");
      name.append(tokenCell(row.token));
      const a = dashNode("td");
      a.append(signedUsd(changeOver(row.usd, row.coin.change24h)));
      const b = dashNode("td");
      b.append(signedUsd(changeOver(row.usd, row.coin.change7d)));
      tr.append(name, dashNode("td", "", usdShort(row.usd)), a, b);
      return tr;
    });
    const sum = dashNode("div", "dash-pnl");
    for (const [label, value] of [[words.day, day], [words.week, week]]) {
      const tile = dashNode("div");
      tile.append(dashNode("small", "muted", label), dashNode("b", changeClass(value), `${value >= 0 ? "+" : "−"}${usdShort(Math.abs(value))}`));
      sum.append(tile);
    }
    body.append(...(rows.length ? [sum, table([[words.asset, true], [words.value], [words.day], [words.week]], lines)] : [emptyNote()]), dashNode("p", "muted dash-note", words.pnlNote));
    return;
  }
  const ranges = dashNode("div", "dash-ranges");
  ranges.append(...words.ranges.map(([days, label]) => {
    const button = dashNode("button", days === dash.range ? "on" : "", label);
    button.type = "button";
    button.addEventListener("click", () => { dash.range = days; renderDashboard(); });
    return button;
  }));
  const plot = dashNode("div", "dash-plot");
  body.append(ranges, plot);
  if (!assets.length) { plot.append(emptyNote()); return; }
  requestAnimationFrame(() => drawDashHistory(plot, assets, body));
}
function drawDashHistory(box, assets, body) {
  const own = new Set(chosenAccounts().map((item) => item.address.toLowerCase()));
  const keyOf = (chain, token) => `${chain}:${(token.address ?? "native").toLowerCase()}`;
  const book = new Map();
  for (const asset of assets) {
    const key = keyOf(asset.chain, asset.token);
    const entry = book.get(key) ?? { amount: 0, price: asset.token.price };
    entry.amount += asset.amount;
    book.set(key, entry);
  }
  let total = [...book.values()].reduce((sum, entry) => sum + Math.max(0, entry.amount) * (entry.price ?? 0), 0);
  const now = Date.now();
  const steps = [[now, total]];
  const items = [...dashLedger.values()].filter((item) => inNetwork(item.chain)).sort((left, right) => right.time - left.time);
  for (const item of items) {
    const incoming = own.has(item.to.address?.toLowerCase());
    if (incoming === own.has(item.from.address?.toLowerCase())) continue;
    const key = keyOf(item.chain, item.token);
    if (!book.has(key)) book.set(key, { amount: 0, price: item.token.price ?? (item.usd && item.amount ? item.usd / item.amount : null) });
    const entry = book.get(key);
    if (!entry.price) continue;
    const before = Math.max(0, entry.amount);
    entry.amount += incoming ? -item.amount : item.amount;
    total += (Math.max(0, entry.amount) - before) * entry.price;
    steps.push([item.time, total]);
  }
  const oldest = items.length ? items.at(-1).time : now - 86_400_000;
  const from = dash.range ? Math.max(now - dash.range * 86_400_000, Math.min(oldest, now - 3_600_000)) : Math.min(oldest, now - 3_600_000);
  const ascending = [];
  for (let index = steps.length - 1; index >= 1; index -= 1) ascending.push([steps[index][0], steps[index - 1][1]]);
  const points = [[from, ascending.findLast(([time]) => time <= from)?.[1] ?? steps.at(-1)[1]], ...ascending.filter(([time]) => time > from), [now, steps[0][1]]];
  const width = Math.max(260, box.clientWidth);
  const height = Math.max(180, box.clientHeight);
  const right = width - 92;
  const values = points.map(([, value]) => value);
  const pad = (Math.max(...values) - Math.min(...values)) * 0.15 || Math.max(...values) * 0.05 || 1;
  const low = Math.max(0, Math.min(...values) - pad);
  const high = Math.max(...values) + pad;
  const x = (time) => (time - from) / ((now - from) || 1) * right;
  const y = (value) => 10 + (high - value) / (high - low) * (height - 34);
  let line = `M${x(points[0][0]).toFixed(1)},${y(points[0][1]).toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) line += `H${x(points[index][0]).toFixed(1)}V${y(points[index][1]).toFixed(1)}`;
  const short = now - from < 2 * 86_400_000;
  // A narrow band of a large sum shows whole dollars, so the scale's labels differ.
  const label = (value) => ((high - low) / high < 0.02 ? `$${Math.round(value).toLocaleString(locale())}` : usdShort(value));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = `<defs><linearGradient id="dash-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${[0, 0.25, 0.5, 0.75, 1].map((share) => { const value = low + (high - low) * share; return `<line class="grid" x1="0" x2="${right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text class="tick" x="${right + 8}" y="${(y(value) + 4).toFixed(1)}">${label(value)}</text>`; }).join("")}
    <path d="${line}V${height - 24}H0Z" fill="url(#dash-fill)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${[0, 0.25, 0.5, 0.75, 1].map((share) => { const time = from + (now - from) * share; return `<text class="tick" text-anchor="${share === 0 ? "start" : share === 1 ? "end" : "middle"}" x="${(share * right).toFixed(1)}" y="${height - 6}">${short ? new Date(time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : new Date(time).toLocaleDateString(locale(), { day: "numeric", month: "short" })}</text>`; }).join("")}`;
  box.replaceChildren(svg);
  body.querySelector(".dash-note")?.remove();
  body.append(dashNode("p", "muted dash-note", dw().historyNote(new Date(from).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" }))));
}

// --- 3. Transactions of the chosen accounts: all, inflow, outflow; small ones hidden unless asked.
function renderTransactions(box) {
  const words = dw();
  const own = new Set(chosenAccounts().map((item) => item.address.toLowerCase()));
  const all = [...dashLedger.values()].filter((item) => inNetwork(item.chain) && (own.has(item.from.address?.toLowerCase()) || own.has(item.to.address?.toLowerCase())))
    .filter((item) => !dash.minUsd || (item.usd ?? 0) >= 0.1);
  const inflow = all.filter((item) => own.has(item.to.address?.toLowerCase()) && !own.has(item.from.address?.toLowerCase()));
  const outflow = all.filter((item) => own.has(item.from.address?.toLowerCase()) && !own.has(item.to.address?.toLowerCase()));
  const list = dash.q3 === "in" ? inflow : dash.q3 === "out" ? outflow : all;
  const rows = sortBy(list, dash.tsort, (item, key) => item[key]).slice(0, 200).map((item) => {
    const tr = document.createElement("tr");
    const when = dashNode("td", "left");
    when.append(chainDot(item.chain), " ", dashNode("span", "dash-time", timeAgo(item.time)));
    when.title = new Date(item.time).toLocaleString(locale());
    const from = dashNode("td", "left");
    from.append(walletLink(item.from));
    const to = dashNode("td", "left");
    to.append(walletLink(item.to));
    const incoming = own.has(item.to.address?.toLowerCase());
    tr.append(when, from, to, dashNode("td", incoming ? "up" : "down", amountShort(item.amount)), dashNode("td", "left", item.token.symbol), dashNode("td", "", usdShort(item.usd)));
    return tr;
  });
  const strip = tabStrip([["all", `${words.transactions} ${all.length}`], ["in", `${words.inflow} ${inflow.length}`], ["out", `${words.outflow} ${outflow.length}`]], dash.q3,
    (key) => { dash.q3 = key; renderDashboard(); });
  const chip = dashNode("button", `dash-chip${dash.minUsd ? " on" : ""}`, `${dash.minUsd ? "× " : ""}${words.minUsd}`);
  chip.type = "button";
  chip.addEventListener("click", () => { dash.minUsd = !dash.minUsd; renderDashboard(); });
  const body = dashNode("div", "dash-body");
  const grid = table([[words.time, true, "time"], [words.from, true], [words.to, true], [words.amount, false, "amount"], [words.token, true], [words.usd, false, "usd"]], rows);
  sortable(grid.querySelector("thead"), dash.tsort, renderDashboard);
  markSort(grid.querySelector("thead"), dash.tsort);
  body.append(rows.length ? grid : emptyNote(dashLoading ? words.loading : undefined));
  if ([...dashCursors.values()].some((cursor) => cursor)) {
    const more = dashNode("button", "pill dash-more", dashLoading ? words.loading : words.more);
    more.type = "button";
    more.disabled = dashLoading;
    more.addEventListener("click", () => void loadDashTransfers());
    body.append(more);
  }
  box.replaceChildren(chip, strip, body);
}
// The next page of every account's transfers on every network it uses, three requests at a time.
async function loadDashTransfers() {
  if (dashLoading) return;
  const jobs = [];
  for (const item of ownAccounts()) {
    const data = holdingsOf(item.address);
    if (!data) continue;
    const utxo = data.kind === "utxo";
    const chains = utxo ? ["btc"] : [...new Set([...(data.networks ?? []).filter((entry) => entry.ok && entry.active).map((entry) => entry.chain),
      ...data.assets.map((asset) => asset.chain)])].filter((chain) => chain !== "btc");
    for (const chain of chains) {
      const key = `${item.address}|${chain}`;
      if (dashCursors.get(key) === null) continue;
      jobs.push({ address: item.address, chain, key, utxo });
    }
  }
  if (!jobs.length) return;
  dashLoading = true;
  renderDashboard();
  const work = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const cursor = dashCursors.get(job.key);
      const query = new URLSearchParams({ dir: "all", ...(job.utxo ? {} : { chain: job.chain }), ...(cursor ? { cursor } : {}) });
      const answer = await fetch(`/market/chain/address/${encodeURIComponent(job.address)}/transfers?${query}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
      dashCursors.set(job.key, answer?.next ?? null);
      for (const transfer of answer?.items ?? []) dashLedger.set(transfer.id, transfer);
    }
  };
  await Promise.all([work(), work(), work()]);
  dashLoading = false;
  renderDashboard();
}

// --- 4. Accounts: every own wallet with its largest holding and value; + adds one.
function renderAccounts(box) {
  const words = dw();
  const accounts = ownAccounts();
  const head = dashNode("div", "dash-tabs dash-accounts-tabs");
  const allTab = dashNode("button", dash.account ? "" : "on", words.accounts);
  allTab.type = "button";
  allTab.addEventListener("click", () => { dash.account = null; renderDashboard(); });
  // "Add +" stands right after "All accounts", where it is seen.
  const plus = dashNode("button", "dash-plus", `${words.addShort} +`);
  plus.type = "button";
  plus.title = words.add;
  plus.addEventListener("click", () => { addBox().hidden = !addBox().hidden; if (!addBox().hidden) addBox().querySelector("input")?.focus(); });
  head.append(allTab, plus, ...accounts.map((item) => {
    const tab = dashNode("span", `dash-account-tab${dash.account === item.address ? " on" : ""}`);
    const open = dashNode("button", "", item.label || shortAddress(item.address));
    open.type = "button";
    open.title = item.address;
    open.addEventListener("click", () => { dash.account = item.address; renderDashboard(); });
    const drop = dashNode("button", "dash-x", "×");
    drop.type = "button";
    drop.title = words.remove;
    drop.addEventListener("click", async () => {
      const { status, data } = await send(`/market/me/addresses/${encodeURIComponent(item.address)}`, "DELETE");
      if (status !== 200) return;
      saved = data.addresses;
      walletPortfolios = data.portfolios ?? walletPortfolios;
      if (dash.account === item.address) dash.account = null;
      renderDashboard();
      if (typeof renderView === "function") renderView();
    });
    tab.append(open, drop);
    return tab;
  }));
  const body = dashNode("div", "dash-body");
  if (!dash.account) {
    const rows = accounts.map((item) => {
      const data = holdingsOf(item.address);
      const held = byToken(data?.assets ?? []);
      const tr = document.createElement("tr");
      tr.className = "coin";
      tr.addEventListener("click", (event) => { if (!event.target.closest("a")) { dash.account = item.address; renderDashboard(); } });
      const who = dashNode("td", "left");
      who.append(walletLink({ address: item.address, name: item.label || null }));
      const top = held[0];
      tr.append(who, dashNode("td", "", data ? (top ? `${amountShort(top.amount)} ${top.token.symbol} ${held.length > 1 ? words.others(held.length - 1) : ""}` : "0")
        : holdings.get(item.address) === "failed" ? "—" : words.loading), dashNode("td", "", data ? usdShort(held.reduce((sum, row) => sum + row.usd, 0)) : ""));
      return tr;
    });
    body.append(rows.length ? table([[words.account, true], [words.holdings], [words.value]], rows) : emptyNote(words.hint));
  } else {
    const rows = byToken((holdingsOf(dash.account)?.assets ?? []).filter((asset) => inNetwork(asset.chain))).map((row) => {
      const tr = document.createElement("tr");
      const name = dashNode("td", "left");
      name.append(tokenCell(row.token));
      tr.append(name, dashNode("td", "", `${amountShort(row.amount)} ${row.token.symbol}`), dashNode("td", "", usdShort(row.usd)));
      return tr;
    });
    body.append(rows.length ? table([[words.asset, true], [words.holdings], [words.value]], rows) : emptyNote());
  }
  box.replaceChildren(head, addBox(), body);
}
// The add-an-account box is built once, so what is typed survives the redraws.
let dashAdd = null;
function addBox() {
  if (dashAdd) return dashAdd;
  const words = dw();
  dashAdd = dashNode("div", "dash-add");
  dashAdd.hidden = true;
  const error = dashNode("p", "form-error");
  const connect = dashNode("button", "act", words.metamask);
  connect.type = "button";
  connect.addEventListener("click", async () => {
    error.textContent = "";
    if (!window.ethereum?.request) { error.textContent = words.noMetamask; return; }
    try {
      const found = await window.ethereum.request({ method: "eth_requestAccounts" });
      for (const address of (Array.isArray(found) ? found : []).filter((value) => ADDRESS.test(value))) await addAccount(address, "MetaMask");
      dashAdd.hidden = true;
    } catch { error.textContent = words.noMetamask; }
  });
  const form = dashNode("form", "dash-add-form");
  const address = Object.assign(dashNode("input"), { placeholder: words.address, autocomplete: "off", spellcheck: false });
  const label = Object.assign(dashNode("input"), { placeholder: words.label, maxLength: 40, autocomplete: "off" });
  const save = dashNode("button", "act ghost", words.save);
  save.type = "submit";
  form.append(address, label, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const value = address.value.trim();
    if (!ADDRESS.test(value)) { error.textContent = words.badAddress; return; }
    const problem = await addAccount(value, label.value.trim());
    if (problem) { error.textContent = problem; return; }
    address.value = label.value = "";
    dashAdd.hidden = true;
  });
  dashAdd.append(connect, dashNode("small", "muted", words.manual), form, error, dashNode("small", "muted", words.private));
  return dashAdd;
}
async function addAccount(address, label) {
  // The first wallet makes the first portfolio.
  if (!currentPortfolio()) {
    const made = await send("/market/me/wallet-portfolios", "POST", { name: dw().firstPortfolio });
    if (made.status !== 200) return made.data?.error ?? dw().badAddress;
    walletPortfolios = made.data.portfolios;
    dash.portfolio = made.data.id;
  }
  const { status, data } = await send(`/market/me/addresses/${encodeURIComponent(address)}`, "PUT", { mine: true, label, portfolioId: currentPortfolio().id });
  if (status !== 200) return data?.error ?? dw().badAddress;
  saved = data.addresses;
  walletPortfolios = data.portfolios ?? walletPortfolios;
  renderDashboard();
  if (typeof renderView === "function") renderView();
  return null;
}

// The portfolios bar over the quadrants: each named portfolio, a new one, and rename / delete for the chosen one.
async function changePortfolios(path, method, body) {
  const { status, data } = await send(path, method, body);
  if (status !== 200) { alert(data?.error ?? "error"); return null; }
  saved = data.addresses;
  walletPortfolios = data.portfolios;
  dashLedger.clear();
  dashCursors.clear();
  dash.account = null;
  renderDashboard();
  if (typeof renderView === "function") renderView();
  return data;
}
function renderPortfolios(bar) {
  const words = dw();
  const chosen = currentPortfolio();
  const chip = (label, on, click, className = "") => { const button = dashNode("button", `${className}${on ? " on" : ""}`, label); button.type = "button"; button.addEventListener("click", click); return button; };
  bar.replaceChildren(...walletPortfolios.map((item) => chip(item.name, item.id === chosen?.id, () => {
    dash.portfolio = item.id; dash.account = null; dashLedger.clear(); dashCursors.clear(); renderDashboard();
  })), chip(words.newPortfolio, false, async () => {
    const name = prompt(words.askPortfolio)?.trim();
    if (!name) return;
    const data = await changePortfolios("/market/me/wallet-portfolios", "POST", { name });
    if (data) { dash.portfolio = data.id; renderDashboard(); }
  }, "dash-new"), ...(chosen ? [chip("✎", false, async () => {
    const name = prompt(words.askPortfolio, chosen.name)?.trim();
    if (name) await changePortfolios(`/market/me/wallet-portfolios/${chosen.id}`, "PATCH", { name });
  }, "dash-icon"), chip("🗑", false, async () => {
    if (!confirm(words.confirmRemove(chosen.name))) return;
    dash.portfolio = null;
    await changePortfolios(`/market/me/wallet-portfolios/${chosen.id}`, "DELETE");
  }, "dash-icon")] : []));
  bar.querySelectorAll(".dash-icon")[0]?.setAttribute("title", words.rename);
  bar.querySelectorAll(".dash-icon")[1]?.setAttribute("title", words.removePortfolio);
}

// Draws the four quadrants; only on the owner's own profile.
let dashFrame = false;
function renderDashboard() {
  const root = $("#dash");
  if (!root) return;
  root.hidden = !page?.own || view !== "dash";
  if (root.hidden) return;
  if (saved === null) { void loadSaved(); return; }
  if (dashFrame) return;
  dashFrame = true;
  requestAnimationFrame(() => {
    dashFrame = false;
    const words = dw();
    if (!dashBuilt) {
      root.innerHTML = '<div class="dash-top"><div class="dash-total"></div><select class="dash-network" aria-label="network"></select></div>'
        + '<div class="dash-portfolios"></div><div class="dash-grid"><section class="card dash-q" data-q="1"></section><section class="card dash-q" data-q="2"></section>'
        + '<section class="card dash-q" data-q="4"></section><section class="card dash-q" data-q="3"></section></div>';
      root.querySelector(".dash-network").addEventListener("change", (event) => { dash.network = event.target.value; renderDashboard(); });
      // The network choice stands with the profile's buttons, top right.
      $("#own-actions")?.prepend(root.querySelector(".dash-network"));
      dashBuilt = true;
    }
    const assets = chosenAssets();
    const total = assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0);
    const day = byToken(assets).reduce((sum, row) => sum + (changeOver(row.usd, marketCoin(row.token)?.change24h) ?? 0), 0);
    // The total stands next to the owner's name, as on the analytics sites.
    const head = $("#profile-total") ?? root.querySelector(".dash-total");
    head.replaceChildren(dashNode("b", "", price(total)), " ", signedUsd(day));
    const select = document.querySelector(".dash-network");
    const chains = [...new Set(ownAccounts().flatMap((item) => (holdingsOf(item.address)?.assets ?? []).map((asset) => asset.chain)))];
    select.replaceChildren(...[["all", words.allNetworks], ...chains.map((chain) => [chain, CHAINS[chain]?.name ?? chain])].map(([value, text]) => {
      const option = Object.assign(document.createElement("option"), { value, textContent: text });
      option.selected = value === dash.network;
      return option;
    }));
    renderPortfolios(root.querySelector(".dash-portfolios"));
    renderPortfolio(root.querySelector('[data-q="1"]'));
    renderHistory(root.querySelector('[data-q="2"]'));
    renderAccounts(root.querySelector('[data-q="4"]'));
    renderTransactions(root.querySelector('[data-q="3"]'));
    // Transfers start once every account's balances are in.
    if (!dashLoading && ownAccounts().length && ownAccounts().every((item) => holdings.has(item.address) && holdings.get(item.address) !== "loading")
      && ownAccounts().some((item) => [...dashCursors.keys()].every((key) => !key.startsWith(`${item.address}|`)))) void loadDashTransfers();
  });
}
