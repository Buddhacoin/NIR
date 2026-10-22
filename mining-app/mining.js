
// One-button mining (docs/proof-mining.md): the local service runs a valueless
// devnet and searches for cliques; this panel shows the search and the reward
// path into NIR Wallet.

const panel = document.querySelector("#mining");
const sky = document.querySelector("#mining-sky");
const phase = document.querySelector("#mining-phase");
const toggle = document.querySelector("#mining-toggle");
const withdraw = document.querySelector("#mining-withdraw");
const recipientNote = document.querySelector("#mining-recipient");
const events = document.querySelector("#mining-events");
const field = (id) => document.querySelector(`#mining-${id}`);
const networkChoice = document.querySelector("#mining-network");
const networkNote = document.querySelector("#mining-network-note");

const copy = {
  ru: {
    title: "Майнинг NIR", badge: "ТЕСТОВАЯ СЕТЬ", levelLabel: "УРОВЕНЬ", taskLabel: "Задача",
    checkedLabel: "ПРОВЕРЕНО", foundLabel: "НАЙДЕНО КЛИК", walletLabel: "БАЛАНС", walletLabelLinked: "В NIR WALLET", heightLabel: "блок",
    connect: "Подключить NIR Wallet", connectOther: "Подключить другой кошелёк",
    howtoTitle: "Как это работает?",
    howto1: "Сеть сама придумывает головоломки: паутину из точек и линий. Никто не знает их заранее.",
    howto2: "Ваш Mac ищет группу точек, где каждая соединена с каждой. Найти трудно, а проверить — мгновенно.",
    howto3: "Примерно раз в 10 минут сеть делит 44 NIR между всеми найденными ответами. Если задачи решают слишком быстро, они усложняются — поэтому чем умнее программы и ИИ, тем сложнее майнинг.",
    start: "Начать майнинг", stop: "Остановить", withdraw: "Отправить намайненное в NIR Wallet",
    idle: "Нажмите «Начать майнинг»",
    preparing: "Открываю локальную сеть NIR… После обновления или в первый раз — до минуты.",
    preparingShared: "Подключаюсь к общей сети NIR…",
    networkLabel: "Сеть", networkShared: "Общая сеть", networkLocal: "Тренировка на этом Mac",
    noteShared: "Одна сеть для всех майнеров NIR: можно отправлять NIR друг другу.",
    noteLocal: "Сеть только на этом Mac, работает без интернета. Её NIR не видны другим.",
    noteSwitched: "Сеть сменилась. NIR Wallet переключится на неё сам через несколько секунд.",
    waiting: "Жду следующую задачу…",
    searching: (t) => `Ищу ${t.k} вершин, соединённых каждая с каждой, среди ${t.n}`,
    committing: "Клика найдена! Отправляю запечатанный ответ…",
    revealing: "Раскрываю ответ сети…",
    linked: (a) => `Награды идут прямо в NIR Wallet: ${a.slice(0, 12)}…${a.slice(-6)}`,
    unlinked: "Кошелёк не подключён — награды пока копятся в майнере. Подключите NIR Wallet ниже.",
    events: {
      "network-create": () => "Создаю локальную сеть NIR",
      "network-ready": (e) => e.shared ? `Подключено к общей сети, блок ${e.height}` : `Сеть готова, блок ${e.height}`,
      "network-error": (e) => offline(e) ? "Общая сеть не отвечает. Проверьте интернет — майнер попробует снова."
        : `Сеть: ${e.message}`,
      faucet: () => "Ключ майнера получил 10 тестовых NIR на залоги",
      task: (e) => `Новая задача #${e.round}, уровень ${e.level}`,
      found: (e) => `Клика из ${e.k} вершин найдена за ${(e.ms / 1000).toFixed(1)} с — задача #${e.round}`,
      revealed: (e) => `Ответ на задачу #${e.round} принят. Сеть раздаёт 44 NIR раз в ~10 минут — награда придёт в течение ~15 минут`,
      withdraw: (e) => `Отправлено в NIR Wallet: ${e.amount}`,
      error: (e) => offline(e) ? "Нет связи с сетью. Майнер попробует снова через несколько секунд."
        : `Ошибка: ${e.message}`,
    },
  },
  en: {
    title: "NIR mining", badge: "TEST NETWORK", levelLabel: "LEVEL", taskLabel: "Task",
    checkedLabel: "CHECKED", foundLabel: "CLIQUES FOUND", walletLabel: "BALANCE", walletLabelLinked: "IN NIR WALLET", heightLabel: "block",
    connect: "Connect NIR Wallet", connectOther: "Connect another wallet",
    howtoTitle: "How does it work?",
    howto1: "The network makes up puzzles by itself: webs of dots and lines. Nobody knows them in advance.",
    howto2: "Your Mac looks for a group of dots where every dot is linked to every other. Finding one is hard; checking it is instant.",
    howto3: "About every 10 minutes the network shares 44 NIR among all the answers found. If puzzles get solved too fast they get harder, so the smarter programs and AI become, the harder mining gets.",
    start: "Start mining", stop: "Stop", withdraw: "Send mined NIR to NIR Wallet",
    idle: "Press “Start mining”",
    preparing: "Opening the local NIR network… Up to a minute after an update or the first time.",
    preparingShared: "Connecting to the shared NIR network…",
    networkLabel: "Network", networkShared: "Shared network", networkLocal: "Practice on this Mac",
    noteShared: "One network for every NIR miner: you can send NIR to each other.",
    noteLocal: "A network only on this Mac that works offline. Its NIR is not visible to others.",
    noteSwitched: "The network changed. NIR Wallet switches to it by itself within a few seconds.",
    waiting: "Waiting for the next task…",
    searching: (t) => `Looking for ${t.k} pairwise connected vertices among ${t.n}`,
    committing: "Clique found! Sending the sealed answer…",
    revealing: "Revealing the answer to the network…",
    linked: (a) => `Rewards go straight to NIR Wallet: ${a.slice(0, 12)}…${a.slice(-6)}`,
    unlinked: "No wallet connected — rewards collect in the miner for now. Connect NIR Wallet below.",
    events: {
      "network-create": () => "Creating a local NIR network",
      "network-ready": (e) => e.shared ? `Connected to the shared network at block ${e.height}` : `Network ready at block ${e.height}`,
      "network-error": (e) => offline(e) ? "The shared network is not answering. Check the internet; the miner will try again."
        : `Network: ${e.message}`,
      faucet: () => "Miner key received 10 test NIR for bonds",
      task: (e) => `New task #${e.round}, level ${e.level}`,
      found: (e) => `Found a ${e.k}-vertex clique in ${(e.ms / 1000).toFixed(1)} s — task #${e.round}`,
      revealed: (e) => `Answer to task #${e.round} accepted. The network pays out 44 NIR about every 10 minutes; the reward arrives within ~15 minutes`,
      withdraw: (e) => `Sent to NIR Wallet: ${e.amount}`,
      error: (e) => offline(e) ? "No connection to the network. The miner will try again in a few seconds."
        : `Error: ${e.message}`,
    },
  },
};

