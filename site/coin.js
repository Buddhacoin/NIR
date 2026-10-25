// A coin's own page, /coin/<id>: price and changes, market figures and supply,
// links and wallets, a converter, a price chart (ours from /market/chart, or
// TradingView candles for coins with a Binance pair), the description and the
// markets where the coin trades. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  nirOpen: "NIR network is open", nirMiners: "Miners online", nirPioneers: "Pioneers", nirMined: "Mined",
  nirPool: "🏆 210,000 NIR for pioneers", nirCta: "Mine NIR with one button →",
  navCoins: "Cryptocurrencies", navMine: "NIR mining", search: "Search coins",
  col1h: "1h", col24h: "24h", col7d: "7d", range24: "24h low and high", marketCap: "Market cap",
  volume24: "Volume 24h", volumeCap: "Volume / market cap", fdv: "Fully diluted value", circulating: "Circulating supply",
  supply: "Total / max supply", ath: "All-time high", atl: "All-time low", converter: "Converter",
  tabOverview: "Overview", tabAbout: "About", tabMarkets: "Markets", tabCommunity: "Discussion", community: "Discussion",
  sortLatest: "Latest", sortTop: "Top", barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist",
  d1: "1D", d7: "7D", d30: "1M", d90: "3M", d365: "1Y",
  more: "Show all ▾", descriptionBy: "Description: CoinGecko", whereTraded: "Where it trades", exchange: "Exchange",
  pair: "Pair", colPrice: "Price", colVolume: "Volume 24h", trust: "Trust",
  pricesBy: "Prices:", chartsBy: "Charts:", notAdvice: "Not financial advice",
  aboutNir: "About the NIR blockchain →", privacy: "Privacy", terms: "Terms", dataBy: "Data:", navCharts: "Market overview", navNir: "NIR",
};
const words = {
  ru: { loading: "Загружаю данные монеты…", missing: "Такой монеты нет. Вернитесь к списку и выберите монету там.",
    unavailable: "Данные монеты временно недоступны. Попробуйте обновить страницу через минуту.",
    chartLoading: "Загружаю график…", chartUnavailable: "График временно недоступен.",
    chart: (name) => `График ${name}`, about: (name) => `Что такое ${name}`, english: "Описание есть только на английском.",
    noDescription: "Описания пока нет.", noMarkets: "Нет данных о биржах.", line: "Линия", candles: "Свечи",
    period: { 1: "За сутки", 7: "За неделю", 30: "За месяц", 90: "За 3 месяца", 365: "За год" },
    sections: { site: "Сайт и документы", explorers: "Обозреватели блоков", wallets: "Кошельки", community: "Сообщество" },
    title: (coin) => `${coin.name} (${coin.symbol}) — цена, график и капитализация | NIR Markets` },
  en: { loading: "Loading the coin…", missing: "There is no such coin. Go back to the list and pick one there.",
    unavailable: "Coin data is unavailable right now. Try reloading in a minute.",
    chartLoading: "Loading the chart…", chartUnavailable: "The chart is unavailable right now.",
    chart: (name) => `${name} chart`, about: (name) => `What is ${name}`, english: "",
    noDescription: "No description yet.", noMarkets: "No market data.", line: "Line", candles: "Candles",
    period: { 1: "In 24 hours", 7: "In a week", 30: "In a month", 90: "In 3 months", 365: "In a year" },
    sections: { site: "Website and documents", explorers: "Block explorers", wallets: "Wallets", community: "Community" },
    title: (coin) => `${coin.name} (${coin.symbol}) price, chart and market cap | NIR Markets` },
};

// Well-known wallets of the largest networks; a token gets its network's wallets.
const LEDGER = ["Ledger", "https://www.ledger.com"];
const TREZOR = ["Trezor", "https://trezor.io"];
const WALLETS = {
  bitcoin: [["Electrum", "https://electrum.org"], ["Sparrow", "https://sparrowwallet.com"], LEDGER, TREZOR],
  ethereum: [["MetaMask", "https://metamask.io"], ["Rabby", "https://rabby.io"], LEDGER, TREZOR],
  binancecoin: [["Trust Wallet", "https://trustwallet.com"], ["MetaMask", "https://metamask.io"], LEDGER],
  solana: [["Phantom", "https://phantom.com"], ["Solflare", "https://solflare.com"], LEDGER],
  ripple: [["Xaman", "https://xaman.app"], LEDGER],
  cardano: [["Eternl", "https://eternl.io"], ["Yoroi", "https://yoroi-wallet.com"], LEDGER],
  tron: [["TronLink", "https://www.tronlink.org"], LEDGER],
  "the-open-network": [["Tonkeeper", "https://tonkeeper.com"], ["MyTonWallet", "https://mytonwallet.io"]],
  dogecoin: [["Exodus", "https://www.exodus.com"], LEDGER, TREZOR],
  litecoin: [["Electrum-LTC", "https://electrum-ltc.org"], LEDGER, TREZOR],
};
const NETWORKS = { ethereum: "ethereum", "binance-smart-chain": "binancecoin", solana: "solana", tron: "tron",
  "the-open-network": "the-open-network" };

const COIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/; // as in blockchain/market-service.mjs
const id = decodeURIComponent(location.pathname.split("/")[2] ?? "").toLowerCase();
let coin = null;
let chart = null;
let chartFailed = false;
let days = "30";
let candles = false;
let showAll = false;
let failure = "";

const t = () => words[language];
const tradingViewSymbol = () => (!coin || STABLE.has(coin.symbol) ? null
  : coin.tickers.some((ticker) => ticker.exchange === "binance" && ticker.base === coin.symbol && ticker.target === "USDT")
    ? `BINANCE:${coin.symbol}USDT` : null);
const host = (url) => new URL(url).hostname.replace(/^www\./, "");
const amount = (value) => (value === null || value === undefined ? "—" : big(value, ""));
const date = (value) => (value ? new Date(value).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" }) : "");
function setChange(node, value) {
  node.className = changeClass(value);
  node.textContent = percentText(value);
}
function external(label, url) {
  const link = document.createElement("a");
  link.href = url;
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noopener noreferrer nofollow";
  return link;
}

// --- Price, changes, figures and supply.
function renderHead() {
  document.title = t().title(coin);
  $("#crumb").textContent = coin.name;
  $("#logo").replaceChildren(logo(coin));
  $("#name").textContent = coin.name;
  $("#symbol").textContent = coin.symbol;
  $("#rank").textContent = coin.rank ? `#${coin.rank}` : "";
  $("#rank").hidden = !coin.rank;
  $("#watch").textContent = watch.has(coin.id) ? "★" : "☆";
  $("#watch").classList.toggle("on", watch.has(coin.id));
  $("#price").textContent = price(coin.price);
  setChange($("#c1h"), coin.change1h);
  setChange($("#c24h"), coin.change24h);
  setChange($("#c7d"), coin.change7d);
  $("#low").textContent = price(coin.low24h);
  $("#high").textContent = price(coin.high24h);
  const span = (coin.high24h ?? 0) - (coin.low24h ?? 0);
  $("#range-bar").style.width = span > 0 && coin.price !== null
    ? `${Math.min(100, Math.max(0, (coin.price - coin.low24h) / span * 100)).toFixed(1)}%` : "0";
  $("#s-cap").textContent = big(coin.marketCap);
  $("#s-volume").textContent = big(coin.volume);
  $("#s-ratio").textContent = coin.marketCap && coin.volume !== null
    ? `${(coin.volume / coin.marketCap * 100).toLocaleString(locale(), { maximumFractionDigits: 2 })}%` : "—";
  $("#s-fdv").textContent = big(coin.fullyDiluted);
  $("#s-circ").textContent = coin.circulating === null ? "—" : `${amount(coin.circulating)} ${coin.symbol}`;
  $("#s-supply").textContent = `${amount(coin.totalSupply)} / ${coin.maxSupply === null ? "∞" : amount(coin.maxSupply)}`;
  for (const [key, value, change, when] of [["ath", coin.ath, coin.athChange, coin.athDate], ["atl", coin.atl, coin.atlChange, coin.atlDate]]) {
    const cell = $(`#s-${key}`);
    const shift = document.createElement("em");
    setChange(shift, change);
    cell.replaceChildren(`${price(value)} `, shift);
    cell.title = date(when);
  }
  $("#conv-symbol").textContent = coin.symbol;
  convert("coin");
  $("#chart-title").textContent = t().chart(coin.name);
  $("#about-title").textContent = t().about(coin.name);
}

// --- Links: website, documents, source, explorers, wallets, community.
function renderLinks() {
  const sections = [];
  const { links } = coin;
  sections.push(["site", [...links.websites.map((url) => [`🌐 ${host(url)}`, url]),
    ...(links.whitepaper ? [["📄 Whitepaper", links.whitepaper]] : []),
    ...links.source.slice(0, 1).map((url) => [`‹› ${host(url) === "github.com" ? "GitHub" : host(url)}`, url])]]);
  sections.push(["explorers", links.explorers.map((url) => [host(url), url])]);
  const network = coin.platforms.map((name) => NETWORKS[name]).find(Boolean);
  const wallets = WALLETS[coin.id === "toncoin" ? "the-open-network" : coin.id] ?? WALLETS[network] ?? [];
  sections.push(["wallets", wallets.map(([name, url]) => [`👛 ${name}`, url])]);
  sections.push(["community", [...(links.x ? [["X", links.x]] : []), ...(links.reddit ? [["Reddit", links.reddit]] : []),
    ...(links.telegram ? [["Telegram", links.telegram]] : []),
    ...[...links.forums, ...links.chats].map((url) => [host(url), url])]]);
  const nodes = [];
  for (const [key, items] of sections) {
    if (!items.length) continue;
    const title = document.createElement("h3");
    title.textContent = t().sections[key];
    const list = document.createElement("div");
    list.className = "chips";
    list.append(...items.map(([label, url]) => external(label, url)));
    nodes.push(title, list);
  }
  $("#links").replaceChildren(...nodes);
  $("#links").hidden = !nodes.length;
}

// --- Description and categories.
function renderAbout() {
  const russian = language === "ru" && coin.description.ru;
  const text = russian ? coin.description.ru : coin.description.en;
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const shown = showAll ? paragraphs : paragraphs.slice(0, 2);
  const nodes = shown.map((part) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = part;
    return paragraph;
  });
  if (!paragraphs.length) nodes.push(Object.assign(document.createElement("p"), { textContent: t().noDescription }));
  else if (language === "ru" && !russian) nodes.unshift(Object.assign(document.createElement("p"), { className: "muted", textContent: t().english }));
  $("#description").replaceChildren(...nodes);
  $("#more").hidden = shown.length === paragraphs.length;
  $("#categories").replaceChildren(...coin.categories.map((name) => Object.assign(document.createElement("span"), { textContent: name })));
}

