// NIR Markets: the top 100 coins from the server's cached copy (/market/overview,
// refreshed every minute), a watchlist kept in this browser, a TradingView
// chart under any coin and a link to each coin's own page. Shared helpers
// (numbers, logos, themes, languages, NIR's figures) are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  nirOpen: "NIR network is open", nirMiners: "Miners online", nirPioneers: "Pioneers", nirMined: "Mined",
  nirPool: "🏆 210,000 NIR for pioneers", nirCta: "Mine NIR with one button →",
  navCoins: "Cryptocurrencies", navMovers: "Gainers & losers", navNir: "About NIR", navMine: "NIR mining",
  search: "Search coins or addresses", marketStatus: "Market status", fearGreed: "Fear & Greed", marketCap: "Market cap",
  volume24: "Volume 24h", dominance: "BTC dominance", trending: "Trending", gainers24: "Top gainers 24h",
  tabTop: "Top", tabWatch: "Watchlist", tabTrending: "Trending", tabGainers: "Gainers", tabLosers: "Losers", tabStable: "Stablecoins", tabWallets: "Popular wallets",
  colCoin: "Coin", colPrice: "Price", col1h: "1h", col24h: "24h", col7d: "7d", colCap: "Market cap",
  colVolume: "Volume 24h", col7days: "7 days", nirRow: "test network · mined with intelligence",
  nirNoPrice: "no price yet — pioneers are mining", nirMinedShort: "NIR mined", mine: "Mine",
  loading: "Loading prices…", pricesBy: "Prices:", chartsBy: "Charts:", updated: "Updated",
  noTrackers: "No trackers", aboutNir: "About the NIR blockchain →", privacy: "Privacy", terms: "Terms",
  briefShort: "✦ Summary", barMarkets: "Markets", barMine: "Mining", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", mineArrow: "Mine →",
  chipFear: "📈 Fear & Greed Index", chipDominance: "🥧 BTC and ETH dominance", chipTrending: "🔥 Trending", colSupply: "Circulating supply", risingNow: "Rising in 24h", altSeason: "Altcoin season · 7d", allTransfers: "All transfers", colSentiment: "Sentiment",
  dataBy: "Data:",
};
const words = {
  ru: { altSeason: "сезон альткоинов", btcSeason: "сезон биткоина", neutralSeason: "нейтрально", moodTitle: (rise, fall) => `Голоса за 7 дней: рост ${rise}, падение ${fall}`, communityTitle: "Голоса сообщества CoinGecko за сутки: доля «рост»", rate: "Оценить", rateTitle: "Голосов пока нет — оцените первым", empty: "Ничего не найдено", watchEmpty: "Нажмите ☆ у монеты в таблице или на её странице, чтобы добавить её в избранное.",
    unavailable: "Курсы временно недоступны. Попробуйте обновить страницу через минуту.",
    fear: { "Extreme Fear": "Сильный страх", Fear: "Страх", Neutral: "Нейтрально", Greed: "Жадность", "Extreme Greed": "Сильная жадность" },
    brief: (d) => `Рынок за сутки ${d.cap >= 0 ? "вырос" : "снизился"} на ${d.capPct}: капитализация ${d.capValue}. ` +
      `Bitcoin стоит ${d.btc} (${d.btcPct}), доминация — ${d.dom}. Сильнее всех растёт ${d.top} (${d.topPct}), ` +
      `сильнее всех падает ${d.low} (${d.lowPct}).${d.fg ? ` Индекс страха и жадности — ${d.fg}.` : ""}` },
  en: { altSeason: "altcoin season", btcSeason: "bitcoin season", neutralSeason: "neutral", moodTitle: (rise, fall) => `Votes over 7 days: rise ${rise}, fall ${fall}`, communityTitle: "CoinGecko community votes over a day: share of “rise”", rate: "Rate", rateTitle: "No votes yet — be the first", empty: "Nothing found", watchEmpty: "Tap ☆ next to a coin or on its page to add it to your watchlist.",
    unavailable: "Prices are unavailable right now. Try reloading in a minute.",
    fear: {},
    brief: (d) => `The market ${d.cap >= 0 ? "rose" : "fell"} ${d.capPct} in 24 hours to a ${d.capValue} market cap. ` +
      `Bitcoin trades at ${d.btc} (${d.btcPct}) with ${d.dom} dominance. The top gainer is ${d.top} (${d.topPct}), ` +
      `the biggest loser ${d.low} (${d.lowPct}).${d.fg ? ` Fear & Greed stands at ${d.fg}.` : ""}` },
};

