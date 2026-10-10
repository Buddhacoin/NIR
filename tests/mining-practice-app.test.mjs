import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { createMiningPracticeApp, localReplayRecordHash, miningModelAppPreflight,
  runPinnedModel } from "../blockchain/mining-practice-app.mjs";
import { evaluateIrisPostCommitStress } from "../blockchain/iris-linear-candidate.mjs";

const root = join(import.meta.dirname, "..");

test("local rechecker requires authenticated model and record imports", async () => {
  const { server, base, token } = await serve();
  try {
    const model = readFileSync(join(root, "examples/iris_integer_linear.json"));
    const record = evaluateIrisPostCommitStress(root, model, Buffer.alloc(32, 7));
    const post = (origin, supplied, body) => fetch(`${base}/candidate/iris-linear/recheck`, {
      method: "POST", body: JSON.stringify(body), headers: { origin,
        "X-NIR-Session": supplied, "Content-Type": "application/json" },
    });
    const input = { modelBase64: model.toString("base64"), record };
    assert.equal((await post(base, "0".repeat(64), input)).status, 403);
    assert.equal((await post("https://attacker.example", token, input)).status, 403);
    assert.equal((await post(base, token, { modelBase64: "", record: {} })).status, 400);
    const match = await post(base, token, input);
    assert.equal(match.status, 200);
    const matched = await match.json();
    assert.equal(matched.status, "local-iris-recheck-matched");
    assert.equal(matched.caseCount, 90);
    assert.equal(matched.rewardEligible, false);
    assert.equal(matched.operatorIdentityVerified, false);
    const mismatch = await post(base, token, { ...input,
      record: { ...record, candidateAccuracyBps: 0 } });
    assert.equal((await mismatch.json()).status, "local-iris-recheck-mismatch");
    assert.equal((await post(base, token, { ...input,
      modelBase64: Buffer.from("import os").toString("base64") })).status, 400);
  } finally { await stop(server); }
});

