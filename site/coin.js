// A coin's own page, /coin/<id>: price and changes, market figures and supply,
// links and wallets, a converter, a price chart (ours from /market/chart, or
// TradingView candles for coins with a Binance pair), the description and the
// markets where the coin trades. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  nirOpen: "NIR network is open", nirMiners: "Miners online", nirPioneers: "Pioneers", nirMined: "Mined",
  nirPool: "🏆 210,000 NIR for pioneers", nirCta: "Mine NIR with one button →",
  navCoins: "Cryptocurrencies", navMine: "NIR mining", search: "Search coins or addresses",
  col1h: "1h", col24h: "24h", col7d: "7d", range24: "24h low and high", marketCap: "Market cap",
  volume24: "Volume 24h", volumeCap: "Volume / market cap", fdv: "Fully diluted value", circulating: "Circulating supply",
  supply: "Total / max supply", ath: "All-time high", atl: "All-time low", converter: "Converter",
  tabOverview: "Overview", tabAbout: "About", tabMarkets: "Markets", tabCommunity: "Discussion", community: "Discussion",
  tradesTitle: "Live trades", trTime: "Time", trType: "Type", trPrice: "Price (USD)", trTotal: "Total", trAmount: "Amount", trMaker: "Wallet",
  sortLatest: "Latest", sortTop: "Top", barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist",
  d1: "24h", d7: "7D", d30: "1M", d90: "3M", d365: "1Y", mPrice: "Price", mCap: "Market cap",
  more: "Show all ▾", descriptionBy: "Description: CoinGecko", whereTraded: "Where it trades", exchange: "Exchange",
  pair: "Pair", colPrice: "Price", colVolume: "Volume 24h", trust: "Trust",
  pricesBy: "Prices:", chartsBy: "Charts:", notAdvice: "Not financial advice",
  aboutNir: "About the NIR blockchain →", privacy: "Privacy", terms: "Terms", dataBy: "Data:", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR",
};
const words = {
  ru: { loading: "Загружаю данные монеты…", missing: "Такой монеты нет. Вернитесь к списку и выберите монету там.",
    unavailable: "Данные монеты временно недоступны. Попробуйте обновить страницу через минуту.",
    chartLoading: "Загружаю график…", standIn: "пока показана неделя, выбранный период загружается", young: "С начала торгов", chartUnavailable: "График временно недоступен.",
    chart: (name) => `График ${name}`, about: (name) => `Что такое ${name}`, english: "Описание есть только на английском.",
    noDescription: "Описания пока нет.", noMarkets: "Нет данных о биржах.", fetching: "Загружаю…", line: "Линия", candles: "Свечи",
    period: { 1: "За сутки", 7: "За неделю", 30: "За месяц", 90: "За 3 месяца", 365: "За год" },
    sections: { site: "Сайт и документы", explorers: "Обозреватели блоков", wallets: "Кошельки", community: "Сообщество" },
    title: (coin) => `${coin.name} (${coin.symbol}) — цена, график и капитализация | NIR Markets` },
  en: { loading: "Loading the coin…", missing: "There is no such coin. Go back to the list and pick one there.",
    unavailable: "Coin data is unavailable right now. Try reloading in a minute.",
    chartLoading: "Loading the chart…", standIn: "the week is shown while the chosen period loads", young: "Since trading began", chartUnavailable: "The chart is unavailable right now.",
    chart: (name) => `${name} chart`, about: (name) => `What is ${name}`, english: "",
    noDescription: "No description yet.", noMarkets: "No market data.", fetching: "Loading…", line: "Line", candles: "Candles",
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
// Every coin TradingView knows opens on its full chart (Bitcoin on the CRYPTO:BTCUSD index, the rest on
// their Binance pair); the others, and anyone who picks the line, get the page's own chart.
let wantCandles = true;
let candles = false;
let metric = "prices"; // or "caps": the line shows price or market cap
let showAll = false;
let failure = "";

const t = () => words[language];
// The TradingView chart for every coin: the exchange pair it trades on (Binance first, then the other
// big exchanges TradingView carries), else, while its markets are unknown, the bare ticker pair.
const TV_EXCHANGES = { binance: "BINANCE", bybit_spot: "BYBIT", okex: "OKX", gate: "GATEIO", kucoin: "KUCOIN", mxc: "MEXC", bitget: "BITGET", coinbase: "COINBASE", kraken: "KRAKEN" };
function tradingViewSymbol() {
  if (!coin || STABLE.has(coin.symbol) || !/^[A-Z0-9]{1,20}$/.test(coin.symbol ?? "")) return null;
  if (coin.id === "bitcoin") return "CRYPTO:BTCUSD";
  for (const [exchange, prefix] of Object.entries(TV_EXCHANGES)) {
    const ticker = (coin.tickers ?? []).find((item) => item.exchange === exchange && item.base === coin.symbol && ["USDT", "USD"].includes(item.target));
    if (ticker) return `${prefix}:${coin.symbol}${ticker.target}`;
  }
  // The bare ticker only while the coin's markets are not known yet; a coin known to trade on no big
  // exchange (a fund's token, say) keeps the line chart, which TradingView would only call missing.
  return coin.partial ? `${coin.symbol}USDT` : null;
}
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
  $("#name").title = coin.name;
  $("#name").classList.toggle("long", coin.name.length > 10); // a long name gets a smaller size and wraps between words
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
  if (!paragraphs.length) nodes.push(Object.assign(document.createElement("p"), { className: coin.partial ? "muted" : "", textContent: coin.partial ? t().fetching : t().noDescription }));
  else if (language === "ru" && !russian) nodes.unshift(Object.assign(document.createElement("p"), { className: "muted", textContent: t().english }));
  $("#description").replaceChildren(...nodes);
  $("#more").hidden = shown.length === paragraphs.length;
  $("#categories").replaceChildren(...coin.categories.map((name) => Object.assign(document.createElement("span"), { textContent: name })));
}

// --- Where the coin trades.
function renderTickers() {
  // CoinGecko rates few markets now: the trust column shows only when some row has a rating.
  $(".markets-table").classList.toggle("no-trust", !coin.tickers.some((ticker) => ticker.trust));
  const rows = coin.tickers.map((ticker, index) => {
    const row = document.createElement("tr");
    const cells = [String(index + 1), "", `${ticker.base}/${ticker.target}`, price(ticker.price), big(ticker.volume), ""]
      .map((value, column) => {
        const cell = document.createElement("td");
        if (column < 3) cell.className = "left";
        cell.textContent = value;
        return cell;
      });
    if (ticker.logo) cells[1].append(Object.assign(document.createElement("img"), { className: "ex-logo", src: ticker.logo, alt: "", loading: "lazy", width: 22, height: 22 }));
    else cells[1].append(Object.assign(document.createElement("span"), { className: "ex-logo blank", textContent: ticker.market.slice(0, 1) }));
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
    cell.textContent = coin.partial ? t().fetching : t().noMarkets;
    row.append(cell);
    rows.push(row);
  }
  $("#tickers").replaceChildren(...rows);
}

// --- The converter works both ways: coins to dollars and dollars to coins. The fields hold plain
// numbers (no thousands separators), so a comma there is only ever the decimal mark.
const parse = (value) => Number(value.replace(/[\s ]/g, "").replace(",", "."));
function convert(from) {
  if (!coin?.price) return;
  if (from === "coin") {
    const value = parse($("#conv-coin").value);
    $("#conv-usd").value = Number.isFinite(value) ? (value * coin.price).toLocaleString(locale(), { maximumFractionDigits: 2, useGrouping: false }) : "";
  } else {
    const value = parse($("#conv-usd").value);
    $("#conv-coin").value = Number.isFinite(value) ? (value / coin.price).toLocaleString(locale(), { maximumSignificantDigits: 8, useGrouping: false }) : "";
  }
}

// --- The chart, as on the big market sites: a line that is green above the
// period's opening value and red below it, with that level dotted, a value
// scale and the latest value tagged on the right, time underneath, volume
// bars and a crosshair. Or TradingView's full chart with candles, drawing
// tools and indicators for coins with a Binance pair.
const SVG = "http://www.w3.org/2000/svg";
// 81.00K, 1.33T, 0.5123: short labels for the scale.
function short(value) {
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) {
    if (Math.abs(value) >= size) return `${(value / size).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit}`;
  }
  return value.toLocaleString(locale(), { maximumSignificantDigits: 4 });
}
// About eight round steps between low and high, as on the big market sites.
function ticks(low, high) {
  const span = (high - low) || Math.abs(high) || 1;
  const raw = span / 8;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw);
  const values = [];
  for (let value = Math.ceil(low / step) * step; value <= high; value += step) values.push(value);
  return values;
}
function renderChart() {
  const plot = $("#plot");
  const symbol = tradingViewSymbol();
  $("#candles").hidden = !symbol;
  candles = wantCandles && Boolean(symbol);
  for (const button of document.querySelectorAll("#mode [data-mode]")) button.classList.toggle("on", (button.dataset.mode === "tv") === candles);
  for (const button of document.querySelectorAll("#ranges [data-days]")) button.classList.toggle("on", button.dataset.days === days);
  for (const button of document.querySelectorAll("#metric [data-metric]")) button.classList.toggle("on", button.dataset.metric === metric);
  $("#ranges").hidden = $("#metric").hidden = candles;
  plot.classList.toggle("tv", candles);
  $("#period-change").replaceChildren();
  if (candles) {
    if (!plot.querySelector(".tradingview-widget-container")) plot.replaceChildren(tradingView(symbol, true));
    return;
  }
  let points = (metric === "caps" ? chart?.caps : chart?.prices) ?? [];
  // While the chosen period loads, the week from the market list stands in, so the box is never empty.
  const stand = points.length < 2 && metric === "prices" && (coin.sparkline?.length ?? 0) > 1;
  if (stand) {
    const step = 7 * 86_400_000 / (coin.sparkline.length - 1);
    const start = Date.now() - 7 * 86_400_000;
    points = coin.sparkline.map((value, index) => [start + index * step, value]);
  }
  if (points.length < 2) {
    plot.replaceChildren(Object.assign(document.createElement("p"), { className: "status",
      textContent: chartFailed ? t().chartUnavailable : t().chartLoading }));
    return;
  }
  const width = Math.max(200, plot.clientWidth);
  const height = Math.max(240, plot.clientHeight);
  const axis = 74; // the value scale on the right
  const right = width - axis;
  const top = 14;
  const bottom = height - 24 - 52; // the price area ends above the volume bars and the time labels
  const values = points.map(([, value]) => value);
  const open = values[0];
  const last = values.at(-1);
  let low = Math.min(...values);
  let high = Math.max(...values);
  const pad = (high - low) * 0.06 || Math.abs(high) * 0.01 || 1;
  low -= pad;
  high += pad;
  const x = (index) => index / (points.length - 1) * right;
  const y = (value) => top + (high - value) / (high - low) * (bottom - top);
  const baseY = y(open);
  const line = points.map(([, value], index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  const area = `${line}L${right},${baseY.toFixed(1)}L0,${baseY.toFixed(1)}Z`;
  const volumes = stand ? [] : chart?.volumes ?? [];
  const topVolume = Math.max(1, ...volumes.map(([, value]) => value));
  const barWidth = right / Math.max(1, volumes.length);
  // A young coin's history is shorter than the chosen period: the labels follow what is drawn.
  const span = points.at(-1)[0] - points[0][0];
  const young = !stand && span < Number(days) * 86_400_000 * 0.8;
  const time = (value) => new Date(value).toLocaleString(locale(), span < 2.5 * 86_400_000
    ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", ...(span > 200 * 86_400_000 ? { year: "2-digit" } : {}) });
  // A scale label under the latest value's tag is left out.
  const grid = ticks(low, high).map((value) => `<line class="grid" x1="0" x2="${right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/>` +
    (Math.abs(y(value) - y(values.at(-1))) < 16 ? "" : `<text class="tick" x="${right + 8}" y="${(y(value) + 4).toFixed(1)}">${short(value)}</text>`)).join("");
  const times = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1].map((share) => {
    const index = Math.round(share * (points.length - 1));
    const anchor = share === 0 ? "start" : share === 1 ? "end" : "middle";
    return `<text class="tick" text-anchor="${anchor}" x="${x(index).toFixed(1)}" y="${height - 6}">${time(points[index][0])}</text>`;
  }).join("");
  const rising = last >= open;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = `<defs>
      <clipPath id="above"><rect x="0" y="0" width="${right}" height="${baseY.toFixed(1)}"/></clipPath>
      <clipPath id="below"><rect x="0" y="${baseY.toFixed(1)}" width="${right}" height="${height}"/></clipPath>
      <linearGradient id="fill-up" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--up)" stop-opacity=".28"/><stop offset="1" stop-color="var(--up)" stop-opacity=".02"/></linearGradient>
      <linearGradient id="fill-down" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stop-color="var(--down)" stop-opacity=".28"/><stop offset="1" stop-color="var(--down)" stop-opacity=".02"/></linearGradient>
    </defs><rect class="frame" x="0.5" y="0.5" width="${(right - 1).toFixed(1)}" height="${(height - 24.5).toFixed(1)}"/>${grid}
    ${volumes.map(([, value], index) => `<rect class="vol" x="${(index * barWidth).toFixed(1)}" y="${(height - 24 - value / topVolume * 44).toFixed(1)}" width="${Math.max(1, barWidth - 1).toFixed(1)}" height="${(value / topVolume * 44).toFixed(1)}"/>`).join("")}
    <path d="${area}" fill="url(#fill-up)" clip-path="url(#above)"/><path d="${area}" fill="url(#fill-down)" clip-path="url(#below)"/>
    <path d="${line}" fill="none" stroke="var(--up)" stroke-width="2" clip-path="url(#above)"/>
    <path d="${line}" fill="none" stroke="var(--down)" stroke-width="2" clip-path="url(#below)"/>
    <line class="base" x1="0" x2="${right}" y1="${baseY.toFixed(1)}" y2="${baseY.toFixed(1)}"/>
    <rect class="base-tag" x="2" y="${(baseY - 9).toFixed(1)}" rx="3" width="${short(open).length * 7 + 10}" height="18"/>
    <text class="base-text" x="7" y="${(baseY + 4).toFixed(1)}">${short(open)}</text>
    <rect x="${right + 2}" y="${(y(last) - 10).toFixed(1)}" rx="4" width="${axis - 4}" height="20" fill="var(--${rising ? "up" : "down"})"/>
    <text class="now" x="${right + 8}" y="${(y(last) + 4).toFixed(1)}">${short(last)}</text>
    <text class="mark" x="${right - 10}" y="${bottom - 8}" text-anchor="end">NIR Markets</text>${times}`;
  const label = (className) => Object.assign(document.createElement("span"), { className });
  const cursor = label("cursor");
  const dot = label("dot");
  const tip = label("tip");
  plot.replaceChildren(svg, cursor, dot, tip);
  plot.onpointermove = (event) => {
    const box = plot.getBoundingClientRect();
    const index = Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / right)) * (points.length - 1));
    const [when, value] = points[index];
    cursor.style.left = dot.style.left = `${x(index)}px`;
    dot.style.top = `${y(value)}px`;
    dot.style.background = `var(--${value >= open ? "up" : "down"})`;
    const volume = volumes[Math.round(index / (points.length - 1) * (volumes.length - 1))]?.[1];
    tip.replaceChildren(Object.assign(document.createElement("small"), { textContent: new Date(when).toLocaleString(locale(),
      { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) }),
    Object.assign(document.createElement("b"), { textContent: metric === "caps" ? big(value) : price(value) }),
    ...(volume ? [Object.assign(document.createElement("small"), { textContent: `${language === "en" ? "Vol" : "Объём"} ${big(volume)}` })] : []));
    tip.style.left = `${Math.min(right - tip.offsetWidth - 6, Math.max(6, x(index) + 12))}px`;
    plot.classList.add("hover");
  };
  plot.onpointerleave = () => plot.classList.remove("hover");
  const shift = document.createElement("b");
  setChange(shift, (last - open) / open * 100);
  $("#period-change").replaceChildren(`${stand ? t().period["7"] : young ? t().young : t().period[days]}: `, shift, ...(stand && days !== "7" ? [Object.assign(document.createElement("span"), { className: "muted", textContent: ` · ${t().standIn}` })] : []));
}
// The line is drawn to the box's real size, so it is redrawn when the box changes.
new ResizeObserver(() => { if (coin && !candles) renderChart(); }).observe($("#plot"));

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
  // The discussion draws itself as its data comes (community.js); here only the first time and when the
  // language or the account changes, so a refresh of the coin never wipes a comment being written.
  const drawn = `${language}|${account.signIn}|${account.user?.username ?? ""}`;
  if (typeof renderCommunity === "function" && communityDrawnIn !== drawn) { communityDrawnIn = drawn; renderCommunity(); }
  if (typeof startTrades === "function") { startTrades(); renderTrades(); } // trades.js
}

