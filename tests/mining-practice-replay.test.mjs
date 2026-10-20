import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { createMiningPracticeApp, localReplayRecordHash } from "../blockchain/mining-practice-app.mjs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const sessions = new Map();
const record = {
  format: "nir-local-open-model-replay-v1", scope: "non-reward-local-replay",
  repository: "Qwen/Qwen3-0.6B", revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  packageIdentity: `sha256:${"a".repeat(64)}`, prompt: "Reply with the single word NIR.",
  answer: "NIR", generation: { temperature: "0", maxTokens: 32 },
  runtimeDeclaration: { mlx: "0.32.3", "mlx-lm": "0.32.0", transformers: "5.17.0" },
  rewardEligible: false, networkSubmitted: false, independentlyVerified: false,
  recordHash: "",
};
record.recordHash = localReplayRecordHash(record);

async function withServer(runReplay, action) {
  const server = createMiningPracticeApp({ root, runReplay });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  sessions.set(base, server.localSessionToken);
  try { await action(base); }
  finally {
    sessions.delete(base);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function submit(base, body, headers = {}) {
  return fetch(`${base}/open-model/replay`, { method: "POST", body,
    headers: { origin: base, "x-nir-session": sessions.get(base), "content-type": "application/json",
      "x-nir-download-consent": "qwen3-0.6b-up-to-4gib", ...headers } });
}

async function completed(base, jobId) {
  for (let i = 0; i < 40; i++) {
    const response = await fetch(`${base}/open-model/jobs/${jobId}`);
    if (response.status !== 202) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish");
}

test("replay route reruns only a bounded pinned record and labels the match non-reward", async () => {
  let calls = 0;
  await withServer(async (_, bytes) => {
    calls++;
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), record);
    return { status: "local-replay-matched", recordHash: record.recordHash,
      rewardEligible: false, networkSubmitted: false, independentlyVerified: false };
  }, async (base) => {
    const response = await submit(base, JSON.stringify(record));
    assert.equal(response.status, 202);
    const { jobId } = await response.json();
    assert.match(jobId, /^[a-f0-9]{32}$/);
    const result = await completed(base, jobId);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { status: "local-replay-matched",
      recordHash: record.recordHash, rewardEligible: false,
      networkSubmitted: false, independentlyVerified: false });
  });
  assert.equal(calls, 1);
});

test("replay refuses foreign origin, no consent, excess bytes, arbitrary path and forged hash", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("should not run"); }, async (base) => {
    const body = JSON.stringify(record);
    assert.equal((await submit(base, body, { origin: "https://evil.example" })).status, 403);
    assert.equal((await submit(base, body, { "x-nir-download-consent": "" })).status, 403);
    assert.equal((await submit(base, "x".repeat(16_385))).status, 403);
    assert.equal((await submit(base, JSON.stringify({ path: "/etc/passwd" }))).status, 400);
    assert.equal((await submit(base, JSON.stringify({ ...record, answer: "FORGED" }))).status, 400);
    assert.equal((await submit(base, JSON.stringify({ ...record, rewardEligible: true,
      recordHash: localReplayRecordHash({ ...record, rewardEligible: true }) }))).status, 400);
  });
  assert.equal(calls, 0);
});

test("replay cannot overlap another replay and never accepts a fabricated reward result", async () => {
  let finish;
  await withServer(() => new Promise((resolve) => { finish = resolve; }), async (base) => {
    const body = JSON.stringify(record);
    const first = await submit(base, body);
    assert.equal(first.status, 202);
    const { jobId } = await first.json();
    assert.equal((await submit(base, body)).status, 409);
    finish({ status: "local-replay-matched", recordHash: record.recordHash,
      rewardEligible: true, networkSubmitted: false, independentlyVerified: false });
    assert.equal((await completed(base, jobId)).status, 500);
  });
});

