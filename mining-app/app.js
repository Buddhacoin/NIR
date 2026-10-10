const start = document.querySelector("#start");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const error = document.querySelector("#error");
const errorMessage = document.querySelector("#error-message");
const connection = document.querySelector("#connection");
const languageButton = document.querySelector("#language");
const catalogModel = document.querySelector("#catalog-model");
const catalogVersion = document.querySelector("#catalog-version");
const catalogState = document.querySelector("#catalog-state");
const catalogRefresh = document.querySelector("#catalog-refresh");
const qwenStart = document.querySelector("#qwen-start");
const qwenState = document.querySelector("#qwen-state");
const qwenAnswer = document.querySelector("#qwen-answer");
const qwenIdentity = document.querySelector("#qwen-identity");
const qwenExport = document.querySelector("#qwen-export");
const qwenReplayFile = document.querySelector("#qwen-replay-file");
const qwenReplay = document.querySelector("#qwen-replay");
const qwenReplayState = document.querySelector("#qwen-replay-state");
const eventPulses = document.querySelector("#event-pulses");
const eventLog = document.querySelector("#event-log");
const qwenAvailability = document.querySelector("#qwen-availability");
const nativeApp = typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("local-app") === "1";
// Native shell injects this before page scripts. The terminal-only browser mode
// receives it in a fragment, which is never sent to HTTP and is removed here.
const fragmentSession = typeof location !== "undefined" &&
  /^#session=[0-9a-f]{64}$/.test(location.hash) ? location.hash.slice(9) : "";
if (fragmentSession) history.replaceState(null, "", `${location.pathname}${location.search}`);
const localSession = nativeApp && typeof window !== "undefined" ? window.__NIR_MODEL_SESSION : fragmentSession;
const sessionHeaders = () => ({ "X-NIR-Session": localSession ?? "" });

function canonicalReplayJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalReplayJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalReplayJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function matchesReplayHash(record) {
  if (!record || !/^sha256:[0-9a-f]{64}$/.test(record.recordHash ?? "") ||
      typeof crypto === "undefined" || !crypto.subtle) return false;
  const { recordHash, ...payload } = record;
  const data = new TextEncoder().encode(`NIR_LOCAL_OPEN_MODEL_REPLAY_V1\0${canonicalReplayJson(payload)}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}` ===
    recordHash;
}

async function fetchQwenJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(path, { ...options,
      headers: { ...options.headers, ...sessionHeaders() }, signal: controller.signal });
    if (!response.body?.getReader) return { response, data: await response.json() };
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) {
        await reader.cancel();
        throw new Error("oversized local response");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response, data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } finally {
    clearTimeout(timeout);
  }
}

