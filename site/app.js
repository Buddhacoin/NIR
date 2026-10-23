// nircoin.com: the clique sky, live network numbers, RU/EN and day/night.
// Live numbers come from the shared test network through /api on the same
// host, so the page needs no cross-origin access.

const en = {
  navIdea: "Idea", navPioneers: "Pioneers", navApps: "Apps", navEconomy: "Economy", navRoadmap: "Roadmap",
  ctaShort: "Start mining", tag: "Early access · the network is open",
  h1a: "Bitcoin was mined with graphics cards.", h1b: "NIR is mined with", h1c: "intelligence.",
  lead: "The first blockchain where every coin is born from a solved problem. No farms, no noise, no power bills — your computer, one button, and problems that get harder as artificial intelligence grows.",
  ctaMine: "⚡ Start mining for free", ctaHow: "▶ How it works",
  platforms: "<b>macOS</b> — available now · Windows and Linux — soon",
  fFound: "Solution found", fLevel: "Task difficulty", fProtect: "Protection", fQuantum: "Post-quantum 🔒",
  tLive: "Network is live", tBlock: "Block", tLevel: "Difficulty", tSupply: "Total ever", tHardware: "Hardware",
  tSales: "Presales", tOnly: "mining only",
  whyEyebrow: "Why it is different", whyTitle: "Mining that doesn't burn the planet",
  whyLead: "Bitcoin spends the electricity of whole countries guessing random numbers. NIR spends it on solving problems: hard to find, instant to check. The smarter programs and AI become, the harder the problems get — turning the progress of intelligence into the coin's scarcity.",
  oldTitle: "Old mining", old1: "Graphics card farms worth thousands", old2: "Noise, heat and huge power bills",
  old3: "Pointless number guessing", old4: "The early days are long gone",
  new1: "An ordinary computer and one button", new2: "Runs quietly in the background",
  new3: "Solving real problems", new4: "The network just opened — you are at the very start",
  pEyebrow: "Pioneer program", pTitle: "Mine now — receive real NIR at launch",
  pLead: "In 2009 bitcoin was mined on home computers. NIR is at that same point today. 210,000 NIR — 1% of all coins — are set aside for those who mine on the test network. When the main network launches, they are shared among pioneers by what each has earned.",
  p1: "<b>1 NIR mined now = 1 pioneer point.</b> Faucet coins and transfers don't count — only solved problems.",
  p2: "<b>Points don't expire,</b> even if the test network is restarted.",
  p3: "<b>The reward arrives at the same address.</b> Keep your 24 words.",
  pCta: "⚡ Become a pioneer", poolText: "pioneer pool · 1% of all coins",
  privEyebrow: "Privacy", privTitle: "Your money is your business",
  privLead: "No sign-up, no passport, no email. Your address is not tied to your name. And coming next — fully invisible transfers: nobody sees the sender, the receiver or the amount. If you want, you show them to your accountant with a viewing key.",
  ch1: "✓ No sign-up", ch2: "✓ No passport", ch3: "✓ Only you hold the keys",
  ch4: "◐ Shielded transfers — soon", ch5: "◐ Viewing key for reporting — soon",
  mFrom: "from", mTo: "to", mSum: "amount", mStatus: "status", mOk: "✓ confirmed by the network",
  appsEyebrow: "Apps", appsTitle: "Everything you need. Nothing you don't.",
  wSub: "A safe for the money of the future",
  w1: "<b>◈</b>Protected from quantum computers", w2: "<b>@</b>A name instead of an address: athena.nir",
  w3: "<b>✓</b>Checks every balance itself", w4: "<b>★</b>Soon: BTC, ETH and swaps inside",
  uiBalance: "Total balance", uiVerified: "✓ Confirmed by network signatures", uiReceive: "Receive", uiSend: "Send",
  uiMine: "Mining", uiMining: "● Mining is running", uiToday: "Today: +132.00 NIR", uiReward: "Reward for a solution",
  mTitle: "NIR Miner", mSub: "One button and you are mining",
  m1: "<b>✦</b>No graphics cards, no settings", m2: "<b>↯</b>Rewards straight to your wallet",
  m3: "<b>◎</b>Watch the solution being found", m4: "<b>★</b>Soon: miner leaderboard",
  uiMiner: "NIR MINER", uiFound: "&gt;_ Clique found! +44 NIR", uiInWallet: "IN WALLET", uiSolved: "SOLVED",
  uiLevel: "LEVEL", uiChecked: "CHECKED", uiStop: "STOP",
  startEyebrow: "Start", startTitle: "From zero to your first coin in 15 minutes",
  s1Title: "One command",
  s1Text: "Open Terminal (⌘ + Space → “Terminal”), paste the command and press Enter. NIR is built right on your Mac from the open source code.",
  copy: "Copy", copied: "Copied", s1Hint: "macOS 13 or newer · Windows and Linux — soon",
  s2Title: "24 words — your safe", s2Text: "NIR Wallet shows 24 words. Write them on paper: they are the key to all your coins and to your pioneer reward.",
  s3Title: "One button and you are mining", s3Text: "In NIR Miner press “Connect NIR Wallet” and “Start mining”. Claim your name.nir while it is free.",
  eCap: "and not a coin more", economyEyebrow: "Economy", economyTitle: "A hard cap. A fair split.",
  eMining: "to miners — only for work. 44 NIR about every 10 minutes, halving roughly every 4 years.",
  eFounder: "to the founder — unlocks over 10 years: the founder gains from the network's success, not a quick sale.",
  eFund: "to the community fund — for developers, testers and grants.",
  ePioneer: "to test network pioneers — by what each has earned.",
  eNote: "No presales, no hidden wallets, no printing press: every rule is written in open code.",
  roadmapEyebrow: "Roadmap", roadmapTitle: "The story of NIR in seven chapters",
  ch1n: "Chapter I", ch1t: "Spark", ch1p: "Protocol, post-quantum signatures, .nir names, wallet and miner",
  ch2n: "Chapter II", ch2t: "Awakening", ch2p: "The network opens, first miners, the pioneer program", now: "NOW",
  ch3n: "Chapter III", ch3t: "Borderless", ch3p: "Nodes around the world, Windows and Linux, block explorer, miner leaderboard",
  ch4n: "Chapter IV", ch4t: "Trial", ch4p: "Bug bounties with rewards, independent audits",
  ch5n: "Chapter V", ch5t: "Genesis", ch5p: "The main network. NIR become real coins, pioneers receive their reward",
  ch6n: "Chapter VI", ch6t: "Invisible", ch6p: "Shielded transfers and a multi-wallet: BTC, ETH, stablecoins",
  ch7n: "Chapter VII", ch7t: "The intelligence economy", ch7p: "AI agents and programs pay each other in NIR for computing and verification",
  finalA: "History is being written now.", finalB: "Write your name into it.",
  finalText: "Claim your name.nir before others and become one of the first miners of a new network.",
  ctaShort2: "⚡ Start mining", ctaCode: "Open source on GitHub",
  footerPioneers: "Pioneer rules", footerDocs: "Documentation",
  legal: "A test network runs today: apps and rules are tested on it before the main network launches. Test network coins are not sold or exchanged. NIR runs no token sales and promises no price. Never tell anyone your 24 words.",
};