test("operator console shows only real local stages, roles, and runnable models", () => {
  const html = readFileSync(join(root, "mining-app/index.html"), "utf8");
  const css = readFileSync(join(root, "mining-app/style.css"), "utf8");
  const script = readFileSync(join(root, "mining-app/app.js"), "utf8");
  for (const id of ["operator-console", "event-chart", "event-log", "operator-role",
    "iris-availability", "qwen-availability"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<title>NIR · Проверка модели<\/title>/);
  assert.match(html, /id="iris-availability" data-i18n="bundled">ВСТРОЕНА<\/b>/);
  assert.match(html, /отдельный закреплённый запуск Qwen доступен ниже/);
  assert.match(script, /bundled: "ВСТРОЕНА"/);
  assert.match(script, /bundled: "BUNDLED"/);
  assert.match(html, /data-i18n="localOnly"/);
  assert.match(html, /id="iris-evidence-file" type="file" accept="application\/json,\.json"/);
  assert.match(html, /id="iris-evidence-verify"[^>]*disabled/);
  assert.match(script, /irisImportMatched: \(hash\) => .*Личность оператора не подтверждена/);
  assert.match(html, /id="candidate-file" type="file" accept="application\/json,\.json"/);
  assert.match(html, /href="\/iris-linear-sample\.json"/);
  assert.match(html, /Все 30 проверочных примеров Iris публичны/);
  assert.match(html, /id="candidate-stress"[^>]*disabled/);
  assert.match(html, /id="candidate-stress-state"[^>]*aria-live="polite"/);
  assert.match(script, /candidateDone: \(baseline, candidate, hash\) => .*не скрытый тест, не сетевая заявка и не награда/);
  assert.match(script, /candidateStressDone: .*повторными запусками можно выбрать удачный seed/);
  assert.match(script, /candidateStressDone: .*repeated runs can cherry-pick a favorable seed/);
  for (const id of ["candidate-record-export", "recheck-model-file", "recheck-record-file",
    "recheck-run", "recheck-state"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Личность оператора, скрытые задания, консенсус и награда этим не подтверждаются/);
  assert.match(script, /recheckMatched: \(hash\) => .*не независимая сетевая проверка/);
  assert.match(script, /recheckMismatch: .*Не принимайте эту запись как результат/);
  assert.match(css, /image-rendering:pixelated/);
  assert.match(css, /\.event-pulse/);
  for (const event of ["service-online", "iris-requested", "iris-result", "qwen-started",
    "qwen-result"]) assert.match(script, new RegExp(`recordLocalEvent\\("${event}"`));
  assert.doesNotMatch(script, /Math\.random\(\)/);
  assert.doesNotMatch(html, /\b(?:100|[1-9]?[0-9])%\b/);
});

test("operator console keeps its status, event, and model text readable", () => {
  const css = readFileSync(join(root, "mining-app/style.css"), "utf8");
  const fontSize = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
    assert.ok(rule, `missing CSS rule for ${selector}`);
    const size = rule[1].match(/font-size:\s*(\d+)px/);
    assert.ok(size, `missing pixel font size for ${selector}`);
    return Number(size[1]);
  };
  for (const selector of ["header small", "header b,.local-only,.console-title b",
    ".connection", ".console-grid span", ".console-grid strong",
    ".trace-heading h3,.models-heading", ".trace-heading span", ".event-log li",
    ".model-index", ".model-grid strong", ".model-grid small",
    ".model-grid article > b", ".eyebrow", ".safety", "footer"]) {
    assert.ok(fontSize(selector) >= 12, `${selector} is too small`);
  }
  assert.doesNotMatch(css, /\.event-log span\s*\{[^}]*text-overflow:ellipsis/);
  assert.doesNotMatch(css, /\.model-grid small\s*\{[^}]*text-overflow:ellipsis/);
});

async function serve(runModel) {
  const server = createMiningPracticeApp({ root, runModel });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, token: server.localSessionToken };
}
async function stop(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

const qwenResult = {
  repository: "Qwen/Qwen3-0.6B", revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  packageIdentity: `sha256:${"a".repeat(64)}`, answer: "NIR",
  record: {
    format: "nir-local-open-model-replay-v1", scope: "non-reward-local-replay",
    repository: "Qwen/Qwen3-0.6B", revision: "c1899de289a04d12100db370d81485cdf75e47ca",
    packageIdentity: `sha256:${"a".repeat(64)}`, prompt: "Reply with the single word NIR.",
    answer: "NIR", generation: { temperature: "0", maxTokens: 32 },
    runtimeDeclaration: { mlx: "0.32.3", "mlx-lm": "0.32.0", transformers: "5.17.0" },
    rewardEligible: false, networkSubmitted: false, independentlyVerified: false,
    recordHash: `sha256:${"b".repeat(64)}`,
  },
  rewardEligible: false, networkSubmitted: false, independentlyVerified: false,
};
qwenResult.record.recordHash = localReplayRecordHash(qwenResult.record);
assert.equal(qwenResult.record.recordHash,
  "sha256:866768567ad82a3bce80ea074f2612215f31f237aa04c9a2ed8cb118453dbe54");
assert.equal(localReplayRecordHash({ ...qwenResult.record, answer: "Ответ: ✓" }),
  "sha256:b06751692ce4d1ac5460ed3f6526b0d10b5b0eb8a2d4b2068a211d2ac19252e6");

test("pinned Qwen route requires explicit same-origin download consent and refuses code", async () => {
  let calls = 0;
  const server = createMiningPracticeApp({ root, runOpenModel: async () => { calls++; return qwenResult; } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (origin, consent, body = "") => fetch(`${base}/open-model/qwen-check`, {
    method: "POST", body, headers: { origin, "X-NIR-Session": server.localSessionToken,
      ...(consent ? { "X-NIR-Download-Consent": consent } : {}) },
  });
  try {
    assert.equal((await request(base)).status, 403);
    assert.equal((await request("https://evil.example", "qwen3-0.6b-up-to-4gib")).status, 403);
    assert.equal((await request(base, "qwen3-0.6b-up-to-4gib", "import os")).status, 403);
    assert.equal(calls, 0);
    const response = await request(base, "qwen3-0.6b-up-to-4gib");
    assert.equal(response.status, 202);
    const job = await response.json();
    assert.match(job.jobId, /^[a-f0-9]{32}$/);
    let completed;
    for (let i = 0; i < 50; i++) {
      completed = await fetch(`${base}/open-model/jobs/${job.jobId}`);
      if (completed.status !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed.status, 200);
    const completedResult = await completed.json();
    assert.deepEqual(completedResult, { status: "local-open-model-inference-only", ...qwenResult });
    assert.equal(completedResult.record.scope, "non-reward-local-replay");
    assert.equal(calls, 1);
  } finally { await stop(server); }
});

test("each service has a private session; forged origin or consent cannot launch model work", async () => {
  let calls = 0;
  let refreshes = 0;
  const make = () => createMiningPracticeApp({ root,
    runModel: async () => { calls++; throw new Error("not reached"); },
    runOpenModel: async () => { calls++; throw new Error("not reached"); },
    runReplay: async () => { calls++; throw new Error("not reached"); },
    catalog: { get: async () => ({ status: "read-only-open-model-catalog" }),
      refresh: async () => { refreshes++; return { status: "read-only-open-model-catalog" }; } },
  });
  const first = make();
  const second = make();
  await Promise.all([first, second].map((server) =>
    new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const base = `http://127.0.0.1:${second.address().port}`;
  const invoke = (path, token, origin = base) => fetch(`${base}${path}`, {
    method: "POST", body: "", headers: { origin,
      "X-NIR-Download-Consent": "qwen3-0.6b-up-to-4gib",
      ...(token === undefined ? {} : { "X-NIR-Session": token }) },
  });
  try {
    assert.notEqual(first.localSessionToken, second.localSessionToken);
    for (const path of ["/model-check", "/catalog/refresh", "/open-model/qwen-check"]) {
      assert.equal((await invoke(path)).status, 403, `${path}: missing token`);
      assert.equal((await invoke(path, "0".repeat(64))).status, 403, `${path}: wrong token`);
      assert.equal((await invoke(path, first.localSessionToken)).status, 403,
        `${path}: previous service token`);
      assert.equal((await invoke(path, second.localSessionToken, "https://evil.example")).status,
        403, `${path}: foreign origin`);
    }
    const replay = await fetch(`${base}/open-model/replay`, { method: "POST", body: "{}",
      headers: { origin: base, "Content-Type": "application/json",
        "X-NIR-Download-Consent": "qwen3-0.6b-up-to-4gib" } });
    assert.equal(replay.status, 403);
    assert.equal(calls, 0);
    assert.equal(refreshes, 0);
    for (const path of ["/", "/app.js", "/status", "/catalog", "/open-model/runtime"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal((await response.text()).includes(second.localSessionToken), false,
        `${path}: secret must not be served`);
    }
  } finally { await Promise.all([stop(first), stop(second)]); }
});

test("restarting the service on the same port invalidates its previous session", async () => {
  let calls = 0;
  const first = createMiningPracticeApp({ root, runModel: async () => { calls++; } });
  await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
  const port = first.address().port;
  const oldToken = first.localSessionToken;
  await stop(first);
  const second = createMiningPracticeApp({ root, runModel: async () => { calls++; } });
  await new Promise((resolve) => second.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.notEqual(second.localSessionToken, oldToken);
    const response = await fetch(`${base}/model-check`, { method: "POST", body: "",
      headers: { origin: base, "X-NIR-Session": oldToken } });
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  } finally { await stop(second); }
});

test("Qwen runtime preflight gives a read-only reason before any download", async () => {
  let runs = 0;
  const server = createMiningPracticeApp({ root,
    runOpenModel: async () => { runs++; return qwenResult; },
    checkOpenModel: async () => ({ status: "missing-runtime", package: "mlx" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/open-model/runtime`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "missing-runtime", package: "mlx" });
    assert.equal(runs, 0);
  } finally { await stop(server); }
});

test("Qwen route refuses a transcript whose hash would fail independent local replay", async () => {
  const server = createMiningPracticeApp({ root, runOpenModel: async () => ({
    ...qwenResult, record: { ...qwenResult.record, recordHash: `sha256:${"b".repeat(64)}` },
  }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(`${base}/open-model/qwen-check`, { method: "POST", body: "",
      headers: { origin: base, "X-NIR-Session": server.localSessionToken,
        "X-NIR-Download-Consent": "qwen3-0.6b-up-to-4gib" } });
    const { jobId } = await start.json();
    let result;
    for (let i = 0; i < 50; i++) {
      result = await fetch(`${base}/open-model/jobs/${jobId}`);
      if (result.status !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.status, 500);
  } finally { await stop(server); }
});

test("Qwen UI refuses missing runtime and requires a separate user confirmation", async () => {
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection",
    "language", "score", "technical", "qwen-start", "qwen-state", "qwen-answer", "qwen-identity",
    "qwen-export"]) {
    nodes.set(`#${id}`, { hidden: true, disabled: false, dataset: {}, textContent: "", setAttribute() {},
      addEventListener(_, listener) { this.click = listener; } });
  }
  let runtime = { status: "missing-runtime", package: "mlx" };
  let consent = false;
  let runs = 0;
  let returnedResult = qwenResult;
  let stall = false;
  let downloaded;
  const document = { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id),
    querySelectorAll: () => [], body: { append() {} }, createElement: () => ({
      click() { downloaded = { filename: this.download, bytes: this.href }; }, remove() {},
    }) };
  const browserURL = { createObjectURL: (blob) => blob.parts.join(""), revokeObjectURL() {} };
  class TestBlob { constructor(parts) { this.parts = parts; } }
  const code = readFileSync(join(root, "mining-app/app.js"), "utf8");
  runInNewContext(code, {
    document,
    navigator: { language: "ru-RU" }, window: { confirm: () => consent }, AbortController,
    fetch: async (path, options) => {
      if (path === "/status") return { ok: true, json: async () => ({ status: "local-model-service-ready" }) };
      if (path === "/open-model/runtime") return { ok: true, json: async () => runtime };
      if (path === "/open-model/qwen-check") {
        runs++;
        if (stall) return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new TypeError("aborted"))));
        return { ok: true, status: 202, json: async () => ({ status: "running", jobId: "a".repeat(32) }) };
      }
      if (path === `/open-model/jobs/${"a".repeat(32)}`) return { ok: true, status: 200, json: async () => ({ status: "local-open-model-inference-only", ...returnedResult }) };
      throw new Error(`unexpected ${path}`);
    },
    setInterval: () => 0, setTimeout, clearTimeout, TypeError, Blob: TestBlob, URL: browserURL,
    crypto: webcrypto, TextEncoder,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get("#qwen-start").disabled, true);
  assert.match(nodes.get("#qwen-state").textContent, /mlx/);
  await nodes.get("#qwen-start").click();
  assert.equal(runs, 0);
  runtime = { status: "pinned-qwen-runtime-ready" };
  // A fresh tab performs another read-only prerequisite check.
  const freshNodes = new Map();
  for (const [key, value] of nodes) freshNodes.set(key, { ...value, addEventListener(_, listener) { this.click = listener; } });
  runInNewContext(code, {
    document: { ...document, querySelector: (id) => freshNodes.get(id) },
    navigator: { language: "ru-RU" }, window: { confirm: () => consent }, AbortController,
    fetch: async (path, options) => {
      if (path === "/status") return { ok: true, json: async () => ({ status: "local-model-service-ready" }) };
      if (path === "/open-model/runtime") return { ok: true, json: async () => runtime };
      if (path === "/open-model/qwen-check") {
        runs++;
        if (stall) return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new TypeError("aborted"))));
        return { ok: true, status: 202, json: async () => ({ status: "running", jobId: "a".repeat(32) }) };
      }
      if (path === `/open-model/jobs/${"a".repeat(32)}`) return { ok: true, status: 200, json: async () => ({ status: "local-open-model-inference-only", ...returnedResult }) };
      throw new Error(`unexpected ${path}`);
    }, setInterval: () => 0, setTimeout: (callback, delay) =>
      setTimeout(callback, delay === 10_000 ? 5 : delay), clearTimeout, TypeError,
    Blob: TestBlob, URL: browserURL,
    crypto: webcrypto, TextEncoder,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(freshNodes.get("#qwen-start").disabled, false);
  await freshNodes.get("#qwen-start").click();
  assert.equal(runs, 0);
  consent = true;
  await freshNodes.get("#qwen-start").click();
  assert.equal(runs, 1);
  assert.equal(freshNodes.get("#qwen-answer").hidden, false);
  assert.equal(freshNodes.get("#qwen-export").hidden, false);
  freshNodes.get("#qwen-export").click();
  assert.match(downloaded.filename, /^nir-local-replay-[0-9a-f]{12}\.json$/);
  assert.deepEqual(JSON.parse(downloaded.bytes), qwenResult.record);
  assert.match(freshNodes.get("#qwen-state").textContent, /награды нет/);
  returnedResult = { ...qwenResult, record: {
    ...qwenResult.record, recordHash: `sha256:${"b".repeat(64)}`,
  } };
  downloaded = undefined;
  await freshNodes.get("#qwen-start").click();
  assert.equal(freshNodes.get("#qwen-export").hidden, true);
  assert.match(freshNodes.get("#qwen-state").textContent, /не подтверждён/);
  freshNodes.get("#qwen-export").click();
  assert.equal(downloaded, undefined);
  const wrongSettings = { ...qwenResult.record, generation: { temperature: "1", maxTokens: 32 },
    extra: "unreviewed" };
  wrongSettings.recordHash = localReplayRecordHash(wrongSettings);
  returnedResult = { ...qwenResult, record: wrongSettings };
  await freshNodes.get("#qwen-start").click();
  assert.equal(freshNodes.get("#qwen-export").hidden, true);
  assert.match(freshNodes.get("#qwen-state").textContent, /не подтверждён/);
  stall = true;
  await Promise.race([freshNodes.get("#qwen-start").click(),
    new Promise((resolve) => setTimeout(resolve, 100))]);
  assert.equal(freshNodes.get("#qwen-export").hidden, true);
  assert.match(freshNodes.get("#qwen-state").textContent, /не запустилась/);
});

test("pinned Qwen route rejects forged rewards and conflicting local jobs", async () => {
  let finish;
  let calls = 0;
  const server = createMiningPracticeApp({ root, runOpenModel: () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = () => fetch(`${base}/open-model/qwen-check`, {
    method: "POST", body: "", headers: {
      origin: base, "X-NIR-Session": server.localSessionToken,
      "X-NIR-Download-Consent": "qwen3-0.6b-up-to-4gib",
    },
  });
  try {
    const first = await request();
    assert.equal(first.status, 202);
    const { jobId } = await first.json();
    for (let index = 0; index < 100 && !finish; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    assert.equal((await request()).status, 409);
    assert.equal((await fetch(`${base}/open-model/jobs/${jobId}`)).status, 202);
    assert.equal((await fetch(`${base}/open-model/jobs/${"b".repeat(32)}`)).status, 404);
    finish({ ...qwenResult, rewardEligible: true });
    let denied;
    for (let i = 0; i < 50; i++) {
      denied = await fetch(`${base}/open-model/jobs/${jobId}`);
      if (denied.status !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(denied.status, 500);
    assert.match((await denied.json()).error, /награда не начислена/);
  } finally { await stop(server); }
});

test("app preflight requires model files but not unrelated demo or wallet files", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-model-app-test-"));
  try {
    writeFileSync(join(temporary, "package.json"), '{"name":"nir-protocol","private":true}');
    for (const name of [
      "mining-app/index.html", "mining-app/app.js", "mining-app/style.css",
      "wallet-ui/nir-coin-icon.png", "nir/iris_rehearsal.py",
      "examples/iris_model_adapter.py", "examples/iris.data",
      "examples/iris_integer_linear.json", "blockchain/iris-linear-candidate.mjs",
      "blockchain/operator-wallet-link.mjs", "blockchain/crypto.mjs",
      "blockchain/consensus-codec.mjs", "blockchain/constants.mjs",
      "nir/open_model_local_run.py", "nir/open_model_fetch.py",
      "nir/open_model_package.py", "nir/open_model_snapshot.py",
      "nir/open_model_source.py",
    ]) {
      mkdirSync(join(temporary, name, ".."), { recursive: true });
      writeFileSync(join(temporary, name), "test");
    }
    const options = { root: temporary, platform: "darwin", nodeVersion: "26.0.0" };
    assert.equal(miningModelAppPreflight(options).ready, true);
    assert.equal(miningModelAppPreflight({ ...options, platform: "linux" }).ready, false);
    assert.equal(miningModelAppPreflight({ ...options, nodeVersion: "25.9.0" }).ready, false);
    rmSync(join(temporary, "examples/iris.data"));
    assert.equal(miningModelAppPreflight(options).ready, false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("mining lab serves a pinned-model UI with no secret or code input", async () => {
  const { server, base } = await serve(async () => ({}));
  try {
    const response = await fetch(base);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(html, /id="start"/);
    assert.deepEqual([...html.matchAll(/<input\b[^>]*>/gi)].map(([input]) => input),
      ['<input id="candidate-file" type="file" accept="application/json,.json">',
        '<input id="recheck-model-file" type="file" accept="application/json,.json">',
        '<input id="recheck-record-file" type="file" accept="application/json,.json">',
        '<input id="qwen-replay-file" type="file" accept="application/json,.json">',
        '<input id="iris-evidence-file" type="file" accept="application/json,.json">']);
    assert.deepEqual([...html.matchAll(/<textarea\b[^>]*>/gi)].map(([field]) => field), [
      '<textarea id="wallet-link-challenge" readonly hidden aria-label="Одноразовый запрос для кошелька">',
      '<textarea id="wallet-link-proof" spellcheck="false" maxlength="16384" aria-label="Подписанное доказательство из кошелька">',
    ]);
    assert.doesNotMatch(html, /<form|type="(?:text|password)"|приватный ключ.*введите|введите.*пароль/i);
    assert.match(html, /Проверка модели Iris/);
    assert.match(html, /Независимых операторов, скрытых заданий/);
    assert.match(html, /id="connection"/);
    assert.match(html, /id="error-message"/);
    const status = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(status, { status: "local-model-service-ready" });
  } finally { await stop(server); }
});

test("portrait layout stays bounded and a stopped service explains the new-tab requirement", async () => {
  const css = readFileSync(join(root, "mining-app/style.css"), "utf8");
  assert.match(css, /width:min\(100%,480px\)/);
  assert.match(css, /min-height:680px/);
  assert.match(css, /@media \(max-width:460px\)/);
  assert.match(css, /html,body \{ max-width:100%;overflow-x:hidden; \}/);
  assert.match(css, /\.app \{ width:100vw;max-width:100vw;min-width:0;/);
  assert.match(css, /header \{ flex-wrap:wrap; \}/);
  assert.match(css, /white-space:normal;overflow-wrap:anywhere;/);

  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection", "language", "score", "technical"]) {
    nodes.set(`#${id}`, { hidden: true, disabled: false, dataset: {}, textContent: "", setAttribute() {} });
  }
  let onClick;
  nodes.get("#start").addEventListener = (_, listener) => { onClick = listener; };
  let onLanguage;
  nodes.get("#language").addEventListener = (_, listener) => { onLanguage = listener; };
  let online = true;
  let lastMethod;
  const code = readFileSync(join(root, "mining-app/app.js"), "utf8");
  runInNewContext(code, {
    document: { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id), querySelectorAll: () => [] },
    navigator: { language: "ru-RU" }, AbortController,
    fetch: async (path, options) => {
      lastMethod = options?.method ?? "GET";
      if (!online) throw new TypeError("Load failed");
      assert.equal(path, "/status");
      return { ok: true, json: async () => ({ status: "local-model-service-ready" }) };
    },
    setInterval: () => 0, setTimeout, clearTimeout,
    TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get("#connection").dataset.state, "online");
  onLanguage();
  assert.equal(nodes.get("#connection").textContent, "● Local service connected");
  online = false;
  await onClick();
  assert.equal(lastMethod, "POST");
  assert.equal(nodes.get("#connection").dataset.state, "offline");
  assert.equal(nodes.get("#start").disabled, true);
  assert.equal(nodes.get("#error").hidden, false);
  assert.match(nodes.get("#error-message").textContent, /npm run mine:app/);
  assert.match(nodes.get("#error-message").textContent, /new browser tab/);
  assert.doesNotMatch(nodes.get("#error-message").textContent, /Load failed/);
  onLanguage();
  assert.match(nodes.get("#error-message").textContent, /новую вкладку/);
});

test("RU/EN switch translates the active model result without changing its values", async () => {
  const html = readFileSync(join(root, "mining-app/index.html"), "utf8");
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
  const labels = keys.map((key) => ({ dataset: { i18n: key }, textContent: "" }));
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection", "language", "score", "technical"]) {
    nodes.set(`#${id}`, { hidden: true, disabled: false, dataset: {}, textContent: "", setAttribute() {} });
  }
  let onStart;
  let onLanguage;
  nodes.get("#start").addEventListener = (_, listener) => { onStart = listener; };
  nodes.get("#language").addEventListener = (_, listener) => { onLanguage = listener; };
  const document = {
    documentElement: { lang: "ru" },
    querySelector: (id) => nodes.get(id),
    querySelectorAll: () => labels,
  };
  const model = {
    status: "pinned-local-model-evaluation", scope: "local-public-iris-example-only",
    baselineAccuracyBps: 9000, candidateAccuracyBps: 9666, caseCount: 30,
    bundleHash: "a".repeat(64), bundleVerified: true, independentOperators: false,
    hiddenChallenges: false, energyAttested: false, networkSubmitted: false,
    rewardCredited: false, walletChanged: false, evidenceAvailable: false,
  };
  const code = readFileSync(join(root, "mining-app/app.js"), "utf8");
  runInNewContext(code, {
    document,
    navigator: { language: "ru-RU" }, AbortController,
    fetch: async (path) => ({
      ok: true, json: async () => path === "/status" ? { status: "local-model-service-ready" } : model,
    }),
    setInterval: () => 0, setTimeout, clearTimeout,
    TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await onStart();
  assert.equal(nodes.get("#result").hidden, false);
  assert.match(nodes.get("#score").textContent, /90\.00.*96\.66/);
  assert.ok(labels.every((label) => label.textContent.length > 0));
  onLanguage();
  assert.equal(document.documentElement.lang, "en");
  assert.match(nodes.get("#score").textContent, /Accuracy: baseline 90\.00%, candidate 96\.66%/);
  assert.match(nodes.get("#technical").textContent, /Verified bundle hash/);
  assert.ok(labels.every((label) => label.textContent.length > 0));
  assert.equal(labels[keys.indexOf("footer")].textContent.includes("Public mining and real NIR are unavailable"), true);
});

test("a reused loopback port with a different service is not presented as NIR", async () => {
  const element = () => ({ hidden: true, disabled: false, dataset: {}, textContent: "", children: [],
    style: { setProperty() {} }, setAttribute() {}, addEventListener() {},
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); } });
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection", "language", "score", "technical"]) {
    nodes.set(`#${id}`, element());
  }
  nodes.set("#event-pulses", element());
  nodes.set("#event-log", element());
  runInNewContext(readFileSync(join(root, "mining-app/app.js"), "utf8"), {
    document: { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id),
      querySelectorAll: () => [], createElement: element },
    navigator: { language: "ru-RU" }, AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ status: "another-service" }) }),
    setInterval: () => 0, setTimeout, clearTimeout, TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get("#connection").dataset.state, "offline");
  assert.equal(nodes.get("#start").disabled, true);
  const labels = nodes.get("#event-log").children.map((item) => item.children[1]?.textContent);
  assert.equal(labels.includes("Локальный сервис подтверждён"), false);
  assert.equal(labels.includes("Локальный сервис недоступен"), true);
});

test("a matching unauthenticated health string is reported as a response, not identity proof", async () => {
  const element = () => ({ hidden: true, disabled: false, dataset: {}, textContent: "", children: [],
    style: { setProperty() {} }, setAttribute() {}, addEventListener() {},
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); } });
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection",
    "language", "score", "technical", "event-pulses", "event-log"]) nodes.set(`#${id}`, element());
  runInNewContext(readFileSync(join(root, "mining-app/app.js"), "utf8"), {
    document: { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id),
      querySelectorAll: () => [], createElement: element },
    navigator: { language: "ru-RU" }, AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ status: "local-model-service-ready" }) }),
    setInterval: () => 0, setTimeout, clearTimeout, TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const labels = nodes.get("#event-log").children.map((item) => item.children[1]?.textContent);
  assert.equal(labels.includes("Локальный сервис ответил: готов"), true);
  assert.equal(labels.some((label) => /подтвержд/i.test(label ?? "")), false);
});

