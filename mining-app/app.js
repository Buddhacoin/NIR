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
    const response = await fetch("/practice", { method: "POST", body: "" });
    const data = await response.json();
    if (!response.ok || data.status !== "local-practice-complete" ||
        data.scope !== "local-valueless-demo-only" || data.walletChanged !== false ||
        data.networkSubmitted !== false || data.rewardCredited !== false ||
        !Number.isSafeInteger(data.blockHeight) || !/^[0-9a-f]{64}$/.test(data.tipHash)) {
      throw new Error(data.error ?? "Результат тренировки не подтверждён.");
    }
    document.querySelector("#technical").textContent =
      `Локальный блок ${data.blockHeight} · ${data.tipHash}`;
    result.hidden = false;
  } catch (reason) {
    error.textContent = reason.message || "Не удалось выполнить тренировку.";
    error.hidden = false;
  } finally {
    progress.hidden = true;
    start.disabled = false;
  }
});