let data = null;
let tab = "top";
// Coins are browsed 100 a page, as /?page=N; the first page comes with the overview.
const page = Math.min(500, Math.max(1, Number.parseInt(new URLSearchParams(location.search).get("page") ?? "1", 10) || 1));
let pageCoins = null;
let query = "";
const sort = { key: null, dir: 0 };
// Rise and fall votes per coin over the last 7 days (/market/sentiment), for the sentiment column.
let votes = {};
// Where NIR Markets has no votes on a coin yet, the CoinGecko community's share of rise votes stands in.
const sentiment = (coin) => {
  const count = votes[coin.id];
  if (count && count.rise + count.fall) return count.rise / (count.rise + count.fall) * 100;
  return Number.isFinite(data?.community?.[coin.id]) ? data.community[coin.id] : null;
};

function sparkline(points, rising, className = "spark") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 120 38");
  svg.setAttribute("preserveAspectRatio", "none");
  if (points.length > 1) {
    const low = Math.min(...points);
    const high = Math.max(...points);
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", points.map((value, index) =>
      `${(index / (points.length - 1) * 120).toFixed(1)},${(36 - (value - low) / ((high - low) || 1) * 34).toFixed(1)}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", rising ? "var(--up)" : "var(--down)");
    line.setAttribute("stroke-width", "1.8");
    svg.append(line);
  }
  return svg;
}

let watchExtra = [];
let watchAsked = "";
async function loadWatchExtra(ids) {
  const key = ids.slice().sort().join(",");
  if (key === watchAsked) return;
  watchAsked = key;
  const answer = await fetch(`/market/coins?ids=${encodeURIComponent(ids.slice(0, 50).join(","))}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (!answer) { watchAsked = ""; return; }
  watchExtra = answer.coins;
  renderTable();
}

function visibleCoins() {
  let coins = (tab === "top" && page > 1 ? pageCoins : data?.coins) ?? [];
  // The watchlist: starred coins from the top hundred, and the others fetched by id.
  if (tab === "watch") {
    coins = coins.filter((coin) => watch.has(coin.id));
    const missing = [...watch].filter((id) => !coins.some((coin) => coin.id === id));
    coins = [...coins, ...watchExtra.filter((coin) => watch.has(coin.id))];
    if (missing.some((id) => !watchExtra.some((coin) => coin.id === id))) void loadWatchExtra(missing);
  }
  if (tab === "stable") coins = coins.filter((coin) => STABLE.has(coin.symbol));
  // Trending coins outside the top 100 come with a price and a 24h change only.
  if (tab === "trending") {
    coins = (data?.trending ?? []).map((item) => data.coins.find((coin) => coin.id === item.id) ?? data.trendingCoins?.find((coin) => coin.id === item.id) ??
      { ...item, rank: null, change1h: null, change7d: null, marketCap: null, volume: null, sparkline: [] });
  }
  if (tab === "gainers" || tab === "losers") {
    coins = coins.filter((coin) => coin.change24h !== null && !STABLE.has(coin.symbol))
      .sort((a, b) => (tab === "gainers" ? b.change24h - a.change24h : a.change24h - b.change24h));
  }
  if (query) {
    const needle = query.toLowerCase();
    coins = coins.filter((coin) => coin.name.toLowerCase().includes(needle) || coin.symbol.toLowerCase().includes(needle));
  }
  return sortBy(coins, sort, (coin, key) => (key === "name" ? coin.name.toLowerCase() : key === "sentiment" ? sentiment(coin) : coin[key]));
}

