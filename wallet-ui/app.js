const messages = {
  receive: ["Получить NIR", "Здесь появятся адрес и QR-код после подключения зашифрованного vault."],
  send: ["Отправить NIR", "Перед подписью кошелёк покажет адрес, сумму, комиссию и процент комиссии."],
  mine: ["Майнинг интеллекта", "Здесь можно будет выбрать роль, проверить оборудование и получить назначенное задание. Сейчас доступен только локальный демонстрационный режим."],
  history: ["История операций", "Операций пока нет. После подключения узла здесь появятся подтверждённые переводы, комиссии и награды."],
  settings: ["Настройки", "Переключение темы уже работает. Подключение узла, резервное восстановление и управление vault будут добавлены перед публичной тестовой сетью."],
  network: ["Local testnet", "Это локальная тестовая сеть. Реальные NIR и вывод средств отключены."],
};

const panel = document.querySelector("#panel");
const panelTitle = document.querySelector("#panel-title");
const panelCopy = document.querySelector("#panel-copy");

function showMessage(key) {
  const [title, copy] = messages[key];
  panelTitle.textContent = title;
  panelCopy.textContent = copy;
  if (!panel.open) panel.showModal();
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => showMessage(button.dataset.action));
});
document.querySelector(".close").onclick = () => panel.close();
document.querySelector(".primary").onclick = () => panel.close();

const navigationButtons = [...document.querySelectorAll("[data-nav]")];
navigationButtons.forEach((button) => button.addEventListener("click", () => {
  navigationButtons.forEach((candidate) => {
    const selected = candidate === button;
    candidate.classList.toggle("active", selected);
    if (selected) candidate.setAttribute("aria-current", "page");
    else candidate.removeAttribute("aria-current");
  });
  const destination = button.dataset.nav;
  if (destination === "home") window.scrollTo({ top: 0, behavior: "smooth" });
  else if (destination === "history") {
    document.querySelector("#history").scrollIntoView({ behavior: "smooth", block: "center" });
    showMessage("history");
  } else showMessage(destination);
}));

const themeButton = document.querySelector("#theme");
const setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === "light" ? "☾" : "☀";
  themeButton.setAttribute("aria-label", theme === "light" ? "Включить тёмную тему" : "Включить дневную тему");
  localStorage.setItem("nir-theme", theme);
};
setTheme(localStorage.getItem("nir-theme") || "dark");
themeButton.onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

const networkButton = document.querySelector(".network");
async function refreshNodeStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch("http://127.0.0.1:8787/health", { signal: controller.signal });
    if (!response.ok) throw new Error("node unavailable");
    const status = await response.json();
    networkButton.textContent = `● Connected · h${status.height}`;
    networkButton.classList.add("connected");
    networkButton.classList.remove("offline");
    messages.network = ["NIR node подключён", `${status.networkId}, высота ${status.height}. Режим: тестовые единицы без реальной стоимости.`];
  } catch {
    networkButton.textContent = "○ Node offline";
    networkButton.classList.add("offline");
    networkButton.classList.remove("connected");
    messages.network = ["NIR node не подключён", "Запустите локальный узел на 127.0.0.1:8787. Кошелёк повторит проверку после обновления страницы."];
  } finally {
    clearTimeout(timeout);
  }
}
refreshNodeStatus();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js");
}
