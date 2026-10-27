// The market heatmap, /screener/heatmap/: every coin a tile, sized by market cap (the top coins from
// marketOverview) or by day volume (the futures coins of /market/screener), and coloured by its price change
// over the chosen period. Tiles are laid out as a squarified treemap; a tile opens the coin's page, and on a
// pointer it shows the coin's figures. Shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  tabTrends: "Trends", tabDensities: "Order book walls", tabBook: "Order book", tabArbitrage: "Arbitrage", tabLiquidations: "Liquidations", tabListings: "Listings", tabHeatmap: "Heatmap",
  title: "Heatmap",
  source: "A tile's size is the coin's market cap (for futures, its day's trading volume); its colour is the price change over the chosen period: the brighter, the stronger. Data: CoinGecko (spot) and the open futures markets of six exchanges.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  howItWorks: "How it works", privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
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
  draw(list, full);
}
// Zoom (the wheel, a pinch or the buttons) and drag: the map is laid out again at the zoomed size, so a small
// coin's tile grows big enough for its name and change, and only the part in view is drawn.
const view = { zoom: 1, x: 0, y: 0 };
let last = null;
function draw(list = last?.list, full = last?.full) {
  if (!list) return;
  last = { list, full };
  const map = $("#map");
  // A square root keeps the biggest coin from taking the whole map, so the rest stay readable.
  const width = map.clientWidth;
  const height = Math.round(width < 600 ? width * 1.7 : Math.min(760, width * 0.56));
  map.style.height = `${height}px`;
  view.x = Math.max(0, Math.min(view.x, width * view.zoom - width));
  view.y = Math.max(0, Math.min(view.y, height * view.zoom - height));
  map.classList.toggle("zoomed", view.zoom > 1);
  $("#zoom-reset").hidden = view.zoom === 1;
  const tiles = squarify(list.map((item) => ({ ...item, weight: Math.sqrt(item.size) })).sort((left, right) => right.weight - left.weight),
    -view.x, -view.y, width * view.zoom, height * view.zoom).filter((tile) => tile.x < width && tile.y < height && tile.x + tile.width > 0 && tile.y + tile.height > 0)
    // Each tile cut to the part in view, so its name sits in the middle of what is seen.
    .map((tile) => {
      const x = Math.max(0, tile.x);
      const y = Math.max(0, tile.y);
      return { ...tile, x, y, width: Math.min(width, tile.x + tile.width) - x, height: Math.min(height, tile.y + tile.height) - y };
    });
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
    box.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse" && !drag) showTip(tile, box); });
    box.addEventListener("pointerleave", () => { $("#tip").hidden = true; });
    return box;
  }));
}
// Zoom to `zoom`, keeping the point (x, y) of the map (from its top left corner) where it is.
function zoomTo(zoom, x = $("#map").clientWidth / 2, y = $("#map").clientHeight / 2) {
  const next = Math.max(1, Math.min(8, zoom));
  view.x = (view.x + x) / view.zoom * next - x;
  view.y = (view.y + y) / view.zoom * next - y;
  view.zoom = next;
  $("#tip").hidden = true;
  draw();
}
const mapBox = $("#map");
mapBox.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = mapBox.getBoundingClientRect();
  zoomTo(view.zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.008 : 0.0012)), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });
// Dragging moves a zoomed map; two fingers zoom. A drag is not a click on a tile.
const pointers = new Map();
let drag = null;
let dragged = false;
mapBox.addEventListener("pointerdown", (event) => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) { drag = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y }; dragged = false; }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { pinch: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
  }
});
mapBox.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId) || !drag) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const rect = mapBox.getBoundingClientRect();
  if (pointers.size === 2 && drag.pinch) {
    const [a, b] = [...pointers.values()];
    dragged = true;
    zoomTo(drag.zoom * Math.hypot(a.x - b.x, a.y - b.y) / drag.pinch, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
    return;
  }
  if (view.zoom === 1 || drag.pinch) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!dragged && Math.hypot(dx, dy) < 5) return;
  if (!dragged) mapBox.setPointerCapture(event.pointerId);
  dragged = true;
  $("#tip").hidden = true;
  view.x = drag.viewX - dx;
  view.y = drag.viewY - dy;
  draw();
});
const release = (event) => {
  pointers.delete(event.pointerId);
  if (!pointers.size) drag = null;
};
mapBox.addEventListener("pointerup", release);
mapBox.addEventListener("pointercancel", release);
mapBox.addEventListener("click", (event) => { if (dragged) { event.preventDefault(); event.stopPropagation(); dragged = false; } }, true);
$("#zoom-in").addEventListener("click", () => zoomTo(view.zoom * 1.6));
$("#zoom-out").addEventListener("click", () => zoomTo(view.zoom / 1.6));
$("#zoom-reset").addEventListener("click", () => { view.zoom = 1; view.x = 0; view.y = 0; draw(); });
function showTip(tile, box) {
  const tip = $("#tip");
  tip.replaceChildren(node("b", "", `${tile.name} · ${tile.symbol}`), node("span", "", `${t().price}: ${price(tile.price)}`),
    node("span", tile.change === null ? "" : tile.change >= 0 ? "up" : "down", percent(tile.change)),
    node("span", "muted", `${state.source === "spot" ? t().cap : t().volume}: ${big(tile.size)}`));
  tip.hidden = false;
  const rect = box.getBoundingClientRect();
  const page = $("#map").getBoundingClientRect();
  tip.style.left = `${Math.min(page.width - 200, Math.max(0, rect.left - page.left + rect.width / 2 - 100))}px`;
  tip.style.top = `${rect.top - page.top + Math.min(rect.height, 40)}px`;
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
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { view.zoom = 1; view.x = 0; view.y = 0; render(); }, 150); });
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
