// Each storage.local.set is allowed to finish before the next starts. A failed
// write does not prevent a later user choice from being persisted.
export function createLocaleWriteQueue(write) {
  let tail = Promise.resolve();
  return (value) => {
    const next = tail.catch(() => {}).then(() => write(value));
    tail = next;
    return next;
  };
}
