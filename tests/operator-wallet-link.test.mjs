import assert from "node:assert/strict";
import test from "node:test";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createOperatorWalletProof, verifyOperatorWalletProof } from "../blockchain/operator-wallet-link.mjs";
import { createLocalIrisRunIntent, signLocalIrisRunReceipt,
  verifyLocalIrisRunReceipt } from "../blockchain/operator-model-receipt.mjs";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createMiningPracticeApp, runPinnedModel } from "../blockchain/mining-practice-app.mjs";

test("operator link proves only local address ownership and binds challenge", () => {
  const wallet = generateWallet();
  const challenge = "a".repeat(64);
  const now = 1_000_000;
  const proof = createOperatorWalletProof({ wallet, challenge, now });
  assert.equal(verifyOperatorWalletProof(proof, { challenge, now: now + 1 }), wallet.address);
  assert.throws(() => verifyOperatorWalletProof(proof, { challenge: "b".repeat(64), now: now + 1 }));
  assert.throws(() => verifyOperatorWalletProof(proof, { challenge, now: now + 301_000 }));
  assert.throws(() => verifyOperatorWalletProof({ ...proof, address: generateWallet().address }, { challenge, now }));
  assert.throws(() => verifyOperatorWalletProof({ ...proof, networkId: "nir-main" }, { challenge, now }));
  assert.throws(() => verifyOperatorWalletProof({ ...proof, permissions: ["mint"] }, { challenge, now }));
});

test("a forged shallow Iris envelope can prove only signature and byte binding, never execution", () => {
  const wallet = generateWallet();
  const bundleHash = "a".repeat(64);
  const fakeEvidence = Buffer.from(JSON.stringify({ format: "nir-local-iris-evidence-v1",
    summary: { status: "pinned-local-model-evaluation",
      scope: "local-public-iris-example-only", bundleHash, bundleVerified: true,
      networkSubmitted: false, rewardCredited: false, independentOperators: false,
      hiddenChallenges: false, energyAttested: false, walletChanged: false },
    bundle: { bundle_hash: bundleHash } }));
  const intent = createLocalIrisRunIntent({ recipient: wallet.address,
    nonce: "b".repeat(64), bundleHash, evidenceBytes: fakeEvidence });
  const receipt = signLocalIrisRunReceipt({ wallet, intent });
  assert.equal(receipt.executionVerified, false);
  assert.deepEqual(verifyLocalIrisRunReceipt(receipt, { intent, evidenceBytes: fakeEvidence }), {
    recipient: wallet.address, signatureValid: true, evidenceBytesBound: true,
    executionVerified: false, networkSubmitted: false, rewardEligible: false,
  });
  assert.throws(() => signLocalIrisRunReceipt({ wallet,
    intent: { ...intent, executionVerified: true } }));
});

