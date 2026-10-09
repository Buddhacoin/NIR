import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createMiningPracticeApp, runPractice } from "../blockchain/mining-practice-app.mjs";

const root = join(import.meta.dirname, "..");
async function serve(run) {
  const server = createMiningPracticeApp({ root, run });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function stop(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test("mining practice app serves a single-button UI with no secret field", async () => {
  const { server, base } = await serve(async () => ({}));
  try {
    const response = await fetch(base);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(html, /id="start"/);
    assert.doesNotMatch(html, /<input|<textarea|<form/i);
    assert.match(html, /без реальной модели и без начисления монет/);
  } finally { await stop(server); }
});

test("practice endpoint refuses cross-origin requests and overlapping runs", async () => {
  let finish;
  let calls = 0;
  const { server, base } = await serve(() => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const request = (origin) => fetch(`${base}/practice`, {
    method: "POST", body: "", headers: { origin },
  });
  try {
    assert.equal((await request("https://other.example")).status, 403);
    assert.equal(calls, 0);
    const first = request(base);
    for (let index = 0; index < 100 && !finish; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls, 1);
    assert.equal((await request(base)).status, 409);
    finish({ blockHeight: 6, tipHash: "a".repeat(64) });
    const response = await first;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "local-practice-complete", scope: "local-valueless-demo-only",
      blockHeight: 6, tipHash: "a".repeat(64), walletChanged: false,
      networkSubmitted: false, rewardCredited: false,
    });
  } finally { await stop(server); }
});

test("real practice returns only a local block and no payout or wallet data", async () => {
  if (process.platform !== "darwin" || Number.parseInt(process.versions.node, 10) < 26) return;
  const result = await runPractice(root);
  assert.ok(result.blockHeight > 0);
  assert.match(result.tipHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /reward|address|private|password|seed/i);
});

test("invalid practice output is never presented as a successful reward", async () => {
  const { server, base } = await serve(async () => ({ blockHeight: 0, tipHash: "bad" }));
  try {
    const response = await fetch(`${base}/practice`, {
      method: "POST", body: "", headers: { origin: base },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Локальная тренировка не завершилась. Баланс кошелька не менялся.",
    });
  } finally { await stop(server); }
});
