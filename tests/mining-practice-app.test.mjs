import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { createMiningPracticeApp, miningModelAppPreflight, runPinnedModel } from "../blockchain/mining-practice-app.mjs";

const root = join(import.meta.dirname, "..");
async function serve(runModel) {
  const server = createMiningPracticeApp({ root, runModel });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function stop(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

const qwenResult = {
  repository: "Qwen/Qwen3-0.6B", revision: "c1899de289a04d12100db370d81485cdf75e47ca",
  packageIdentity: `sha256:${"a".repeat(64)}`, answer: "NIR",
  rewardEligible: false, networkSubmitted: false, independentlyVerified: false,
};

test("pinned Qwen route requires explicit same-origin download consent and refuses code", async () => {
  let calls = 0;
  const server = createMiningPracticeApp({ root, runOpenModel: async () => { calls++; return qwenResult; } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (origin, consent, body = "") => fetch(`${base}/open-model/qwen-check`, {
    method: "POST", body, headers: { origin, ...(consent ? { "X-NIR-Download-Consent": consent } : {}) },
  });
  try {
    assert.equal((await request(base)).status, 403);
    assert.equal((await request("https://evil.example", "qwen3-0.6b-up-to-4gib")).status, 403);
    assert.equal((await request(base, "qwen3-0.6b-up-to-4gib", "import os")).status, 403);
    assert.equal(calls, 0);
    const response = await request(base, "qwen3-0.6b-up-to-4gib");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "local-open-model-inference-only", ...qwenResult });
    assert.equal(calls, 1);
  } finally { await stop(server); }
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

test("Qwen UI refuses missing runtime and requires a separate user confirmation", async () => {
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection",
    "language", "score", "technical", "qwen-start", "qwen-state", "qwen-answer", "qwen-identity"]) {
    nodes.set(`#${id}`, { hidden: true, disabled: false, dataset: {}, textContent: "", setAttribute() {},
      addEventListener(_, listener) { this.click = listener; } });
  }
  let runtime = { status: "missing-runtime", package: "mlx" };
  let consent = false;
  let runs = 0;
  const code = readFileSync(join(root, "mining-app/app.js"), "utf8");
  runInNewContext(code, {
    document: { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id), querySelectorAll: () => [] },
    navigator: { language: "ru-RU" }, window: { confirm: () => consent }, AbortController,
    fetch: async (path) => {
      if (path === "/status") return { ok: true, json: async () => ({ status: "local-model-service-ready" }) };
      if (path === "/open-model/runtime") return { ok: true, json: async () => runtime };
      if (path === "/open-model/qwen-check") { runs++; return { ok: true, json: async () => ({ status: "local-open-model-inference-only", ...qwenResult }) }; }
      throw new Error(`unexpected ${path}`);
    },
    setInterval: () => 0, setTimeout, clearTimeout, TypeError,
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
    document: { documentElement: { lang: "ru" }, querySelector: (id) => freshNodes.get(id), querySelectorAll: () => [] },
    navigator: { language: "ru-RU" }, window: { confirm: () => consent }, AbortController,
    fetch: async (path) => {
      if (path === "/status") return { ok: true, json: async () => ({ status: "local-model-service-ready" }) };
      if (path === "/open-model/runtime") return { ok: true, json: async () => runtime };
      if (path === "/open-model/qwen-check") { runs++; return { ok: true, json: async () => ({ status: "local-open-model-inference-only", ...qwenResult }) }; }
      throw new Error(`unexpected ${path}`);
    }, setInterval: () => 0, setTimeout, clearTimeout, TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(freshNodes.get("#qwen-start").disabled, false);
  await freshNodes.get("#qwen-start").click();
  assert.equal(runs, 0);
  consent = true;
  await freshNodes.get("#qwen-start").click();
  assert.equal(runs, 1);
  assert.equal(freshNodes.get("#qwen-answer").hidden, false);
  assert.match(freshNodes.get("#qwen-state").textContent, /награды нет/);
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
      origin: base, "X-NIR-Download-Consent": "qwen3-0.6b-up-to-4gib",
    },
  });
  try {
    const first = request();
    for (let index = 0; index < 100 && !finish; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    assert.equal((await request()).status, 409);
    finish({ ...qwenResult, rewardEligible: true });
    const denied = await first;
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
    assert.doesNotMatch(html, /<input|<textarea|<form/i);
    assert.match(html, /Проверка модели Iris/);
    assert.match(html, /Независимых операторов, скрытых заданий/);
    assert.match(html, /id="connection"/);
    assert.match(html, /id="error-message"/);
    const status = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(status, { status: "local-model-service-ready" });
  } finally { await stop(server); }
});

test("portrait layout stays narrow and a stopped service explains the new-tab requirement", async () => {
  const css = readFileSync(join(root, "mining-app/style.css"), "utf8");
  assert.match(css, /width:min\(100%,390px\)/);
  assert.match(css, /min-height:680px/);
  assert.match(css, /@media \(max-width:460px\)/);

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
    rewardCredited: false, walletChanged: false,
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
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection", "language", "score", "technical"]) {
    nodes.set(`#${id}`, { hidden: true, disabled: false, dataset: {}, textContent: "", setAttribute() {}, addEventListener() {} });
  }
  runInNewContext(readFileSync(join(root, "mining-app/app.js"), "utf8"), {
    document: { documentElement: { lang: "ru" }, querySelector: (id) => nodes.get(id), querySelectorAll: () => [] },
    navigator: { language: "ru-RU" }, AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ status: "another-service" }) }),
    setInterval: () => 0, setTimeout, clearTimeout, TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get("#connection").dataset.state, "offline");
  assert.equal(nodes.get("#start").disabled, true);
});

test("model endpoint refuses cross-origin, input bodies, and concurrent runs", async () => {
  let finish;
  let calls = 0;
  const model = () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  };
  const { server, base } = await serve(model);
  const request = (origin, body = "") => fetch(`${base}/model-check`, {
    method: "POST", body, headers: { origin },
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
  const { server, base } = await serve();
  try {
    const response = await fetch(`${base}/model-check`, {
      method: "POST", body: "", headers: { origin: base },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result, await runPinnedModel(root));
    assert.equal(result.baselineAccuracyBps, 9000);
    assert.equal(result.candidateAccuracyBps, 9666);
    assert.equal(result.bundleVerified, true);
    assert.equal(result.networkSubmitted, false);
    assert.equal(result.rewardCredited, false);
  } finally { await stop(server); }
});

test("forged model success cannot be presented as verified or reward eligible", async () => {
  const { server, base } = await serve(async () => ({
    status: "pinned-local-model-evaluation", scope: "local-public-iris-example-only",
    baselineAccuracyBps: 9000, candidateAccuracyBps: 9666, caseCount: 30,
    bundleHash: "a".repeat(64), bundleVerified: true, independentOperators: false,
    hiddenChallenges: false, energyAttested: false, networkSubmitted: false,
    rewardCredited: true, walletChanged: false,
  }));
  try {
    const response = await fetch(`${base}/model-check`, {
      method: "POST", body: "", headers: { origin: base },
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
