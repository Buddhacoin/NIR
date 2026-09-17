import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet, verifyObject } from "../blockchain/crypto.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { createAccountProof } from "../blockchain/account-proof.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";

async function close(server) {
  if (!server.listening) return;
  const done = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await done;
}

function request(url, origin, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin,
      "x-nir-bridge-token": token,
      ...options.headers,
    },
  });
}

function validatorMembers(wallets) {
  return wallets.map((wallet) => ({
    ...publicWallet(wallet), operatorId: `validator-${wallet.address.slice(4, 16)}`,
  }));
}

test("wallet account trust advances through verified validator handoffs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-proof-rotation-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const account = createWalletFile({ path: vaultPath, password: "wallet-proof-password-long" });
  const first = Array.from({ length: 4 }, generateWallet);
  const second = [first[0], first[1], generateWallet(), generateWallet()];
  const firstMembers = validatorMembers(first);
  const secondMembers = validatorMembers(second);
  const networkId = "nir-wallet-rotation-test";
  const handoff = createValidatorHandoff({
    activationBlockHash: "a".repeat(64),
    activationHeight: 10,
    activationStateRoot: "b".repeat(64),
    networkId,
    nextValidators: secondMembers,
    previousValidators: firstMembers,
  }, first.slice(0, 3), second.slice(0, 3));
  const accountState = {
    address: account.address,
    atomicBalance: "500000000",
    nextNonce: 2,
    resources: {
      atomicStake: "0", availableTransferCredits: "0", delegations: [], pendingUnstake: null,
    },
  };
  const proof = createAccountProof({
    account: accountState,
    height: 10,
    networkId,
    stateRoot: "b".repeat(64),
    tipHash: "a".repeat(64),
    validators: secondMembers,
    validatorWallets: second.slice(0, 3),
  });
  const staleAuthority = createAccountProof({
    account: accountState,
    height: 10,
    networkId,
    stateRoot: "b".repeat(64),
    tipHash: "a".repeat(64),
    validators: firstMembers,
    validatorWallets: first.slice(0, 3),
  });
  const origin = "http://127.0.0.1:8765";
  const token = "0".repeat(64);
  const trustCheckpointPath = join(directory, "wallet.trust.json");
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    sessionToken: token,
    trustAnchor: {
      expectedNetworkId: networkId,
      handoffs: [handoff],
      trustedValidators: firstMembers,
    },
    trustCheckpointPath,
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const verified = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: account.address, minimumHeight: 10, proof }), method: "POST",
    });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).verified, true);
    assert.equal(existsSync(trustCheckpointPath), true);
    const rejected = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({
        address: account.address, minimumHeight: 10, proof: staleAuthority,
      }),
      method: "POST",
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /trust anchor/);
    const wrongActivationProof = createAccountProof({
      account: accountState,
      height: 10,
      networkId,
      stateRoot: "c".repeat(64),
      tipHash: "d".repeat(64),
      validators: secondMembers,
      validatorWallets: second.slice(0, 3),
    });
    const wrongActivation = await request(
      `${base}/v1/verify-account-proof`, origin, token, {
        body: JSON.stringify({
          address: account.address, minimumHeight: 10, proof: wrongActivationProof,
        }),
        method: "POST",
      },
    );
    assert.equal(wrongActivation.status, 400);
    assert.match((await wrongActivation.json()).error, /activation block/);
    await close(server);
    assert.throws(() => createWalletBridgeServer({
      authorize: async () => null,
      origin,
      sessionToken: token,
      trustAnchor: {
        expectedNetworkId: networkId,
        handoffs: [],
        trustedValidators: firstMembers,
      },
      trustCheckpointPath,
      vaultPath,
    }), /rolls back/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge signs only an exact-origin, session-authorized, confirmed request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-bridge-password-long";
  const wallet = createWalletFile({ path: vaultPath, password });
  const recipient = generateWallet();
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  const approvals = [];
  const server = createWalletBridgeServer({
    authorize: async (intent) => { approvals.push(intent); return password; },
    origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await request(`${base}/v1/wallet`, "http://evil.invalid", token)).status, 403);
    assert.equal((await request(`${base}/v1/wallet`, origin, "b".repeat(64))).status, 401);
    const publicInfo = await request(`${base}/v1/wallet`, origin, token);
    assert.equal(publicInfo.status, 200);
    assert.equal((await publicInfo.json()).address, wallet.address);

    const intent = {
      amount: "250000000",
      networkId: "nir-testnet",
      nonce: 0,
      recipient: recipient.address,
      requestId: "c".repeat(64),
    };
    const signed = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(signed.status, 200);
    const result = await signed.json();
    assert.equal(result.requestId, intent.requestId);
    assert.equal(approvals.length, 1);
    const { signature, ...payload } = result.transaction;
    const publicKey = JSON.parse(readFileSync(vaultPath, "utf8")).publicKey;
    assert.equal(verifyObject(payload, signature, publicKey, "TRANSFER"), true);
    assert.equal(JSON.stringify(result).includes("privateKey"), false);
    const replay = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /already used/);
    assert.equal(approvals.length, 1);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge never broadcasts and consumes a rejected request id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-reject-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const recipient = generateWallet();
  const origin = "http://localhost:8765";
  const token = "d".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const intent = {
      amount: "1", networkId: "nir-testnet", nonce: 0,
      recipient: recipient.address, requestId: "e".repeat(64),
    };
    const rejected = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /rejected/);
    assert.equal((await request(`${base}/v1/transactions`, origin, token, {
      body: "{}", method: "POST",
    })).status, 404);
    const replay = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /already used/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge signs an allowlisted resource operation without exposing the key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-resource-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-resource-password-long";
  createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8765";
  const token = "3".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => password, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({
        amount: "10000000000", fee: "1000", networkId: "nir-testnet", nonce: 0,
        requestId: "4".repeat(64), type: "credit-stake",
      }),
      method: "POST",
    });
    assert.equal(signed.status, 200);
    const result = await signed.json();
    const { signature, ...payload } = result.transaction;
    const publicKey = JSON.parse(readFileSync(vaultPath, "utf8")).publicKey;
    assert.equal(verifyObject(payload, signature, publicKey, "CREDIT_STAKE"), true);
    assert.equal(result.transaction.type, "credit-stake");
    assert.equal(JSON.stringify(result).includes("privateKey"), false);

    const invalid = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({
        networkId: "nir-testnet", nonce: 1, requestId: "5".repeat(64), type: "validator-bond",
      }),
      method: "POST",
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /invalid/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge signs and verifies an exact expiring payment request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-request-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-payment-request-password";
  const wallet = createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8765";
  const token = "7".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => password, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "300000000",
        expiresAt: Date.now() + 3_600_000,
        memo: "Invoice 17",
        networkId: "nir-testnet",
        requestId: "8".repeat(64),
      }),
      method: "POST",
    });
    assert.equal(signed.status, 200);
    const result = await signed.json();
    assert.equal(result.paymentRequest.recipient, wallet.address);
    assert.equal(result.paymentRequest.amount, "300000000");

    const verified = await request(`${base}/v1/verify-payment-request`, origin, token, {
      body: JSON.stringify({ networkId: "nir-testnet", request: result.paymentRequest }),
      method: "POST",
    });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).verified, true);

    const tampered = await request(`${base}/v1/verify-payment-request`, origin, token, {
      body: JSON.stringify({
        networkId: "nir-testnet",
        request: { ...result.paymentRequest, amount: "300000001" },
      }),
      method: "POST",
    });
    assert.equal(tampered.status, 400);
    assert.match((await tampered.json()).error, /signature/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge serializes confirmations so prompts cannot overlap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-lock-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-bridge-password-long";
  createWalletFile({ path: vaultPath, password });
  const recipient = generateWallet();
  const origin = "http://127.0.0.1:8765";
  const token = "f".repeat(64);
  let releaseApproval;
  let approvalStarted;
  const started = new Promise((resolve) => { approvalStarted = resolve; });
  const server = createWalletBridgeServer({
    authorize: async () => {
      approvalStarted();
      return new Promise((resolve) => { releaseApproval = () => resolve(password); });
    },
    origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const intent = (requestId) => ({
      amount: "1", networkId: "nir-testnet", nonce: 0,
      recipient: recipient.address, requestId,
    });
    const first = request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent("1".repeat(64))), method: "POST",
    });
    await started;
    const second = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent("2".repeat(64))), method: "POST",
    });
    assert.equal(second.status, 400);
    assert.match((await second.json()).error, /another signing request/);
    releaseApproval();
    assert.equal((await first).status, 200);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge exchanges a short-lived one-time code for one in-memory session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-pair-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const token = "9".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    pairingCode: "12345678",
    sessionToken: token,
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const wrong = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "00000000" }), method: "POST",
    });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /invalid/);
    const paired = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "12345678" }), method: "POST",
    });
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), { sessionToken: token });
    const reused = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "12345678" }), method: "POST",
    });
    assert.equal(reused.status, 400);
    assert.match((await reused.json()).error, /unavailable/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge disables pairing after five incorrect attempts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-attempt-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    pairingCode: "87654321",
    sessionToken: "6".repeat(64),
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await request(`${base}/v1/pair`, origin, "", {
        body: JSON.stringify({ code: "00000000" }), method: "POST",
      });
      assert.equal(rejected.status, 400);
    }
    const locked = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "87654321" }), method: "POST",
    });
    assert.equal(locked.status, 400);
    assert.match((await locked.json()).error, /unavailable/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
