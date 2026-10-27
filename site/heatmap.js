// The market heatmap, /screener/heatmap/: every coin a tile, sized by market cap (the top coins from
// marketOverview) or by day volume (the futures coins of /market/screener), and coloured by its price change
// over the chosen period. Tiles are laid out as a squarified treemap; a tile opens the coin's page, and on a
// pointer it shows the coin's figures. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  tabTrends: "Trends", tabDensities: "Order book walls", tabArbitrage: "Arbitrage", tabLiquidations: "Liquidations", tabListings: "Listings", tabHeatmap: "Heatmap",
  title: "Heatmap",
  source: "A tile's size is the coin's market cap (for futures, its day's trading volume); its colour is the price change over the chosen period: the brighter, the stronger. Data: CoinGecko (spot) and the open futures markets of six exchanges.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { sources: { spot: "Капитализация", futures: "Фьючерсы" }, counts: [[50, "50 монет"], [100, "100 монет"], [200, "200 монет"]], stables: "Без стейблкоинов",
    loading: "Загружаю монеты…", cap: "Капитализация", volume: "Объём 24 ч", price: "Цена",
    note: (up, down, avg) => `Растут ${up} · падают ${down} · в среднем ${avg}` },
  en: { sources: { spot: "Market cap", futures: "Futures" }, counts: [[50, "50 coins"], [100, "100 coins"], [200, "200 coins"]], stables: "No stablecoins",
    loading: "Loading coins…", cap: "Market cap", volume: "24h volume", price: "Price",
    note: (up, down, avg) => `Up ${up} · down ${down} · on average ${avg}` },
};
// The periods each source has, and how big a change paints a tile at full strength.
const PERIODS = {
  spot: [["change1h", "1h", 3], ["change24h", "24h", 10], ["change7d", "7d", 20]],
  futures: [["ch5m", "5m", 1.5], ["ch1h", "1h", 3], ["ch4h", "4h", 6], ["ch24h", "24h", 10]],
};
const t = () => words[language === "en" ? "en" : "ru"];
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
const state = { source: "spot", period: "change24h", count: 100, stables: false };
let spot = null;
let futures = null;
let coins = new Map(); // symbol → market coin, for the futures tiles' logos and links