function renderTable() {
  const body = $("#rows");
  body.replaceChildren();
  const t = words[language];
  const coins = visibleCoins();
  markSort($("thead"), sort);
  for (const coin of coins) {
    const row = document.createElement("tr");
    row.className = "coin";
    const star = document.createElement("td");
    star.className = `star hide-s${watch.has(coin.id) ? " on" : ""}`;
    star.textContent = watch.has(coin.id) ? "★" : "☆";
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleWatch(coin.id);
      renderTable();
    });
    const rank = document.createElement("td");
    rank.className = "rank";
    rank.textContent = coin.rank ?? "";
    const name = document.createElement("td");
    name.className = "left";
    const cell = document.createElement("a");
    cell.className = "coin-cell";
    cell.href = coinUrl(coin);
    const title = document.createElement("b");
    title.textContent = coin.name;
    cell.title = `${coin.name} (${coin.symbol})`;
    const symbol = document.createElement("span");
    symbol.textContent = coin.symbol;
    // On a phone the row shows the symbol over the market cap, as in the market apps.
    const capLine = document.createElement("small");
    capLine.textContent = big(coin.marketCap);
    cell.append(logo(coin), title, symbol, capLine);
    name.append(cell);
    const value = document.createElement("td");
    value.textContent = price(coin.price);
    const cap = document.createElement("td");
    cap.className = "hide-s";
    cap.textContent = big(coin.marketCap);
    const volume = document.createElement("td");
    volume.className = "hide-s";
    volume.textContent = big(coin.volume);
    // Circulating supply, with a bar towards the maximum when there is one.
    const supply = document.createElement("td");
    supply.className = "hide-s supply";
    supply.textContent = coin.circulating ? `${big(coin.circulating, "")} ${coin.symbol}` : "—";
    if (coin.circulating && coin.maxSupply) {
      const bar = document.createElement("i");
      bar.style.setProperty("--fill", `${Math.min(100, coin.circulating / coin.maxSupply * 100).toFixed(1)}%`);
      bar.title = `${Math.round(coin.circulating / coin.maxSupply * 100)}%`;
      supply.append(bar);
    }
    const spark = document.createElement("td");
    spark.className = "hide-s";
    spark.append(sparkline(coin.sparkline, (coin.change7d ?? 0) >= 0));
    const day = percentCell(coin.change24h);
    day.prepend(sparkline(coin.sparkline, (coin.change7d ?? 0) >= 0, "m-spark"));
    const hour = percentCell(coin.change1h);
    const week = percentCell(coin.change7d);
    hour.classList.add("hide-s");
    week.classList.add("hide-s");
    // The whole row opens the coin's page; the star does its own thing.
    row.addEventListener("click", (event) => { if (!event.target.closest("a")) location.href = coinUrl(coin); });
    // The community's mood: the share of "rise" votes, with a bar of rise against fall.
    const mood = document.createElement("td");
    mood.className = "hide-s mood";
    const share = sentiment(coin);
    if (share === null) {
      // No votes anywhere yet: an invitation to rate it on the coin's page.
      mood.append(Object.assign(document.createElement("a"), { className: "rate", href: `${coinUrl(coin)}#vote`, textContent: t.rate, title: t.rateTitle }));
    } else {
      const count = votes[coin.id];
      mood.className = `hide-s mood ${share >= 50 ? "up" : "down"}`;
      mood.textContent = `${share >= 50 ? "▲" : "▼"} ${Math.round(share >= 50 ? share : 100 - share)}%`;
      const bar = document.createElement("i");
      bar.style.setProperty("--rise", `${share.toFixed(0)}%`);
      mood.append(bar);
      mood.title = count && count.rise + count.fall ? t.moodTitle(count.rise, count.fall) : t.communityTitle;
    }
    row.append(star, rank, name, value, hour, day, week, cap, volume, supply, mood, spark);
    body.append(row);
  }
  $("#status").textContent = !data ? $("#status").textContent
    : coins.length ? "" : tab === "watch" && !query ? t.watchEmpty : t.empty;
  renderPager();
}