const copy = {
  ru: {
    consoleTitle: "Локальная панель оператора", localBadge: "НЕ СЕТЬ",
    roleLabel: "РОЛЬ", roleValue: "Локальный оператор", networkLabel: "ПУБЛИЧНАЯ СЕТЬ",
    networkValue: "Не подключена", rewardLabel: "НАГРАДА", rewardValue: "Недоступна",
    traceTitle: "События интерфейса этой сессии", traceScale: "ПОРЯДОК →",
    traceAria: "Последовательность событий локального интерфейса без процента выполнения",
    modelsTitle: "Доступность локальных моделей",
    irisScope: "Встроенная проверка", qwenScope: "Закреплённый локальный запуск",
    bundled: "ВСТРОЕНА", reportedReady: "СООБЩАЕТ: ГОТОВА", checkingShort: "ПРОВЕРКА", unavailableShort: "НЕДОСТУПНА",
    localOnly: "Адрес кошелька не подключён. Эта панель показывает только действия на этом Mac: она не отправляет заявку и не обещает NIR.",
    test: "ТЕСТ", eyebrow: "Локальная тренировка", headline: "Проверка модели Iris",
    description: "Локально обучим два классификатора на 120 примерах и проверим их на 30 новых. Результаты и свидетельства будут проверены на этом Mac.",
    start: "Проверить модель Iris", safety: "Не нужен кошелёк, пароль, секретная фраза или оплата.",
    runningTitle: "Модель выполняется на этом Mac…",
    runningBody: "Проверяем исходную и улучшенную модель, затем целостность набора свидетельств.",
    doneTitle: "Локальная проверка завершена",
    doneBody: "Набор свидетельств проверен локально. Независимых операторов, скрытых заданий, подтверждённого измерения энергии и сетевой награды нет.",
    technicalTitle: "Технический результат", errorTitle: "Локальная проверка не завершилась",
    footer: "Публичный майнинг и реальные NIR недоступны. Iris встроена; Qwen запускается только после отдельного согласия и загрузки закреплённых файлов. Программа не является песочницей и не принимает произвольный код.",
    checking: "Проверяем подключение к локальному сервису…", online: "● Локальный сервис подключён",
    offline: "● Локальный сервис отключён",
    offlineMessage: "Локальный сервис NIR недоступен. Повторно запустите `npm run mine:app` из доверенной копии NIR и используйте новую вкладку, которую откроет приложение. Старый адрес может больше не работать.",
    offlineMessageNative: "Локальный сервис остановился. Закройте окно и снова откройте NIR Model Lab.app. Если ошибка повторится, проверьте локальную сборку и Node/Python; награды не было.",
    failed: "Локальная проверка не завершилась. Заявка не отправлена, награда не начислена.",
    invalid: "Результат локальной проверки не подтверждён. Награда не начислена.",
    score: (baseline, candidate, count) => `Точность: исходная модель ${baseline} %, улучшенная ${candidate} % · ${count} примеров.`,
    hash: (value) => `Хеш проверенного набора: ${value}`,
    catalogTitle: "Каталог открытых моделей", catalogIntro: "Можно посмотреть замеченные ревизии открытых моделей. Произвольную ревизию запускать здесь нельзя; отдельный закреплённый запуск Qwen доступен ниже.",
    catalogModel: "Модель", catalogVersion: "Замеченная ревизия (точный commit SHA)",
    catalogPlaceholder: "Выберите модель", catalogVersionPlaceholder: "Сначала выберите модель", catalogChooseRevision: "Выберите ревизию",
    catalogRefresh: "Обновить сведения", catalogLoading: "Загружаем сведения о версиях…",
    catalogFresh: "Сведения доступны. Выбранная ревизия не меняется автоматически; запросы ограничены разом в 30 секунд.",
    catalogStale: "Не удалось обновить все сведения. Показаны ранее загруженные версии; они могут устареть.",
    catalogUnavailable: "Сведения о моделях недоступны. Проверьте соединение и повторите позже.",
    catalogNoVersion: "Для этой модели пока нет сведений о замеченных ревизиях.",
    catalogSelected: (repo, sha) => `${repo} · ${sha}. Только просмотр: запуск и награда недоступны.`,
    catalogOlderSelection: "Это ранее замеченная ревизия; её уже нет в кратком списке.",
    catalogNote: "Сведения берутся из публичных метаданных Hugging Face. SHA обозначает версию репозитория, но не проверяет файлы модели. Выбор ревизии в каталоге ничего не скачивает и не запускает; награда недоступна.",
    qwenTitle: "Локальный запуск Qwen3-0.6B", qwenIntro: "Открытая языковая модель Qwen. Однократный запуск закреплённой версии: загрузка около 1,5 ГБ, максимум 4 ГиБ проверяемых файлов. Во время проверки хранятся две копии; до загрузки требуется свободное место не меньше удвоенного размера файлов плюс 1 ГиБ. Нужны Apple Silicon, Python 3.13 и дополнительные библиотеки. Без независимой проверки, заявки и награды.",
    qwenStart: "Скачать и запустить Qwen локально",
    qwenConfirm: "Разрешить загрузку модели Qwen3-0.6B (около 1,5 ГБ; не более 4 ГиБ проверяемых файлов)? Программа проверит запас места для двух копий файлов и 1 ГиБ резерва. Это не майнинг и не начислит NIR.",
    qwenRunning: "Скачиваем закреплённые файлы и запускаем локальный вывод. Приложение проверяет состояние задания; это может занять до 30 минут. Не закрывайте вкладку.",
    qwenRunningNative: "Скачиваем закреплённые файлы и запускаем локальный вывод. Это может занять до 30 минут. Не закрывайте окно приложения.",
    qwenFailed: "Модель не запустилась. Проверьте Apple Silicon, Python 3.13, установленные зависимости и подключение. Заявка не отправлена, награда не начислена.",
    qwenFailedNative: "Модель не запустилась. Проверьте Apple Silicon, среду Python 3.13, выбранную при сборке, зависимости и подключение. Заявка не отправлена, награда не начислена.",
    qwenInvalid: "Результат локального запуска не подтверждён. Заявка не отправлена, награда не начислена.",
    qwenDone: "Локальный вывод выполнен. Независимой проверки и награды нет.",
    qwenAnswer: (answer) => `Ответ локального сервиса (не независимое свидетельство): ${answer}`,
    qwenIdentity: (identity) => `Идентификатор локального пакета (не доказательство выполнения): ${identity}`,
    qwenExport: "Скачать запись для локального повторного запуска (не доказательство награды)",
    qwenReplayLabel: "Запись другого запуска (.json, не более 16 КБ)",
    qwenReplay: "Повторить запуск на этом Mac",
    qwenReplayRunning: "Повторно скачиваем закреплённую модель и сравниваем ответ. Это локальный повтор, не независимое подтверждение или награда.",
    qwenReplayMatched: "Локальный повтор совпал по пакету и ответу. Запись не подписана; независимой проверки и награды нет.",
    qwenReplayFailed: "Повтор не завершился или ответ отличается. Независимая проверка и награда отсутствуют.",
    qwenReplayInvalid: "Выберите действительную запись JSON до 16 КБ. Файл не является доказательством выполнения.",
    qwenRuntimeChecking: "Проверяем локальную среду Qwen без загрузки модели…",
    qwenRuntimeUnavailable: "Не удалось проверить среду Qwen. Перезапустите приложение из доверенной копии NIR.",
    qwenRuntimeUnavailableNative: "Не удалось проверить среду Qwen. Закройте окно и снова откройте NIR Model Lab.app; если ошибка повторится, пересоберите из доверенной копии NIR.",
    qwenUnsupported: "Для Qwen нужен Mac с Apple Silicon. На этом устройстве запуск недоступен.",
    qwenPython: "Для Qwen нужен Python 3.13. Установите его и запустите приложение с ним в PATH.",
    qwenPythonNative: "Для Qwen нужен Python 3.13. Создайте новую локальную Mac-сборку, выбрав эту среду до сборки.",
    qwenDependencies: (name) => `Нет закреплённой зависимости ${name}. Создайте отдельную Python 3.13 venv, установите mlx==0.32.3, mlx-lm==0.32.0, transformers==5.17.0; запустите приложение из активированной venv.`,
    qwenDependenciesNative: (name) => `Нет закреплённой зависимости ${name}. Нужна Python 3.13 venv с mlx==0.32.3, mlx-lm==0.32.0, transformers==5.17.0; затем создайте новую локальную Mac-сборку с ней.`,
    qwenReady: "Среда проверена локально. Загрузка модели начнётся только после подтверждения.",
  },
  en: {
    consoleTitle: "Local operator console", localBadge: "NOT A NETWORK",
    roleLabel: "ROLE", roleValue: "Local operator", networkLabel: "PUBLIC NETWORK",
    networkValue: "Not connected", rewardLabel: "REWARD", rewardValue: "Unavailable",
    traceTitle: "Interface events in this session", traceScale: "SEQUENCE →",
    traceAria: "Sequence of local interface events without a completion percentage",
    modelsTitle: "Local model availability",
    irisScope: "Bundled check", qwenScope: "Pinned local run",
    bundled: "BUNDLED", reportedReady: "REPORTS READY", checkingShort: "CHECKING", unavailableShort: "UNAVAILABLE",
    localOnly: "No wallet address is connected. This console shows actions on this Mac only: it submits no claim and promises no NIR.",
    test: "TEST", eyebrow: "Local rehearsal", headline: "Check the Iris model",
    description: "Train two classifiers locally on 120 examples and check them against 30 held-out examples. Results and evidence are checked on this Mac.",
    start: "Check Iris model", safety: "No wallet, password, recovery phrase, or payment is needed.",
    runningTitle: "Model running on this Mac…",
    runningBody: "Checking the baseline and candidate models, then the evidence bundle integrity.",
    doneTitle: "Local check complete",
    doneBody: "The evidence bundle was checked locally. There are no independent operators, hidden challenges, attested energy measurements, or network rewards.",
    technicalTitle: "Technical result", errorTitle: "Local check failed",
    footer: "Public mining and real NIR are unavailable. Iris is bundled; Qwen runs only after separate consent and a pinned download. This is not a sandbox and does not accept arbitrary code.",
    checking: "Checking the local service…", online: "● Local service connected",
    offline: "● Local service disconnected",
    offlineMessage: "The local NIR service is unavailable. Run `npm run mine:app` again from a trusted NIR checkout and use the new browser tab it opens. The old address may no longer work.",
    offlineMessageNative: "The local service stopped. Close this window and reopen NIR Model Lab.app. If it persists, check the local build and Node/Python; no reward was issued.",
    failed: "The local check did not finish. No claim was submitted and no reward was credited.",
    invalid: "The local result could not be verified. No reward was credited.",
    score: (baseline, candidate, count) => `Accuracy: baseline ${baseline}%, candidate ${candidate}% · ${count} examples.`,
    hash: (value) => `Verified bundle hash: ${value}`,
    catalogTitle: "Open model catalog", catalogIntro: "Browse observed open-model revisions. Arbitrary revisions cannot run here; a separate pinned Qwen run is available below.",
    catalogModel: "Model", catalogVersion: "Observed revision (exact commit SHA)",
    catalogPlaceholder: "Choose a model", catalogVersionPlaceholder: "Choose a model first", catalogChooseRevision: "Choose a revision",
    catalogRefresh: "Refresh metadata", catalogLoading: "Loading version metadata…",
    catalogFresh: "Metadata is available. The selected revision does not change automatically; requests are limited to once per 30 seconds.",
    catalogStale: "Some metadata could not be refreshed. Previously seen versions are shown and may be outdated.",
    catalogUnavailable: "Model metadata is unavailable. Check your connection and try again later.",
    catalogNoVersion: "No observed revision metadata is available for this model yet.",
    catalogSelected: (repo, sha) => `${repo} · ${sha}. View only: execution and rewards are unavailable.`,
    catalogOlderSelection: "This revision was observed earlier and is no longer in the short list.",
    catalogNote: "Metadata comes from public Hugging Face records. A SHA identifies a repository revision; it does not verify model files. Choosing a catalog revision downloads or runs nothing; no reward is available.",
    qwenTitle: "Run Qwen3-0.6B locally", qwenIntro: "Open Qwen language model. One pinned-revision run: about 1.5 GB downloaded, up to 4 GiB of checked files. Verification holds two copies; before downloading, free space must exceed twice the file size plus 1 GiB. Requires Apple Silicon, Python 3.13, and optional libraries. No independent verification, claim, or reward.",
    qwenStart: "Download and run Qwen locally",
    qwenConfirm: "Allow the Qwen3-0.6B download (about 1.5 GB; up to 4 GiB of checked files)? The app checks free space for two file copies plus 1 GiB of headroom. This is not mining and will not credit NIR.",
    qwenRunning: "Downloading pinned files and running local inference. The app checks job progress; this can take up to 30 minutes. Keep this tab open.",
    qwenRunningNative: "Downloading pinned files and running local inference. This can take up to 30 minutes. Keep the app window open.",
    qwenFailed: "The model could not run. Check Apple Silicon, Python 3.13, installed dependencies, and connectivity. No claim was submitted or reward credited.",
    qwenFailedNative: "The model could not run. Check Apple Silicon, the Python 3.13 environment selected when building, dependencies, and connectivity. No claim was submitted or reward credited.",
    qwenInvalid: "The local result could not be confirmed. No claim was submitted or reward credited.",
    qwenDone: "Local inference completed. There was no independent verification or reward.",
    qwenAnswer: (answer) => `Local service answer (not independent evidence): ${answer}`,
    qwenIdentity: (identity) => `Local package ID (not proof of execution): ${identity}`,
    qwenExport: "Download local replay record (not reward proof)",
    qwenReplayLabel: "Another run's record (.json, at most 16 KB)",
    qwenReplay: "Rerun on this Mac",
    qwenReplayRunning: "Downloading the pinned model again and comparing its answer. This is a local rerun, not independent attestation or a reward.",
    qwenReplayMatched: "Local rerun matched package and answer. The record is unsigned; there is no independent verification or reward.",
    qwenReplayFailed: "Rerun failed or the answer differed. No independent verification or reward.",
    qwenReplayInvalid: "Choose a valid JSON record up to 16 KB. The file is not execution proof.",
    qwenRuntimeChecking: "Checking the local Qwen runtime without downloading a model…",
    qwenRuntimeUnavailable: "Could not check the Qwen runtime. Restart the app from a trusted NIR checkout.",
    qwenRuntimeUnavailableNative: "Could not check the Qwen runtime. Close and reopen NIR Model Lab.app; if it persists, rebuild from a trusted NIR checkout.",
    qwenUnsupported: "Qwen requires an Apple Silicon Mac. It cannot run on this device.",
    qwenPython: "Qwen requires Python 3.13. Install it and start the app with that interpreter in PATH.",
    qwenPythonNative: "Qwen requires Python 3.13. Make a new local Mac build with that environment selected before building.",
    qwenDependencies: (name) => `Pinned dependency ${name} is unavailable or has the wrong version. Create a separate Python 3.13 venv, install mlx==0.32.3, mlx-lm==0.32.0, transformers==5.17.0, and start the app from the activated venv.`,
    qwenDependenciesNative: (name) => `Pinned dependency ${name} is missing or has the wrong version. Use a Python 3.13 venv with mlx==0.32.3, mlx-lm==0.32.0, transformers==5.17.0, then make a new local Mac build with it.`,
    qwenReady: "Local runtime checked. Model download starts only after confirmation.",
  },
};

