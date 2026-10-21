import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { minerNetworkTrust } from "../blockchain/miner-network-trust.mjs";
import { createDeveloperNodeHttpServer } from "../blockchain/node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "../blockchain/node-store.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

// The Mac wallet's balance check against the miner's network, as
// wallet-ui/app.js does it: finality from genesis up to the account proof's
// height, through the protocol upgrades the devnet made, then the proof.
test("NIR Wallet verifies a balance on the miner's network from that network's genesis", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-miner-trust-"));
  try {
    const networkDirectory = join(directory, "devnet");
    assert.equal(minerNetworkTrust({ networkDirectory, storageRoot: directory }), null);
    initializeDevnet(networkDirectory, { proofMining: true, proofMiningInitialLevel: 8 });
    const node = new PersistentDevNode(networkDirectory);
    const vaultPath = join(directory, "wallet.nirvault.json");
    const { address } = createWalletFile({ path: vaultPath, password: "miner-trust-password-2026" });
    node.faucet(address);
    for (let i = 0; i < 3; i++) node.tick();
    const trust = minerNetworkTrust({ networkDirectory, storageRoot: directory });
    assert.ok(trust.trustCheckpointPath.startsWith(directory));
    const origin = "http://127.0.0.1:8765";
    const token = "a".repeat(64);
    const bridge = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token, vaultPath,
      ...trust });
    const nodeServer = createDeveloperNodeHttpServer(node);
    await listen(bridge);
    await listen(nodeServer);
    try {
      const nodeBase = `http://127.0.0.1:${nodeServer.address().port}`;
      const bridgeCall = async (path, body) => {
        const response = await fetch(`http://127.0.0.1:${bridge.address().port}${path}`, {
          ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
          headers: { "content-type": "application/json", origin, "x-nir-bridge-token": token } });
        const value = await response.json();
        assert.equal(response.status, 200, value.error);
        return value;
      };
      const info = await bridgeCall("/v1/trust-info");
      assert.equal(info.enabled, true);
      const proof = await (await fetch(`${nodeBase}/v1/accounts/${address}/proof`)).json();
      let verified = info.minimumHeight;
      while (verified < proof.height) {
        const { proofs } = await (await fetch(
          `${nodeBase}/v1/finality-proofs?fromHeight=${verified}&limit=${Math.min(512, proof.height - verified)}`)).json();
        verified = (await bridgeCall("/v1/verify-finality-chain", { proofs })).tip.height;
      }
      const account = await bridgeCall("/v1/verify-account-proof", { address, minimumHeight: proof.height, proof });
      assert.equal(account.verified, true);
      assert.equal(account.statement.account.atomicBalance, node.account(address).atomicBalance);
    } finally {
      await close(nodeServer);
      await close(bridge);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
