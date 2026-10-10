import test from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTransferSession } from "../blockchain/synthetic-transfer.mjs";
import { createMiningPracticeApp } from "../blockchain/mining-practice-app.mjs";
import { join } from "node:path";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createOperatorWalletProof } from "../blockchain/operator-wallet-link.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const address = `nir1${"a".repeat(64)}`;
const other = `nir1${"b".repeat(64)}`;

test("explicitly synthetic training credit can be transferred once to a NIR-shaped address", () => {
  const ledger = createSyntheticTransferSession();
  assert.equal(ledger.snapshot().remaining, "0");
  ledger.startTraining();
  assert.equal(ledger.snapshot().remaining, "7");
  const entry = ledger.transfer({ recipient: address, amount: "3", id: "first" });
  assert.equal(entry.recipient, address);
  assert.equal(ledger.snapshot().remaining, "4");
  assert.equal(ledger.snapshot().balances[address], "3");
  assert.equal(BigInt(ledger.snapshot().remaining) +
    Object.values(ledger.snapshot().balances).reduce((sum, value) => sum + BigInt(value), 0n), 7n);
  assert.throws(() => ledger.transfer({ recipient: other, amount: "3", id: "first" }), /replay/);
  assert.equal(ledger.snapshot().balances[other], undefined);
});

test("synthetic transfer rejects malformed recipient, network, overspend, zero and repeated credit", () => {
  const ledger = createSyntheticTransferSession();
  assert.throws(() => ledger.transfer({ recipient: address, amount: "1", id: "x" }), /training/);
  ledger.startTraining();
  assert.throws(() => ledger.startTraining(), /already/);
  assert.throws(() => ledger.transfer({ recipient: "nir1bad", amount: "1", id: "x" }), /recipient/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "1", id: "x", networkId: "nir-mainnet-1" }), /network/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "0", id: "x" }), /amount/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "8", id: "x" }), /balance/);
  assert.deepEqual(ledger.snapshot().balances, {});
});

test("Model Lab exposes only authenticated in-memory synthetic transfers and never a wallet balance", async () => {
  const server = createMiningPracticeApp({ root: join(import.meta.dirname, "..") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: base, "X-NIR-Session": server.localSessionToken };
  const post = (path, body = "", extra = headers) => fetch(`${base}${path}`, {
    method: "POST", body, headers: { ...extra, ...(body ? { "Content-Type": "application/json" } : {}) },
  });
  try {
    assert.equal((await post("/synthetic-transfer/start", "", { ...headers, origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/synthetic-transfer/start", "", { origin: base })).status, 403);
    assert.equal((await post("/synthetic-transfer/start")).status, 403);
    const wallet = generateWallet();
    const otherWallet = generateWallet();
    const request = await post("/wallet-link/challenge");
    assert.equal(request.status, 200);
    const { challenge } = await request.json();
    const proof = createOperatorWalletProof({ wallet, challenge });
    assert.equal((await post("/wallet-link/complete", JSON.stringify(proof))).status, 200);
    const started = await post("/synthetic-transfer/start");
    assert.equal(started.status, 200);
    assert.equal((await started.json()).verifiedRecipient, wallet.address);
    assert.equal((await post("/synthetic-transfer/start")).status, 409);
    const input = { recipient: wallet.address, amount: "3", id: "test-1", networkId: "nir-synthetic-local-1" };
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, recipient: otherWallet.address }))).status, 400);
    const sent = await post("/synthetic-transfer", JSON.stringify(input));
    assert.equal(sent.status, 200);
    const result = await sent.json();
    assert.equal(result.state.balances[wallet.address], "3");
    assert.equal(result.state.transferableNir, "0");
    assert.equal(result.state.walletChanged, false);
    assert.equal(result.state.networkSubmitted, false);
    assert.equal((await post("/synthetic-transfer", JSON.stringify(input))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-2", networkId: "nir-mainnet-1" }))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-3", recipient: "bad" }))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-4", amount: "5" }))).status, 400);
    assert.equal((await post("/wallet-link/challenge")).status, 200);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-5", amount: "1" }))).status, 400);
    const state = await fetch(`${base}/synthetic-transfer/state`, {
      headers: { "X-NIR-Session": server.localSessionToken },
    });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).remaining, "4");
    assert.equal((await fetch(`${base}/synthetic-transfer/state`, {
      headers: { ...headers, origin: "https://evil.example" },
    })).status, 403);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("temporary wallet bridge proof permits only an imaginary transfer without vault mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-synthetic-link-test-"));
  const vaultPath = join(directory, "wallet.json");
  const password = "temporary-test-password";
  const wallet = createWalletFile({ path: vaultPath, password });
  const vaultBefore = readFileSync(vaultPath);
  const walletOrigin = "http://127.0.0.1:8976";
  const bridgeToken = "f".repeat(64);
  const bridge = createWalletBridgeServer({ vaultPath, origin: walletOrigin,
    sessionToken: bridgeToken, authorize: async () => password });
  const lab = createMiningPracticeApp({ root: join(import.meta.dirname, "..") });
  try {
    for (const server of [bridge, lab])
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const labBase = `http://127.0.0.1:${lab.address().port}`;
    const bridgeBase = `http://127.0.0.1:${bridge.address().port}`;
    const labHeaders = { origin: labBase, "X-NIR-Session": lab.localSessionToken };
    const postLab = (path, body = "") => fetch(`${labBase}${path}`, {
      method: "POST", body, headers: { ...labHeaders,
        ...(body ? { "Content-Type": "application/json" } : {}) },
    });
    const challengeResponse = await postLab("/wallet-link/challenge");
    assert.equal(challengeResponse.status, 200);
    const { challenge } = await challengeResponse.json();
    const signed = await fetch(`${bridgeBase}/v1/sign-operator-link`, {
      method: "POST", body: JSON.stringify({ challenge, requestId: "d".repeat(64) }),
      headers: { origin: walletOrigin, "X-NIR-Bridge-Token": bridgeToken,
        "Content-Type": "application/json" },
    });
    assert.equal(signed.status, 200);
    const { proof } = await signed.json();
    assert.equal((await postLab("/wallet-link/complete", JSON.stringify(proof))).status, 200);
    assert.equal((await postLab("/synthetic-transfer/start")).status, 200);
    const moved = await postLab("/synthetic-transfer", JSON.stringify({
      recipient: wallet.address, amount: "2", id: "bridge-test-1",
      networkId: "nir-synthetic-local-1",
    }));
    assert.equal(moved.status, 200);
    const { state } = await moved.json();
    assert.equal(state.balances[wallet.address], "2");
    assert.equal(state.remaining, "5");
    assert.equal(state.verifiedRecipient, wallet.address);
    assert.equal(state.transferableNir, "0");
    assert.equal(state.walletChanged, false);
    assert.deepEqual(readFileSync(vaultPath), vaultBefore);
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
