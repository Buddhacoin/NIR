// The wallet visualizer, /visualizer/?address=<address>, in the manner of the analytics sites: the wallet in
// the middle and, around it, the wallets it exchanged coins with, drawn as bubbles (the open name's logo when
// there is one). A green line: coins came to the wallet; red: they left it; the thicker, the more dollars.
// Bubbles can be dragged, the picture panned and zoomed (two fingers on a phone); a bubble opens a card that
// expands that wallet's own links in place or opens its page. Filters: how many links, by sum or by time, the
// smallest sum and the networks. Transfers come from /market/chain (market-chain.mjs); shared helpers are in common.js.

const en = {
  stCoins: "Coins:", stExchanges: "Exchanges:", stCap: "Market cap:", stVolume: "24h volume:", stDominance: "Dominance:",
  stFear: "Fear & Greed:", stNir: "NIR network: miners", stMined: "mined",
  navCoins: "Cryptocurrencies", navCharts: "Market overview", navScreener: "Screeners", navPortfolio: "Portfolio", navNir: "About NIR", search: "Search coins or addresses",
  vizTitle: "Visualizer", vizLoading: "Loading transfers…",
  vizNote: "A green line: coins came to the wallet; red: they left it; the thicker the line, the larger the sum. Bubbles can be dragged; tap a bubble to expand its links or open the wallet.",
  barMarkets: "Markets", barMine: "Mining", tabWatch: "Watchlist", dataBy: "Data:", notAdvice: "Not financial advice",
  privacy: "Privacy", terms: "Terms", aboutNir: "About the NIR blockchain →",
};
const words = {
  ru: { limit: (count) => `Связей: ${count}`, byUsd: "По сумме", byTime: "По времени", min: (value) => (value ? `$ ≥ ${money(value)}` : "Любая сумма"),
    allChains: "Все сети", missing: "Это не адрес кошелька.", none: "Переводов не найдено.", failed: "Обозреватель сейчас не отвечает. Попробуйте через минуту.",
    loadingMore: "Загружаю связи…", received: "Получено", sent: "Отправлено", transfers: "Переводов", last: "Последний",
    expand: "Раскрыть связи", collapse: "Свернуть связи", open: "Открыть кошелёк", center: "Сделать центром", title: (name) => `${name} — связи кошелька на NIR Markets` },
  en: { limit: (count) => `Limit ${count}`, byUsd: "By sum", byTime: "By time", min: (value) => (value ? `USD ≥ ${money(value)}` : "Any sum"),
    allChains: "All networks", missing: "This is not a wallet address.", none: "No transfers found.", failed: "The explorer is not answering now. Try again in a minute.",
    loadingMore: "Loading links…", received: "Received", sent: "Sent", transfers: "Transfers", last: "Last",
    expand: "Expand links", collapse: "Collapse links", open: "Open wallet", center: "Make it the centre", title: (name) => `${name} — wallet links on NIR Markets` },
};
const t = () => words[language === "en" ? "en" : "ru"];
const LIMITS = [25, 50, 100];
const MINIMUMS = [0, 1, 100, 1_000, 10_000, 100_000];
const ZERO = /^0x0{40}$/i;
const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attributes = {}) => { const item = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value); return item; };
const node = (tag, className = "", text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
function money(value) {
  const abs = Math.abs(value);
  if (abs >= 1e6) return big(value, "$", 1);
  if (abs >= 1e3) return `$${(value / 1e3).toLocaleString(locale(), { maximumFractionDigits: 1 })}${language === "en" ? "K" : " тыс"}`;
  return `$${value.toLocaleString(locale(), { maximumFractionDigits: value < 10 ? 2 : 0 })}`;
}

const root = new URLSearchParams(location.search).get("address")?.trim() ?? "";
const utxo = /^(?:bc1|[13])/.test(root);
const lower = (address) => String(address ?? "").toLowerCase();
const filters = { limit: 25, order: "usd", min: 1, chain: "all" };
let chains = []; // networks the root wallet is active on
let rootInfo = null;
const ledger = new Map(); // transfer id → transfer, every wallet's loaded so far
const parties = new Map(); // lower-case address → { address, name, logo }
const expanded = []; // lower-case addresses whose links are drawn, the root first
const loading = new Set();
const pos = new Map(); // lower-case address → { x, y, vx, vy, fixed }
let shown = { nodes: [], edges: [] };
let selected = null;
let failure = "";
let touched = false; // the visitor moved the picture: it no longer fits itself to the bubbles
let fitted = false; // the picture was fitted once this layout settled

// --- Data: a wallet's transfers on the networks, a few pages each.
// The wallet's links from NIR Markets' own store of transfers (one request, at once); while the server
// is still reading the wallet's older pages, asked again every few seconds. Without the store, the
// wallet's transfer pages are read network by network.
async function loadWallet(address, pages, round = 0) {
  const key = lower(address);
  loading.add(key);
  if (!round) render();
  const answer = await fetch(`/market/chain/address/${encodeURIComponent(address)}/links`).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  if (!answer) { await loadPages(address, pages); return; }
  for (const party of answer.parties) {
    const known = parties.get(party.address);
    parties.set(party.address, { ...known, address: known?.address ?? party.address, name: party.name ?? known?.name ?? knownName(party.address), logo: party.logo ?? known?.logo });
  }
  for (const [time, chain, other, incoming, usd] of answer.rows) {
    const them = answer.parties[other].address;
    const [from, to] = incoming ? [them, key] : [key, them];
    // The same transfer comes from both wallets' lists: one key for it.
    ledger.set(`${chain}:${time}:${from}:${to}:${usd}`, { chain, time, usd, from: { address: from }, to: { address: to } });
  }
  if (!utxo) chains = [...new Set([...chains, ...answer.rows.map((row) => row[1])])].filter((chain) => CHAINS[chain] && chain !== "btc");
  if (!answer.rows.length && key === lower(root) && !answer.crawling) failure = t().none;
  if (answer.crawling && round < 40) setTimeout(() => { void loadWallet(address, pages, round + 1); }, round < 5 ? 2_500 : 5_000);
  else loading.delete(key);
  render();
  layout();
  void loadOpenNames(shown.nodes.map((item) => item.address)).then(() => draw());
}
async function loadPages(address, pages) {
  const key = lower(address);
  loading.add(key);
  render();
  const list = utxo ? ["btc"] : chains.length ? chains : ["eth"];
  let any = false;
  await Promise.all(list.map(async (chain) => {
    let cursor = null;
    for (let page = 0; page < pages; page += 1) {
      const query = new URLSearchParams({ dir: "all", ...(utxo ? {} : { chain }), ...(cursor ? { cursor } : {}) });
      const answer = await fetch(`/market/chain/address/${encodeURIComponent(address)}/transfers?${query}`)
        .then((response) => (response.ok ? response.json() : null)).catch(() => null);
      if (!answer) break;
      any = true;
      for (const item of answer.items) {
        ledger.set(item.id, item);
        for (const party of [item.from, item.to]) {
          if (!party?.address) continue;
          const known = parties.get(lower(party.address));
          parties.set(lower(party.address), { ...known, ...party, name: party.name ?? known?.name ?? knownName(party.address), logo: party.logo ?? known?.logo });
        }
      }
      // Each page shows as soon as it arrives.
      layout();
      cursor = answer.next;
      if (!cursor) break;
    }
  }));
  loading.delete(key);
  if (!any && key === lower(root)) failure = t().failed;
  layout();
  // Open names for the new bubbles, then their pictures.
  void loadOpenNames(shown.nodes.map((item) => item.address)).then(() => draw());
}

// --- Which bubbles and lines to show, from the loaded transfers and the filters.
function layout() {
  const nodes = new Map();
  const edges = new Map();
  const add = (address, from) => {
    const key = lower(address);
    if (!nodes.has(key)) nodes.set(key, { key, address: parties.get(key)?.address ?? address, usd: 0 });
    if (!pos.has(key)) {
      const near = pos.get(from) ?? { x: 0, y: 0 };
      const angle = Math.random() * Math.PI * 2;
      const distance = from ? 140 + Math.random() * 80 : 0;
      pos.set(key, { x: near.x + Math.cos(angle) * distance, y: near.y + Math.sin(angle) * distance, vx: 0, vy: 0, fixed: false });
    }
    return nodes.get(key);
  };
  add(root, null);
  for (const center of expanded) {
    const sums = new Map();
    for (const item of ledger.values()) {
      if (filters.chain !== "all" && item.chain !== filters.chain) continue;
      if ((item.usd ?? 0) < filters.min) continue;
      const from = lower(item.from?.address);
      const to = lower(item.to?.address);
      if (from !== center && to !== center) continue;
      const other = from === center ? to : from;
      if (!other || other === center || ZERO.test(other)) continue;
      const entry = sums.get(other) ?? { other, address: from === center ? item.to.address : item.from.address, in: 0, out: 0, count: 0, last: 0, chains: new Set(), flows: [] };
      entry[to === center ? "in" : "out"] += item.usd ?? 0;
      entry.count += 1;
      entry.last = Math.max(entry.last, item.time ?? 0);
      entry.chains.add(item.chain);
      entry.flows.push({ dir: to === center ? "in" : "out", usd: item.usd ?? 0, time: item.time ?? 0 });
      sums.set(other, entry);
    }
    const top = [...sums.values()].sort((left, right) => (filters.order === "time" ? right.last - left.last : right.in + right.out - left.in - left.out))
      .slice(0, filters.limit);
    add(center, null);
    for (const entry of top) {
      const item = add(entry.address, center);
      item.usd = Math.max(item.usd, entry.in + entry.out);
      const pair = [center, entry.other].sort().join("|");
      if (!edges.has(pair)) edges.set(pair, { from: center, to: entry.other, ...entry });
    }
  }
  shown = { nodes: [...nodes.values()], edges: [...edges.values()] };
  heat(1);
  draw();
  fitted = false;
}

// --- Drawing: lines, then bubbles with their pictures and names.
const clips = new Set();
function clip(radius) {
  const id = `viz-clip-${radius}`;
  if (!clips.has(id)) {
    clips.add(id);
    const defs = $("#graph").querySelector("defs") ?? $("#graph").insertBefore(svg("defs"), $("#graph").firstChild);
    const path = svg("clipPath", { id });
    path.append(svg("circle", { r: radius }));
    defs.append(path);
  }
  return `url(#${id})`;
}
const radius = (item) => (item.key === lower(root) ? 40 : expanded.includes(item.key) ? 32 : Math.round(25 + Math.min(7, Math.log10(1 + item.usd))));
// Each transfer is a line of its own, as on the analytics sites; past this many the newest stand for the rest.
const MAX_LINES = 24;
const widthOf = (usd) => Math.max(0.8, Math.min(2.6, 0.5 + Math.log10(1 + usd) / 2.5));
// The words inside a bubble with no picture: its name, or the start of its address.
function inner(item) {
  const text = label(item);
  if (text === shortAddress(item.address)) return `${item.address.slice(0, 6)}…`;
  return text.length > 10 ? `${text.slice(0, 9)}…` : text;
}
function label(item) {
  const party = parties.get(item.key) ?? { address: item.address };
  return party.name ?? openNames.get(item.key)?.name ?? (item.key === lower(root) ? rootInfo?.name : null) ?? shortAddress(item.address);
}
function draw() {
  $("#status").hidden = Boolean(shown.edges.length) && !failure;
  $("#status").textContent = failure || (loading.size ? t().loadingMore : !ADDRESS.test(root) ? t().missing : shown.edges.length ? "" : t().none);
  if (loading.size && shown.edges.length) { $("#status").hidden = false; $("#status").textContent = t().loadingMore; }
  $("#edges").replaceChildren(...shown.edges.flatMap((edge) => {
    const flows = [...edge.flows].sort((left, right) => right.time - left.time).slice(0, MAX_LINES);
    return flows.map((flow, index) => {
      const line = svg("path", { class: `viz-edge ${flow.dir}`, fill: "none", "stroke-width": widthOf(flow.usd).toFixed(2) });
      Object.assign(line.dataset, { from: edge.from, to: edge.to, index, count: flows.length });
      return line;
    });
  }));
  $("#nodes").replaceChildren(...shown.nodes.map((item) => {
    const party = { ...(parties.get(item.key) ?? { address: item.address }), ...(item.key === lower(root) && rootInfo ? { name: rootInfo.name, logo: rootInfo.logo } : {}) };
    const size = radius(item);
    const group = svg("g", { class: `viz-node${item.key === lower(root) ? " root" : ""}${expanded.includes(item.key) ? " open" : ""}${selected === item.key ? " on" : ""}${loading.has(item.key) ? " busy" : ""}` });
    group.dataset.key = item.key;
    group.append(svg("circle", { class: "viz-ring", r: size + 3 }), svg("circle", { class: "viz-face", r: size }));
    // The name or address sits inside the bubble; a picture, when there is one, covers it.
    const text = svg("text", { class: "viz-inner", "text-anchor": "middle", dy: "0.35em", "font-size": (size * 0.36).toFixed(1) });
    text.textContent = inner(item);
    group.append(text);
    const source = party.name || party.logo ? walletPicture({ ...party, address: item.address }) : null;
    if (source) {
      // With a picture the name moves under the bubble, so the two never overlap.
      const image = svg("image", { href: source, x: -size, y: -size, width: size * 2, height: size * 2, "clip-path": clip(size), preserveAspectRatio: "xMidYMid slice" });
      const caption = svg("text", { class: "viz-caption", "text-anchor": "middle", y: (size + 14).toFixed(1) });
      caption.textContent = inner(item);
      text.style.display = "none";
      image.addEventListener("error", () => { image.remove(); caption.remove(); text.style.display = ""; }, { once: true });
      group.append(image, caption);
    }
    group.append(Object.assign(svg("title"), { textContent: label(item) }));
    return group;
  }));
  place();
  renderCard();
}
function place() {
  // A wallet's transfers fan out as a sheaf of curves between the two bubbles.
  for (const line of $("#edges").children) {
    const from = pos.get(line.dataset.from);
    const to = pos.get(line.dataset.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const spread = Math.min(9, 140 / Number(line.dataset.count));
    const bend = (Number(line.dataset.index) - (Number(line.dataset.count) - 1) / 2) * spread;
    const cx = (from.x + to.x) / 2 - (dy / length) * bend;
    const cy = (from.y + to.y) / 2 + (dx / length) * bend;
    line.setAttribute("d", `M${from.x.toFixed(1)} ${from.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`);
  }
  for (const group of $("#nodes").children) {
    const at = pos.get(group.dataset.key);
    if (at) group.setAttribute("transform", `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`);
  }
}

// --- A light force layout: bubbles push each other apart, lines pull linked ones together.
let warmth = 0;
let frame = 0;
function heat(value) {
  warmth = Math.max(warmth, value);
  if (!frame) frame = requestAnimationFrame(step);
}
function step() {
  frame = 0;
  const items = shown.nodes.map((item) => ({ item, at: pos.get(item.key), size: radius(item) }));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].at;
      const b = items[j].at;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; distance = 0.5; }
      const room = items[i].size + items[j].size + 18;
      const push = (2600 / (distance * distance) + (distance < room ? (room - distance) * 0.25 : 0)) * warmth;
      const fx = (dx / distance) * push;
      const fy = (dy / distance) * push;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (const edge of shown.edges) {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const pull = (distance - 190) * 0.03 * warmth;
    a.vx += (dx / distance) * pull; a.vy += (dy / distance) * pull;
    b.vx -= (dx / distance) * pull; b.vy -= (dy / distance) * pull;
  }
  const center = pos.get(lower(root));
  for (const { item, at } of items) {
    if (item.key === lower(root) && !at.fixed) { at.vx -= at.x * 0.05; at.vy -= at.y * 0.05; }
    else if (center) { at.vx -= (at.x - center.x) * 0.002 * warmth; at.vy -= (at.y - center.y) * 0.002 * warmth; }
    if (at.fixed) { at.vx = 0; at.vy = 0; continue; }
    at.vx *= 0.6; at.vy *= 0.6;
    at.x += Math.max(-30, Math.min(30, at.vx));
    at.y += Math.max(-30, Math.min(30, at.vy));
  }
  place();
  warmth *= 0.97;
  // Until the visitor moves it, the picture fits itself to the bubbles as they settle.
  if (!touched && !fitted && warmth < 0.15) { fitted = true; fit(); }
  if (warmth > 0.02) frame = requestAnimationFrame(step);
}

