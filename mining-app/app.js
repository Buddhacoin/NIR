const start = document.querySelector("#start");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const error = document.querySelector("#error");

start.addEventListener("click", async () => {
  start.disabled = true;
  progress.hidden = false;
  result.hidden = true;
  error.hidden = true;
  try {
    const response = await fetch("/model-check", { method: "POST", body: "" });
    const data = await response.json();
    if (!response.ok || data.status !== "pinned-local-model-evaluation" ||
        data.scope !== "local-public-iris-example-only" || data.walletChanged !== false ||
        data.networkSubmitted !== false || data.rewardCredited !== false ||
        data.independentOperators !== false || data.hiddenChallenges !== false ||
        data.energyAttested !== false || data.bundleVerified !== true ||
        data.caseCount !== 30 || !Number.isSafeInteger(data.baselineAccuracyBps) ||
        !Number.isSafeInteger(data.candidateAccuracyBps) ||
        !/^[0-9a-f]{64}$/.test(data.bundleHash)) {
      throw new Error(data.error ?? "Результат локальной проверки не подтверждён.");
    }
    document.querySelector("#score").textContent =
      `Точность: исходная модель ${(data.baselineAccuracyBps / 100).toFixed(2)} %, улучшенная ${(data.candidateAccuracyBps / 100).toFixed(2)} % · ${data.caseCount} примеров.`;
    document.querySelector("#technical").textContent =
      `Хеш проверенного набора: ${data.bundleHash}`;
    result.hidden = false;
  } catch (reason) {
    error.textContent = reason.message || "Не удалось выполнить тренировку.";
    error.hidden = false;
  } finally {
    progress.hidden = true;
    start.disabled = false;
  }
});
