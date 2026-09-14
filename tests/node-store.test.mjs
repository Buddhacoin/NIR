import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTransfer } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS, MIN_TRANSFER_FEE } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createNodeHttpServer } from "../blockchain/node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";

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

    const rejected = await fetch(`${base}/health`, { headers: { origin: "https://example.com" } });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temporary, { recursive: true, force: true });
  }
});
