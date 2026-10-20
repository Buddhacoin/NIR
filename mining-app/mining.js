
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

const copy = {
  ru: {
    title: "Майнинг NIR", badge: "ТЕСТОВАЯ СЕТЬ", levelLabel: "УРОВЕНЬ", taskLabel: "ЗАДАЧА",
    checkedLabel: "ПРОВЕРЕНО ВАРИАНТОВ", foundLabel: "НАЙДЕНО КЛИК", walletLabel: "В КОШЕЛЬКЕ", heightLabel: "БЛОК",
    start: "Начать майнинг", stop: "Остановить", withdraw: "Отправить намайненное в NIR Wallet",
    idle: "Нажмите «Начать майнинг»",
    preparing: "Поднимаю локальную сеть NIR… (в первый раз около 20 секунд)",
    waiting: "Жду новую задачу от маяка сети…",
    searching: (t) => `Ищу ${t.k} вершин, соединённых каждая с каждой, среди ${t.n}`,
    committing: "Клика найдена! Отправляю запечатанный ответ…",
    revealing: "Раскрываю ответ сети…",
    linked: (a) => `Награды идут прямо в NIR Wallet: ${a.slice(0, 12)}…${a.slice(-6)}`,
    unlinked: "Кошелёк не привязан: награды копятся на ключе майнера. Привяжите адрес NIR Wallet ниже — и отправьте их туда кнопкой.",
    valueless: "Локальная тестовая сеть: эти NIR не имеют ценности и не переходят в основную сеть.",
    events: {
      "network-create": () => "Создаю локальную сеть NIR",
      "network-ready": (e) => `Сеть готова, блок ${e.height}`,
      "network-error": (e) => `Сеть: ${e.message}`,
      faucet: () => "Ключ майнера получил 10 тестовых NIR на залоги",
      task: (e) => `Новая задача #${e.round}, уровень ${e.level}`,
      found: (e) => `Клика из ${e.k} вершин найдена за ${(e.ms / 1000).toFixed(1)} с — задача #${e.round}`,
      revealed: (e) => `Ответ на задачу #${e.round} раскрыт, награда придёт через 64 блока`,
      withdraw: (e) => `Отправлено в NIR Wallet: ${e.amount}`,
      error: (e) => `Ошибка: ${e.message}`,
    },
  },
  en: {
    title: "NIR mining", badge: "TEST NETWORK", levelLabel: "LEVEL", taskLabel: "TASK",
    checkedLabel: "BRANCHES CHECKED", foundLabel: "CLIQUES FOUND", walletLabel: "IN WALLET", heightLabel: "BLOCK",
    start: "Start mining", stop: "Stop", withdraw: "Send mined NIR to NIR Wallet",
    idle: "Press “Start mining”",
    preparing: "Starting a local NIR network… (about 20 seconds the first time)",
    waiting: "Waiting for the network beacon to issue a task…",
    searching: (t) => `Looking for ${t.k} pairwise connected vertices among ${t.n}`,
    committing: "Clique found! Sending the sealed answer…",
    revealing: "Revealing the answer to the network…",
    linked: (a) => `Rewards go straight to NIR Wallet: ${a.slice(0, 12)}…${a.slice(-6)}`,
    unlinked: "No wallet linked: rewards stay on the miner key. Link your NIR Wallet address below, then send them there.",
    valueless: "Local test network: these NIR have no value and do not carry over to a main network.",
    events: {
      "network-create": () => "Creating a local NIR network",
      "network-ready": (e) => `Network ready at block ${e.height}`,
      "network-error": (e) => `Network: ${e.message}`,
      faucet: () => "Miner key received 10 test NIR for bonds",
      task: (e) => `New task #${e.round}, level ${e.level}`,
      found: (e) => `Found a ${e.k}-vertex clique in ${(e.ms / 1000).toFixed(1)} s — task #${e.round}`,
      revealed: (e) => `Answer to task #${e.round} revealed; the reward arrives in 64 blocks`,
      withdraw: (e) => `Sent to NIR Wallet: ${e.amount}`,
      error: (e) => `Error: ${e.message}`,
    },
  },
};

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
  toggle.dataset.running = String(status.running);
  const state = status.state ?? "idle";
  phase.textContent = state === "searching" && status.task ? t.searching(status.task) : t[state] ?? t.idle;
  field("level").textContent = status.network ? String(status.network.level) : "—";
  field("task").textContent = status.task ? `#${status.task.round} · ${status.task.k}/${status.task.n}` : "—";
  field("checked").textContent = compact(status.visited ?? 0);
  field("found").textContent = String(status.found ?? 0);
  field("wallet").textContent = nir(status.wallet?.balance ?? status.miner?.balance);
  field("height").textContent = status.network ? String(status.network.height) : "—";
  recipientNote.textContent = `${status.wallet ? t.linked(status.wallet.address) : t.unlinked} ${t.valueless}`;
  withdraw.hidden = !status.wallet || !status.miner;
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

async function call(method, path) {
  const response = await fetch(path, { method, cache: "no-store", headers: globalThis.nirModelLab.sessionHeaders(),
    ...(method === "POST" ? { body: "" } : {}) });
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

withdraw.addEventListener("click", async () => {
  withdraw.disabled = true;
  try { await call("POST", "/mining/withdraw"); } catch (error) { phase.textContent = error.message; }
  finally { withdraw.disabled = false; void refresh(); }
});

render();
requestAnimationFrame(drawSky);
void refresh();
setInterval(refresh, 1_000);