test("a runner cannot smuggle extra success or reward fields into the public job", async () => {
  await withServer(async () => ({ status: "local-replay-matched", recordHash: record.recordHash,
    rewardEligible: false, networkSubmitted: false, independentlyVerified: false,
    rewardCredited: true }), async (base) => {
    const response = await submit(base, JSON.stringify(record));
    const { jobId } = await response.json();
    assert.equal((await completed(base, jobId)).status, 500);
  });
});

test("a self-consistent forged answer is only a claim until the backend reruns it", async () => {
  const forged = { ...record, answer: "FORGED" };
  forged.recordHash = localReplayRecordHash(forged);
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("local output did not match"); }, async (base) => {
    const response = await submit(base, JSON.stringify(forged));
    assert.equal(response.status, 202);
    const { jobId } = await response.json();
    assert.equal((await completed(base, jobId)).status, 500);
  });
  assert.equal(calls, 1);
});

test("browser import labels matched local replay and rejects a changed record before upload", async () => {
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection",
    "language", "score", "technical", "qwen-start", "qwen-state", "qwen-answer",
    "qwen-identity", "qwen-export", "qwen-replay-file", "qwen-replay", "qwen-replay-state"]) {
    nodes.set(`#${id}`, { hidden: id === "progress", disabled: false, dataset: {},
      textContent: "", files: [], setAttribute() {},
      addEventListener(_, listener) { this.click = listener; } });
  }
  let uploaded = 0;
  let oversized = false;
  const document = { documentElement: { lang: "ru" }, title: "",
    querySelector: (id) => nodes.get(id), querySelectorAll: () => [] };
  const code = readFileSync(new URL("../mining-app/app.js", import.meta.url), "utf8");
  runInNewContext(code, { document, navigator: { language: "ru-RU" },
    window: { confirm: () => true }, localStorage: { getItem: () => null },
    AbortController, setTimeout, clearTimeout, setInterval: () => 0, TextEncoder,
    crypto: webcrypto, TypeError, fetch: async (path) => {
      if (path === "/status") return { ok: true, json: async () => ({ status: "local-model-service-ready" }) };
      if (path === "/open-model/runtime") return { ok: true, json: async () => ({ status: "pinned-qwen-runtime-ready" }) };
      if (path === "/open-model/replay") {
        uploaded++;
        if (oversized) return { body: { getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(16_385) }),
          cancel: async () => {},
        }) } };
        return { status: 202, json: async () => ({ status: "running", jobId: "a".repeat(32) }) };
      }
      if (path === `/open-model/jobs/${"a".repeat(32)}`) return { status: 200,
        json: async () => ({ status: "local-replay-matched", recordHash: record.recordHash,
          rewardEligible: false, networkSubmitted: false, independentlyVerified: false }) };
      throw new Error(`unexpected ${path}`);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  nodes.get("#qwen-replay-file").files = [{ size: Buffer.byteLength(JSON.stringify(record)),
    text: async () => JSON.stringify(record) }];
  nodes.get("#qwen-replay-file").click();
  assert.equal(nodes.get("#qwen-replay").disabled, false);
  await nodes.get("#qwen-replay").click();
  assert.equal(uploaded, 1);
  assert.match(nodes.get("#qwen-replay-state").textContent, /Запись не подписана/);
  const changed = { ...record, answer: "FORGED" };
  nodes.get("#qwen-replay-file").files = [{ size: Buffer.byteLength(JSON.stringify(changed)),
    text: async () => JSON.stringify(changed) }];
  nodes.get("#qwen-replay-file").click();
  await nodes.get("#qwen-replay").click();
  assert.equal(uploaded, 1);
  assert.match(nodes.get("#qwen-replay-state").textContent, /действительную запись/);
  nodes.get("#qwen-replay-file").files = [{ size: Buffer.byteLength(JSON.stringify(record)),
    text: async () => JSON.stringify(record) }];
  nodes.get("#qwen-replay-file").click();
  oversized = true;
  await nodes.get("#qwen-replay").click();
  assert.equal(uploaded, 2);
  assert.match(nodes.get("#qwen-replay-state").textContent, /Повтор не завершился/);
});
