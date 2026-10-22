import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliqueMiningSession } from "../blockchain/clique-mining-session.mjs";
import { activeMinerNetworkTrust, minerNetworkSignature } from "../blockchain/miner-network-trust.mjs";
import { createFaucetLimit, initializeSharedTestnet, startSharedTestnet } from "../blockchain/shared-testnet.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

// NIR Wallet often opens before NIR Майнер has joined the shared network. It
// then follows the miner: the bridge takes the shared network's trust while
// it runs, and a balance verifies through the miner's relay.
test("NIR Wallet follows NIR Майнер onto the shared network and verifies a balance through the relay",
  { timeout: 180_000 }, async () => {
    const temporary = mkdtempSync(join(tmpdir(), "nir-shared-wallet-"));
    try {
      const created = initializeSharedTestnet(join(temporary, "server"), { proofMiningInitialLevel: 8 });
      const running = await startSharedTestnet({ directory: join(temporary, "server"), port: 0, tickMs: 50,
        faucetLimit: createFaucetLimit({ perClient: 10 }) });
      const network = { genesisHash: created.genesisHash, networkId: created.networkId,
        url: `http://127.0.0.1:${running.server.address().port}` };
      const vaultPath = join(temporary, "wallet.nirvault.json");
      const { address } = createWalletFile({ path: vaultPath, password: "shared-wallet-password-2026" });
      const miningDirectory = join(temporary, "mining");
      const probe = createServer();
      await listen(probe);
      const relayPort = probe.address().port;
      await close(probe);

      // The wallet opens first: the miner has no network yet.
      assert.equal(activeMinerNetworkTrust({ miningDirectory, storageRoot: temporary, sharedNetwork: network }), null);
      const before = minerNetworkSignature({ miningDirectory });
      const origin = "http://127.0.0.1:8765";
      const token = "a".repeat(64);
      const bridge = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token, vaultPath });
      await listen(bridge);
      const session = new CliqueMiningSession({ dataDirectory: miningDirectory, httpPort: relayPort, network });
      try {
        const bridgeCall = async (path, body) => {
          const response = await fetch(`http://127.0.0.1:${bridge.address().port}${path}`, {
            ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
            headers: { "content-type": "application/json", origin, "x-nir-bridge-token": token } });
          const value = await response.json();
          assert.equal(response.status, 200, value.error);
          return value;
        };
        assert.equal((await bridgeCall("/v1/trust-info")).enabled, false);

        await session.open();
        assert.notEqual(minerNetworkSignature({ miningDirectory }), before);
        const trust = activeMinerNetworkTrust({ miningDirectory, storageRoot: temporary, sharedNetwork: network });
        assert.throws(() => bridge.setNetworkTrust({ trustAnchor: { expectedNetworkId: "x" } }), /invalid/);
        bridge.setNetworkTrust(trust);
        const info = await bridgeCall("/v1/trust-info");
        assert.equal(info.enabled, true);
        assert.equal(info.networkId, created.networkId);

        const relay = `http://127.0.0.1:${relayPort}`;
        const funded = await fetch(`${relay}/v1/faucet`, { method: "POST",
          headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ recipient: address }) });
        assert.equal(funded.status, 202);
        let funds = "0";
        for (let i = 0; i < 200 && /^0?$/.test(funds); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          funds = (await (await fetch(`${relay}/v1/accounts/${address}`, { headers: { origin } })).json())
            .atomicBalance ?? "0";
        }
        assert.notEqual(funds, "0", "the faucet transfer was not included");
        const proof = await (await fetch(`${relay}/v1/accounts/${address}/proof`, { headers: { origin } })).json();
        assert.equal((await (await fetch(`${relay}/health`, { headers: { origin } })).json()).networkId, info.networkId);
        let verified = info.minimumHeight;
        while (verified < proof.height) {
          const { proofs } = await (await fetch(`${relay}/v1/finality-proofs?fromHeight=${verified}` +
            `&limit=${Math.min(512, proof.height - verified)}`, { headers: { origin } })).json();
          verified = (await bridgeCall("/v1/verify-finality-chain", { proofs })).tip.height;
        }
        const account = await bridgeCall("/v1/verify-account-proof", { address, minimumHeight: proof.height, proof });
        assert.equal(account.verified, true);
        assert.ok(BigInt(account.statement.account.atomicBalance) > 0n);
        assert.equal((await fetch(`${relay}/v1/proof-mining`, { headers: { origin } })).status, 200);
        assert.equal((await fetch(`${relay}/v1/accounts/${address}/proof-rewards`, { headers: { origin } })).status, 200);
      } finally {
        await session.close();
        await close(bridge);
        await running.close();
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