// --- Panning, zooming and dragging, with a mouse or fingers.
const view = { x: 0, y: 0, k: 1 };
const applyView = () => $("#view").setAttribute("transform", `translate(${view.x.toFixed(1)} ${view.y.toFixed(1)}) scale(${view.k.toFixed(3)})`);
function zoomAt(factor, cx, cy) {
  const k = Math.max(0.25, Math.min(4, view.k * factor));
  view.x = cx - ((cx - view.x) * k) / view.k;
  view.y = cy - ((cy - view.y) * k) / view.k;
  view.k = k;
  applyView();
}
function fit() {
  const box = $("#graph").getBoundingClientRect();
  const points = shown.nodes.map((item) => pos.get(item.key)).filter(Boolean);
  if (!points.length) return;
  const xs = points.map((at) => at.x);
  const ys = points.map((at) => at.y);
  const width = Math.max(200, Math.max(...xs) - Math.min(...xs) + 120);
  const height = Math.max(200, Math.max(...ys) - Math.min(...ys) + 120);
  view.k = Math.max(0.25, Math.min(1.4, Math.min(box.width / width, box.height / height)));
  view.x = box.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * view.k;
  view.y = box.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * view.k;
  applyView();
}
function setupGestures() {
  const stage = $("#graph");
  const pointers = new Map();
  let drag = null; // { key, moved, startX, startY } or { pan: true, … }
  let pinch = null;
  let tap; // the bubble just tapped (null: the background), until its click arrives
  const local = (event) => { const box = stage.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  stage.addEventListener("pointerdown", (event) => {
    touched = true;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, local(event));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      drag = null;
      return;
    }
    const group = event.target.closest?.(".viz-node");
    const point = local(event);
    drag = group ? { key: group.dataset.key, moved: false, startX: point.x, startY: point.y }
      : { pan: true, moved: false, startX: point.x, startY: point.y, x: view.x, y: view.y };
  });
  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const point = local(event);
    pointers.set(event.pointerId, point);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((pinch.k * distance) / pinch.distance / view.k, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (!drag) return;
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 5) drag.moved = true;
    if (!drag.moved) return;
    if (drag.pan) { view.x = drag.x + point.x - drag.startX; view.y = drag.y + point.y - drag.startY; applyView(); return; }
    const at = pos.get(drag.key);
    at.x = (point.x - view.x) / view.k;
    at.y = (point.y - view.y) / view.k;
    at.fixed = true;
    heat(0.3);
    place();
  });
  const end = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag || pointers.size) return;
    // A tap chooses on the click that follows it, so the card that opens cannot catch that same click.
    tap = drag.moved ? undefined : drag.key ?? null;
    drag = null;
  };
  stage.addEventListener("click", () => {
    if (tap === undefined) return;
    selected = tap;
    tap = undefined;
    draw();
  });
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("dblclick", (event) => {
    const group = event.target.closest?.(".viz-node");
    if (group) void toggle(group.dataset.key);
  });
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    touched = true;
    const point = local(event);
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, point.x, point.y);
  }, { passive: false });
  $("#zoom-in").addEventListener("click", () => { const box = stage.getBoundingClientRect(); zoomAt(1.25, box.width / 2, box.height / 2); });
  $("#zoom-out").addEventListener("click", () => { const box = stage.getBoundingClientRect(); zoomAt(0.8, box.width / 2, box.height / 2); });
  $("#fit").addEventListener("click", fit);
}

