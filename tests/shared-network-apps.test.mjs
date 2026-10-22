import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliqueMiningSession } from "../blockchain/clique-mining-session.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { activeMinerNetworkTrust } from "../blockchain/miner-network-trust.mjs";
import { createMiningPracticeApp } from "../blockchain/mining-practice-app.mjs";
import { createNetworkRelay } from "../blockchain/network-relay.mjs";
import { createFaucetLimit, initializeSharedTestnet, startSharedTestnet } from "../blockchain/shared-testnet.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

test("NIR Майнер mines on the shared network and NIR Wallet trusts it by the pinned genesis", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-shared-apps-"));
  try {
    const created = initializeSharedTestnet(join(temporary, "server"), { proofMiningInitialLevel: 8 });
    const running = await startSharedTestnet({ directory: join(temporary, "server"), port: 0, tickMs: 50,
      faucetLimit: createFaucetLimit({ perClient: 10 }) });
    const base = `http://127.0.0.1:${running.server.address().port}`;
    const network = { genesisHash: created.genesisHash, networkId: created.networkId, url: base };
    const relay = createNetworkRelay(base);
    await listen(relay);
    const miningDirectory = join(temporary, "mining");
    const wallet = generateWallet().address;
    const session = new CliqueMiningSession({ dataDirectory: miningDirectory, httpPort: null,
      network, recipient: () => wallet });
    try {
      // A wrong pinned genesis is refused before anything else happens.
      const impostor = new CliqueMiningSession({ dataDirectory: join(temporary, "impostor"), httpPort: null,
        network: { ...network, genesisHash: "0".repeat(64) } });
      await assert.rejects(impostor.open(), /pinned genesis/);

      const opened = await session.open();
      assert.equal(opened.networkMode, "shared");
      assert.ok(opened.miner.address);
      session.start();
      for (let i = 0; i < 400 && session.status().found === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(session.status().found >= 1);
      await session.stop();

      // NIR Wallet reads the miner's choice and the genesis it checked.
      const trust = activeMinerNetworkTrust({ miningDirectory, storageRoot: temporary, sharedNetwork: network });
      assert.equal(trust.trustAnchor.genesisCheckpoint.tipHash, created.genesisHash);
      assert.equal(trust.trustAnchor.expectedNetworkId, created.networkId);
      assert.equal(activeMinerNetworkTrust({ miningDirectory, storageRoot: temporary,
        sharedNetwork: { ...network, genesisHash: "1".repeat(64) } }), null);

      // The wallet's requests go through the relay on this Mac.
      const relayBase = `http://127.0.0.1:${relay.address().port}`;
      const origin = { origin: "http://127.0.0.1:41000" };
      assert.equal((await (await fetch(`${relayBase}/health`, { headers: origin })).json()).networkId, created.networkId);
      // (The wallet already holds mining rewards, so a fresh address asks the faucet.)
      const funded = await fetch(`${relayBase}/v1/faucet`, { method: "POST", headers: { ...origin,
        "content-type": "application/json" }, body: JSON.stringify({ recipient: generateWallet().address }) });
      assert.equal(funded.status, 202);
      assert.equal((await fetch(`${relayBase}/v1/blocks/produce`, { method: "POST", headers: origin })).status, 404);
      assert.equal((await fetch(`${relayBase}/health`, { headers: { origin: "https://example.com" } })).status, 403);
    } finally {
      await session.close();
      relay.close();
      await running.close();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("NIR Майнер offers the shared network only once its genesis is pinned, and keeps the choice", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-network-choice-"));
  const root = join(import.meta.dirname, "..");
  const open = async (sharedNetwork) => {
    const server = createMiningPracticeApp({ root, miningDirectory: join(temporary, "mining"), miningHttpPort: null,
      sharedNetwork });
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, body) => fetch(`${base}/mining/network`, { method, body,
      headers: { origin: base, "X-NIR-Session": server.localSessionToken } }).then(async (response) =>
      ({ status: response.status, data: await response.json() }));
    return { call, server };
  };
  const unreachable = { genesisHash: "a".repeat(64), networkId: "nir-shared-testnet-1", url: "http://127.0.0.1:9" };
  try {
    const before = await open({ ...unreachable, genesisHash: null });
    try {
      assert.deepEqual((await before.call("GET")).data, { available: false, mode: "local", url: unreachable.url });
      assert.equal((await before.call("POST", JSON.stringify({ mode: "shared" }))).status, 400);
    } finally { before.server.close(); }

    const after = await open(unreachable);
    try {
      assert.equal((await after.call("GET")).data.mode, "shared");
      assert.equal((await after.call("POST", JSON.stringify({ mode: "elsewhere" }))).status, 400);
      assert.equal((await after.call("POST", JSON.stringify({ mode: "local" }))).data.mode, "local");
      assert.deepEqual(JSON.parse(readFileSync(join(temporary, "mining", "network-choice.json"), "utf8")),
        { mode: "local" });
    } finally { after.server.close(); }

    const reopened = await open(unreachable);
    try {
      assert.equal((await reopened.call("GET")).data.mode, "local");
    } finally { reopened.server.close(); }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