// --- Where the coin trades.
function renderTickers() {
  const rows = coin.tickers.map((ticker, index) => {
    const row = document.createElement("tr");
    const cells = [String(index + 1), "", `${ticker.base}/${ticker.target}`, price(ticker.price), big(ticker.volume), ""]
      .map((value, column) => {
        const cell = document.createElement("td");
        if (column < 3) cell.className = "left";
        cell.textContent = value;
        return cell;
      });
    cells[1].append(ticker.url ? external(ticker.market, ticker.url) : ticker.market);
    const trust = document.createElement("span");
    trust.className = `trust ${ticker.trust ?? "none"}`;
    cells[5].append(trust);
    row.append(...cells);
    return row;
  });
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "status";
    cell.textContent = t().noMarkets;
    row.append(cell);
    rows.push(row);
  }
  $("#tickers").replaceChildren(...rows);
}

// --- The converter works both ways: coins to dollars and dollars to coins.
const parse = (value) => Number(value.replace(/[\s ]/g, "").replace(",", "."));
function convert(from) {
  if (!coin?.price) return;
  if (from === "coin") {
    const value = parse($("#conv-coin").value);
    $("#conv-usd").value = Number.isFinite(value) ? (value * coin.price).toLocaleString(locale(), { maximumFractionDigits: 2 }) : "";
  } else {
    const value = parse($("#conv-usd").value);
    $("#conv-coin").value = Number.isFinite(value) ? (value / coin.price).toLocaleString(locale(), { maximumSignificantDigits: 8 }) : "";
  }
}