let locale = typeof navigator !== "undefined" && !/^ru\b/i.test(navigator.language || "") ? "en" : "ru";
try { const saved = localStorage.getItem("nir-mining-locale"); if (saved === "en" || saved === "ru") locale = saved; } catch {}
let connected = false;
let checking = false;
let statusRequestRunning = false;
let errorKind = null;
let lastResult = null;
let catalogData = null;
let catalogLoading = false;
let qwenRunning = false;
let qwenStatus = null;
let qwenLastResult = null;
let qwenRuntime = { status: "checking-runtime" };
let replayRunning = false;
let replayStatus = null;
const localEvents = [];
let lastServiceState = null;
let lastRuntimeState = null;

const eventCopy = {
  ru: {
    "ui-ready": "Интерфейс готов", "service-online": "Локальный сервис ответил: готов",
    "service-offline": "Локальный сервис недоступен", "runtime-ready": "Среда Qwen сообщает готовность",
    "runtime-unavailable": "Среда Qwen недоступна", "iris-requested": "Запрошена проверка Iris",
    "iris-result": "Локальный результат Iris получен", "iris-failed": "Проверка Iris не завершена",
    "qwen-started": "Сервис принял запрос Qwen", "qwen-result": "Локальный результат Qwen получен",
    "qwen-failed": "Локальный запуск Qwen не завершён",
  },
  en: {
    "ui-ready": "Interface ready", "service-online": "Local service responded: ready",
    "service-offline": "Local service unavailable", "runtime-ready": "Qwen runtime reports ready",
    "runtime-unavailable": "Qwen runtime unavailable", "iris-requested": "Iris check requested",
    "iris-result": "Local Iris result received", "iris-failed": "Iris check did not finish",
    "qwen-started": "Service accepted Qwen request", "qwen-result": "Local Qwen result received",
    "qwen-failed": "Local Qwen run did not finish",
  },
};