function renderCards() {
  const t = words[language];
  const g = data.global;
  $("#g-cap").textContent = big(g?.marketCap, "$", 1);
  const capChange = $("#g-cap-change");
  capChange.className = changeClass(g?.marketCapChange24h);
  capChange.textContent = percentText(g?.marketCapChange24h);
  $("#g-volume").textContent = big(g?.volume, "$", 1);
  // How many of the top coins rose today, and how many of the top 50 beat BTC over the week.
  const moving = (data.coins ?? []).filter((coin) => Number.isFinite(coin.change24h));
  const rising = moving.filter((coin) => coin.change24h > 0).length;
  $("#g-rising").textContent = moving.length ? `${rising} / ${moving.length}` : "—";
  $("#g-rising-share").textContent = moving.length ? `${Math.round(rising / moving.length * 100)}%` : "";
  const btcWeek = (data.coins ?? []).find((coin) => coin.symbol === "BTC")?.change7d;
  const alts = (data.coins ?? []).slice(0, 50).filter((coin) => coin.symbol !== "BTC" && !STABLE.has(coin.symbol) && Number.isFinite(coin.change7d));
  const season = Number.isFinite(btcWeek) && alts.length ? Math.round(alts.filter((coin) => coin.change7d > btcWeek).length / alts.length * 100) : null;
  $("#g-alt").textContent = season === null ? "—" : `${season}/100`;
  $("#g-alt-label").textContent = season === null ? "" : season >= 75 ? t.altSeason : season <= 25 ? t.btcSeason : t.neutralSeason;
  $("#g-btc").textContent = g?.btcDominance === null || g?.btcDominance === undefined ? "—"
    : `${g.btcDominance.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`;
  $("#g-eth").textContent = g?.ethDominance ? `ETH ${g.ethDominance.toLocaleString(locale(), { maximumFractionDigits: 1 })}%` : "";
  const fg = data.fearGreed;
  $("#fg-value").textContent = fg ? String(fg.value) : "—";
  $("#fg-label").textContent = fg ? (t.fear[fg.label] ?? fg.label) : "";
  if (fg) {
    // The dot rides the arc from 0 (left) to 100 (right).
    const angle = Math.PI * (1 - fg.value / 100);
    $("#fg-dot").setAttribute("cx", (55 + 47 * Math.cos(angle)).toFixed(1));
    $("#fg-dot").setAttribute("cy", (56 - 47 * Math.sin(angle)).toFixed(1));
  }
  const list = (target, coins, withPrice) => {
    $(target).replaceChildren(...coins.slice(0, 8).map((coin, index) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = coinUrl(coin);
      const number = document.createElement("span");
      number.className = "n";
      number.textContent = String(index + 1);
      const name = document.createElement("b");
      name.textContent = coin.symbol;
      link.append(number, logo(coin), name);
      if (withPrice) {
        const value = document.createElement("span");
        value.textContent = price(coin.price);
        link.append(value);
      }
      const change = document.createElement("span");
      change.className = changeClass(coin.change24h);
      change.textContent = percentText(coin.change24h);
      link.append(change);
      item.append(link);
      return item;
    }));
  };
  list("#trending", data.trending ?? [], true);
  // The day's top gainers among the top coins, without stablecoins.
  list("#gainers", (data.coins ?? []).filter((coin) => coin.change24h > 0 && !STABLE.has(coin.symbol))
    .sort((left, right) => right.change24h - left.change24h), false);
  const btc = data.coins.find((coin) => coin.symbol === "BTC");
  const top = data.gainers?.[0];
  const low = data.losers?.[0];
  $("#m-brief-text").textContent = g && btc && top && low ? t.brief({
    cap: g.marketCapChange24h ?? 0, capPct: `${Math.abs(g.marketCapChange24h ?? 0).toLocaleString(locale(), { maximumFractionDigits: 2 })}%`,
    capValue: big(g.marketCap), btc: price(btc.price), btcPct: percentText(btc.change24h).replace("▲ ", "+").replace("▼ ", "−"),
    dom: `${(g.btcDominance ?? 0).toLocaleString(locale(), { maximumFractionDigits: 1 })}%`,
    top: top.name, topPct: `+${top.change24h.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`,
    low: low.name, lowPct: `${low.change24h.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`,
    fg: fg ? `${fg.value} (${(t.fear[fg.label] ?? fg.label).toLowerCase()})` : "",
  }) : "";
  $("#updated").textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString(locale(),
    { hour: "2-digit", minute: "2-digit" }) : "—";
}

// Page numbers: the first, the last and two around the current one.
function renderPager() {
  const total = data?.global?.coins ?? 0;
  const pages = Math.min(500, Math.ceil(total / 100));
  $("#pager").hidden = !data || tab !== "top" || Boolean(query) || !pages;
  if ($("#pager").hidden) return;
  const from = (page - 1) * 100 + 1;
  $("#pager-info").textContent = language === "en"
    ? `Showing ${from}–${Math.min(page * 100, total)} of ${total.toLocaleString(locale())}`
    : `Показаны ${from}–${Math.min(page * 100, total)} из ${total.toLocaleString(locale())}`;
  const wanted = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const nodes = [];
  const link = (n, text = String(n)) => Object.assign(document.createElement("a"), { href: n === 1 ? "/" : `/?page=${n}`,
    textContent: text, className: n === page && text === String(n) ? "on" : "" });
  if (page > 1) nodes.push(link(page - 1, "‹"));
  let last = 0;
  for (const n of [...wanted].sort((a, b) => a - b)) {
    if (n - last > 1) nodes.push(Object.assign(document.createElement("span"), { textContent: "…" }));
    nodes.push(link(n));
    last = n;
  }
  if (page < pages) nodes.push(link(page + 1, "›"));
  $("#pages").replaceChildren(...nodes);
}