test("a refused Iris request is not shown as a started or completed model run", async () => {
  const element = () => ({ hidden: true, disabled: false, dataset: {}, textContent: "", children: [],
    style: { setProperty() {} }, setAttribute() {},
    addEventListener(_, listener) { this.listener = listener; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); } });
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection",
    "language", "score", "technical", "event-pulses", "event-log"]) nodes.set(`#${id}`, element());
  runInNewContext(readFileSync(join(root, "mining-app/app.js"), "utf8"), {
    document: { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id),
      querySelectorAll: () => [], createElement: element },
    navigator: { language: "ru-RU" }, AbortController,
    fetch: async (path) => {
      if (path === "/status") return { ok: true,
        json: async () => ({ status: "local-model-service-ready" }) };
      throw new TypeError("refused");
    },
    setInterval: () => 0, setTimeout, clearTimeout, TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await nodes.get("#start").listener();
  const labels = nodes.get("#event-log").children.map((item) => item.children[1]?.textContent);
  assert.equal(labels.includes("Запрошена проверка Iris"), true);
  assert.equal(labels.some((label) => /запущена|результат Iris получен/i.test(label ?? "")), false);
});

test("model endpoint refuses cross-origin, input bodies, and concurrent runs", async () => {
  let finish;
  let calls = 0;
  const model = () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  };
  const { server, base, token } = await serve(model);
  const request = (origin, body = "") => fetch(`${base}/model-check`, {
    method: "POST", body, headers: { origin, "X-NIR-Session": token },
  });
  try {
    assert.equal((await request("https://other.example")).status, 403);
    assert.equal((await request(base, "python-code")).status, 403);
    assert.equal(calls, 0);
    const first = request(base);
    for (let index = 0; index < 100 && !finish; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls, 1);
    assert.equal((await request(base)).status, 409);
    finish({
      status: "pinned-local-model-evaluation", scope: "local-public-iris-example-only",
      baselineAccuracyBps: 9000, candidateAccuracyBps: 9666, caseCount: 30,
      bundleHash: "a".repeat(64), bundleVerified: true, independentOperators: false,
      hiddenChallenges: false, energyAttested: false, networkSubmitted: false,
      rewardCredited: false, walletChanged: false,
    });
    assert.equal((await first).status, 200);
  } finally { await stop(server); }
});

