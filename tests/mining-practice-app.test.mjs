import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

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
    assert.match(html, /Проверьте реальную модель локально/);
    assert.match(html, /Независимых операторов, скрытых заданий/);
  } finally { await stop(server); }
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