// Messages that mean the network could not be reached.
const offline = (event) => /did not answer|fetch failed|timed? ?out|aborted|ECONN|ENOTFOUND|EAI_AGAIN/i
  .test(event.message ?? "");
let network = { available: false, mode: "local" };
let networkSwitched = false;

let status = { running: false, state: "idle" };
// "12.34000000 NIR" as "12.34 NIR".
const nir = (text) => {
  const match = /^([0-9]+)\.([0-9]{8}) NIR$/.exec(text ?? "");
  return match ? `${match[1]}.${match[2].slice(0, 2)} NIR` : "—";
};
const lang = () => (document.documentElement.lang === "en" ? "en" : "ru");
const compact = (value) => new Intl.NumberFormat(lang() === "ru" ? "ru-RU" : "en-US",
  { maximumFractionDigits: 1, notation: "compact" }).format(value);

// A constellation of the task's first vertices; a found clique lights up.
const STARS = 48;
function drawSky(time) {
  const context = sky.getContext("2d");
  const { width, height } = sky;
  context.fillStyle = "#121512";
  context.fillRect(0, 0, width, height);
  const points = Array.from({ length: STARS }, (_, i) => {
    const angle = (i / STARS) * Math.PI * 2 + time / 9000;
    const radius = 70 + 18 * Math.sin(i * 1.7);
    return [width / 2 + Math.cos(angle) * radius * 1.9, height / 2 + Math.sin(angle) * radius * 0.95];
  });
  const searching = status.state === "searching";
  context.strokeStyle = "#2c352d";
  context.lineWidth = 1;
  for (let i = 0; i < STARS; i++) {
    for (let j = i + 1; j < STARS; j += 7) {
      context.beginPath(); context.moveTo(...points[i]); context.lineTo(...points[j]); context.stroke();
    }
  }
  if (searching) {
    // A sweep of candidate edges stands in for the branches being tried.
    context.strokeStyle = "#ffb44a88";
    const base = Math.floor(time / 90);
    for (let s = 0; s < 6; s++) {
      const a = (base * 7 + s * 11) % STARS;
      const b = (base * 13 + s * 5 + 3) % STARS;
      context.beginPath(); context.moveTo(...points[a]); context.lineTo(...points[b]); context.stroke();
    }
  }
  const clique = status.lastClique;
  if (clique) {
    const lit = clique.vertices.map((v, i) => points[(v * 7 + i) % STARS]);
    context.strokeStyle = "#b9ff5a";
    context.shadowColor = "#b9ff5a";
    context.shadowBlur = 8;
    for (let i = 0; i < lit.length; i++) {
      for (let j = i + 1; j < lit.length; j++) {
        context.beginPath(); context.moveTo(...lit[i]); context.lineTo(...lit[j]); context.stroke();
      }
    }
    context.shadowBlur = 0;
  }
  for (const [x, y] of points) {
    context.fillStyle = searching ? "#ffb44a" : "#6f7b72";
    context.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4);
  }
  requestAnimationFrame(drawSky);
}