test("pinned Iris endpoint runs trained classifiers and never reports a reward", async () => {
  const { server, base, token } = await serve();
  try {
    const response = await fetch(`${base}/model-check`, {
      method: "POST", body: "", headers: { origin: base, "X-NIR-Session": token },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result, { ...await runPinnedModel(root), evidenceAvailable: true });
    assert.equal(result.baselineAccuracyBps, 9000);
    assert.equal(result.candidateAccuracyBps, 9666);
    assert.equal(result.bundleVerified, true);
    assert.equal(result.networkSubmitted, false);
    assert.equal(result.rewardCredited, false);
  } finally { await stop(server); }
});

test("Iris evidence can be downloaded only after a real local run and independently rerun", async () => {
  const { server, base, token } = await serve();
  const evidence = () => fetch(`${base}/model-evidence`, {
    headers: { "X-NIR-Session": token },
  });
  try {
    assert.equal((await evidence()).status, 404);
    assert.equal((await fetch(`${base}/model-evidence`)).status, 403);
    const run = await fetch(`${base}/model-check`, {
      method: "POST", body: "", headers: { origin: base, "X-NIR-Session": token },
    });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).evidenceAvailable, true);
    const downloaded = await evidence();
    assert.equal(downloaded.status, 200);
    const raw = await downloaded.text();
    assert.ok(Buffer.byteLength(raw) <= 1_000_000);
    const item = JSON.parse(raw);
    assert.equal(item.format, "nir-local-iris-evidence-v1");
    assert.equal(item.summary.rewardCredited, false);
    const verifier = execFileSync("python3", ["-B", "-m", "nir.iris_rehearsal", "--verify-evidence"], {
      cwd: root, input: raw, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(JSON.parse(verifier).bundleHash, item.summary.bundleHash);
  } finally { await stop(server); }
});

test("another Model Lab service can import and rerun bounded Iris evidence without crediting a reward", async () => {
  const first = await serve();
  const second = await serve();
  try {
    const run = await fetch(`${first.base}/model-check`, { method: "POST", body: "",
      headers: { origin: first.base, "X-NIR-Session": first.token } });
    assert.equal(run.status, 200);
    const exported = await fetch(`${first.base}/model-evidence`, {
      headers: { "X-NIR-Session": first.token } });
    const raw = await exported.text();
    const verify = (body, token = second.token) => fetch(`${second.base}/model-evidence/verify`, {
      method: "POST", body,
      headers: { origin: second.base, "X-NIR-Session": token,
        "Content-Type": "application/json" },
    });
    assert.equal((await verify(raw, "0".repeat(64))).status, 403);
    const checked = await verify(raw);
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), { status: "local-iris-evidence-matched",
      bundleHash: JSON.parse(raw).summary.bundleHash, independentlyVerified: false,
      networkSubmitted: false, rewardEligible: false });
    const forged = JSON.parse(raw);
    forged.summary.candidateAccuracyBps = 10_000;
    assert.equal((await verify(JSON.stringify(forged))).status, 400);
    const typeSwapped = JSON.parse(raw);
    typeSwapped.summary.rewardCredited = 0;
    assert.equal((await verify(JSON.stringify(typeSwapped))).status, 400);
    const extraCommand = JSON.parse(raw);
    extraCommand.command = "/bin/sh";
    assert.equal((await verify(JSON.stringify(extraCommand))).status, 400);
    assert.equal((await verify("x".repeat(1_000_001))).status, 403);
  } finally { await stop(first.server); await stop(second.server); }
});

