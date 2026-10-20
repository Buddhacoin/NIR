export function createSessionGuard({
  idleMs,
  onLock,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || typeof onLock !== "function") {
    throw new Error("session guard configuration is invalid");
  }
  let deadline = now() + idleMs;
  let timer;
  let locked = false;

  function lock() {
    if (locked) return;
    locked = true;
    clearTimer(timer);
    onLock();
  }

  function arm() {
    clearTimer(timer);
    timer = setTimer(() => {
      if (now() >= deadline) lock();
      else arm();
    }, Math.max(1, deadline - now()));
  }

  function check() {
    if (!locked && now() >= deadline) lock();
    return !locked;
  }

  arm();
  return {
    activity() {
      if (!check()) return false;
      deadline = now() + idleMs;
      arm();
      return true;
    },
    resume: check,
    background: lock,
    stop() {
      locked = true;
      clearTimer(timer);
    },
  };
}

export async function reloadAfterPendingWrite(write, reload) {
  try { await write; }
  catch { /* Reload will read the last successfully committed encrypted profile. */ }
  reload();
}
