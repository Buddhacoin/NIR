import assert from "node:assert/strict";
import test from "node:test";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createOperatorWalletProof, verifyOperatorWalletProof } from "../blockchain/operator-wallet-link.mjs";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createMiningPracticeApp } from "../blockchain/mining-practice-app.mjs";

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
