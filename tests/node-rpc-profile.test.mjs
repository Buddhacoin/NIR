import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTransfer } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  createDeveloperNodeHttpServer, createNodeHttpServer, createProductionNodeHttpServer,
} from "../blockchain/node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";

function fixture() {
  const called = { faucet: 0, produce: 0, snapshot: 0, transaction: 0 };
  const node = {
    height: 0,
    networkId: "nir-rpc-profile-test",
    tipHash: "0".repeat(64),
    feeQuote: () => ({ fee: "1" }),
    faucet: () => { called.faucet += 1; return { ok: true }; },
    produceBlock: () => { called.produce += 1; return { ok: true }; },
    createSnapshot: () => { called.snapshot += 1; return { ok: true }; },
    submitTransaction: () => { called.transaction += 1; return { ok: true }; },
  };
  return { called, node };
}

async function withServer(server, run) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await server.gracefulShutdown(200); }
}

function rawStatus(base, path, method = "POST") {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, method, path, port }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

const mutatingPaths = [
  "/v1/transactions", "/v1/faucet", "/v1/blocks/produce", "/v1/snapshots/create",
];

test("default public node RPC rejects every mutating POST before dispatch", async () => {
  const { called, node } = fixture();
  for (const server of [
    createNodeHttpServer(node),
    createProductionNodeHttpServer(node, { rpcProfile: "developer" }),
  ]) {
    await withServer(server, async (base) => {
      for (const path of mutatingPaths) {
        const response = await fetch(`${base}${path}?rpcProfile=developer`, {
          method: "POST", headers: {
            "content-type": "application/json", "x-nir-rpc-profile": "developer",
            origin: "http://localhost:8765",
          },
          body: JSON.stringify({ recipient: "not-an-address" }),
        });
        assert.equal(response.status, 404, path);
        assert.deepEqual(await response.json(), { error: "not found" });
        const preflight = await fetch(`${base}${path}`, { method: "OPTIONS" });
        assert.equal(preflight.status, 404, path);
        assert.equal(await rawStatus(base, path, "GET"), 404, path);
        assert.equal(await rawStatus(base, path, "HEAD"), 404, path);
      }
      for (const path of [
        "/x/../v1/faucet",
        "/v1/%2e%2e/v1/faucet",
        "/v1/faucet?rpcProfile=developer",
        `${base}/v1/faucet`,
      ]) {
        assert.equal(await rawStatus(base, path), 404, path);
      }
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/v1/fees?amount=1`)).status, 200);
    });
  }
  assert.deepEqual(called, { faucet: 0, produce: 0, snapshot: 0, transaction: 0 });
});

test("mutating POSTs require the explicit developer RPC profile", async () => {
  const { called, node } = fixture();
  await withServer(createDeveloperNodeHttpServer(node), async (base) => {
    const address = `nir1${"1".repeat(64)}`;
    for (const [path, body] of [
      ["/v1/transactions", {}],
      ["/v1/faucet", { recipient: address }],
      ["/v1/blocks/produce", null],
      ["/v1/snapshots/create", null],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST", ...(body === null ? {} : {
          headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }),
      });
      assert.ok(response.status >= 200 && response.status < 300, path);
    }
  });
  assert.deepEqual(called, { faucet: 1, produce: 1, snapshot: 1, transaction: 1 });
  assert.throws(() => createNodeHttpServer(node, { rpcProfile: "unknown" }), /RPC profile/);
});

test("production profile cannot make PersistentDevNode finalize a signed transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-node-rpc-profile-"));
  try {
    const directory = join(root, "node");
    initializeDevnet(directory);
    const node = new PersistentDevNode(directory);
    const sender = generateWallet();
    const recipient = generateWallet();
    node.faucet(sender.address);
    const transfer = createTransfer({
      wallet: sender, networkId: node.networkId, recipient: recipient.address,
      amount: ATOMIC_UNITS.toString(), nonce: 0,
    });
    const before = { height: node.height, tipHash: node.tipHash };
    await withServer(createProductionNodeHttpServer(node), async (base) => {
      for (const body of [JSON.stringify(transfer), "not JSON"]) {
        const response = await fetch(`${base}/v1/transactions`, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        assert.equal(response.status, 404);
      }
      assert.equal((await fetch(`${base}/health`).then((response) => response.json())).height,
        before.height);
    });
    assert.deepEqual({ height: node.height, tipHash: node.tipHash }, before);
    await withServer(createDeveloperNodeHttpServer(node), async (base) => {
      const response = await fetch(`${base}/v1/transactions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(transfer),
      });
      assert.equal(response.status, 202);
    });
    assert.equal(node.height, before.height + 1);
    assert.notEqual(node.tipHash, before.tipHash);
    assert.equal(node.account(recipient.address).atomicBalance, ATOMIC_UNITS.toString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});