test("vault replacement during native approval cannot sign a different wallet", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-local-wallet-swap-"));
  const path = join(directory, "selected.json");
  const replacement = join(directory, "replacement.json");
  const password = "local-proof-test-password";
  const original = createWalletFile({ path, password });
  const other = createWalletFile({ path: replacement, password });
  const origin = "http://127.0.0.1:8977";
  const token = "d".repeat(64);
  const bridge = createWalletBridgeServer({ vaultPath: path, origin, sessionToken: token,
    authorize: async () => { copyFileSync(replacement, path); return password; } });
  try {
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${bridge.address().port}/v1/sign-operator-link`, {
      method: "POST", body: JSON.stringify({ challenge: "a".repeat(64), requestId: "e".repeat(64) }),
      headers: { origin, "x-nir-bridge-token": token, "content-type": "application/json" },
    });
    assert.equal(response.status, 400);
    assert.notEqual(original.address, other.address);
    assert.equal((await response.json()).proof, undefined);
  } finally {
    if (bridge.listening) {
      bridge.closeAllConnections?.();
      await new Promise((resolve) => bridge.close(resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge signs once and Model Lab consumes proof without crediting coins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-local-wallet-link-"));
  const vaultPath = join(directory, "wallet.json");
  const password = "local-proof-test-password";
  const wallet = createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8976";
  const token = "b".repeat(64);
  const bridge = createWalletBridgeServer({ vaultPath, origin, sessionToken: token,
    authorize: async () => password });
  const lab = createMiningPracticeApp({ root: join(import.meta.dirname, "..") });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await listen(bridge);
    await listen(lab);
    const bridgeBase = `http://127.0.0.1:${bridge.address().port}`;
    const labBase = `http://127.0.0.1:${lab.address().port}`;
    const labOrigin = labBase;
    const headers = { origin: labOrigin, "x-nir-session": lab.localSessionToken };
    const challengeResponse = await fetch(`${labBase}/wallet-link/challenge`, {
      method: "POST", body: "", headers,
    });
    assert.equal(challengeResponse.status, 200);
    const { challenge } = await challengeResponse.json();
    const forgedChallenge = await fetch(`${labBase}/wallet-link/challenge`, {
      method: "POST", body: "", headers: { ...headers, origin: "http://evil.invalid" },
    });
    assert.equal(forgedChallenge.status, 403);
    const refused = await fetch(`${bridgeBase}/v1/sign-operator-link`, {
      method: "POST", body: JSON.stringify({ challenge, requestId: "c".repeat(64) }),
      headers: { origin: labOrigin, "x-nir-bridge-token": token, "content-type": "application/json" },
    });
    assert.equal(refused.status, 403);
    const sign = await fetch(`${bridgeBase}/v1/sign-operator-link`, {
      method: "POST", body: JSON.stringify({ challenge, requestId: "c".repeat(64) }),
      headers: { origin, "x-nir-bridge-token": token, "content-type": "application/json" },
    });
    assert.equal(sign.status, 200);
    const { proof } = await sign.json();
    assert.equal(proof.address, wallet.address);
    const forgedComplete = await fetch(`${labBase}/wallet-link/complete`, {
      method: "POST", body: JSON.stringify(proof),
      headers: { ...headers, origin: "http://evil.invalid", "content-type": "application/json" },
    });
    assert.equal(forgedComplete.status, 403);
    const wrongProof = await fetch(`${labBase}/wallet-link/complete`, {
      method: "POST", body: JSON.stringify({ ...proof, address: generateWallet().address }),
      headers: { ...headers, "content-type": "application/json" },
    });
    assert.equal(wrongProof.status, 400);
    const consumedAfterInvalid = await fetch(`${labBase}/wallet-link/complete`, {
      method: "POST", body: JSON.stringify(proof),
      headers: { ...headers, "content-type": "application/json" },
    });
    assert.equal(consumedAfterInvalid.status, 410);
    const renewed = await fetch(`${labBase}/wallet-link/challenge`, {
      method: "POST", body: "", headers,
    });
    assert.equal(renewed.status, 200);
    const nextChallenge = (await renewed.json()).challenge;
    const nextProofResponse = await fetch(`${bridgeBase}/v1/sign-operator-link`, {
      method: "POST", body: JSON.stringify({ challenge: nextChallenge, requestId: "f".repeat(64) }),
      headers: { origin, "x-nir-bridge-token": token, "content-type": "application/json" },
    });
    assert.equal(nextProofResponse.status, 200);
    const nextProof = (await nextProofResponse.json()).proof;
    const complete = await fetch(`${labBase}/wallet-link/complete`, {
      method: "POST", body: JSON.stringify(nextProof),
      headers: { ...headers, "content-type": "application/json" },
    });
    assert.equal(complete.status, 200);
    assert.deepEqual(await complete.json(), {
      status: "local-address-ownership-verified", address: wallet.address,
      networkSubmitted: false, rewardEligible: false, walletChanged: false,
    });
    const replay = await fetch(`${labBase}/wallet-link/complete`, {
      method: "POST", body: JSON.stringify(nextProof),
      headers: { ...headers, "content-type": "application/json" },
    });
    assert.equal(replay.status, 410);
  } finally {
    for (const server of [bridge, lab]) {
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Iris run receipt intent requires a pre-linked address and cannot be redirected after run", async () => {
  const lab = createMiningPracticeApp({ root: join(import.meta.dirname, "..") });
  await new Promise((resolve) => lab.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${lab.address().port}`;
  const headers = { origin: base, "x-nir-session": lab.localSessionToken };
  const walletA = generateWallet();
  const walletB = generateWallet();
  const link = async (wallet) => {
    const challengeResponse = await fetch(`${base}/wallet-link/challenge`, {
      method: "POST", body: "", headers,
    });
    const { challenge } = await challengeResponse.json();
    const proof = createOperatorWalletProof({ wallet, challenge });
    const complete = await fetch(`${base}/wallet-link/complete`, {
      method: "POST", body: JSON.stringify(proof),
      headers: { ...headers, "content-type": "application/json" },
    });
    assert.equal(complete.status, 200);
  };
  try {
    const intent = () => fetch(`${base}/model-run-receipt/intent`, { headers });
    const status = async () => (await fetch(`${base}/model-run-receipt/status`, { headers })).json();
    const run = () => fetch(`${base}/model-check`, { method: "POST", body: "", headers });
    assert.equal((await run()).status, 200);
    assert.equal((await intent()).status, 404);
    assert.equal((await status()).status, "no-address-bound-run");
    assert.equal((await fetch(`${base}/model-evidence`, { headers })).status, 200);
    await link(walletA);
    assert.equal((await intent()).status, 404);
    assert.equal((await run()).status, 200);
    const response = await intent();
    assert.equal(response.status, 200);
    const a = await response.json();
    assert.equal(a.recipient, walletA.address);
    assert.equal(a.scope, "local-rehearsal-only");
    assert.equal(a.networkSubmitted, false);
    assert.equal(a.rewardEligible, false);
    assert.equal(a.genesisHash, null);
    assert.equal(a.networkId, null);
    assert.equal((await status()).status, "local-receipt-pending");
    const evidenceBytes = Buffer.from(await (await fetch(`${base}/model-evidence`, { headers })).text());
    const signed = signLocalIrisRunReceipt({ wallet: walletA, intent: a });
    assert.throws(() => verifyLocalIrisRunReceipt(signed));
    assert.deepEqual(verifyLocalIrisRunReceipt(signed, { intent: a, evidenceBytes }), {
      recipient: walletA.address, signatureValid: true, evidenceBytesBound: true,
      executionVerified: false, networkSubmitted: false, rewardEligible: false,
    });
    assert.throws(() => verifyLocalIrisRunReceipt({ ...signed, recipient: walletB.address },
      { intent: a, evidenceBytes }));
    assert.throws(() => verifyLocalIrisRunReceipt({ ...signed, rewardEligible: true },
      { intent: a, evidenceBytes }));
    assert.throws(() => verifyLocalIrisRunReceipt(signed,
      { intent: { ...a, nonce: "e".repeat(64) }, evidenceBytes }));
    assert.throws(() => verifyLocalIrisRunReceipt(signed,
      { intent: a, evidenceBytes: Buffer.from("different") }));
    const alteredBundle = Buffer.from(evidenceBytes.toString("utf8").replace(
      /"bundle_hash":"[0-9a-f]{64}"/, `"bundle_hash":"${"f".repeat(64)}"`));
    assert.throws(() => verifyLocalIrisRunReceipt(signed,
      { intent: a, evidenceBytes: alteredBundle }));
    const completeReceipt = (receipt, origin = base) => fetch(`${base}/model-run-receipt/complete`, {
      method: "POST", body: JSON.stringify(receipt),
      headers: { ...headers, origin, "content-type": "application/json" },
    });
    assert.equal((await completeReceipt(signed, "http://evil.invalid")).status, 403);
    assert.equal((await completeReceipt({ ...signed, evidenceDigest: "f".repeat(64) })).status, 400);
    assert.equal((await completeReceipt({ ...signed, recipient: walletB.address })).status, 400);
    assert.equal((await completeReceipt({ ...signed, rewardEligible: true })).status, 400);
    const complete = await completeReceipt(signed);
    assert.equal(complete.status, 200);
    assert.equal((await complete.json()).rewardEligible, false);
    const recovered = await status();
    assert.equal(recovered.status, "local-receipt-signature-checked");
    assert.equal(recovered.nonce, a.nonce);
    assert.equal(recovered.evidenceDigest, a.evidenceDigest);
    assert.equal(recovered.networkSubmitted, false);
    assert.equal(recovered.rewardEligible, false);
    assert.equal((await completeReceipt(signed)).status, 409);
    await link(walletB);
    assert.equal((await intent()).status, 404);
    assert.equal((await fetch(`${base}/model-evidence`, { headers })).status, 200);
  } finally {
    lab.closeAllConnections?.();
    await new Promise((resolve) => lab.close(resolve));
  }
});

test("wallet bridge signs only an exact local nonreward Iris intent after authorization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-iris-receipt-wallet-"));
  const path = join(directory, "wallet.json");
  const password = "local-proof-test-password";
  const wallet = createWalletFile({ path, password });
  let approvals = 0;
  const origin = "http://127.0.0.1:8980";
  const token = "b".repeat(64);
  const bridge = createWalletBridgeServer({ vaultPath: path, origin, sessionToken: token,
    authorize: async () => { approvals += 1; return password; } });
  try {
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${bridge.address().port}/v1/sign-local-iris-receipt`;
    const evidenceBytes = Buffer.from(JSON.stringify({ format: "nir-local-iris-evidence-v1",
      summary: { status: "pinned-local-model-evaluation",
        scope: "local-public-iris-example-only", bundleHash: "c".repeat(64),
        bundleVerified: true, networkSubmitted: false, rewardCredited: false,
        independentOperators: false, hiddenChallenges: false,
        energyAttested: false, walletChanged: false },
      bundle: { bundle_hash: "c".repeat(64) } }));
    const intent = createLocalIrisRunIntent({ recipient: wallet.address,
      nonce: "a".repeat(64), bundleHash: "c".repeat(64), evidenceBytes });
    assert.throws(() => createLocalIrisRunIntent({ recipient: wallet.address,
      nonce: "a".repeat(64), bundleHash: "d".repeat(64), evidenceBytes }));
    const post = (body) => fetch(url, { method: "POST", body: JSON.stringify(body),
      headers: { origin, "x-nir-bridge-token": token, "content-type": "application/json" } });
    assert.equal((await post({ intent: { ...intent, nonce: "a".repeat(400) },
      requestId: "1".repeat(64) })).status, 400);
    assert.equal((await post({ intent: { ...intent, rewardEligible: true },
      requestId: "2".repeat(64) })).status, 400);
    assert.equal((await post({ intent: { ...intent, extra: "mint" },
      requestId: "3".repeat(64) })).status, 400);
    assert.equal(approvals, 0);
    const signed = await post({ intent, requestId: "4".repeat(64) });
    assert.equal(signed.status, 200);
    const receipt = (await signed.json()).receipt;
    assert.equal(verifyLocalIrisRunReceipt(receipt, { intent,
      evidenceBytes }).executionVerified, false);
    assert.equal(approvals, 1);
    assert.equal((await post({ intent, requestId: "4".repeat(64) })).status, 409);
    assert.equal(approvals, 1);
  } finally {
    bridge.closeAllConnections?.();
    await new Promise((resolve) => bridge.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vault replacement during Iris receipt approval cannot sign with another account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-iris-receipt-swap-"));
  const path = join(directory, "selected.json");
  const replacement = join(directory, "replacement.json");
  const password = "local-proof-test-password";
  const original = createWalletFile({ path, password });
  createWalletFile({ path: replacement, password });
  const origin = "http://127.0.0.1:8981";
  const bridge = createWalletBridgeServer({ vaultPath: path, origin,
    sessionToken: "d".repeat(64), authorize: async () => {
      copyFileSync(replacement, path);
      return password;
    } });
  try {
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const bundleHash = "a".repeat(64);
    const evidenceBytes = Buffer.from(JSON.stringify({ format: "nir-local-iris-evidence-v1",
      summary: { status: "pinned-local-model-evaluation",
        scope: "local-public-iris-example-only", bundleHash, bundleVerified: true,
        networkSubmitted: false, rewardCredited: false, independentOperators: false,
        hiddenChallenges: false, energyAttested: false, walletChanged: false },
      bundle: { bundle_hash: bundleHash } }));
    const intent = createLocalIrisRunIntent({ recipient: original.address,
      nonce: "c".repeat(64), bundleHash, evidenceBytes });
    const response = await fetch(`http://127.0.0.1:${bridge.address().port}/v1/sign-local-iris-receipt`, {
      method: "POST", body: JSON.stringify({ intent, requestId: "e".repeat(64) }),
      headers: { origin, "x-nir-bridge-token": "d".repeat(64),
        "content-type": "application/json" },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).receipt, undefined);
  } finally {
    bridge.closeAllConnections?.();
    await new Promise((resolve) => bridge.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("changing linked wallet while Iris runs cannot redirect the run receipt", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const root = join(import.meta.dirname, "..");
  const lab = createMiningPracticeApp({ root, runModel: async (...args) => {
    started();
    await gate;
    return runPinnedModel(...args);
  } });
  await new Promise((resolve) => lab.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${lab.address().port}`;
  const headers = { origin: base, "x-nir-session": lab.localSessionToken };
  const link = async (wallet) => {
    const challenge = (await (await fetch(`${base}/wallet-link/challenge`, {
      method: "POST", body: "", headers,
    })).json()).challenge;
    const response = await fetch(`${base}/wallet-link/complete`, { method: "POST",
      body: JSON.stringify(createOperatorWalletProof({ wallet, challenge })),
      headers: { ...headers, "content-type": "application/json" } });
    assert.equal(response.status, 200);
  };
  try {
    await link(generateWallet());
    const pending = fetch(`${base}/model-check`, { method: "POST", body: "", headers });
    await startedPromise;
    await link(generateWallet());
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await fetch(`${base}/model-run-receipt/intent`, { headers })).status, 404);
  } finally {
    release();
    lab.closeAllConnections?.();
    await new Promise((resolve) => lab.close(resolve));
  }
});

test("temporary Mac wallet signs the exact local Iris run and Model Lab verifies it without reward", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-iris-local-flow-"));
  const vaultPath = join(directory, "wallet.json");
  const wallet = createWalletFile({ path: vaultPath, password: "local-proof-test-password" });
  const origin = "http://127.0.0.1:8992";
  const bridgeToken = "9".repeat(64);
  const bridge = createWalletBridgeServer({ vaultPath, origin, sessionToken: bridgeToken,
    authorize: async () => "local-proof-test-password" });
  const lab = createMiningPracticeApp({ root: join(import.meta.dirname, "..") });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await listen(bridge);
    await listen(lab);
    const labBase = `http://127.0.0.1:${lab.address().port}`;
    const bridgeBase = `http://127.0.0.1:${bridge.address().port}`;
    const headers = { origin: labBase, "x-nir-session": lab.localSessionToken };
    const bridgeHeaders = { origin, "x-nir-bridge-token": bridgeToken,
      "content-type": "application/json" };
    const challenge = (await (await fetch(`${labBase}/wallet-link/challenge`, {
      method: "POST", body: "", headers,
    })).json()).challenge;
    const linkProof = (await (await fetch(`${bridgeBase}/v1/sign-operator-link`, {
      method: "POST", body: JSON.stringify({ challenge, requestId: "1".repeat(64) }),
      headers: bridgeHeaders,
    })).json()).proof;
    assert.equal((await fetch(`${labBase}/wallet-link/complete`, { method: "POST",
      body: JSON.stringify(linkProof),
      headers: { ...headers, "content-type": "application/json" } })).status, 200);
    const model = await fetch(`${labBase}/model-check`, { method: "POST", body: "", headers });
    assert.equal(model.status, 200);
    assert.equal((await model.json()).rewardCredited, false);
    const intent = await (await fetch(`${labBase}/model-run-receipt/intent`, { headers })).json();
    const signedResponse = await fetch(`${bridgeBase}/v1/sign-local-iris-receipt`, {
      method: "POST", body: JSON.stringify({ intent, requestId: "2".repeat(64) }),
      headers: bridgeHeaders,
    });
    assert.equal(signedResponse.status, 200);
    const { receipt } = await signedResponse.json();
    const complete = await fetch(`${labBase}/model-run-receipt/complete`, { method: "POST",
      body: JSON.stringify(receipt),
      headers: { ...headers, "content-type": "application/json" },
    });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json()).recipient, wallet.address);
    assert.equal(receipt.networkSubmitted, false);
    assert.equal(receipt.rewardEligible, false);
    const evidenceBytes = Buffer.from(await (await fetch(`${labBase}/model-evidence`, { headers })).text());
    assert.deepEqual(verifyLocalIrisRunReceipt(receipt, { intent, evidenceBytes }), {
      recipient: wallet.address, signatureValid: true, evidenceBytesBound: true,
      executionVerified: false, networkSubmitted: false, rewardEligible: false,
    });
  } finally {
    for (const server of [bridge, lab]) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
