// nircoin.com: the clique sky, live test-network numbers and RU/EN.
// Live numbers come from the shared test network through /api on the same
// host, so the page needs no cross-origin access.

const en = {
  navIdea: "Idea", navStart: "Start", navEconomy: "Economy", navRoadmap: "Roadmap",
  pill: "Test network is live",
  heroTitle: "The coin you mine with your&nbsp;mind",
  heroLead: "NIR is an open blockchain where new coins appear for solved problems, not for burned electricity. The smarter programs and AI become, the harder the problems get — and the more every solution is worth.",
  ctaInstall: "Install on Mac", ctaHow: "How it works", ctaCode: "Open source on GitHub",
  liveBlock: "Block", liveLevel: "Task difficulty", liveNetwork: "Network", liveSupply: "Total supply",
  ideaEyebrow: "Idea", ideaTitle: "Work that means something",
  ideaLead: "Bitcoin proved money can live without banks. But its mining is guessing numbers: it burns energy and produces nothing else. NIR is mined by solving real problems: hard to find, instant to check.",
  c1Title: "Mining by solving", c1Text: "The network makes up a puzzle by itself — a web of dots and lines. Your Mac looks for a group of dots where every one is linked to every other. Whoever finds it first earns NIR.",
  c2Title: "Harder as AI grows", c2Text: "When puzzles get solved too fast, the network makes them harder. Mining grows with the intelligence of programs and turns AI progress into the coin's scarcity.",
  c3Title: "Safe from quantum computers", c3Text: "NIR signs with ML-DSA, the post-quantum cryptography standard. Keys stay secure even when quantum computers arrive.",
  c4Title: "Names instead of addresses", c4Text: "Instead of a long nir1… address — a short name like sasha.nir. The name fee is burned: nobody receives it, and fewer coins remain.",
  c5Title: "Your keys stay yours", c5Text: "24 words on paper restore all your accounts. The wallet checks your balance itself from the network's signatures instead of trusting a server.",
  c6Title: "A network without an owner", c6Text: "The code is open. Issuance rules live in the protocol: not even the founder can create an extra coin or take someone else's.",
  startEyebrow: "Start", startTitle: "Three steps to your first coin",
  s1Title: "Install on your Mac", s1Text: "Open Terminal (⌘ + Space, type “Terminal”), paste the command and press Enter. The apps are built right on your Mac from the open source code.",
  copy: "Copy", copied: "Copied",
  s1Hint: "Needs macOS 13 or newer. Installation takes 5–20 minutes. You can read exactly what the command does in install.sh on GitHub.",
  s2Title: "Create a wallet", s2Text: "NIR Wallet shows 24 words. Write them on paper and show them to nobody — they are the key to all your coins.",
  s3Title: "Start mining", s3Text: "In NIR Miner press “Connect NIR Wallet” and “Start mining”. Rewards go straight to your wallet.",
  economyEyebrow: "Economy", economyTitle: "21 million. Not one coin more",
  eMining: "to miners — only for solved problems. 44 NIR about every 10 minutes, halving roughly every 4 years.",
  eFounder: "to the founder — 1% at launch, the rest opens evenly over 10 years. No cut of mining rewards or fees.",
  eFund: "to the community fund — for developers, testers and grants. Also opens over 10 years.",
  roadmapEyebrow: "Roadmap", roadmapTitle: "Step by step to real money",
  roadmapLead: "Each stage opens when its checks pass, not when a date arrives. That is how networks people can trust with money are built.",
  rDone: "Done", rNow: "Now", rNext: "Next", rLater: "Later", rGoal: "Goal",
  r1Title: "Protocol and apps", r1Text: "Consensus with fast block finality, mining by solving, post-quantum signatures, .nir names, NIR Wallet and NIR Miner for Mac.",
  r2Title: "Shared test network", r2Text: "One network for every miner: testnet.nircoin.com. One-command install. Gathering the first testers and their feedback.",
  r3Title: "Public test network", r3Text: "Four validators run by independent people in different countries, a block explorer, an internal security review.",
  r4Title: "Incentivized test network", r4Text: "Testing mining economics with real people, rewards for found vulnerabilities, stable app releases.",
  r5Title: "Main network", r5Text: "Independent audits, legal review, an open ceremony for the first block. NIR starts to be worth money.",
  honestTitle: "Honestly",
  honestText: "Right now this is a test network. Its coins are worth nothing and the network may be reset. NIR sells no coins and promises investors nothing: the only way to get NIR is to mine it. Never send anyone your 24 words, and do not trust anyone offering to “sell you NIR”.",
  finalTitle: "Be among the first", finalText: "The network's first miners are the people who find bugs, suggest ideas and build it with us.",
  footerDocs: "Documentation",
};

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

// Live numbers from the shared test network.
async function refreshLive() {
  try {
    const [health, mining] = await Promise.all([
      fetch("/api/health", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/v1/proof-mining", { cache: "no-store" }).then((response) => response.json()),
    ]);
    document.querySelector("#live-height").textContent = Number(health.height).toLocaleString("ru-RU");
    document.querySelector("#live-network").textContent = health.networkId === "nir-shared-testnet-1"
      ? (language === "en" ? "testnet" : "тестовая") : "—";
    document.querySelector("#live-level").textContent = String(mining.level ?? "—");
  } catch { /* The page works without live numbers. */ }
}
void refreshLive();
setInterval(refreshLive, 15_000);

// The sky: a web of dots; now and then a clique lights up, as in NIR Miner.
const canvas = document.querySelector("#sky");
const context = canvas.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  points = Array.from({ length: count }, (_, i) => ({
    x: width * (0.35 + 0.65 * Math.random()), y: height * Math.random(),
    vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12, phase: i,
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
  const near = points.map((point, index) => ({ index, distance: Math.hypot(point.x - points[start].x, point.y - points[start].y) }))
    .sort((a, b) => a.distance - b.distance).slice(0, 6).map(({ index }) => index);
  clique = near;
  litAt = performance.now();
}
function frame(time) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);
  for (const point of points) {
    if (!reduced) {
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