function renderEventTrace() {
  if (!eventPulses || !eventLog) return;
  eventPulses.replaceChildren();
  eventLog.replaceChildren();
  for (const [index, event] of localEvents.entries()) {
    const pulse = document.createElement("span");
    pulse.className = "event-pulse";
    pulse.style.setProperty("--event-position", localEvents.length === 1 ? "0%" :
      `${(index / (localEvents.length - 1)) * 100}%`);
    pulse.title = `${event.time} · ${eventCopy[locale][event.kind]}`;
    eventPulses.append(pulse);
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = event.dateTime;
    time.textContent = event.time;
    const label = document.createElement("span");
    label.textContent = eventCopy[locale][event.kind];
    item.append(time, label);
    eventLog.append(item);
  }
}

function recordLocalEvent(kind) {
  if (!eventCopy.ru[kind] || !eventCopy.en[kind]) return;
  const now = new Date();
  localEvents.push({ kind, dateTime: now.toISOString(), time: now.toLocaleTimeString(locale, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }) });
  if (localEvents.length > 8) localEvents.shift();
  renderEventTrace();
}

function qwenRuntimeMessage(t) {
  const status = qwenRuntime?.status;
  if (status === "pinned-qwen-runtime-ready") return t.qwenReady;
  if (status === "unsupported-machine") return t.qwenUnsupported;
  if (status === "python-3.13-required") return nativeApp ? t.qwenPythonNative : t.qwenPython;
  if (status === "missing-runtime" || status === "runtime-version-mismatch")
    return (nativeApp ? t.qwenDependenciesNative : t.qwenDependencies)(qwenRuntime.package);
  return status === "checking-runtime" ? t.qwenRuntimeChecking :
    nativeApp ? t.qwenRuntimeUnavailableNative : t.qwenRuntimeUnavailable;
}

