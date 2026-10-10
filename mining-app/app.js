const start = document.querySelector("#start");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const error = document.querySelector("#error");
const errorMessage = document.querySelector("#error-message");
const irisEvidenceExport = document.querySelector("#iris-evidence-export");
const irisEvidenceState = document.querySelector("#iris-evidence-state");
const irisEvidenceFile = document.querySelector("#iris-evidence-file");
const irisEvidenceVerify = document.querySelector("#iris-evidence-verify");
const irisVerifyState = document.querySelector("#iris-verify-state");
const candidateFile = document.querySelector("#candidate-file");
const candidateCheck = document.querySelector("#candidate-check");
const candidateState = document.querySelector("#candidate-state");
const candidateStress = document.querySelector("#candidate-stress");
const candidateStressState = document.querySelector("#candidate-stress-state");
const connection = document.querySelector("#connection");
const languageButton = document.querySelector("#language");
const walletLinkStart = document.querySelector("#wallet-link-start");
const walletLinkChallenge = document.querySelector("#wallet-link-challenge");
const walletLinkCopy = document.querySelector("#wallet-link-copy");
const walletLinkProof = document.querySelector("#wallet-link-proof");
const walletLinkComplete = document.querySelector("#wallet-link-complete");
const walletLinkState = document.querySelector("#wallet-link-state");
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
let walletLinkPending = null;
let walletLinkAddress = null;

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