// --- The squarified treemap: rows of tiles laid along the shorter side, each row as close to square as it gets.
function squarify(items, x, y, width, height) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const scale = (width * height) / total;
  const rest = items.map((item) => ({ ...item, area: item.weight * scale }));
  const tiles = [];
  const worst = (row, side) => {
    const sum = row.reduce((all, item) => all + item.area, 0);
    const max = Math.max(...row.map((item) => item.area));
    const min = Math.min(...row.map((item) => item.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  let box = { x, y, width, height };
  while (rest.length) {
    const side = Math.min(box.width, box.height);
    const row = [rest.shift()];
    while (rest.length && worst([...row, rest[0]], side) <= worst(row, side)) row.push(rest.shift());
    const sum = row.reduce((all, item) => all + item.area, 0);
    if (box.width >= box.height) {
      // A column on the left.
      const columnWidth = sum / box.height;
      let top = box.y;
      for (const item of row) { const h = item.area / columnWidth; tiles.push({ ...item, x: box.x, y: top, width: columnWidth, height: h }); top += h; }
      box = { x: box.x + columnWidth, y: box.y, width: box.width - columnWidth, height: box.height };
    } else {
      // A row along the top.
      const rowHeight = sum / box.width;
      let left = box.x;
      for (const item of row) { const w = item.area / rowHeight; tiles.push({ ...item, x: left, y: box.y, width: w, height: rowHeight }); left += w; }
      box = { x: box.x, y: box.y + rowHeight, width: box.width, height: box.height - rowHeight };
    }
  }
  return tiles;
}

// A stablecoin: a known one, or a coin that holds a dollar (within 3%, under 1% over the week).
const isStable = (coin) => STABLE.has(coin.symbol) || (coin.price > 0.97 && coin.price < 1.03 && Math.abs(coin.change7d ?? coin.ch24h ?? 99) < 1);
function items() {
  if (state.source === "spot") {
    return (spot ?? []).filter((coin) => coin.marketCap > 0 && (state.stables || !isStable(coin))).slice(0, state.count)
      .map((coin) => ({ coin, symbol: coin.symbol, name: coin.name, image: coin.image, size: coin.marketCap, price: coin.price, change: coin[state.period] ?? null }));
  }
  return (futures ?? []).filter((row) => row.volume > 0 && (state.stables || !isStable(row))).slice(0, state.count).map((row) => {
    const coin = row.id ? { id: row.id, symbol: row.symbol, image: row.image } : coins.get(row.symbol) ?? null;
    return { coin, symbol: row.symbol, name: coin?.name ?? row.symbol, image: row.image ?? coin?.image ?? null, size: row.volume, price: row.price, change: row[state.period] ?? null };
  });
}
const percent = (value) => (value === null ? "—" : `${value > 0 ? "+" : ""}${value.toLocaleString(locale(), { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1 })}%`);
function render() {
  document.title = `${language === "en" ? en.title : "Тепловая карта"} — NIR Markets`;
  const button = (label, on, click) => { const item = node("button", on ? "on" : "", label); item.type = "button"; item.addEventListener("click", () => { click(); render(); }); return item; };
  $("#sources").replaceChildren(...Object.entries(t().sources).map(([key, label]) => button(label, key === state.source, () => {
    state.source = key;
    state.period = key === "spot" ? "change24h" : "ch1h";
    if (key === "futures") void loadFutures();
  })));
  $("#periods").replaceChildren(...PERIODS[state.source].map(([key, label]) => button(label, key === state.period, () => { state.period = key; })));
  $("#counts").replaceChildren(...t().counts.filter(([value]) => state.source === "futures" || value <= 100).map(([value, label]) => button(label, value === state.count, () => { state.count = value; })));
  $("#stables").textContent = t().stables;
  $("#stables").classList.toggle("on", !state.stables);
  const list = items();
  const map = $("#map");
  if (!list.length) { map.replaceChildren(node("p", "muted hm-empty", t().loading)); return; }
  const full = PERIODS[state.source].find(([key]) => key === state.period)?.[2] ?? 10;
  const known = list.filter((item) => item.change !== null);
  const average = known.reduce((sum, item) => sum + item.change, 0) / (known.length || 1);
  $("#note").textContent = t().note(known.filter((item) => item.change > 0).length, known.filter((item) => item.change < 0).length, percent(average));
  // A square root keeps the biggest coin from taking the whole map, so the rest stay readable.
  const width = map.clientWidth;
  const height = Math.round(width < 600 ? width * 1.7 : Math.min(760, width * 0.56));
  map.style.height = `${height}px`;
  const tiles = squarify(list.map((item) => ({ ...item, weight: Math.sqrt(item.size) })).sort((left, right) => right.weight - left.weight), 0, 0, width, height);
  map.replaceChildren(...tiles.map((tile) => {
    const box = node(tile.coin ? "a" : "div", `hm-tile ${tile.change === null ? "" : tile.change >= 0 ? "up" : "down"}`);
    if (tile.coin) box.href = coinUrl(tile.coin);
    Object.assign(box.style, { left: `${tile.x}px`, top: `${tile.y}px`, width: `${tile.width}px`, height: `${tile.height}px` });
    box.style.setProperty("--heat", tile.change === null ? "0" : Math.min(1, 0.18 + Math.abs(tile.change) / full).toFixed(2));
    const area = tile.width * tile.height;
    // The type grows with the tile; the smallest show the ticker only, the tiniest nothing.
    const size = Math.max(9, Math.min(34, Math.sqrt(area) / 5.2));
    box.style.fontSize = `${size}px`;
    if (tile.width > 34 && tile.height > 20) {
      if (tile.width > 80 && tile.height > 80 && tile.image) box.append(Object.assign(node("img", "hm-logo"), { src: tile.image, alt: "", loading: "lazy" }));
      box.append(node("b", "", tile.symbol));
      if (tile.height > 38) box.append(node("span", "", percent(tile.change)));
    }
    box.addEventListener("pointerenter", () => showTip(tile, box));
    box.addEventListener("pointerleave", () => { $("#tip").hidden = true; });
    return box;
  }));
}
function showTip(tile, box) {
  const tip = $("#tip");
  tip.replaceChildren(node("b", "", `${tile.name} · ${tile.symbol}`), node("span", "", `${t().price}: ${price(tile.price)}`),
    node("span", tile.change === null ? "" : tile.change >= 0 ? "up" : "down", percent(tile.change)),
    node("span", "muted", `${state.source === "spot" ? t().cap : t().volume}: ${big(tile.size)}`));
  tip.hidden = false;
  const rect = box.getBoundingClientRect();
  const page = $("#map").getBoundingClientRect();
  tip.style.left = `${Math.min(page.width - 200, Math.max(0, rect.left - page.left + rect.width / 2 - 100))}px`;
  tip.style.top = `${rect.top - page.top + $("#map").offsetTop + Math.min(rect.height, 40)}px`;
}

let futuresLoading = false;
async function loadFutures() {
  if (futuresLoading) return;
  futuresLoading = true;
  const answer = await fetch("/market/screener").then((response) => (response.ok ? response.json() : null)).catch(() => null);
  futuresLoading = false;
  if (answer?.rows) futures = answer.rows;
  render();
}

$("#stables").addEventListener("click", () => { state.stables = !state.stables; render(); });
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
let resizeTimer = 0;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
setupSearch({});
setupPage({ en, render });
void marketOverview().then((overview) => {
  spot = overview?.coins ?? [];
  coins = new Map(spot.map((coin) => [coin.symbol.toUpperCase(), coin]));
  render();
});
setInterval(() => {
  if (document.hidden) return;
  if (state.source === "futures") void loadFutures();
  else void marketOverview().then((overview) => { if (overview?.coins) { spot = overview.coins; render(); } });
}, 60_000);
