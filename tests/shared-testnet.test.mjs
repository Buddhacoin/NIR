import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NirChain } from "../blockchain/chain.mjs";
import { createMinerNodeClient, mineOneCliqueTask } from "../blockchain/clique-miner.mjs";
import { createFaucetLimit, initializeSharedTestnet, startSharedTestnet } from "../blockchain/shared-testnet.mjs";
import { createWalletFile, signWalletProofAnswer } from "../blockchain/wallet-files.mjs";

test("the faucet limit counts per client and per hour", () => {
  let time = 0;
  const limit = createFaucetLimit({ perClient: 2, perHour: 3, now: () => time });
  const from = (address) => ({ headers: {}, socket: { remoteAddress: address } });
  limit(from("a"));
  limit(from("a"));
  assert.throws(() => limit(from("a")), /rate limit/);
  limit(from("b"));
  assert.throws(() => limit(from("c")), /rate limit/);
  time += 3_600_001;
  limit(from("c"));
  // Behind a proxy the client is the forwarded address, only when trusted.
  const proxied = createFaucetLimit({ perClient: 1, trustProxy: true, now: () => time });
  proxied({ headers: { "x-forwarded-for": "1.1.1.1" }, socket: { remoteAddress: "127.0.0.1" } });
  proxied({ headers: { "x-forwarded-for": "2.2.2.2" }, socket: { remoteAddress: "127.0.0.1" } });
  assert.throws(() => proxied({ headers: { "x-forwarded-for": "1.1.1.1" }, socket: {} }), /rate limit/);
});

test("miners and wallets share one test network over HTTP: genesis, faucet, mining", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-shared-testnet-"));
  try {
    const directory = join(temporary, "network");
    const created = initializeSharedTestnet(directory, { proofMiningInitialLevel: 8 });
    assert.equal(created.networkId, "nir-shared-testnet-1");
    const running = await startSharedTestnet({ directory, port: 0, tickMs: 50,
      faucetLimit: createFaucetLimit({ perClient: 5 }) });
    try {
      const base = `http://127.0.0.1:${running.server.address().port}`;
      const origin = "http://127.0.0.1:41234";
      const json = async (path, init = {}) => {
        const response = await fetch(`${base}${path}`, { ...init,
          headers: { origin, "content-type": "application/json", ...init.headers } });
        return { status: response.status, body: await response.json() };
      };
      // The genesis a wallet pins: its hash is the network's identity.
      const genesis = (await json("/v1/genesis")).body;
      assert.equal(new NirChain(genesis).tipHash, created.genesisHash);
      assert.equal(JSON.stringify(genesis).includes("privateKey"), false);
      // Nobody outside can make blocks on request.
      assert.equal((await json("/v1/blocks/produce", { method: "POST", body: "{}" })).status, 404);

      const password = "shared-testnet-password";
      const walletPath = join(temporary, "miner.wallet");
      const { address } = createWalletFile({ password, path: walletPath });
      const faucet = await json("/v1/faucet", { method: "POST", body: JSON.stringify({ recipient: address, amount: "1" }) });
      assert.equal(faucet.status, 202);
      // A fixed amount, once per fresh address.
      assert.equal((await json(`/v1/accounts/${address}`)).body.atomicBalance, "1000000000");
      assert.equal((await json("/v1/faucet", { method: "POST", body: JSON.stringify({ recipient: address }) })).status, 400);

      // A miner elsewhere asks for tasks; the network makes blocks while it does.
      // The first poll wakes the network; a task follows within a few blocks.
      let outcome = { result: "no-open-task" };
      for (let attempt = 0; attempt < 100 && outcome.result === "no-open-task"; attempt++) {
        outcome = await mineOneCliqueTask({ address, client: createMinerNodeClient(base), pollMs: 50,
          sign: (operation) => signWalletProofAnswer({ operation, password, path: walletPath }) });
        if (outcome.result === "no-open-task") await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(outcome.result, "revealed");
    } finally {
      await running.close();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
