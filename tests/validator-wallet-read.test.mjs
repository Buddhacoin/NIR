import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createNodeHttpServer } from "../blockchain/node-service.mjs";
import { exactWalletReadOrigin, pinWalletReadPeerUrls }
  from "../blockchain/validator-wallet-read.mjs";

const servers = [];
after(async () => { await Promise.all(servers.map((server) => new Promise((resolve) =>
  server.close(resolve)))); });

function genesis() {
  const validators = Array.from({ length: 4 }, (_, index) => ({
    address: `nir1${String(index + 1).padStart(64, "0")}`,
  }));
  return { networkId: "nir-valueless-test", validators, peerRegistry: {
    peers: validators.map(({ address }, index) => ({ validatorAddress: address,
      tlsCertificateSha256: String(index + 1).repeat(64),
      url: `https://127.0.0.1:${8791 + index}` })),
  } };
}

test("wallet read pins the exact ceremony genesis, peers and local browser origin", () => {
  const signed = genesis();
  assert.deepEqual(pinWalletReadPeerUrls(signed, structuredClone(signed)),
    signed.peerRegistry.peers.map(({ url }) => url));
  const foreign = structuredClone(signed);
  foreign.peerRegistry.peers[0].tlsCertificateSha256 = "f".repeat(64);
  assert.throws(() => pinWalletReadPeerUrls(signed, foreign), /genesis differs/);
  const insecure = structuredClone(signed);
  insecure.peerRegistry.peers[0].url = "http://127.0.0.1:8791";
  assert.throws(() => pinWalletReadPeerUrls(insecure, insecure), /endpoint or TLS pin/);
  assert.equal(exactWalletReadOrigin("http://127.0.0.1:8765"),
    "http://127.0.0.1:8765");
  assert.throws(() => exactWalletReadOrigin("http://localhost:8765"), /exact local/);
  assert.throws(() => exactWalletReadOrigin("http://127.0.0.1:8765/path"), /exact local/);
});

test("wallet read HTTP surface serves existing GET shapes and never calls a POST method", async () => {
  let writes = 0;
  const node = {
    height: 2, networkId: "nir-valueless-test", tipHash: "a".repeat(64),
    account: () => ({ nextNonce: 3 }),
    accountProof: async () => ({ format: "existing-account-proof" }),
    accountHistoryPage: async () => ({ entries: [] }),
    assetProof: async () => ({ format: "existing-asset-proof" }),
    finalityProofsAfter: async () => [{ format: "existing-finality-proof" }],
    transactionProof: async () => ({ format: "existing-transaction-proof" }),
    validatorHandoffHistory: async () => ({ handoffs: [] }),
    feeQuote: () => ({ fee: "1" }),
    submitTransaction: () => { writes += 1; },
    faucet: () => { writes += 1; },
    produceBlock: () => { writes += 1; },
  };
  const server = createNodeHttpServer(node, {
    rpcProfile: "public", walletReadOrigin: "http://127.0.0.1:8765",
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: "http://127.0.0.1:8765" };
  const proof = await fetch(`${base}/v1/accounts/nir1${"1".repeat(64)}/proof`, { headers });
  assert.equal(proof.status, 200);
  assert.equal(proof.headers.get("access-control-allow-origin"), headers.origin);
  assert.deepEqual(await proof.json(), { format: "existing-account-proof" });
  const finality = await fetch(`${base}/v1/finality-proofs?fromHeight=0&limit=2`, { headers });
  assert.equal(finality.status, 200);
  assert.deepEqual(await finality.json(), { proofs: [{ format: "existing-finality-proof" }] });
  const foreign = await fetch(`${base}/health`, { headers: { origin: "http://127.0.0.1:9999" } });
  assert.equal(foreign.status, 403);
  for (const path of ["/v1/transactions", "/v1/faucet", "/v1/blocks/produce",
    "/v1/snapshots/create"]) {
    const rejected = await fetch(`${base}${path}`, { method: "POST", headers: {
      ...headers, "content-type": "application/json",
    }, body: "{}" });
    assert.equal(rejected.status, 404);
  }
  assert.equal((await fetch(`${base}/metrics`, { headers })).status, 404);
  assert.equal(writes, 0);
});
