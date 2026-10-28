// Live trades on a coin's page, as on the DEX trade screens: the latest swaps in the coin's
// busiest decentralised-exchange pool (/market/trades, market-trades.mjs, from GeckoTerminal),
// refreshed every 15 seconds. Time, price, total and amount sort; type, size (flea to whale) and
// wallet filter; a bar weighs the buys against the sells. Uses `coin` from coin.js.

// The pool's network and the coin's contract there. Network coins trade as their wrapped tokens.
const TRADE_NATIVE = {
  bitcoin: ["eth", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"],
  ethereum: ["eth", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
  binancecoin: ["bsc", "0xbb4cdb9cbd36b01bd8cbaef56b8b3fd29a3c3a39"],
  solana: ["solana", "So11111111111111111111111111111111111111112"],
  tron: ["tron", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR"],
  "avalanche-2": ["avax", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"],
  "polygon-ecosystem-token": ["polygon_pos", "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"],
};
// CoinGecko's platform → GeckoTerminal's network, in the order a pool is looked for.
const TRADE_NETWORKS = [["ethereum", "eth"], ["solana", "solana"], ["binance-smart-chain", "bsc"], ["base", "base"],
  ["arbitrum-one", "arbitrum"], ["polygon-pos", "polygon_pos"], ["tron", "tron"], ["avalanche", "avax"],
  ["optimistic-ethereum", "optimism"], ["the-open-network", "ton"]];
// Where a transaction and a wallet open, per network; EVM wallets open their page on this site.
const TRADE_EXPLORERS = {
  eth: ["https://eth.blockscout.com/tx/", null], bsc: ["https://bscscan.com/tx/", null], base: ["https://basescan.org/tx/", null],
  arbitrum: ["https://arbiscan.io/tx/", null], polygon_pos: ["https://polygonscan.com/tx/", null], optimism: ["https://explorer.optimism.io/tx/", null],
  avax: ["https://snowtrace.io/tx/", null], solana: ["https://solscan.io/tx/", "https://solscan.io/account/"],
  tron: ["https://tronscan.org/#/transaction/", "https://tronscan.org/#/address/"], ton: ["https://tonviewer.com/transaction/", "https://tonviewer.com/"],
};
const TRADE_EVM = new Set(["eth", "bsc", "base", "arbitrum", "polygon_pos", "optimism", "avax"]);
// Sizes by dollars, as the trade screens draw them.
const SIZES = [["flea", "🐜", 0, 1], ["shrimp", "🦐", 1, 1_000], ["fish", "🐟", 1_000, 3_000], ["dolphin", "🐬", 3_000, 10_000], ["whale", "🐋", 10_000, Infinity]];
const sizeOf = (usd) => SIZES.find(([, , from, to]) => usd >= from && usd < to) ?? SIZES[0];
const tradeWords = {
  ru: { buy: "Покупка", sell: "Продажа", buys: "Покупки", sells: "Продажи", amount: (symbol) => `Кол-во ${symbol}`, none: "Сделок не найдено.",
    noPool: "Эта монета не торгуется на децентрализованных биржах, которые видит GeckoTerminal.", loading: "Загружаю сделки…",
    noMatch: "Под фильтр ничего не подходит.", clear: "Сбросить фильтры", maker: "Адрес кошелька", all: "Все",
    sizes: { flea: "Блоха (< $1)", shrimp: "Креветка ($1 – $1K)", fish: "Рыба ($1K – $3K)", dolphin: "Дельфин ($3K – $10K)", whale: "Кит (> $10K)" },
    note: (pool, dex, count) => `${count} последних сделок пула ${pool} (${dex}). Данные GeckoTerminal, обновляются каждые 15 секунд.`,
    pool: (pool, dex, network) => `${pool} · ${dex} · ${network}`, tx: "Транзакция" },
  en: { buy: "Buy", sell: "Sell", buys: "Buys", sells: "Sells", amount: (symbol) => `${symbol} amount`, none: "No trades found.",
    noPool: "This coin does not trade on the decentralised exchanges GeckoTerminal follows.", loading: "Loading trades…",
    noMatch: "Nothing matches the filter.", clear: "Clear filters", maker: "Wallet address", all: "All",
    sizes: { flea: "Flea (< $1)", shrimp: "Shrimp ($1 – $1K)", fish: "Fish ($1K – $3K)", dolphin: "Dolphin ($3K – $10K)", whale: "Whale (> $10K)" },
    note: (pool, dex, count) => `The latest ${count} trades of the ${pool} pool (${dex}). Data by GeckoTerminal, refreshed every 15 seconds.`,
    pool: (pool, dex, network) => `${pool} · ${dex} · ${network}`, tx: "Transaction" },
};
const tw = () => tradeWords[language === "en" ? "en" : "ru"];
const tradeNode = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });

let tradeTarget = null; // [network, token] once the coin is known
let tradeData = null;
let tradeLoading = false;
let tradeSeen = new Set();
const tradeSort = { key: "time", dir: -1 };
const tradeFilter = { kinds: new Set(["buy", "sell"]), sizes: new Set(SIZES.map(([key]) => key)), maker: "" };

function tradeTargetOf(item) {
  if (TRADE_NATIVE[item.id]) return TRADE_NATIVE[item.id];
  for (const [platform, network] of TRADE_NETWORKS) {
    const address = item.contracts?.[platform];
    if (address) return [network, address];
  }
  return null;
}

// Called by coin.js whenever the coin is drawn. Network coins start at once; tokens once the full
// coin data with their contracts is in.
let tradeFails = 0; // trade requests in a row that got no answer
function startTrades() {
  // A stand-in coin may already carry its contracts (from the explorer's coin list): its trades need no more.
  if (tradeTarget || !coin || (coin.partial && !TRADE_NATIVE[coin.id] && !Object.keys(coin.contracts ?? {}).length)) return;
  tradeTarget = tradeTargetOf(coin);
  $("#trades").hidden = !tradeTarget;
  if (!tradeTarget) return;
  renderTrades();
  void loadTrades();
  setInterval(() => { if (!document.hidden) void loadTrades(); }, 15_000);
}

async function loadTrades() {
  if (tradeLoading) return;
  tradeLoading = true;
  const [network, token] = tradeTarget;
  const answer = await fetch(`/market/trades?network=${encodeURIComponent(network)}&token=${encodeURIComponent(token)}`)
    .then((response) => (response.ok ? response.json() : null)).catch(() => null);
  tradeLoading = false;
  if (!answer) { tradeFails += 1; if (!tradeData) { renderTrades(); setTimeout(loadTrades, tradeFails < 6 ? 5_000 : 20_000); } return; }
  tradeFails = 0;
  const fresh = tradeData ? new Set(answer.trades.filter((trade) => !tradeSeen.has(trade.tx)).map((trade) => trade.tx)) : new Set();
  tradeSeen = new Set(answer.trades.map((trade) => trade.tx));
  tradeData = { ...answer, fresh };
  renderTrades();
}

function renderTrades() {
  if (!tradeTarget) return;
  const words = tw();
  const symbol = coin?.symbol ?? "";
  $("#trades-symbol").textContent = words.amount(symbol);
  for (const head of document.querySelectorAll(".trades-table [data-trsort]")) head.dataset.dir = head.dataset.trsort === tradeSort.key ? (tradeSort.dir > 0 ? "asc" : "desc") : "";
  for (const head of document.querySelectorAll(".trades-table [data-trfilter]")) {
    const key = head.dataset.trfilter;
    head.classList.toggle("on", key === "kind" ? tradeFilter.kinds.size < 2 : key === "size" ? tradeFilter.sizes.size < SIZES.length : Boolean(tradeFilter.maker));
  }
  const message = (text, button) => {
    const row = tradeNode("tr");
    const cell = tradeNode("td", "muted ex-empty", text);
    cell.colSpan = 7;
    if (button) cell.append(" ", button);
    row.append(cell);
    return row;
  };
  if (!tradeData) { $("#trades-rows").replaceChildren(message(tradeFails >= 3 ? (language === "en" ? "The trades source is busy; asking again…" : "Источник сделок сейчас занят, пробую ещё раз…") : words.loading)); return; }
  const { pool, trades, buys, sells, fresh } = tradeData;
  if (!pool) {
    $("#trades-pool").textContent = "";
    $("#trades-bar").hidden = true;
    $("#trades-note").textContent = "";
    $("#trades-rows").replaceChildren(message(words.noPool));
    return;
  }
  const [network] = tradeTarget;
  $("#trades-pool").textContent = words.pool(pool.name, pool.dex.replace(/[_-]/g, " "), network.replace(/_pos$/, "").toUpperCase());
  $("#trades-note").textContent = words.note(pool.name, pool.dex.replace(/[_-]/g, " "), trades.length) +
    // A network coin trades here as its wrapped token: said plainly, its price in the pool can differ a little.
    (TRADE_NATIVE[coin.id] ? (language === "en" ? ` The coin trades here as its wrapped token (${pool.name.split(" / ")[0]}); the pool's price can differ slightly from the exchanges'.`
      : ` Монета торгуется здесь как обёрнутый токен (${pool.name.split(" / ")[0]}); цена в пуле может немного отличаться от биржевой.`) : "");
  // The bar: the dollars bought against the dollars sold among the loaded trades.
  const total = buys + sells || 1;
  $("#trades-bar").hidden = false;
  $("#trades-buys").style.flexBasis = `${buys / total * 100}%`;
  $("#trades-buys").textContent = `${words.buys} ${usdShort(buys)}`;
  $("#trades-sells").style.flexBasis = `${sells / total * 100}%`;
  $("#trades-sells").textContent = `${words.sells} ${usdShort(sells)}`;
  const needle = tradeFilter.maker.toLowerCase();
  const shown = trades.filter((trade) => tradeFilter.kinds.has(trade.kind) && tradeFilter.sizes.has(sizeOf(trade.usd)[0])
    && (!needle || trade.maker?.toLowerCase().includes(needle)))
    .sort((left, right) => ((left[tradeSort.key] ?? 0) - (right[tradeSort.key] ?? 0)) * tradeSort.dir);
  const [txBase, walletBase] = TRADE_EXPLORERS[network] ?? [null, null];
  const filtered = tradeFilter.kinds.size < 2 || tradeFilter.sizes.size < SIZES.length || needle;
  const clear = () => {
    const button = tradeNode("button", "pill", words.clear);
    button.type = "button";
    button.addEventListener("click", () => { tradeFilter.kinds = new Set(["buy", "sell"]); tradeFilter.sizes = new Set(SIZES.map(([key]) => key)); tradeFilter.maker = ""; renderTrades(); });
    return button;
  };
  $("#trades-rows").replaceChildren(...(shown.length ? shown.slice(0, 300).map((trade) => {
    const row = tradeNode("tr", `${trade.kind}${fresh?.has(trade.tx) ? " fresh" : ""}`);
    const when = tradeNode("td", "left", timeAgo(trade.time));
    when.title = new Date(trade.time).toLocaleString(locale());
    const [size, icon] = sizeOf(trade.usd);
    const totalCell = tradeNode("td", "trade-total");
    totalCell.append(usdShort(trade.usd), " ", Object.assign(tradeNode("span", "trade-size", icon), { title: words.sizes[size] }));
    const maker = tradeNode("td", "left");
    if (trade.maker && TRADE_EVM.has(network)) maker.append(walletLink({ address: trade.maker }));
    else if (trade.maker) maker.append(Object.assign(tradeNode("a", "wallet", shortAddress(trade.maker)), { href: `${walletBase}${trade.maker}`, target: "_blank", rel: "noopener" }));
    const link = tradeNode("td");
    if (trade.tx && txBase) link.append(Object.assign(tradeNode("a", "trade-tx", "↗"), { href: `${txBase}${trade.tx}`, target: "_blank", rel: "noopener", title: words.tx }));
    row.append(when, tradeNode("td", `left trade-kind ${trade.kind === "buy" ? "up" : "down"}`, trade.kind === "buy" ? words.buy : words.sell),
      tradeNode("td", trade.kind === "buy" ? "up" : "down", price(trade.price)), totalCell,
      tradeNode("td", "", amountShort(trade.amount)), maker, link);
    return row;
  }) : [message(filtered ? words.noMatch : words.none, filtered ? clear() : null)]));
}

// A header's filter: buys and sells, sizes from flea to whale, or a wallet.
function openTradeFilter(head) {
  document.querySelector(".ex-pop")?.remove();
  const words = tw();
  const key = head.dataset.trfilter;
  const pop = tradeNode("div", "ex-pop wide");
  const check = (label, on, toggle) => {
    const row = tradeNode("label", "ex-check");
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: on });
    box.addEventListener("change", () => { toggle(box.checked); renderTrades(); });
    row.append(box, label);
    return row;
  };
  if (key === "kind") {
    pop.append(...[["buy", words.buys], ["sell", words.sells]].map(([kind, label]) => check(label, tradeFilter.kinds.has(kind),
      (on) => { if (on) tradeFilter.kinds.add(kind); else tradeFilter.kinds.delete(kind); })));
  } else if (key === "size") {
    pop.append(...SIZES.map(([size, icon]) => check(`${icon} ${words.sizes[size]}`, tradeFilter.sizes.has(size),
      (on) => { if (on) tradeFilter.sizes.add(size); else tradeFilter.sizes.delete(size); })));
  } else {
    const field = Object.assign(tradeNode("input", "ex-token"), { type: "search", value: tradeFilter.maker, placeholder: words.maker });
    field.addEventListener("input", () => { tradeFilter.maker = field.value.trim(); renderTrades(); });
    field.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === "Escape") pop.remove(); });
    pop.append(field);
    setTimeout(() => field.focus());
  }
  head.append(pop);
  // On a phone the list must not run past the screen's right edge.
  const over = pop.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
  if (over > 0) pop.style.left = `${-over}px`;
}

for (const head of document.querySelectorAll(".trades-table [data-trsort]")) {
  head.addEventListener("click", (event) => {
    if (head.dataset.trfilter && event.target.closest(".th-icon")) return; // the funnel opens the filter instead
    if (event.target.closest(".ex-pop")) return;
    const key = head.dataset.trsort;
    if (tradeSort.key === key) tradeSort.dir = -tradeSort.dir; else { tradeSort.key = key; tradeSort.dir = -1; }
    renderTrades();
  });
}
for (const head of document.querySelectorAll(".trades-table [data-trfilter]")) {
  const opener = head.dataset.trsort ? head.querySelector(".th-icon") : head;
  opener.addEventListener("click", (event) => { if (!event.target.closest(".ex-pop")) { event.stopPropagation(); openTradeFilter(head); } });
}
document.addEventListener("click", (event) => { if (!event.target.closest(".ex-pop, [data-trfilter]")) document.querySelector(".trades .ex-pop")?.remove(); });