function render() {
  const t = copy[lang()];
  for (const node of panel.querySelectorAll("[data-mining]")) {
    const value = t[node.dataset.mining];
    if (typeof value === "string") node.textContent = value;
  }
  toggle.textContent = status.running ? t.stop : t.start;
  const connect = document.querySelector("#wallet-link-connect");
  if (connect && !connect.disabled) connect.textContent = status.wallet ? t.connectOther : t.connect;
  toggle.dataset.running = String(status.running);
  const state = status.state ?? "idle";
  phase.textContent = state === "searching" && status.task ? t.searching(status.task)
    : state === "preparing" && status.networkMode === "shared" ? t.preparingShared : t[state] ?? t.idle;
  networkChoice.hidden = !network.available;
  networkChoice.setAttribute("aria-label", t.networkLabel);
  for (const button of networkChoice.querySelectorAll("[data-network]")) {
    button.setAttribute("aria-checked", String(button.dataset.network === network.mode));
  }
  networkNote.hidden = !network.available;
  networkNote.textContent = networkSwitched ? t.noteSwitched
    : network.mode === "shared" ? t.noteShared : t.noteLocal;
  field("level").textContent = status.network ? String(status.network.level) : "—";
  field("task").textContent = status.task ? `#${status.task.round} · ${status.task.k}/${status.task.n}` : "—";
  field("checked").textContent = compact(status.visited ?? 0);
  field("found").textContent = String(status.found ?? 0);
  field("wallet").textContent = nir(status.wallet?.balance ?? status.miner?.balance);
  field("height").textContent = status.network ? String(status.network.height) : "—";
  recipientNote.textContent = status.wallet ? t.linked(status.wallet.address) : t.unlinked;
  withdraw.hidden = !status.wallet || status.miner?.canSend !== true;
  field("walletLabel").textContent = status.wallet ? t.walletLabelLinked : t.walletLabel;
  events.replaceChildren(...(status.events ?? []).slice(-6).reverse().map((event) => {
    const item = document.createElement("li");
    const stamp = document.createElement("time");
    stamp.textContent = new Date(event.at).toLocaleTimeString(lang() === "ru" ? "ru-RU" : "en-GB");
    const text = document.createElement("span");
    text.textContent = t.events[event.kind]?.(event) ?? event.kind;
    item.append(stamp, text);
    return item;
  }));
}

async function call(method, path, body = "") {
  const response = await fetch(path, { method, cache: "no-store", headers: globalThis.nirModelLab.sessionHeaders(),
    ...(method === "POST" ? { body } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
}

async function refresh() {
  try { status = await call("GET", "/mining/status"); } catch {}
  render();
}

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try { status = await call("POST", status.running ? "/mining/stop" : "/mining/start"); }
  catch {}
  finally { toggle.disabled = false; render(); }
});

networkChoice.addEventListener("click", async (event) => {
  const mode = event.target.closest("[data-network]")?.dataset.network;
  if (!mode || mode === network.mode) return;
  const buttons = [...networkChoice.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  try {
    network = await call("POST", "/mining/network", JSON.stringify({ mode }));
    networkSwitched = true;
  } catch (error) { phase.textContent = error.message; }
  finally { for (const button of buttons) button.disabled = false; void refresh(); }
});

withdraw.addEventListener("click", async () => {
  withdraw.disabled = true;
  try { await call("POST", "/mining/withdraw"); } catch (error) { phase.textContent = error.message; }
  finally { withdraw.disabled = false; void refresh(); }
});

render();
requestAnimationFrame(drawSky);
call("GET", "/mining/network").then((value) => { network = value; render(); }).catch(() => {});
void refresh();
setInterval(refresh, 1_000);