// --- The price chart: a line with volume bars and a crosshair, or TradingView candles.
function renderChart() {
  const plot = $("#plot");
  const symbol = tradingViewSymbol();
  $("#candles").hidden = !symbol;
  candles = candles && Boolean(symbol);
  $("#candles").textContent = candles ? t().line : t().candles;
  for (const button of document.querySelectorAll("#ranges [data-days]")) {
    button.classList.toggle("on", !candles && button.dataset.days === days);
    button.hidden = candles;
  }
  $("#period-change").replaceChildren();
  if (candles) { plot.replaceChildren(tradingView(symbol)); return; }
  const points = chart?.prices ?? [];
  if (points.length < 2) {
    plot.replaceChildren(Object.assign(document.createElement("p"), { className: "status",
      textContent: chartFailed ? t().chartUnavailable : t().chartLoading }));
    return;
  }
  const width = 1000;
  const height = 360;
  const values = points.map(([, value]) => value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const x = (index) => index / (points.length - 1) * width;
  const y = (value) => 14 + (high - value) / ((high - low) || 1) * (height - 84);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const line = points.map(([, value], index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  const volumes = chart.volumes ?? [];
  const topVolume = Math.max(1, ...volumes.map(([, value]) => value));
  const barWidth = width / Math.max(1, volumes.length);
  svg.innerHTML = '<defs><linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">' +
    '<stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>' +
    "</linearGradient></defs>" +
    volumes.map(([, value], index) => `<rect class="vol" x="${(index * barWidth).toFixed(1)}" y="${(height - value / topVolume * 40).toFixed(1)}" ` +
      `width="${Math.max(1, barWidth - 1).toFixed(1)}" height="${(value / topVolume * 40).toFixed(1)}"/>`).join("") +
    `<path d="${line}L${width},${height - 50}L0,${height - 50}Z" fill="url(#area-fill)"/>` +
    `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  const label = (className, text) => Object.assign(document.createElement("span"), { className, textContent: text });
  const time = (value) => new Date(value).toLocaleString(locale(), days === "1"
    ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", ...(days === "365" ? { year: "2-digit" } : {}) });
  const cursor = label("cursor", "");
  const dot = label("dot", "");
  const tip = label("tip", "");
  const lowLabel = label("axis low", price(low));
  lowLabel.style.top = `calc(${(y(low) / height * 100).toFixed(1)}% + 4px)`;
  plot.replaceChildren(svg, label("axis high", price(high)), lowLabel,
    label("axis start", time(points[0][0])), label("axis end", time(points.at(-1)[0])), cursor, dot, tip);
  plot.onpointermove = (event) => {
    const box = plot.getBoundingClientRect();
    const index = Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * (points.length - 1));
    const [when, value] = points[index];
    const left = x(index) / width * box.width;
    const top = y(value) / height * box.height;
    cursor.style.left = dot.style.left = `${left}px`;
    dot.style.top = `${top}px`;
    tip.textContent = `${price(value)} · ${new Date(when).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    tip.style.left = `${Math.min(box.width - tip.offsetWidth - 6, Math.max(6, left - tip.offsetWidth / 2))}px`;
    plot.classList.add("hover");
  };
  plot.onpointerleave = () => plot.classList.remove("hover");
  const change = (values.at(-1) - values[0]) / values[0] * 100;
  const shift = document.createElement("b");
  setChange(shift, change);
  $("#period-change").replaceChildren(`${t().period[days]}: `, shift);
}

function render() {
  if (!coin) {
    $("#status").textContent = failure || t().loading;
    return;
  }
  $("#status").textContent = "";
  $("#page").hidden = false;
  renderHead();
  renderLinks();
  renderAbout();
  renderTickers();
  renderChart();
  if (typeof renderCommunity === "function") renderCommunity(); // community.js
}

async function loadCoin() {
  try {
    const response = await fetch(`/market/coin/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 404) { failure = t().missing; return; }
    if (!response.ok) throw new Error("coin data unavailable");
    coin = await response.json();
  } catch {
    if (!coin) failure = t().unavailable;
  } finally {
    render();
  }
}

async function loadChart() {
  const wanted = days;
  try {
    const response = await fetch(`/market/chart/${encodeURIComponent(id)}?days=${wanted}`, { cache: "no-store" });
    if (!response.ok) throw new Error("chart unavailable");
    const value = await response.json();
    if (wanted === days) { chart = value; chartFailed = false; }
  } catch {
    if (wanted === days) chartFailed = !chart;
  }
  if (coin && wanted === days) renderChart();
}

for (const button of document.querySelectorAll("#ranges [data-days]")) {
  button.addEventListener("click", () => {
    days = button.dataset.days;
    chart = null;
    renderChart();
    void loadChart();
  });
}
$("#candles").addEventListener("click", () => { candles = !candles; renderChart(); });
$("#watch").addEventListener("click", () => { toggleWatch(coin.id); renderHead(); });
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
$("#more").addEventListener("click", () => { showAll = true; renderAbout(); });
$("#conv-coin").addEventListener("input", () => convert("coin"));
$("#conv-usd").addEventListener("input", () => convert("usd"));
for (const link of document.querySelectorAll(".coin-main .tabs a")) {
  link.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".coin-main .tabs a")) other.classList.toggle("on", other === link);
  });
}

setupSearch({});
setupPage({ en, render, onTheme: () => { if (candles) renderChart(); } }); // the candles follow the theme
if (COIN_ID_PATTERN.test(id)) {
  void loadCoin();
  void loadChart();
  setInterval(loadCoin, 120_000);
  setInterval(loadChart, 300_000);
} else {
  failure = t().missing;
  render();
}
