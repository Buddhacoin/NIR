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
    catalogTitle: "Каталог открытых моделей", catalogIntro: "Можно посмотреть замеченные ревизии открытых моделей; запускать их здесь пока нельзя. Встроенная Iris выше — единственная доступная проверка.",
    catalogModel: "Модель", catalogVersion: "Замеченная ревизия (точный commit SHA)",
    catalogPlaceholder: "Выберите модель", catalogVersionPlaceholder: "Сначала выберите модель", catalogChooseRevision: "Выберите ревизию",
    catalogRefresh: "Обновить сведения", catalogLoading: "Загружаем сведения о версиях…",
    catalogFresh: "Сведения доступны. Выбранная ревизия не меняется автоматически; запросы ограничены разом в 30 секунд.",
    catalogStale: "Не удалось обновить все сведения. Показаны ранее загруженные версии; они могут устареть.",
    catalogUnavailable: "Сведения о моделях недоступны. Проверьте соединение и повторите позже.",
    catalogNoVersion: "Для этой модели пока нет сведений о замеченных ревизиях.",
    catalogSelected: (repo, sha) => `${repo} · ${sha}. Только просмотр: запуск и награда недоступны.`,
    catalogOlderSelection: "Это ранее замеченная ревизия; её уже нет в кратком списке.",
    catalogNote: "Сведения берутся из публичных метаданных Hugging Face. SHA обозначает версию репозитория, но не проверяет файлы модели. Ничего не скачивается, не исполняется и не даёт права на награду.",
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
    catalogTitle: "Open model catalog", catalogIntro: "Browse observed revisions of open models; they cannot run here yet. The built-in Iris example above is the only available check.",
    catalogModel: "Model", catalogVersion: "Observed revision (exact commit SHA)",
    catalogPlaceholder: "Choose a model", catalogVersionPlaceholder: "Choose a model first", catalogChooseRevision: "Choose a revision",
    catalogRefresh: "Refresh metadata", catalogLoading: "Loading version metadata…",
    catalogFresh: "Metadata is available. The selected revision does not change automatically; requests are limited to once per 30 seconds.",
    catalogStale: "Some metadata could not be refreshed. Previously seen versions are shown and may be outdated.",
    catalogUnavailable: "Model metadata is unavailable. Check your connection and try again later.",
    catalogNoVersion: "No observed revision metadata is available for this model yet.",
    catalogSelected: (repo, sha) => `${repo} · ${sha}. View only: execution and rewards are unavailable.`,
    catalogOlderSelection: "This revision was observed earlier and is no longer in the short list.",
    catalogNote: "Metadata comes from public Hugging Face records. A SHA identifies a repository revision; it does not verify the model files. Nothing is downloaded, executed, or made reward-eligible.",
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
      method: refresh ? "POST" : "GET", ...(refresh ? { body: "" } : {}), cache: "no-store",
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