// The ticker scrolls forever: a second copy follows the first.
const track = document.querySelector(".ticker-track");
for (const item of [...track.children]) {
  const copy = item.cloneNode(true);
  copy.setAttribute("aria-hidden", "true");
  track.append(copy);
}

const nodes = [...document.querySelectorAll("[data-i18n]")];
const ru = Object.fromEntries(nodes.map((node) => [node.dataset.i18n, node.innerHTML]));
let language = "ru";
function setLanguage(next) {
  language = next;
  document.documentElement.lang = next;
  for (const node of nodes) node.innerHTML = (next === "en" ? en : ru)[node.dataset.i18n] ?? node.innerHTML;
  const button = document.querySelector("#lang");
  button.textContent = next === "en" ? "RU" : "EN";
  button.setAttribute("aria-label", next === "en" ? "Переключить на русский" : "Switch to English");
  try { localStorage.setItem("nir-site-language", next); } catch {}
}
document.querySelector("#lang").addEventListener("click", () => {
  setLanguage(language === "en" ? "ru" : "en");
  renderTheme();
});
let saved = null;
try { saved = localStorage.getItem("nir-site-language"); } catch {}
if (saved === "en" || (!saved && !/^ru|^be|^uk|^kk/i.test(navigator.language || ""))) setLanguage("en");

// Day and night: the system's choice until the visitor picks one.
const themeButton = document.querySelector("#theme");
const isLight = () => document.documentElement.dataset.theme === "light" ||
  (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: light)").matches);
function renderTheme() {
  themeButton.textContent = isLight() ? "☾" : "☀︎";
  themeButton.setAttribute("aria-label", isLight() ? (language === "en" ? "Night theme" : "Ночная тема")
    : (language === "en" ? "Day theme" : "Дневная тема"));
}
themeButton.addEventListener("click", () => {
  const next = isLight() ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("nir-site-theme", next); } catch {}
  renderTheme();
});
matchMedia("(prefers-color-scheme: light)").addEventListener("change", renderTheme);
renderTheme();

