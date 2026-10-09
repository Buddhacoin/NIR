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

test("app preflight requires model files but not unrelated demo or wallet files", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-model-app-test-"));
  try {
    writeFileSync(join(temporary, "package.json"), '{"name":"nir-protocol","private":true}');
    for (const name of [
      "mining-app/index.html", "mining-app/app.js", "mining-app/style.css",
      "wallet-ui/nir-coin-icon.png", "nir/iris_rehearsal.py",
      "examples/iris_model_adapter.py", "examples/iris.data",
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
