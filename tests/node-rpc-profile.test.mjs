import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeveloperNodeHttpServer, createNodeHttpServer, createProductionNodeHttpServer,
} from "../blockchain/node-service.mjs";

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

const adminPaths = ["/v1/faucet", "/v1/blocks/produce", "/v1/snapshots/create"];

test("default public node RPC rejects every administrative POST before dispatch", async () => {
  const { called, node } = fixture();
  for (const server of [
    createNodeHttpServer(node),
    createProductionNodeHttpServer(node, { rpcProfile: "developer" }),
  ]) {
    await withServer(server, async (base) => {
      for (const path of adminPaths) {
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
      }
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/v1/fees?amount=1`)).status, 200);
      assert.equal((await fetch(`${base}/v1/transactions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })).status, 202);
    });
  }
  assert.deepEqual(called, { faucet: 0, produce: 0, snapshot: 0, transaction: 2 });
});

test("administrative POSTs require the explicit developer RPC profile", async () => {
  const { called, node } = fixture();
  await withServer(createDeveloperNodeHttpServer(node), async (base) => {
    const address = `nir1${"1".repeat(64)}`;
    for (const [path, body] of [
      [adminPaths[0], { recipient: address }],
      [adminPaths[1], null],
      [adminPaths[2], null],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST", ...(body === null ? {} : {
          headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }),
      });
      assert.ok(response.status >= 200 && response.status < 300, path);
    }
  });
  assert.deepEqual(called, { faucet: 1, produce: 1, snapshot: 1, transaction: 0 });
  assert.throws(() => createNodeHttpServer(node, { rpcProfile: "unknown" }), /RPC profile/);
});