document.querySelector("#copy").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(document.querySelector("#install-command").textContent);
    button.textContent = language === "en" ? en.copied : "Скопировано";
    setTimeout(() => { button.textContent = language === "en" ? en.copy : ru.copy; }, 2000);
  } catch {
    getSelection().selectAllChildren(document.querySelector("#install-command"));
  }
});

// Sections rise into view as the visitor scrolls.
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduced && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { entry.target.classList.add("shown"); observer.unobserve(entry.target); }
    }
  }, { threshold: 0.12 });
  for (const element of document.querySelectorAll("section.s .wrap > *")) {
    element.classList.add("reveal");
    observer.observe(element);
  }
}

// Live numbers from the shared test network.
const live = (name, value) => { for (const node of document.querySelectorAll(`[data-live="${name}"]`)) node.textContent = value; };
async function refreshLive() {
  try {
    const [health, mining] = await Promise.all([
      fetch("/api/health", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/v1/proof-mining", { cache: "no-store" }).then((response) => response.json()),
    ]);
    if (Number.isSafeInteger(health.height)) live("height", health.height.toLocaleString("ru-RU"));
    if (mining.level !== undefined) live("level", String(mining.level));
  } catch { /* The page works without live numbers. */ }
}
void refreshLive();
setInterval(refreshLive, 15_000);

// The sky: a web of dots; now and then a clique lights up, as in NIR Miner.
const canvas = document.querySelector("#sky");
const context = canvas.getContext("2d");
let points = [];
let edges = [];
let clique = [];
let litAt = 0;
function layout() {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const count = width < 700 ? 40 : 90;
  points = Array.from({ length: count }, () => ({
    x: width * (0.35 + 0.65 * Math.random()), y: height * Math.random(),
    vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12,
  }));
  // Each dot links to its nearest neighbours, so the web looks like a graph.
  const linked = new Set();
  edges = [];
  for (let i = 0; i < count; i++) {
    const nearest = points.map((point, j) => ({ j, d: Math.hypot(point.x - points[i].x, point.y - points[i].y) }))
      .filter(({ j }) => j !== i).sort((a, b) => a.d - b.d).slice(0, 4);
    for (const { j } of nearest) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!linked.has(key)) { linked.add(key); edges.push([Math.min(i, j), Math.max(i, j)]); }
    }
  }
}
function pickClique() {
  const start = Math.floor(Math.random() * points.length);
  clique = points.map((point, index) => ({ index, distance: Math.hypot(point.x - points[start].x, point.y - points[start].y) }))
    .sort((a, b) => a.distance - b.distance).slice(0, 6).map(({ index }) => index);
  litAt = performance.now();
}
function frame(time) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);
  if (!reduced) {
    for (const point of points) {
      point.x += point.vx; point.y += point.vy;
      if (point.x < width * 0.3 || point.x > width) point.vx *= -1;
      if (point.y < 0 || point.y > height) point.vy *= -1;
    }
  }
  const style = getComputedStyle(document.documentElement);
  const color = (name) => style.getPropertyValue(name).trim();
  context.lineWidth = 1;
  context.strokeStyle = color("--sky-line");
  for (const [a, b] of edges) {
    context.beginPath(); context.moveTo(points[a].x, points[a].y); context.lineTo(points[b].x, points[b].y); context.stroke();
  }
  if (time - litAt > 3600) pickClique();
  const glow = Math.max(0, 1 - Math.abs((time - litAt) - 1200) / 1600);
  if (glow > 0) {
    context.globalAlpha = 0.9 * glow;
    context.strokeStyle = color("--sky-lit");
    context.shadowColor = color("--sky-lit");
    context.shadowBlur = 12 * glow;
    context.lineWidth = 1.4;
    for (let i = 0; i < clique.length; i++) {
      for (let j = i + 1; j < clique.length; j++) {
        const a = points[clique[i]];
        const b = points[clique[j]];
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
    }
    context.shadowBlur = 0;
    context.globalAlpha = 1;
  }
  for (const [index, point] of points.entries()) {
    const lit = glow > 0 && clique.includes(index);
    context.fillStyle = lit ? color("--sky-lit") : color("--sky-dot");
    context.fillRect(point.x - (lit ? 2.5 : 1.5), point.y - (lit ? 2.5 : 1.5), lit ? 5 : 3, lit ? 5 : 3);
  }
  if (!reduced) requestAnimationFrame(frame);
}
layout();
pickClique();
addEventListener("resize", layout);
requestAnimationFrame(frame);