// --- The card of the chosen bubble: its sums with the wallet it hangs on, and what to do next.
async function toggle(key) {
  const at = expanded.indexOf(key);
  if (key === lower(root)) return;
  if (at > 0) { expanded.splice(at, 1); layout(); return; }
  expanded.push(key);
  selected = key;
  layout();
  await loadWallet(parties.get(key)?.address ?? key, 2);
}
function renderCard() {
  const card = $("#card");
  const item = shown.nodes.find((entry) => entry.key === selected);
  if (!item) { card.hidden = true; return; }
  card.hidden = false;
  const edge = shown.edges.find((entry) => entry.to === item.key || entry.from === item.key);
  const head = node("div", "viz-card-head");
  head.append(walletAvatar({ ...(parties.get(item.key) ?? {}), address: item.address, name: label(item) }));
  const who = node("div");
  who.append(node("b", "", label(item)), ...(label(item) === shortAddress(item.address) ? [] : [node("small", "muted", shortAddress(item.address))]));
  const close = node("button", "pill", "×");
  close.type = "button";
  close.addEventListener("click", () => { selected = null; draw(); });
  head.append(who, close);
  const facts = node("div", "viz-facts");
  if (edge && item.key !== edge.from) {
    // Seen from the wallet it hangs on: what that wallet received from it and sent to it.
    facts.append(node("span", "up", `${t().received}: ${money(edge.in)}`), node("span", "down", `${t().sent}: ${money(edge.out)}`),
      node("span", "muted", `${t().transfers}: ${edge.count}`));
    if (edge.last) facts.append(node("span", "muted", `${t().last}: ${new Date(edge.last).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" })}`));
  }
  const actions = node("div", "viz-actions");
  if (item.key !== lower(root)) {
    const more = node("button", "act", expanded.includes(item.key) ? t().collapse : t().expand);
    more.type = "button";
    more.addEventListener("click", () => { void toggle(item.key); });
    actions.append(more);
  }
  actions.append(Object.assign(node("a", "act ghost", t().open), { href: addressUrl(item.address) }));
  if (item.key !== lower(root)) actions.append(Object.assign(node("a", "act ghost", t().center), { href: `/visualizer/?address=${encodeURIComponent(item.address)}` }));
  card.replaceChildren(head, facts, actions);
}

