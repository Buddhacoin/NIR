import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCreditStake, createTransfer } from "../blockchain/chain.mjs";
import { verifyAccountProof } from "../blockchain/account-proof.mjs";
import { ATOMIC_UNITS, MIN_TRANSFER_FEE } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createNodeHttpServer } from "../blockchain/node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { exportBlockStoreBackup, loadBlockStore } from "../blockchain/block-store.mjs";

test("a transfer survives a complete node restart and replay", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-node-test-"));
  const directory = join(temporary, "node");
  try {
    initializeDevnet(directory);
    const alice = generateWallet();
    const bob = generateWallet();
    let node = new PersistentDevNode(directory);
    node.faucet(alice.address);
    const transfer = createTransfer({
      wallet: alice, networkId: node.networkId, recipient: bob.address,
      amount: (2n * ATOMIC_UNITS).toString(), nonce: 0,
    });
    node.submitTransaction(transfer);
    assert.equal(node.account(bob.address).atomicBalance, (2n * ATOMIC_UNITS).toString());
    assert.equal(node.account(alice.address).atomicBalance,
      (8n * ATOMIC_UNITS - MIN_TRANSFER_FEE).toString());
    assert.equal(node.height, 2);

    node = new PersistentDevNode(directory);
    assert.equal(node.height, 2);
    assert.equal(node.account(bob.address).transactions.length, 1);
    assert.equal(node.account(bob.address).atomicBalance, (2n * ATOMIC_UNITS).toString());

    const forged = { ...transfer, nonce: 1, amount: (3n * ATOMIC_UNITS).toString() };
    assert.throws(() => node.submitTransaction(forged), /invalid transaction signature/);
    assert.equal(node.height, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("account RPC state includes persistent transfer-credit resources", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-resource-account-test-"));
  const directory = join(temporary, "node");
  try {
    initializeDevnet(directory);
    const wallet = generateWallet();
    let node = new PersistentDevNode(directory);
    node.faucet(wallet.address, (10n * ATOMIC_UNITS).toString());
    node.submitTransaction(createCreditStake({
      wallet,
      networkId: node.networkId,
      amount: (5n * ATOMIC_UNITS).toString(),
      nonce: 0,
    }));
    let account = node.account(wallet.address);
    assert.equal(account.resources.atomicStake, (5n * ATOMIC_UNITS).toString());
    assert.equal(account.resources.availableTransferCredits, "0");
    assert.deepEqual(account.resources.delegations, []);
    assert.equal(account.resources.pendingUnstake, null);

    node = new PersistentDevNode(directory);
    account = node.account(wallet.address);
    assert.equal(account.resources.atomicStake, (5n * ATOMIC_UNITS).toString());
    assert.equal(account.resources.availableTransferCredits, "0");
    const proof = node.accountProof(wallet.address);
    const genesis = JSON.parse(readFileSync(join(directory, "genesis.json"), "utf8"));
    const verified = verifyAccountProof(proof, {
      expectedAddress: wallet.address,
      expectedNetworkId: node.networkId,
      minimumHeight: node.height,
      trustedValidators: genesis.validators,
    });
    assert.equal(verified.account.atomicBalance, account.atomicBalance);
    assert.deepEqual(verified.account.resources, account.resources);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a corrupted primary block and checkpoint recover from verified redundant copies", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-node-recovery-test-"));
  const directory = join(temporary, "node");
  try {
    initializeDevnet(directory);
    const wallet = generateWallet();
    let node = new PersistentDevNode(directory);
    node.faucet(wallet.address);
    const blockName = "000000000001.json";
    const primary = join(directory, "blocks", blockName);
    const backup = join(directory, "block-backups", blockName);
    writeFileSync(primary, "{broken", "utf8");
    writeFileSync(join(directory, "STORE-CHECKPOINT.json"), "{broken", "utf8");

    node = new PersistentDevNode(directory);
    assert.equal(node.height, 1);
    assert.equal(node.account(wallet.address).atomicBalance, (10n * ATOMIC_UNITS).toString());
    assert.equal(readFileSync(primary, "utf8"), readFileSync(backup, "utf8"));
    assert.equal(
      readFileSync(join(directory, "STORE-CHECKPOINT.json"), "utf8"),
      readFileSync(join(directory, "STORE-CHECKPOINT.backup.json"), "utf8"),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a stale checkpoint advances from fully verified journal data", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-node-checkpoint-test-"));
  const directory = join(temporary, "node");
  try {
    initializeDevnet(directory);
    const alice = generateWallet();
    const bob = generateWallet();
    let node = new PersistentDevNode(directory);
    node.faucet(alice.address);
    const stale = readFileSync(join(directory, "STORE-CHECKPOINT.json"), "utf8");
    node.submitTransaction(createTransfer({
      wallet: alice,
      networkId: node.networkId,
      recipient: bob.address,
      amount: ATOMIC_UNITS.toString(),
      nonce: 0,
    }));
    writeFileSync(join(directory, "STORE-CHECKPOINT.json"), stale, "utf8");
    writeFileSync(join(directory, "STORE-CHECKPOINT.backup.json"), stale, "utf8");

    node = new PersistentDevNode(directory);
    assert.equal(node.height, 2);
    assert.equal(node.account(bob.address).atomicBalance, ATOMIC_UNITS.toString());
    assert.equal(JSON.parse(readFileSync(
      join(directory, "STORE-CHECKPOINT.json"), "utf8",
    )).height, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("startup fails closed when both copies of a committed block are lost", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-node-loss-test-"));
  const directory = join(temporary, "node");
  try {
    initializeDevnet(directory);
    const node = new PersistentDevNode(directory);
    node.faucet(generateWallet().address);
    const blockName = "000000000001.json";
    rmSync(join(directory, "blocks", blockName));
    rmSync(join(directory, "block-backups", blockName));
    assert.throws(() => new PersistentDevNode(directory), /missing or corrupted in both copies/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("startup fails closed when every existing checkpoint is corrupted", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-node-checkpoint-loss-test-"));
  const directory = join(temporary, "node");
  try {
    initializeDevnet(directory);
    writeFileSync(join(directory, "STORE-CHECKPOINT.json"), "{broken", "utf8");
    writeFileSync(join(directory, "STORE-CHECKPOINT.backup.json"), "{broken", "utf8");
    assert.throws(() => new PersistentDevNode(directory), /checkpoints are corrupted/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an exported chain backup is independently replayable and contains no private keys", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-node-export-test-"));
  const directory = join(temporary, "node");
  const backup = join(temporary, "public-backup");
  try {
    initializeDevnet(directory);
    const wallet = generateWallet();
    const node = new PersistentDevNode(directory);
    node.faucet(wallet.address);
    const genesis = JSON.parse(readFileSync(join(directory, "genesis.json"), "utf8"));
    const result = exportBlockStoreBackup(directory, backup, genesis);
    assert.equal(result.height, 1);
    assert.equal(result.privateKeysIncluded, false);
    assert.equal(existsSync(join(backup, "DEVNET-KEYS.json")), false);
    const replay = loadBlockStore(backup, genesis);
    assert.equal(replay.chain.height, 1);
    assert.equal(replay.chain.tipHash, node.tipHash);
    assert.throws(() => exportBlockStoreBackup(directory, backup, genesis), /EEXIST/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the localhost RPC exposes health, faucet, account, and rejects foreign origins", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-rpc-test-"));
  const directory = join(temporary, "node");
  const server = createNodeHttpServer((() => {
    initializeDevnet(directory);
    return new PersistentDevNode(directory);
  })());
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.status, "ready");
    assert.equal(health.valueMode, "valueless-devnet");

    const wallet = generateWallet();
    const faucetResponse = await fetch(`${base}/v1/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8765" },
      body: JSON.stringify({ recipient: wallet.address }),
    });
    assert.equal(faucetResponse.status, 202);
    const account = await fetch(`${base}/v1/accounts/${wallet.address}`).then((response) => response.json());
    assert.equal(account.atomicBalance, (10n * ATOMIC_UNITS).toString());
    const handoffs = await fetch(`${base}/v1/validator-handoffs`).then((response) => response.json());
    assert.deepEqual(handoffs, { handoffs: [] });

    const rejected = await fetch(`${base}/health`, { headers: { origin: "https://example.com" } });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
  }
});