async function loadQwenRuntime() {
  if (!qwenStart) return;
  try {
    const response = await fetch("/open-model/runtime", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !["pinned-qwen-runtime-ready", "unsupported-machine",
      "python-3.13-required", "missing-runtime", "runtime-version-mismatch"].includes(data.status) ||
      (data.package && !["mlx", "mlx-lm", "transformers"].includes(data.package)))
      throw new Error("invalid runtime check");
    qwenRuntime = data;
  } catch { qwenRuntime = { status: "runtime-check-unavailable" }; }
  const runtimeState = qwenRuntime.status === "pinned-qwen-runtime-ready" ? "runtime-ready" :
    "runtime-unavailable";
  if (lastRuntimeState !== runtimeState) {
    recordLocalEvent(runtimeState);
    lastRuntimeState = runtimeState;
  }
  render();
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function renderCatalog() {
  if (!catalogModel) return;
  const t = copy[locale];
  const previousModel = catalogModel.value;
  const previousVersion = catalogVersion.value;
  catalogModel.replaceChildren(option("", t.catalogPlaceholder));
  for (const entry of catalogData?.entries ?? []) {
    catalogModel.append(option(entry.repo, `${entry.provider} · ${entry.name}`));
  }
  catalogModel.value = catalogData?.entries.some((entry) => entry.repo === previousModel) ? previousModel : "";
  const selected = catalogData?.entries.find((entry) => entry.repo === catalogModel.value);
  catalogVersion.replaceChildren(option("", selected ? t.catalogChooseRevision : t.catalogVersionPlaceholder));
  const olderSelection = selected && /^[a-f0-9]{40}$/.test(previousVersion) &&
    !selected.versions.includes(previousVersion);
  if (olderSelection) catalogVersion.append(option(previousVersion, `${previousVersion} · ${t.catalogOlderSelection}`));
  for (const sha of selected?.versions ?? []) catalogVersion.append(option(sha, sha));
  catalogVersion.value = (selected?.versions.includes(previousVersion) || olderSelection) ? previousVersion : "";
  catalogModel.disabled = !catalogData || catalogLoading;
  catalogVersion.disabled = !(selected?.versions.length || olderSelection) || catalogLoading;
  catalogRefresh.disabled = catalogLoading;
  if (catalogLoading) catalogState.textContent = t.catalogLoading;
  else if (catalogVersion.value) catalogState.textContent = `${t.catalogSelected(selected.repo, catalogVersion.value)} ${olderSelection ? t.catalogOlderSelection : ""} ${catalogData.stale ? t.catalogStale : ""}`.trim();
  else if (selected && !selected.versions.length) catalogState.textContent = t.catalogNoVersion;
  else if (!catalogData || catalogData.entries.every((entry) => !entry.versions.length)) catalogState.textContent = t.catalogUnavailable;
  else catalogState.textContent = t[catalogData.stale ? "catalogStale" : "catalogFresh"];
}

async function loadCatalog(refresh = false) {
  if (!catalogModel || catalogLoading) return;
  catalogLoading = true;
  renderCatalog();
  try {
    const response = await fetch(refresh ? "/catalog/refresh" : "/catalog", {
      method: refresh ? "POST" : "GET", ...(refresh ? { body: "", headers: sessionHeaders() } : {}),
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok || data.status !== "read-only-open-model-catalog" ||
        data.rewardEligible !== false || data.runnableRepo !== null ||
        !Array.isArray(data.entries) || data.entries.length > 8 ||
        data.entries.some((entry) => !/^[\w.-]+\/[\w.-]+$/.test(entry.repo) ||
          entry.runnable !== false || !Array.isArray(entry.versions) ||
          entry.versions.some((sha) => !/^[a-f0-9]{40}$/.test(sha)))) {
      throw new Error("invalid catalog");
    }
    catalogData = data;
  } catch {
    if (catalogData) catalogData = { ...catalogData, stale: true };
  } finally { catalogLoading = false; renderCatalog(); }
}

function render() {
  const t = copy[locale];
  document.documentElement.lang = locale;
  document.title = locale === "ru" ? "NIR · Проверка модели" : "NIR · Model check";
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t[node.dataset.i18n];
  for (const node of document.querySelectorAll("[data-i18n-aria]")) {
    if (node.dataset?.i18nAria && typeof node.setAttribute === "function")
      node.setAttribute("aria-label", t[node.dataset.i18nAria]);
  }
  languageButton.textContent = locale === "ru" ? "EN" : "RU";
  languageButton.setAttribute("aria-label", locale === "ru" ? "Switch language to English" : "Переключить язык на русский");
  connection.textContent = checking ? t.checking : connected ? t.online : t.offline;
  if (qwenAvailability) {
    const ready = qwenRuntime.status === "pinned-qwen-runtime-ready";
    const pending = qwenRuntime.status === "checking-runtime";
    qwenAvailability.textContent = t[ready ? "reportedReady" : pending ? "checkingShort" : "unavailableShort"];
    qwenAvailability.dataset.state = ready ? "ready" : pending ? "checking" : "unavailable";
  }
  renderEventTrace();
  if (qwenStart) {
    qwenStart.disabled = !connected || qwenRunning || replayRunning || !progress.hidden ||
      qwenRuntime.status !== "pinned-qwen-runtime-ready";
    qwenState.textContent = qwenStatus ?
      (nativeApp && t[`${qwenStatus}Native`] ? t[`${qwenStatus}Native`] : t[qwenStatus]) :
      qwenRuntimeMessage(t);
    if (qwenLastResult) {
      qwenAnswer.textContent = t.qwenAnswer(qwenLastResult.answer);
      qwenIdentity.textContent = t.qwenIdentity(qwenLastResult.packageIdentity);
    }
  }
  if (qwenReplay) {
    qwenReplay.disabled = !connected || qwenRunning || replayRunning || !progress.hidden ||
      qwenRuntime.status !== "pinned-qwen-runtime-ready" || !qwenReplayFile.files?.length;
    qwenReplayState.textContent = replayStatus ? t[replayStatus] : "";
  }
  if (errorKind) errorMessage.textContent = errorKind === "offlineMessage" && nativeApp ?
    t.offlineMessageNative : t[errorKind];
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
  if (qwenStart) qwenStart.disabled = true;
  if (lastServiceState !== "service-offline") {
    recordLocalEvent("service-offline");
    lastServiceState = "service-offline";
  }
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
    if (progress.hidden && !qwenRunning) start.disabled = false;
    if (errorKind === "offlineMessage") { errorKind = null; error.hidden = true; }
    if (lastServiceState !== "service-online") {
      recordLocalEvent("service-online");
      lastServiceState = "service-online";
    }
    render();
  } catch { showOffline(); }
  finally { clearTimeout(timeout); statusRequestRunning = false; }
}

languageButton.addEventListener("click", () => {
  locale = locale === "ru" ? "en" : "ru";
  try { localStorage.setItem("nir-mining-locale", locale); } catch {}
  render();
  renderCatalog();
});
if (catalogModel) {
  catalogModel.addEventListener("change", () => { catalogVersion.value = ""; renderCatalog(); });
  catalogVersion.addEventListener("change", renderCatalog);
  catalogRefresh.addEventListener("click", () => { void loadCatalog(true); });
  void loadCatalog();
  setInterval(() => { if (document.visibilityState !== "hidden") void loadCatalog(); }, 5 * 60_000);
}

start.addEventListener("click", async () => {
  if (!connected) { showOffline(); return; }
  if (qwenRunning) return;
  start.disabled = true;
  if (qwenStart) qwenStart.disabled = true;
  progress.hidden = false;
  result.hidden = true;
  error.hidden = true;
  errorKind = null;
  recordLocalEvent("iris-requested");
  try {
    const response = await fetch("/model-check", { method: "POST", body: "", headers: sessionHeaders() });
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
    recordLocalEvent("iris-result");
    render();
    result.hidden = false;
  } catch (reason) {
    if (reason instanceof TypeError) showOffline();
    else {
      recordLocalEvent("iris-failed");
      errorKind = reason?.message === "invalid result" ? "invalid" : "failed";
      render();
      error.hidden = false;
    }
  } finally {
    progress.hidden = true;
    start.disabled = !connected;
    render();
  }
});

if (qwenStart) qwenStart.addEventListener("click", async () => {
  if (!connected || qwenRunning || replayRunning || !progress.hidden ||
      qwenRuntime.status !== "pinned-qwen-runtime-ready") return;
  if (!window.confirm(copy[locale].qwenConfirm)) return;
  qwenRunning = true;
  qwenStatus = "qwenRunning";
  qwenLastResult = null;
  qwenAnswer.hidden = true;
  qwenIdentity.hidden = true;
  if (qwenExport) qwenExport.hidden = true;
  start.disabled = true;
  render();
  try {
    const { response, data: started } = await fetchQwenJson("/open-model/qwen-check", {
      method: "POST", body: "", headers: { "X-NIR-Download-Consent": "qwen3-0.6b-up-to-4gib" },
    });
    if (response.status !== 202 || started.status !== "running" ||
        !/^[a-f0-9]{32}$/.test(started.jobId)) throw new Error("qwen failed");
    recordLocalEvent("qwen-started");
    const deadline = Date.now() + 30 * 60_000;
    let data;
    while (Date.now() < deadline) {
      const { response: check, data: polled } = await fetchQwenJson(
        `/open-model/jobs/${started.jobId}`, { cache: "no-store" });
      data = polled;
      if (check.status === 200) break;
      if (check.status !== 202 || data.status !== "running") throw new Error("qwen failed");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (data?.status !== "local-open-model-inference-only") throw new Error("qwen failed");
    if (data.status !== "local-open-model-inference-only" ||
        data.repository !== "Qwen/Qwen3-0.6B" ||
        data.revision !== "c1899de289a04d12100db370d81485cdf75e47ca" ||
        !/^sha256:[0-9a-f]{64}$/.test(data.packageIdentity) ||
        typeof data.answer !== "string" || data.answer.length > 4096 ||
        data.rewardEligible !== false || data.networkSubmitted !== false ||
        data.independentlyVerified !== false ||
        data.record?.format !== "nir-local-open-model-replay-v1" ||
        Object.keys(data.record).sort().join(",") !== ["answer", "format", "generation",
          "independentlyVerified", "networkSubmitted", "packageIdentity", "prompt",
          "recordHash", "repository", "revision", "rewardEligible", "runtimeDeclaration",
          "scope"].sort().join(",") ||
        data.record.scope !== "non-reward-local-replay" ||
        data.record.repository !== data.repository || data.record.revision !== data.revision ||
        data.record.packageIdentity !== data.packageIdentity || data.record.answer !== data.answer ||
        data.record.prompt !== "Reply with the single word NIR." ||
        !/^sha256:[0-9a-f]{64}$/.test(data.record.recordHash) ||
        data.record.rewardEligible !== false || data.record.networkSubmitted !== false ||
        data.record.independentlyVerified !== false ||
        JSON.stringify(data.record.generation) !== JSON.stringify({ temperature: "0", maxTokens: 32 }) ||
        JSON.stringify(data.record.runtimeDeclaration) !== JSON.stringify({
          mlx: "0.32.3", "mlx-lm": "0.32.0", transformers: "5.17.0",
        }) ||
        !(await matchesReplayHash(data.record))) throw new Error("invalid qwen result");
    qwenLastResult = data;
    qwenAnswer.hidden = false;
    qwenIdentity.hidden = false;
    if (qwenExport) qwenExport.hidden = false;
    qwenStatus = "qwenDone";
    recordLocalEvent("qwen-result");
  } catch (reason) {
    recordLocalEvent("qwen-failed");
    qwenStatus = reason?.message === "invalid qwen result" ? "qwenInvalid" : "qwenFailed";
  } finally {
    qwenRunning = false;
    start.disabled = !connected;
    render();
  }
});

if (qwenReplayFile) qwenReplayFile.addEventListener("change", () => {
  replayStatus = null;
  render();
});
if (qwenReplay) qwenReplay.addEventListener("click", async () => {
  if (!connected || qwenRunning || replayRunning || !progress.hidden ||
      qwenRuntime.status !== "pinned-qwen-runtime-ready") return;
  const file = qwenReplayFile.files?.[0];
  if (!file || file.size < 1 || file.size > 16_384) {
    replayStatus = "qwenReplayInvalid";
    render();
    return;
  }
  if (!window.confirm(copy[locale].qwenConfirm)) return;
  replayRunning = true;
  replayStatus = "qwenReplayRunning";
  start.disabled = true;
  render();
  try {
    const bytes = await file.text();
    if (new TextEncoder().encode(bytes).length !== file.size) throw new Error("invalid record");
    let imported;
    try { imported = JSON.parse(bytes); } catch { throw new Error("invalid record"); }
    if (!(await matchesReplayHash(imported))) throw new Error("invalid record");
    const { response, data: started } = await fetchQwenJson("/open-model/replay", {
      method: "POST", body: bytes, headers: { "Content-Type": "application/json",
        "X-NIR-Download-Consent": "qwen3-0.6b-up-to-4gib" },
    });
    if (response.status === 400 || response.status === 403) throw new Error("invalid record");
    if (response.status !== 202 || started.status !== "running" ||
        !/^[a-f0-9]{32}$/.test(started.jobId)) throw new Error("replay failed");
    const deadline = Date.now() + 30 * 60_000;
    let matched = false;
    while (Date.now() < deadline) {
      const { response: check, data } = await fetchQwenJson(
        `/open-model/jobs/${started.jobId}`, { cache: "no-store" });
      if (check.status === 200) {
        matched = data.status === "local-replay-matched" &&
          data.recordHash === imported.recordHash &&
          data.rewardEligible === false && data.networkSubmitted === false &&
          data.independentlyVerified === false;
        break;
      }
      if (check.status !== 202 || data.status !== "running") throw new Error("replay failed");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!matched) throw new Error("replay failed");
    replayStatus = "qwenReplayMatched";
  } catch (reason) {
    replayStatus = reason?.message === "invalid record" ? "qwenReplayInvalid" : "qwenReplayFailed";
  } finally {
    replayRunning = false;
    start.disabled = !connected;
    render();
  }
});

if (qwenExport) qwenExport.addEventListener("click", () => {
  if (!qwenLastResult?.record || qwenExport.hidden) return;
  const bytes = JSON.stringify(qwenLastResult.record, null, 2) + "\n";
  const blob = new Blob([bytes], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nir-local-replay-${qwenLastResult.record.recordHash.slice(7, 19)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

recordLocalEvent("ui-ready");
render();
void checkConnection();
void loadQwenRuntime();
setInterval(() => { if (progress.hidden) void checkConnection(); }, 5000);
