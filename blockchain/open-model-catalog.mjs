// Read-only discovery. A Hub model is never executable or reward-eligible merely
// because its metadata appears here.
const SOURCES = Object.freeze([
  Object.freeze({ provider: "Qwen", name: "Qwen3 0.6B", repo: "Qwen/Qwen3-0.6B" }),
  Object.freeze({ provider: "TinyLlama", name: "TinyLlama 1.1B Chat", repo: "TinyLlama/TinyLlama-1.1B-Chat-v1.0" }),
]);
const SHA = /^[a-f0-9]{40}$/;
const LIMIT = 32 * 1024;

async function readBoundedJson(response) {
  if (!response.ok || response.status !== 200 || response.redirected ||
      !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    throw new Error("invalid Hub metadata response");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > LIMIT)) {
    await response.body?.cancel();
    throw new Error("Hub metadata exceeds limit");
  }
  if (!response.body) throw new Error("missing Hub metadata body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        throw new Error("Hub metadata exceeds limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function createOpenModelCatalog({ fetchMetadata = fetch, now = () => Date.now() } = {}) {
  const versions = new Map(SOURCES.map((source) => [source.repo, []]));
  let lastAttempt = 0;
  let unavailable = false;
  let pending = null;

  function snapshot() {
    return {
      status: "read-only-open-model-catalog",
      runnableRepo: null,
      rewardEligible: false,
      refreshedAt: lastAttempt ? new Date(lastAttempt).toISOString() : null,
      stale: unavailable || !lastAttempt || now() - lastAttempt > 5 * 60_000,
      entries: SOURCES.map(({ provider, name, repo }) => ({
        provider, name, repo,
        runnable: false,
        versions: [...versions.get(repo)],
      })),
    };
  }

  async function refresh() {
    if (pending) return pending;
    if (lastAttempt && now() - lastAttempt < 30_000) return snapshot();
    pending = (async () => {
      let failures = 0;
      for (const source of SOURCES) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          const url = `https://huggingface.co/api/models/${source.repo}?expand=sha&expand=private&expand=gated`;
          const response = await fetchMetadata(url, {
            method: "GET", redirect: "manual", credentials: "omit",
            headers: { Accept: "application/json" }, signal: controller.signal,
          });
          const metadata = await readBoundedJson(response);
          if (metadata.id !== source.repo || !SHA.test(metadata.sha) ||
              metadata.private !== false || metadata.gated !== false) {
            throw new Error("untrusted Hub metadata");
          }
          const known = versions.get(source.repo);
          if (!known.includes(metadata.sha)) {
            known.push(metadata.sha);
            if (known.length > 12) known.shift();
          }
        } catch { failures++; }
        finally { clearTimeout(timer); }
      }
      lastAttempt = now();
      unavailable = failures > 0;
      return snapshot();
    })();
    try { return await pending; }
    finally { pending = null; }
  }

  async function get() {
    if (!lastAttempt || now() - lastAttempt > 5 * 60_000) return refresh();
    return snapshot();
  }
  return { get, refresh, snapshot };
}