// The page never waits on a busy data source: it opens from the market list the browser already
// has, takes a short answer from the server when CoinGecko is busy, and asks again until it has
// everything; the error shows only after a minute with nothing at all.
let communityDrawnIn = null;
let retries = 0;
let gone = false; // the coin does not exist: no more asking
async function loadCoin() {
  if (gone) return;
  try {
    const response = await fetch(`/market/coin/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 404) { failure = t().missing; gone = true; return; }
    if (!response.ok) throw new Error("coin data unavailable");
    const next = await response.json();
    // The full answer has no week of prices; the one from the market list stays for the stand-in chart.
    if (!next.partial || !coin || coin.partial) coin = { ...next, sparkline: next.sparkline ?? coin?.sparkline ?? [] };
  } catch {
    if (!coin && retries >= 12) failure = t().unavailable;
  } finally {
    // While the data source is busy the page keeps asking, less often after the first minutes.
    if (!gone && (!coin || coin.partial)) { retries += 1; setTimeout(loadCoin, retries < 30 ? Math.min(10_000, 2_000 + retries * 1_000) : 30_000); }
    render();
  }
}
async function quickStart() {
  const overview = await marketOverview();
  const row = [...(overview?.coins ?? []), ...(overview?.trendingCoins ?? [])].find((item) => item.id === id);
  if (coin && row && !coin.sparkline?.length) { coin.sparkline = row.sparkline; renderChart(); }
  if (coin || !row) return;
  coin = { ...row, partial: true, change30d: null, change1y: null, fullyDiluted: null, high24h: null, low24h: null, totalSupply: null,
    ath: null, athChange: null, athDate: "", atl: null, atlChange: null, atlDate: "", categories: [], platforms: [], contracts: {},
    description: { en: "", ru: "" }, tickers: [], updatedAt: "",
    links: { websites: [], whitepaper: null, explorers: [], source: [], forums: [], chats: [], reddit: null, x: null, telegram: null } };
  render();
}

let chartRetries = 0;
let chartAsk = 0; // each range choice starts a new line of asks; older ones stop
async function loadChart(ask = chartAsk) {
  if (ask !== chartAsk) return;
  const wanted = days;
  let again = false;
  try {
    const response = await fetch(`/market/chart/${encodeURIComponent(id)}?days=${wanted}`, { cache: "no-store" });
    if (!response.ok) throw new Error("chart unavailable");
    const value = await response.json();
    if (ask !== chartAsk) return;
    // The week standing in for a busy source is drawn by the page itself; the real chart is asked again.
    if (value.partial) again = true;
    else { chart = value; chartFailed = false; chartRetries = 0; }
  } catch {
    if (ask !== chartAsk) return;
    again = true;
  }
  // A busy source: the chart keeps its stand-in and is asked for again a few seconds later.
  if (again && chartRetries < 20) { chartRetries += 1; setTimeout(() => void loadChart(ask), Math.min(10_000, 2_000 + chartRetries * 1_000)); }
  else if (again) chartFailed = !chart;
  if (coin) renderChart();
}

for (const button of document.querySelectorAll("#ranges [data-days]")) {
  button.addEventListener("click", () => {
    days = button.dataset.days;
    chart = null;
    chartRetries = 0;
    chartFailed = false;
    chartAsk += 1;
    renderChart();
    void loadChart();
  });
}
for (const button of document.querySelectorAll("#mode [data-mode]")) {
  button.addEventListener("click", () => { wantCandles = button.dataset.mode === "tv"; renderChart(); });
}
for (const button of document.querySelectorAll("#metric [data-metric]")) {
  button.addEventListener("click", () => { metric = button.dataset.metric; renderChart(); });
}
$("#watch").addEventListener("click", () => { toggleWatch(coin.id); renderHead(); });
$("#alert").addEventListener("click", () => { if (coin) openAlertDialog(coin); });
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
setupPage({ en, render, onTheme: () => { if (candles) { $("#plot").replaceChildren(); renderChart(); } } }); // the candles follow the theme
if (COIN_ID_PATTERN.test(id)) {
  void quickStart();
  void loadCoin();
  void loadChart();
  setInterval(loadCoin, 120_000);
  setInterval(loadChart, 300_000);
} else {
  failure = t().missing;
  render();
}