async function irisCommitHash(bytes) {
  if (!crypto?.subtle) throw new Error("local hash unavailable");
  const prefix = new TextEncoder().encode("NIR_LOCAL_IRIS_POSTCOMMIT_STRESS_V1\0" +
    "596ffd580471ca4d4880f8e439c7281f3b50d8249a5960353cb200b1490f63a0\0");
  const combined = new Uint8Array(prefix.length + bytes.length);
  combined.set(prefix);
  combined.set(bytes, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
    walletLinkTitle: "Адрес оператора", walletLinkIntro: "Подтвердите владение адресом через установленный NIR Wallet. Пароль и ключ остаются в кошельке. Это локальная привязка без сетевой заявки и начисления.",
    walletLinkStart: "Создать одноразовый запрос", walletLinkCopy: "Скопировать запрос",
    walletLinkProofLabel: "Подписанное доказательство из настроек кошелька",
    walletLinkComplete: "Проверить адрес",
    test: "ТЕСТ", eyebrow: "Локальная тренировка", headline: "Проверка модели Iris",
    description: "Локально обучим два классификатора на 120 примерах и проверим их на 30 новых. Результаты и свидетельства будут проверены на этом Mac.",
    start: "Проверить модель Iris", safety: "Не нужен кошелёк, пароль, секретная фраза или оплата.",
    runningTitle: "Модель выполняется на этом Mac…",
    runningBody: "Проверяем исходную и улучшенную модель, затем целостность набора свидетельств.",
    doneTitle: "Локальная проверка завершена",
    doneBody: "Набор свидетельств проверен локально. Независимых операторов, скрытых заданий, подтверждённого измерения энергии и сетевой награды нет.",
    irisEvidenceExport: "Скачать локальное свидетельство (не заявка и не награда)",
    irisEvidenceFailed: "Свидетельство недоступно. Повторите локальную проверку; заявки и награды нет.",
    irisImportTitle: "Повторить проверку Iris на этом Mac",
    irisImportIntro: "Выберите свидетельство с другого компьютера. Приложение заново запустит только встроенную Iris; файл не может указать программу или путь. Совпадение не доказывает независимость оператора и не даёт награды.",
    irisImportLabel: "Локальное свидетельство Iris (.json, не более 1 МБ)",
    irisImportButton: "Повторить проверку локально",
    irisImportRunning: "Заново выполняем закреплённую Iris на этом Mac…",
    irisImportMatched: (hash) => `Локальный прогон совпал: ${hash}. Личность оператора не подтверждена; заявки и награды нет.`,
    irisImportFailed: "Файл не совпал с новым прогоном или проверка не завершилась. Заявки и награды нет.",
    irisImportInvalid: "Выберите JSON-свидетельство Iris размером до 1 МБ. Оно не является доказательством награды.",
    candidateTitle: "Проверить свой файл модели Iris",
    candidateIntro: "Принимаются только целочисленные веса и смещения линейного классификатора, без программы или ссылок на файлы. Все 30 проверочных примеров Iris публичны: этот результат нельзя использовать для награды.",
    candidateSample: "Скачать пример файла модели",
    candidateLabel: "Файл модели (.json, не более 4 КБ)",
    candidateButton: "Проверить файл локально",
    candidateRunning: "Проверяем вашу модель на публичных примерах Iris…",
    candidateDone: (baseline, candidate, hash) => `Публичная Iris: исходная модель ${baseline} %, ваш файл ${candidate} %. Хеш модели: ${hash}. Это не скрытый тест, не сетевая заявка и не награда.`,
    candidateInvalid: "Файл отклонён: нужен точный JSON только с целочисленными весами и смещениями, без кода. Награды нет.",
    candidateFailed: "Локальная проверка файла не завершилась. Заявки и награды нет.",
    candidateStressButton: "Проверить после фиксации файла",
    candidateStressRunning: "Файл зафиксирован. Выполняем одноразовую локальную стресс-проверку…",
    candidateStressDone: (score, hash, seed) => `Синтетическая стресс-проверка: ${score} % из 90 случаев. Хеш зафиксированных байтов: ${hash}. Seed для повтора: ${seed}. Это публичная Iris с искусственными изменениями: повторными запусками можно выбрать удачный seed. Не скрытые задания, не независимый оператор и не награда.`,
    candidateStressInvalid: "Файл или локальная запись фиксации отклонены. Награды нет.",
    candidateStressFailed: "Локальная фиксация или стресс-проверка не завершилась. После перезапуска приложения незавершённая фиксация теряется; отправьте файл снова. Награды нет.",
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
    walletLinkTitle: "Operator address", walletLinkIntro: "Prove address ownership using the installed NIR Wallet. Your password and key stay in the wallet. This is a local link, with no network claim or reward.",
    walletLinkStart: "Create one-time challenge", walletLinkCopy: "Copy challenge",
    walletLinkProofLabel: "Signed proof from wallet settings", walletLinkComplete: "Verify address",
    test: "TEST", eyebrow: "Local rehearsal", headline: "Check the Iris model",
    description: "Train two classifiers locally on 120 examples and check them against 30 held-out examples. Results and evidence are checked on this Mac.",
    start: "Check Iris model", safety: "No wallet, password, recovery phrase, or payment is needed.",
    runningTitle: "Model running on this Mac…",
    runningBody: "Checking the baseline and candidate models, then the evidence bundle integrity.",
    doneTitle: "Local check complete",
    doneBody: "The evidence bundle was checked locally. There are no independent operators, hidden challenges, attested energy measurements, or network rewards.",
    irisEvidenceExport: "Download local evidence (not a claim or reward)",
    irisEvidenceFailed: "Evidence is unavailable. Repeat the local check; no claim or reward exists.",
    irisImportTitle: "Rerun Iris evidence on this Mac",
    irisImportIntro: "Choose evidence from another computer. This app reruns only its bundled Iris code; the file cannot select a program or path. A match does not prove operator independence or earn a reward.",
    irisImportLabel: "Local Iris evidence (.json, at most 1 MB)",
    irisImportButton: "Rerun locally",
    irisImportRunning: "Rerunning the pinned Iris model on this Mac…",
    irisImportMatched: (hash) => `Local rerun matched: ${hash}. Operator identity is unverified; there is no claim or reward.`,
    irisImportFailed: "The file did not match a fresh run, or verification failed. No claim or reward exists.",
    irisImportInvalid: "Choose an Iris JSON evidence file up to 1 MB. It is not reward proof.",
    candidateTitle: "Check your Iris model file",
    candidateIntro: "Only integer weights and biases for a linear classifier are accepted, with no program or file paths. All 30 Iris evaluation examples are public: this result cannot earn a reward.",
    candidateSample: "Download a sample model file",
    candidateLabel: "Model file (.json, at most 4 KB)",
    candidateButton: "Check file locally",
    candidateRunning: "Checking your model on public Iris examples…",
    candidateDone: (baseline, candidate, hash) => `Public Iris: baseline ${baseline}%, your file ${candidate}%. Model hash: ${hash}. This is not a hidden test, network claim, or reward.`,
    candidateInvalid: "File refused: exact JSON with integer weights and biases only, no code. No reward exists.",
    candidateFailed: "Local file check did not finish. No claim or reward exists.",
    candidateStressButton: "Check after fixing the file",
    candidateStressRunning: "File committed. Running a one-use local stress check…",
    candidateStressDone: (score, hash, seed) => `Synthetic stress check: ${score}% over 90 cases. Committed byte hash: ${hash}. Replay seed: ${seed}. This is public Iris with artificial changes; repeated runs can cherry-pick a favorable seed. Not hidden tasks, an independent operator, or a reward.`,
    candidateStressInvalid: "The file or local commitment was refused. No reward exists.",
    candidateStressFailed: "Local commit or stress check did not finish. A restart loses an unfinished commit; submit the file again. No reward exists.",
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
let irisVerifyRunning = false;
let irisVerifyStatus = null;
let irisVerifyHash = null;
let candidateRunning = false;
let candidateStatus = null;
let candidateResult = null;
let candidateStressStatus = null;
let candidateStressResult = null;
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
  if (walletLinkAddress) document.querySelector(".local-only").textContent = locale === "ru"
    ? `Локально подтверждено владение адресом ${walletLinkAddress}. Сеть не подключена, заявки и награды нет.`
    : `Local ownership of ${walletLinkAddress} verified. No network, claim, or reward is connected.`;
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
    qwenStart.disabled = !connected || qwenRunning || replayRunning || irisVerifyRunning || candidateRunning || !progress.hidden ||
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
    qwenReplay.disabled = !connected || qwenRunning || replayRunning || irisVerifyRunning || candidateRunning || !progress.hidden ||
      qwenRuntime.status !== "pinned-qwen-runtime-ready" || !qwenReplayFile.files?.length;
    qwenReplayState.textContent = replayStatus ? t[replayStatus] : "";
  }
  if (errorKind) errorMessage.textContent = errorKind === "offlineMessage" && nativeApp ?
    t.offlineMessageNative : t[errorKind];
  if (irisEvidenceExport) irisEvidenceExport.hidden = lastResult?.evidenceAvailable !== true;
  if (irisEvidenceVerify) {
    irisEvidenceVerify.disabled = !connected || irisVerifyRunning || candidateRunning || qwenRunning || replayRunning ||
      !progress.hidden || !irisEvidenceFile?.files?.length;
    irisVerifyState.textContent = irisVerifyStatus === "irisImportMatched" ?
      t.irisImportMatched(irisVerifyHash) : irisVerifyStatus ? t[irisVerifyStatus] : "";
  }
  if (candidateCheck) {
    candidateCheck.disabled = !connected || candidateRunning || irisVerifyRunning ||
      qwenRunning || replayRunning || !progress.hidden || !candidateFile?.files?.length;
    candidateState.textContent = candidateStatus === "candidateDone" && candidateResult ?
      t.candidateDone((candidateResult.baselineAccuracyBps / 100).toFixed(2),
        (candidateResult.candidateAccuracyBps / 100).toFixed(2), candidateResult.modelHash) :
      candidateStatus ? t[candidateStatus] : "";
  }
  if (candidateStress) {
    candidateStress.disabled = !connected || candidateRunning || irisVerifyRunning ||
      qwenRunning || replayRunning || !progress.hidden || !candidateFile?.files?.length;
    candidateStressState.textContent = candidateStressStatus === "candidateStressDone" && candidateStressResult ?
      t.candidateStressDone((candidateStressResult.candidateAccuracyBps / 100).toFixed(2),
        candidateStressResult.commitHash, candidateStressResult.seed) :
      candidateStressStatus ? t[candidateStressStatus] : "";
  }
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
  walletLinkAddress = null;
  walletLinkPending = null;
  if (walletLinkChallenge) { walletLinkChallenge.value = ""; walletLinkChallenge.hidden = true; }
  if (walletLinkCopy) walletLinkCopy.hidden = true;
  if (walletLinkProof) walletLinkProof.value = "";
  if (walletLinkState) walletLinkState.textContent = locale === "ru"
    ? "Локальный сервис остановился. Привязка адреса сброшена."
    : "Local service stopped. Address link was cleared.";
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
  if (qwenRunning || replayRunning || irisVerifyRunning || candidateRunning) return;
  start.disabled = true;
  if (qwenStart) qwenStart.disabled = true;
  progress.hidden = false;
  result.hidden = true;
  error.hidden = true;
  errorKind = null;
  lastResult = null;
  if (irisEvidenceState) irisEvidenceState.textContent = "";
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
        !/^[0-9a-f]{64}$/.test(data.bundleHash) ||
        typeof data.evidenceAvailable !== "boolean") {
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

if (irisEvidenceExport) irisEvidenceExport.addEventListener("click", async () => {
  if (!connected || lastResult?.evidenceAvailable !== true || irisEvidenceExport.hidden) return;
  try {
    const response = await fetch("/model-evidence", { headers: sessionHeaders(), cache: "no-store" });
    if (!response.ok || !response.body) throw new Error("evidence unavailable");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); throw new Error("oversized evidence"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const item = JSON.parse(new TextDecoder().decode(bytes));
    if (item?.format !== "nir-local-iris-evidence-v1" ||
        item.summary?.bundleHash !== lastResult.bundleHash ||
        item.bundle?.bundle_hash !== lastResult.bundleHash ||
        item.summary?.networkSubmitted !== false || item.summary?.rewardCredited !== false ||
        item.summary?.independentOperators !== false) throw new Error("invalid evidence");
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `nir-local-iris-${lastResult.bundleHash.slice(0, 12)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (irisEvidenceState) irisEvidenceState.textContent = "";
  } catch {
    if (irisEvidenceState) irisEvidenceState.textContent = copy[locale].irisEvidenceFailed;
  }
});

if (irisEvidenceFile) irisEvidenceFile.addEventListener("change", () => {
  irisVerifyStatus = null;
  irisVerifyHash = null;
  render();
});
if (irisEvidenceVerify) irisEvidenceVerify.addEventListener("click", async () => {
  const file = irisEvidenceFile?.files?.[0];
  if (!connected || irisVerifyRunning || candidateRunning || qwenRunning || replayRunning || !progress.hidden || !file) return;
  if (file.size < 1 || file.size > 1_000_000) {
    irisVerifyStatus = "irisImportInvalid";
    render();
    return;
  }
  irisVerifyRunning = true;
  irisVerifyStatus = "irisImportRunning";
  irisVerifyHash = null;
  start.disabled = true;
  render();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 35_000);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const item = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (item?.format !== "nir-local-iris-evidence-v1" ||
        !/^[0-9a-f]{64}$/.test(item.summary?.bundleHash ?? "") ||
        item.summary?.rewardCredited !== false || item.summary?.networkSubmitted !== false)
      throw new Error("invalid file");
    const response = await fetch("/model-evidence/verify", { method: "POST", body: bytes,
      headers: { ...sessionHeaders(), "Content-Type": "application/json" }, signal: controller.signal });
    const checked = await response.json();
    if (!response.ok || checked?.status !== "local-iris-evidence-matched" ||
        checked.bundleHash !== item.summary.bundleHash ||
        checked.independentlyVerified !== false || checked.networkSubmitted !== false ||
        checked.rewardEligible !== false) throw new Error("replay failed");
    irisVerifyHash = checked.bundleHash;
    irisVerifyStatus = "irisImportMatched";
  } catch (reason) {
    irisVerifyStatus = reason?.message === "invalid file" || reason instanceof SyntaxError ?
      "irisImportInvalid" : "irisImportFailed";
  } finally {
    clearTimeout(deadline);
    irisVerifyRunning = false;
    start.disabled = !connected;
    render();
  }
});

if (candidateFile) candidateFile.addEventListener("change", () => {
  candidateStatus = null;
  candidateResult = null;
  candidateStressStatus = null;
  candidateStressResult = null;
  render();
});
if (candidateCheck) candidateCheck.addEventListener("click", async () => {
  const file = candidateFile?.files?.[0];
  if (!connected || candidateRunning || irisVerifyRunning || qwenRunning || replayRunning ||
      !progress.hidden || !file) return;
  if (file.size < 1 || file.size > 4096) {
    candidateStatus = "candidateInvalid";
    render();
    return;
  }
  candidateRunning = true;
  candidateStatus = "candidateRunning";
  candidateResult = null;
  start.disabled = true;
  render();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const response = await fetch("/candidate/iris-linear", { method: "POST", body: bytes,
      headers: { ...sessionHeaders(), "Content-Type": "application/json" }, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 400 || response.status === 403 ? "invalid" : "failed");
    if (data?.status !== "local-iris-data-model-evaluated" ||
        data.scope !== "public-iris-data-only" || data.caseCount !== 30 ||
        !/^sha256:[0-9a-f]{64}$/.test(data.modelHash) ||
        data.datasetHash !== "sha256:596ffd580471ca4d4880f8e439c7281f3b50d8249a5960353cb200b1490f63a0" ||
        !Number.isSafeInteger(data.baselineAccuracyBps) || !Number.isSafeInteger(data.candidateAccuracyBps) ||
        data.baselineAccuracyBps < 0 || data.baselineAccuracyBps > 10_000 ||
        data.candidateAccuracyBps < 0 || data.candidateAccuracyBps > 10_000 ||
        data.independentOperators !== false || data.hiddenChallenges !== false ||
        data.networkSubmitted !== false || data.rewardEligible !== false || data.walletChanged !== false ||
        Object.keys(data).sort().join(",") !== ["status", "scope", "modelHash", "datasetHash",
          "baselineAccuracyBps", "candidateAccuracyBps", "caseCount", "independentOperators",
          "hiddenChallenges", "networkSubmitted", "rewardEligible", "walletChanged"].sort().join(","))
      throw new Error("invalid");
    candidateResult = data;
    candidateStatus = "candidateDone";
  } catch (reason) {
    candidateStatus = reason?.message === "invalid" ? "candidateInvalid" : "candidateFailed";
  } finally {
    clearTimeout(deadline);
    candidateRunning = false;
    start.disabled = !connected;
    render();
  }
});

if (candidateStress) candidateStress.addEventListener("click", async () => {
  const file = candidateFile?.files?.[0];
  if (!connected || candidateRunning || irisVerifyRunning || qwenRunning || replayRunning ||
      !progress.hidden || !file) return;
  if (file.size < 1 || file.size > 4096) {
    candidateStressStatus = "candidateStressInvalid";
    render();
    return;
  }
  candidateRunning = true;
  candidateStressStatus = "candidateStressRunning";
  candidateStressResult = null;
  start.disabled = true;
  render();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const commitment = await fetchQwenJson("/candidate/iris-linear/commit", {
      method: "POST", body: bytes, headers: { "Content-Type": "application/json" },
    });
    const fixed = commitment.data;
    if (!commitment.response.ok || fixed?.status !== "local-model-committed" ||
        !/^[a-f0-9]{32}$/.test(fixed.challengeId ?? "") ||
        !/^sha256:[a-f0-9]{64}$/.test(fixed.modelHash ?? "") ||
        fixed.commitHash !== await irisCommitHash(bytes) ||
        fixed.hiddenChallenges !== false || fixed.independentOperators !== false ||
        fixed.networkSubmitted !== false || fixed.rewardEligible !== false || fixed.walletChanged !== false)
      throw new Error(commitment.response.status === 400 ? "invalid" : "failed");
    const revealed = await fetchQwenJson("/candidate/iris-linear/reveal", {
      method: "POST", body: "", headers: { "X-NIR-Challenge": fixed.challengeId },
    });
    const data = revealed.data;
    if (!revealed.response.ok || data?.status !== "local-postcommit-iris-stress" ||
        data.scope !== "public-iris-synthetic-perturbations-only" ||
        data.modelHash !== fixed.modelHash || data.commitHash !== fixed.commitHash ||
        !/^[a-f0-9]{64}$/.test(data.seed ?? "") || data.caseCount !== 90 ||
        !Number.isSafeInteger(data.candidateAccuracyBps) ||
        data.candidateAccuracyBps < 0 || data.candidateAccuracyBps > 10_000 ||
        data.syntheticPerturbations !== true || data.hiddenChallenges !== false ||
        data.independentOperators !== false || data.networkSubmitted !== false ||
        data.rewardEligible !== false || data.walletChanged !== false)
      throw new Error("failed");
    candidateStressResult = data;
    candidateStressStatus = "candidateStressDone";
  } catch (reason) {
    candidateStressStatus = reason?.message === "invalid" ? "candidateStressInvalid" : "candidateStressFailed";
  } finally {
    candidateRunning = false;
    start.disabled = !connected;
    render();
  }
});

if (qwenStart) qwenStart.addEventListener("click", async () => {
  if (!connected || qwenRunning || replayRunning || candidateRunning || irisVerifyRunning || !progress.hidden ||
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
  if (!connected || qwenRunning || replayRunning || candidateRunning || irisVerifyRunning || !progress.hidden ||
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

walletLinkStart?.addEventListener("click", async () => {
  walletLinkAddress = null;
  walletLinkPending = null;
  walletLinkChallenge.hidden = true;
  walletLinkCopy.hidden = true;
  walletLinkProof.value = "";
  walletLinkStart.disabled = true;
  try {
    const { response, data } = await fetchQwenJson("/wallet-link/challenge", {
      method: "POST", body: "", cache: "no-store",
    });
    if (!response.ok || !/^[0-9a-f]{64}$/.test(data.challenge) ||
        data.scope !== "local-address-ownership-only" ||
        data.networkSubmitted !== false || data.rewardEligible !== false ||
        !Number.isSafeInteger(data.expiresAt)) throw new Error("invalid challenge");
    walletLinkPending = data.challenge;
    walletLinkChallenge.value = data.challenge;
    walletLinkChallenge.hidden = false;
    walletLinkCopy.hidden = false;
    walletLinkState.textContent = locale === "ru"
      ? "Скопируйте запрос в Настройки NIR Wallet → Адрес для Model Lab. Затем вставьте подписанное доказательство сюда. Действует 5 минут."
      : "Copy into NIR Wallet Settings → Model Lab address. Paste the signed proof here. Expires in 5 minutes.";
  } catch {
    walletLinkState.textContent = locale === "ru" ? "Не удалось создать запрос." : "Could not create challenge.";
  } finally { walletLinkStart.disabled = false; render(); }
});
walletLinkCopy?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(walletLinkChallenge.value); }
  catch { walletLinkChallenge.select(); }
});
walletLinkComplete?.addEventListener("click", async () => {
  if (!walletLinkPending) {
    walletLinkState.textContent = locale === "ru" ? "Сначала создайте запрос." : "Create a challenge first.";
    return;
  }
  let proof;
  try { proof = JSON.parse(walletLinkProof.value); }
  catch { walletLinkState.textContent = locale === "ru" ? "Неверный JSON." : "Invalid JSON."; return; }
  if (proof?.challenge !== walletLinkPending || walletLinkProof.value.length > 16_384) {
    walletLinkState.textContent = locale === "ru" ? "Доказательство не соответствует запросу." : "Proof does not match challenge.";
    return;
  }
  walletLinkComplete.disabled = true;
  try {
    const { response, data } = await fetchQwenJson("/wallet-link/complete", {
      method: "POST", body: JSON.stringify(proof),
      headers: { "Content-Type": "application/json" }, cache: "no-store",
    });
    if (!response.ok || data.status !== "local-address-ownership-verified" ||
        !/^nir1[0-9a-f]{64}$/.test(data.address) ||
        data.networkSubmitted !== false || data.rewardEligible !== false ||
        data.walletChanged !== false) throw new Error("proof rejected");
    walletLinkAddress = data.address;
    walletLinkPending = null;
    walletLinkChallenge.hidden = true;
    walletLinkCopy.hidden = true;
    walletLinkProof.value = "";
    walletLinkState.textContent = locale === "ru"
      ? `Адрес ${data.address} подтверждён для этой локальной сессии. Монет и заявки нет.`
      : `Address ${data.address} verified for this local session. No coins or claim exist.`;
  } catch {
    walletLinkPending = null;
    walletLinkState.textContent = locale === "ru"
      ? "Доказательство отклонено или истекло. Создайте новый запрос; награда не начислена."
      : "Proof rejected or expired. Create a new challenge; no reward was credited.";
  } finally { walletLinkComplete.disabled = false; render(); }
});

recordLocalEvent("ui-ready");
render();
void checkConnection();
void loadQwenRuntime();
setInterval(() => { if (progress.hidden) void checkConnection(); }, 5000);
