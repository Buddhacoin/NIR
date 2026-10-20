import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createOperatorWalletProof } from "../blockchain/operator-wallet-link.mjs";
import { createLocalIrisRunIntent, signLocalIrisRunReceipt } from "../blockchain/operator-model-receipt.mjs";

const root = join(import.meta.dirname, "..");

async function startLabProcess() {
  // Exercise the real HTTP app and pinned Python Iris runtime in two OS processes.
  // The user-facing CLI intentionally refuses non-macOS hosts; this protocol
  // integration test must run on Linux CI without relaxing that product gate.
  const child = spawn(process.execPath, [join(root, "tests/fixtures/model-lab-server-child.mjs")], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { errorOutput += data; });
  try {
    const { base, token } = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Model Lab child startup timed out")), 20_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        output += data;
        const url = output.match(/NIR_MODEL_LAB_URL=(http:\/\/127\.0\.0\.1:\d+\/\?local-app=1)/);
        const session = output.match(/NIR_MODEL_LAB_SESSION=([0-9a-f]{64})/);
        if (url && session) {
          clearTimeout(timeout);
          resolve({ base: url[1].split("/?")[0], token: session[1] });
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Model Lab child exited ${code}: ${errorOutput}`));
      });
    });
    return { child, base, token };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

async function stopLabProcess(lab) {
  if (!lab || lab.child.exitCode !== null) return;
  const stopped = once(lab.child, "exit");
  lab.child.kill("SIGTERM");
  await stopped;
}

test("two separate Model Lab OS processes recheck exact Iris evidence and signed address binding without reward", async () => {
  const first = await startLabProcess();
  let second;
  try {
    second = await startLabProcess();
    assert.notEqual(first.child.pid, second.child.pid);
    assert.equal(new URL(first.base).hostname, "127.0.0.1");
    assert.equal(new URL(second.base).hostname, "127.0.0.1");
    assert.notEqual(first.token, second.token);
    const wallet = generateWallet();
    const firstHeaders = { origin: first.base, "X-NIR-Session": first.token };
    const challengeResponse = await fetch(`${first.base}/wallet-link/challenge`, {
      method: "POST", body: "", headers: firstHeaders,
    });
    assert.equal(challengeResponse.status, 200);
    const { challenge } = await challengeResponse.json();
    const link = await fetch(`${first.base}/wallet-link/complete`, {
      method: "POST", body: JSON.stringify(createOperatorWalletProof({ wallet, challenge })),
      headers: { ...firstHeaders, "Content-Type": "application/json" },
    });
    assert.equal(link.status, 200);
    const run = await fetch(`${first.base}/model-check`, { method: "POST", body: "", headers: firstHeaders });
    assert.equal(run.status, 200);
    const evidenceResponse = await fetch(`${first.base}/model-evidence`, {
      headers: { "X-NIR-Session": first.token },
    });
    assert.equal(evidenceResponse.status, 200);
    const evidenceBytes = Buffer.from(await evidenceResponse.arrayBuffer());
    const intent = await (await fetch(`${first.base}/model-run-receipt/intent`, {
      headers: { "X-NIR-Session": first.token },
    })).json();
    const receipt = signLocalIrisRunReceipt({ wallet, intent });
    const recheck = (bytes, signed = receipt) => fetch(`${second.base}/model-run-receipt/recheck`, {
      method: "POST", body: JSON.stringify({ evidenceBase64: bytes.toString("base64"), receipt: signed }),
      headers: { origin: second.base, "X-NIR-Session": second.token, "Content-Type": "application/json" },
    });
    const postRaw = (value, session = second.token, origin = second.base) =>
      fetch(`${second.base}/model-run-receipt/recheck`, { method: "POST", body: JSON.stringify(value),
        headers: { origin, "X-NIR-Session": session, "Content-Type": "application/json" } });
    const postRawBytes = (body) => fetch(`${second.base}/model-run-receipt/recheck`, {
      method: "POST", body,
      headers: { origin: second.base, "X-NIR-Session": second.token, "Content-Type": "application/json" },
    });
    assert.equal((await postRaw({ evidenceBase64: evidenceBytes.toString("base64"), receipt },
      "0".repeat(64))).status, 403);
    assert.equal((await postRaw({ evidenceBase64: evidenceBytes.toString("base64"), receipt },
      first.token)).status, 403);
    assert.equal((await postRaw({ evidenceBase64: evidenceBytes.toString("base64"), receipt },
      second.token, "http://evil.invalid")).status, 403);
    const checked = await recheck(evidenceBytes);
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), {
      status: "local-iris-recheck-with-address-binding", recipient: wallet.address,
      bundleHash: intent.bundleHash, evidenceDigest: intent.evidenceDigest,
      signatureValid: true, evidenceBytesBound: true, localReplayMatched: true,
      executionVerified: false, independentlyVerified: false,
      networkSubmitted: false, rewardEligible: false,
    });
    assert.equal((await recheck(evidenceBytes)).status, 200);
    const canonicalBase64 = evidenceBytes.toString("base64");
    assert.equal((await postRawBytes(`{"evidenceBase64":"%%%","evidenceBase64":"${canonicalBase64}","receipt":${JSON.stringify(receipt)}}`)).status, 400);
    const receiptJson = JSON.stringify(receipt);
    assert.equal((await postRawBytes(`{"evidenceBase64":"${canonicalBase64}","receipt":${receiptJson.replace(`"recipient":"${wallet.address}"`, `"recipient":"${generateWallet().address}","recipient":"${wallet.address}"`)}}`)).status, 400);
    assert.equal((await postRawBytes(Buffer.from([0xff, ...Buffer.from(JSON.stringify({ evidenceBase64: canonicalBase64, receipt }))]))).status, 400);
    assert.equal((await recheck(Buffer.concat([evidenceBytes, Buffer.from(" ")]))).status, 400);
    assert.equal((await recheck(evidenceBytes, { ...receipt, recipient: generateWallet().address })).status, 400);
    assert.equal((await recheck(evidenceBytes, { ...receipt, signature: "AAAA" })).status, 400);
    assert.equal((await recheck(evidenceBytes, { ...receipt, bundleHash: "f".repeat(64) })).status, 400);
    assert.equal((await postRaw({ evidenceBase64: "%%%", receipt })).status, 400);
    assert.equal((await postRaw({ evidenceBase64: evidenceBytes.toString("base64") })).status, 400);
    assert.equal((await postRaw({ evidenceBase64: "A".repeat(1_400_000), receipt })).status, 403);
    const fakeBundleHash = "a".repeat(64);
    const fakeBytes = Buffer.from(JSON.stringify({ format: "nir-local-iris-evidence-v1",
      summary: { status: "pinned-local-model-evaluation",
        scope: "local-public-iris-example-only", bundleHash: fakeBundleHash,
        bundleVerified: true, networkSubmitted: false, rewardCredited: false,
        independentOperators: false, hiddenChallenges: false, energyAttested: false,
        walletChanged: false }, bundle: { bundle_hash: fakeBundleHash } }));
    const fakeIntent = createLocalIrisRunIntent({ recipient: wallet.address,
      nonce: "a".repeat(64), bundleHash: fakeBundleHash, evidenceBytes: fakeBytes });
    const fakeReceipt = signLocalIrisRunReceipt({ wallet, intent: fakeIntent });
    assert.equal((await recheck(fakeBytes, fakeReceipt)).status, 400);
  } finally {
    await stopLabProcess(second);
    await stopLabProcess(first);
  }
});
