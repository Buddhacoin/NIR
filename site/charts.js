// The market overview, /charts/: totals, the fear & greed index with a year of
// history, and BTC/ETH dominance with the largest coins' shares. The cards and
// the market strip on every page link here. Shared helpers are in common.js.

const en = {
  docTitle: "Market overview — NIR Markets",
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  title: "Market overview", cap: "Market cap", volume: "24h volume", coins: "Coins tracked", exchanges: "Exchanges",
  fearTitle: "Fear & Greed Index", domTitle: "Dominance",
  fearAbout: "From 0 to 100, the index shows the market's mood: near 0 is extreme fear (people sell), near 100 extreme greed (people buy). Source: alternative.me, updated daily.",
  domAbout: "A coin's share of the whole market's capitalisation. Bitcoin dominance rises when money moves from altcoins into BTC.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { fear: { "Extreme Fear": "Сильный страх", Fear: "Страх", Neutral: "Нейтрально", Greed: "Жадность", "Extreme Greed": "Сильная жадность" },
    now: "Сейчас", yesterday: "Вчера", week: "Неделю назад", month: "Месяц назад", high: "Максимум за год", low: "Минимум за год",
    others: "Остальные" },
  en: { fear: {}, now: "Now", yesterday: "Yesterday", week: "Last week", month: "Last month", high: "Yearly high", low: "Yearly low",
    others: "Others" },
};
let market = null;
let history = [];
const t = () => words[language];
const fearLabel = (entry) => t().fear[entry.label] ?? entry.label;
const day = (time) => new Date(time).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });

function renderTotals() {
  const g = market?.global;
  if (!g) return;
  $("#o-cap").textContent = big(g.marketCap, "$", 2);
  $("#o-cap-change").className = changeClass(g.marketCapChange24h);
  $("#o-cap-change").textContent = percentText(g.marketCapChange24h);
  $("#o-volume").textContent = big(g.volume, "$", 2);
  $("#o-coins").textContent = Number.isFinite(g.coins) ? g.coins.toLocaleString(locale()) : "—";
  $("#o-exchanges").textContent = Number.isFinite(g.exchanges) ? g.exchanges.toLocaleString(locale()) : "—";
}

function renderFear() {
  const now = market?.fearGreed ?? history.at(-1);
  if (now) {
    $("#fg-value").textContent = String(now.value);
    $("#fg-label").textContent = fearLabel(now);
    const angle = Math.PI * (1 - now.value / 100);
    $("#fg-dot").setAttribute("cx", (55 + 47 * Math.cos(angle)).toFixed(1));
    $("#fg-dot").setAttribute("cy", (56 - 47 * Math.sin(angle)).toFixed(1));
  }
  const back = (days) => history.at(-1 - days);
  const year = history.slice(-365);
  const high = year.reduce((best, entry) => (!best || entry.value > best.value ? entry : best), null);
  const low = year.reduce((best, entry) => (!best || entry.value < best.value ? entry : best), null);
  const rows = [[t().yesterday, back(1)], [t().week, back(7)], [t().month, back(30)], [t().high, high, true], [t().low, low, true]]
    .filter(([, entry]) => entry)
    .map(([title, entry, dated]) => {
      const row = document.createElement("div");
      row.append(Object.assign(document.createElement("small"), { textContent: dated ? `${title} · ${day(entry.time)}` : title }),
        Object.assign(document.createElement("b"), { textContent: `${entry.value} · ${fearLabel(entry)}` }));
      return row;
    });
  $("#fg-past").replaceChildren(...rows);
  drawHistory();
}

// A year of the index as a line over coloured fear and greed bands.
function drawHistory() {
  const box = $("#fg-chart");
  if (history.length < 2) return box.replaceChildren();
  const width = 1000;
  const height = 240;
  const x = (index) => index / (history.length - 1) * width;
  const y = (value) => 10 + (100 - value) / 100 * (height - 20);
  const line = history.map((entry, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(entry.value).toFixed(1)}`).join("");
  const band = (from, to, color) => `<rect x="0" y="${y(to)}" width="${width}" height="${y(from) - y(to)}" fill="${color}" opacity=".08"/>`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = band(0, 25, "#ea3943") + band(25, 45, "#f3a12f") + band(45, 55, "#f3d42f") + band(55, 75, "#9bd54a") + band(75, 100, "#16c784") +
    `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  const label = (className, text) => Object.assign(document.createElement("span"), { className, textContent: text });
  box.replaceChildren(svg, label("axis high", "100"), Object.assign(label("axis low", "0"), { style: "bottom:4px" }),
    label("axis start", day(history[0].time)), label("axis end", day(history.at(-1).time)));
}

function renderDominance() {
  const g = market?.global;
  if (!g?.marketCap) return;
  const colors = ["#f7931a", "#627eea", "#26a17b", "#8b7bff", "#f3ba2f", "#2ee6a6", "#ea3943", "#3861fb"];
  const shares = (market.coins ?? []).slice(0, 7).map((coin) => ({ name: coin.symbol, share: (coin.marketCap ?? 0) / g.marketCap * 100 }));
  const rest = Math.max(0, 100 - shares.reduce((sum, item) => sum + item.share, 0));
  const parts = [...shares, { name: t().others, share: rest }];
  $("#dom-bar").replaceChildren(...parts.map((part, index) => {
    const piece = document.createElement("i");
    piece.style.cssText = `width:${part.share.toFixed(2)}%;background:${index < shares.length ? colors[index] : "var(--line)"}`;
    piece.title = `${part.name} ${part.share.toFixed(1)}%`;
    return piece;
  }));
  $("#dom-legend").replaceChildren(...parts.map((part, index) => {
    const item = document.createElement("span");
    const dot = Object.assign(document.createElement("i"), { style: `background:${index < shares.length ? colors[index] : "var(--line)"}` });
    item.append(dot, Object.assign(document.createElement("b"), { textContent: part.name }),
      ` ${part.share.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`);
    return item;
  }));
}

function render() {
  renderTotals();
  renderFear();
  renderDominance();
}

$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});
setupSearch({ overview: () => market });
setupPage({ en, render, onTheme: drawHistory });
fetch("/market/overview").then((response) => (response.ok ? response.json() : null)).then((data) => { market = data; render(); }).catch(() => {});
fetch("/market/fear-greed").then((response) => (response.ok ? response.json() : null)).then((data) => { history = data?.history ?? []; render(); }).catch(() => {});
// Opening /charts/#fear-greed scrolls once the content is drawn.
if (location.hash) setTimeout(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(), 600);