async function load() {
  try {
    const response = await fetch("/market/overview", { cache: "no-store" });
    if (!response.ok) throw new Error("market data unavailable");
    data = await response.json();
    if (page > 1) {
      const more = await fetch(`/market/coins?page=${page}`).then((answer) => (answer.ok ? answer.json() : null)).catch(() => null);
      if (more) pageCoins = more.coins;
    }
    votes = (await fetch("/market/sentiment").then((answer) => (answer.ok ? answer.json() : null)).catch(() => null))?.coins ?? votes;
    renderCards();
    renderTable();
  } catch {
    if (!data) $("#status").textContent = words[language].unavailable;
  }
}

// --- "All transfers": the newest transfers on the tracked networks (/market/chain/feed), refreshed every 20 seconds.
let transferMin = Number(store.get("nir-transfers-min")) || 1;
let transfers = null;
function renderTransfers() {
  for (const button of document.querySelectorAll("#tf-min [data-min]")) button.classList.toggle("on", Number(button.dataset.min) === transferMin);
  const box = $("#transfers");
  if (!transfers) return;
  if (!transfers.length) {
    box.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: language === "en" ? "No transfers this large right now." : "Сейчас таких крупных переводов нет." }));
    return;
  }
  box.replaceChildren(...transfers.slice(0, 7).map((item) => {
    const row = document.createElement("li");
    const route = document.createElement("div");
    route.className = "tf-route";
    route.append(chainDot(item.chain), walletLink(item.from), Object.assign(document.createElement("i"), { textContent: "→" }), walletLink(item.to));
    const facts = document.createElement("div");
    facts.className = "tf-facts";
    const sum = Object.assign(document.createElement("a"), { href: `${CHAINS[item.chain]?.tx ?? "#"}${item.hash}`, target: "_blank", rel: "noopener",
      textContent: `${amountShort(item.amount)} ${item.token.symbol}` });
    facts.append(sum, Object.assign(document.createElement("b"), { textContent: usdShort(item.usd) }),
      Object.assign(document.createElement("span"), { className: "muted", textContent: timeAgo(item.time) }));
    row.append(route, facts);
    return row;
  }));
}
async function loadTransfers() {
  const data = await fetch(`/market/chain/feed?min=${transferMin}`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (data) { transfers = data.items; renderTransfers(); }
}
for (const button of document.querySelectorAll("#tf-min [data-min]")) {
  button.addEventListener("click", () => { transferMin = Number(button.dataset.min); store.set("nir-transfers-min", String(transferMin)); transfers = null; renderTransfers(); void loadTransfers(); });
}
void loadTransfers();
setInterval(() => { if (!document.hidden) void loadTransfers(); }, 20_000);

for (const button of document.querySelectorAll("[data-tab]")) {
  button.addEventListener("click", () => {
    tab = button.dataset.tab;
    for (const other of document.querySelectorAll(".tabs [data-tab]")) other.classList.toggle("on", other.dataset.tab === tab);
    // The watchlist opens from the menu at the top; its tab shows only while it is open.
    $(".tabs [data-tab=watch]").hidden = tab !== "watch";
    // The bottom bar on phones: Watchlist, or Markets for every other list.
    for (const item of document.querySelectorAll(".tabbar [data-tab]")) {
      item.classList.toggle("on", (item.dataset.tab === "watch") === (tab === "watch"));
    }
    renderTable();
  });
}
// A search typed on a coin's page arrives as /?q=…
const search = $("#search");
search.value = new URLSearchParams(location.search).get("q")?.slice(0, 60) ?? "";
query = search.value.trim();
search.addEventListener("input", () => { query = search.value.trim(); renderTable(); });
// Phones show a search button that opens the field under the header.
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) search.focus();
});
if (query) document.body.classList.add("searching");
$("#m-brief").addEventListener("click", () => $("#m-brief").classList.toggle("open"));
// A coin page's bottom bar links to /#watch; the menu's movers link to /#gainers.
function openHash() {
  const opening = location.hash.slice(1);
  if (!["watch", "trending", "gainers", "losers"].includes(opening)) return;
  document.querySelector(`.tabs [data-tab=${opening}]`).click();
  if (opening !== "watch") document.querySelector(".tabs").scrollIntoView();
}
openHash();
addEventListener("hashchange", openHash);

sortable($("thead"), sort, () => renderTable());
setupSearch({ overview: () => data });
setupPage({ en, render: () => { if (data) { renderCards(); renderTable(); } renderTransfers(); } });
void load();
setInterval(load, 60_000);