// --- Filters.
function render() {
  document.title = t().title(rootInfo?.name ?? shortAddress(root));
  $("#root-name").textContent = rootInfo?.name ?? shortAddress(root);
  $("#back").href = ADDRESS.test(root) ? addressUrl(root) : "/wallets/";
  $("#limit").textContent = t().limit(filters.limit);
  $("#order").textContent = filters.order === "usd" ? t().byUsd : t().byTime;
  $("#min-usd").textContent = t().min(filters.min);
  $("#min-usd").classList.toggle("on", filters.min > 0);
  const button = (label, on, click) => { const item = node("button", on ? "on" : ""); item.type = "button"; item.append(...label); item.addEventListener("click", click); return item; };
  $("#chains").hidden = chains.length < 2;
  $("#chains").replaceChildren(button([t().allChains], filters.chain === "all", () => { filters.chain = "all"; render(); layout(); }),
    ...chains.map((chain) => button([chainDot(chain), CHAINS[chain]?.short ?? chain], filters.chain === chain, () => { filters.chain = chain; render(); layout(); })));
  draw();
}
const cycle = (list, value) => list[(list.indexOf(value) + 1) % list.length];
$("#limit").addEventListener("click", () => { filters.limit = cycle(LIMITS, filters.limit); render(); layout(); });
$("#order").addEventListener("click", () => { filters.order = filters.order === "usd" ? "time" : "usd"; render(); layout(); });
$("#min-usd").addEventListener("click", () => { filters.min = cycle(MINIMUMS, filters.min); render(); layout(); });
$("#find").addEventListener("click", () => {
  document.body.classList.toggle("searching");
  if (document.body.classList.contains("searching")) $("#search").focus();
});

async function start() {
  if (!ADDRESS.test(root)) { render(); return; }
  expanded.push(lower(root));
  layout();
  render();
  // The wallet's name and picture come beside its links, not before them.
  void fetch(`/market/chain/address/${encodeURIComponent(root)}`).then((response) => (response.ok ? response.json() : null)).catch(() => null).then((summary) => {
    if (!summary) return;
    rootInfo = { name: summary.name ?? knownName(root), logo: summary.logo ?? null };
    parties.set(lower(root), { address: root, ...rootInfo });
    if (!utxo) chains = [...new Set([...chains, ...(summary.networks ?? []).filter((item) => item.ok && item.active).map((item) => item.chain)])].filter((chain) => chain !== "btc");
    render();
  });
  await loadWallet(root, 5);
}

setupGestures();
{ const box = $("#graph").getBoundingClientRect(); view.x = box.width / 2; view.y = box.height / 2; applyView(); }
setupSearch({});
setupPage({ en, render });
void start();