test("a participant data-only Iris model changes measured output without executing supplied code", async () => {
  const { server, base, token } = await serve();
  const second = await serve();
  const model = JSON.stringify({ bias: [-21900, -199165, -349234],
    format: "nir-iris-integer-linear-v1",
    weights: [[0, 0, 2920, 480], [0, 0, 8520, 2660], [0, 0, 11100, 4060]] });
  const submit = (body, origin = base, session = token) => fetch(`${base}/candidate/iris-linear`, {
    method: "POST", body, headers: { origin, "X-NIR-Session": session,
      "Content-Type": "application/json" },
  });
  try {
    const example = await fetch(`${base}/iris-linear-sample.json`);
    assert.equal(example.status, 200);
    assert.equal(JSON.parse(await example.text()).format, "nir-iris-integer-linear-v1");
    assert.equal((await submit(model, "https://attacker.invalid")).status, 403);
    assert.equal((await submit(model, base, "0".repeat(64))).status, 403);
    const checked = await submit(model);
    assert.equal(checked.status, 200);
    const result = await checked.json();
    assert.equal(result.status, "local-iris-data-model-evaluated");
    assert.equal(result.baselineAccuracyBps, 9000);
    assert.equal(result.caseCount, 30);
    assert.match(result.modelHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.rewardEligible, false);
    assert.equal(result.networkSubmitted, false);
    const secondRun = await fetch(`${second.base}/candidate/iris-linear`, {
      method: "POST", body: model, headers: { origin: second.base,
        "X-NIR-Session": second.token, "Content-Type": "application/json" },
    });
    assert.equal(secondRun.status, 200);
    assert.deepEqual(await secondRun.json(), result);
    const zero = await submit(JSON.stringify({ bias: [0, 0, 0],
      format: "nir-iris-integer-linear-v1", weights: Array.from({ length: 3 }, () => [0, 0, 0, 0]) }));
    assert.equal(zero.status, 200);
    assert.notEqual((await zero.json()).candidateAccuracyBps, result.candidateAccuracyBps);
    assert.equal((await submit('{"format":"nir-iris-integer-linear-v1","format":"evil"}')).status, 400);
    assert.equal((await submit(JSON.stringify({ ...JSON.parse(model), command: "/bin/sh" }))).status, 400);
    assert.equal((await submit("x".repeat(4097))).status, 403);
  } finally { await stop(server); await stop(second.server); }
});

