const start = document.querySelector("#start");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const error = document.querySelector("#error");
const errorMessage = document.querySelector("#error-message");
const connection = document.querySelector("#connection");
const languageButton = document.querySelector("#language");

const copy = {
  ru: {
    test: "ТЕСТ", eyebrow: "Локальная тренировка", headline: "Проверка модели Iris",
    description: "Локально обучим два классификатора на 120 примерах и проверим их на 30 новых. Результаты и свидетельства будут проверены на этом Mac.",
    start: "Проверить модель Iris", safety: "Не нужен кошелёк, пароль, секретная фраза или оплата.",
    runningTitle: "Модель выполняется на этом Mac…",
    runningBody: "Проверяем исходную и улучшенную модель, затем целостность набора свидетельств.",
    doneTitle: "Локальная проверка завершена",
    doneBody: "Набор свидетельств проверен локально. Независимых операторов, скрытых заданий, подтверждённого измерения энергии и сетевой награды нет.",
    technicalTitle: "Технический результат", errorTitle: "Локальная проверка не завершилась",
    footer: "Публичный майнинг и реальные NIR недоступны. Запускается только встроенный пример из доверенной копии NIR; программа не является песочницей и не принимает произвольный код.",
    checking: "Проверяем подключение к локальному сервису…", online: "● Локальный сервис подключён",
    offline: "● Локальный сервис отключён",
    offlineMessage: "Локальный сервис NIR недоступен. Повторно запустите `npm run mine:app` из доверенной копии NIR и используйте новую вкладку, которую откроет приложение. Старый адрес может больше не работать.",
    failed: "Локальная проверка не завершилась. Заявка не отправлена, награда не начислена.",
    invalid: "Результат локальной проверки не подтверждён. Награда не начислена.",
    score: (baseline, candidate, count) => `Точность: исходная модель ${baseline} %, улучшенная ${candidate} % · ${count} примеров.`,
    hash: (value) => `Хеш проверенного набора: ${value}`,
  },
  en: {
    test: "TEST", eyebrow: "Local rehearsal", headline: "Check the Iris model",
    description: "Train two classifiers locally on 120 examples and check them against 30 held-out examples. Results and evidence are checked on this Mac.",
    start: "Check Iris model", safety: "No wallet, password, recovery phrase, or payment is needed.",
    runningTitle: "Model running on this Mac…",
    runningBody: "Checking the baseline and candidate models, then the evidence bundle integrity.",
    doneTitle: "Local check complete",
    doneBody: "The evidence bundle was checked locally. There are no independent operators, hidden challenges, attested energy measurements, or network rewards.",
    technicalTitle: "Technical result", errorTitle: "Local check failed",
    footer: "Public mining and real NIR are unavailable. Only the bundled example from a trusted NIR checkout runs; this is not a sandbox and does not accept arbitrary code.",
    checking: "Checking the local service…", online: "● Local service connected",
    offline: "● Local service disconnected",
    offlineMessage: "The local NIR service is unavailable. Run `npm run mine:app` again from a trusted NIR checkout and use the new browser tab it opens. The old address may no longer work.",
    failed: "The local check did not finish. No claim was submitted and no reward was credited.",
    invalid: "The local result could not be verified. No reward was credited.",
    score: (baseline, candidate, count) => `Accuracy: baseline ${baseline}%, candidate ${candidate}% · ${count} examples.`,
    hash: (value) => `Verified bundle hash: ${value}`,
  },
};

let locale = typeof navigator !== "undefined" && !/^ru\b/i.test(navigator.language || "") ? "en" : "ru";
try { const saved = localStorage.getItem("nir-mining-locale"); if (saved === "en" || saved === "ru") locale = saved; } catch {}
let connected = false;
let checking = false;
let statusRequestRunning = false;
let errorKind = null;
let lastResult = null;

function render() {
  const t = copy[locale];
  document.documentElement.lang = locale;
  document.title = locale === "ru" ? "NIR · Проверка модели" : "NIR · Model check";
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t[node.dataset.i18n];
  languageButton.textContent = locale === "ru" ? "EN" : "RU";
  languageButton.setAttribute("aria-label", locale === "ru" ? "Switch language to English" : "Переключить язык на русский");
  connection.textContent = checking ? t.checking : connected ? t.online : t.offline;
  if (errorKind) errorMessage.textContent = t[errorKind];
  if (lastResult) {
    document.querySelector("#score").textContent = t.score(
      (lastResult.baselineAccuracyBps / 100).toFixed(2),
      (lastResult.candidateAccuracyBps / 100).toFixed(2), lastResult.caseCount,
    );
    document.querySelector("#technical").textContent = t.hash(lastResult.bundleHash);
  }
}

function showOffline() {
  connected = false;
  checking = false;
  connection.dataset.state = "offline";
  progress.hidden = true;
  result.hidden = true;
  errorKind = "offlineMessage";
  error.hidden = false;
  start.disabled = true;
  render();
}

async function checkConnection() {
  if (statusRequestRunning) return;
  statusRequestRunning = true;
  checking = true;
  render();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("/status", { cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok || data.status !== "local-model-service-ready") throw new Error("wrong local service");
    connected = true;
    checking = false;
    connection.dataset.state = "online";
    if (progress.hidden) start.disabled = false;
    if (errorKind === "offlineMessage") { errorKind = null; error.hidden = true; }
    render();
  } catch { showOffline(); }
  finally { clearTimeout(timeout); statusRequestRunning = false; }
}

languageButton.addEventListener("click", () => {
  locale = locale === "ru" ? "en" : "ru";
  try { localStorage.setItem("nir-mining-locale", locale); } catch {}
  render();
});

start.addEventListener("click", async () => {
  if (!connected) { showOffline(); return; }
  start.disabled = true;
  progress.hidden = false;
  result.hidden = true;
  error.hidden = true;
  errorKind = null;
  try {
    const response = await fetch("/model-check", { method: "POST", body: "" });
    const data = await response.json();
    if (!response.ok) throw new Error("model-check failed");
    if (data.status !== "pinned-local-model-evaluation" ||
        data.scope !== "local-public-iris-example-only" || data.walletChanged !== false ||
        data.networkSubmitted !== false || data.rewardCredited !== false ||
        data.independentOperators !== false || data.hiddenChallenges !== false ||
        data.energyAttested !== false || data.bundleVerified !== true ||
        data.caseCount !== 30 || !Number.isSafeInteger(data.baselineAccuracyBps) ||
        !Number.isSafeInteger(data.candidateAccuracyBps) ||
        !/^[0-9a-f]{64}$/.test(data.bundleHash)) {
      throw new Error("invalid result");
    }
    lastResult = data;
    render();
    result.hidden = false;
  } catch (reason) {
    if (reason instanceof TypeError) showOffline();
    else {
      errorKind = reason?.message === "invalid result" ? "invalid" : "failed";
      render();
      error.hidden = false;
    }
  } finally {
    progress.hidden = true;
    start.disabled = !connected;
  }
});

render();
void checkConnection();
setInterval(() => { if (progress.hidden) void checkConnection(); }, 5000);