test("a local stress challenge fixes model bytes before its one-use seed is revealed", async () => {
  const first = await serve();
  const second = await serve();
  const sample = readFileSync(join(root, "examples/iris_integer_linear.json"));
  const changed = JSON.parse(sample);
  changed.bias[2] = -400000;
  const commit = (body = sample, origin = first.base, token = first.token) =>
    fetch(`${first.base}/candidate/iris-linear/commit`, { method: "POST", body,
      headers: { origin, "X-NIR-Session": token, "Content-Type": "application/json" } });
  const reveal = (id, base = first.base, token = first.token) =>
    fetch(`${base}/candidate/iris-linear/reveal`, { method: "POST", body: "",
      headers: { origin: base, "X-NIR-Session": token, "X-NIR-Challenge": id } });
  try {
    assert.equal((await commit(sample, "https://attacker.invalid")).status, 403);
    assert.equal((await commit(sample, first.base, "0".repeat(64))).status, 403);
    const accepted = await commit();
    assert.equal(accepted.status, 200);
    const record = await accepted.json();
    assert.equal(record.status, "local-model-committed");
    assert.match(record.modelHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(record.commitHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(record.challengeId, /^[a-f0-9]{32}$/);
    assert.equal(record.seed, undefined);
    assert.equal(record.rewardEligible, false);
    assert.equal((await commit(Buffer.from(JSON.stringify(changed)))).status, 409);
    assert.equal((await reveal("0".repeat(32))).status, 404);
    assert.equal((await reveal(record.challengeId, first.base, "0".repeat(64))).status, 403);
    assert.equal((await fetch(`${first.base}/candidate/iris-linear/reveal`, {
      method: "POST", body: "x", headers: { origin: first.base,
        "X-NIR-Session": first.token, "X-NIR-Challenge": record.challengeId },
    })).status, 403);
    assert.equal((await reveal(record.challengeId, second.base, second.token)).status, 404);
    const scored = await reveal(record.challengeId);
    assert.equal(scored.status, 200);
    const result = await scored.json();
    assert.equal(result.status, "local-postcommit-iris-stress");
    assert.equal(result.modelHash, record.modelHash);
    assert.equal(result.commitHash, record.commitHash);
    assert.match(result.seed, /^[a-f0-9]{64}$/);
    assert.equal(result.caseCount, 90);
    assert.equal(result.syntheticPerturbations, true);
    assert.equal(result.hiddenChallenges, false);
    assert.equal(result.independentOperators, false);
    assert.equal(result.networkSubmitted, false);
    assert.equal(result.rewardEligible, false);
    assert.equal(result.walletChanged, false);
    assert.equal((await reveal(record.challengeId)).status, 404);
    const next = await commit(Buffer.from(JSON.stringify(changed)));
    assert.equal(next.status, 200);
    assert.notEqual((await next.json()).modelHash, record.modelHash);
  } finally { await stop(first.server); await stop(second.server); }
});

test("a failed later run clears prior Iris evidence and rejects forged bundle metadata", async () => {
  let calls = 0;
  const model = async (source, options) => {
    calls++;
    if (calls === 1) return runPinnedModel(source, options);
    if (calls === 2) return { ...await runPinnedModel(source, options),
      evidence: { format: "nir-local-iris-evidence-v1", summary: {}, bundle: { bundle_hash: "0".repeat(64) } } };
    throw new Error("model failed");
  };
  const { server, base, token } = await serve(model);
  const check = () => fetch(`${base}/model-check`, {
    method: "POST", body: "", headers: { origin: base, "X-NIR-Session": token },
  });
  const evidence = () => fetch(`${base}/model-evidence`, { headers: { "X-NIR-Session": token } });
  try {
    assert.equal((await check()).status, 200);
    assert.equal((await evidence()).status, 200);
    assert.equal((await check()).status, 500);
    assert.equal((await evidence()).status, 404);
    assert.equal((await check()).status, 500);
    assert.equal((await evidence()).status, 404);
  } finally { await stop(server); }
});

test("forged model success cannot be presented as verified or reward eligible", async () => {
  const { server, base, token } = await serve(async () => ({
    status: "pinned-local-model-evaluation", scope: "local-public-iris-example-only",
    baselineAccuracyBps: 9000, candidateAccuracyBps: 9666, caseCount: 30,
    bundleHash: "a".repeat(64), bundleVerified: true, independentOperators: false,
    hiddenChallenges: false, energyAttested: false, networkSubmitted: false,
    rewardCredited: true, walletChanged: false,
  }));
  try {
    const response = await fetch(`${base}/model-check`, {
      method: "POST", body: "", headers: { origin: base, "X-NIR-Session": token },
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /награда не начислена/);
  } finally { await stop(server); }
});

test("old demo endpoint is absent from the model app", async () => {
  const { server, base } = await serve(async () => ({}));
  try {
    const response = await fetch(`${base}/practice`, {
      method: "POST", body: "", headers: { origin: base },
    });
    assert.equal(response.status, 404);
  } finally { await stop(server); }
});
