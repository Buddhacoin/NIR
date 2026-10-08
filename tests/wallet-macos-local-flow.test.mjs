import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createLocalTestWallet, listLocalTestWallets, openLocalTestWallet } from
  "../blockchain/wallet-onboarding.mjs";

test("local rehearsal creates a backed-up vault, reopens it and pairs the same address", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-mac-flow-"));
  const password = "local-rehearsal-password-2026";
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let server;
  try {
    const created = createLocalTestWallet({ storageRoot: root, password });
    assert.equal(created.recoveryDrillPassed, true);
    assert.equal(existsSync(created.walletPath), true);
    assert.equal(existsSync(created.backupPath), true);
    const listed = listLocalTestWallets(root);
    assert.equal(listed.length, 1);
    const reopened = openLocalTestWallet({ wallets: listed, path: created.walletPath, password });
    assert.equal(reopened.address, created.address);
    let shown = 0;
    server = createWalletBridgeServer({
      accounts: listed, authorize: async () => null, origin, pairingCode: "98765432",
      presentPairingCode: () => { shown += 1; }, sessionToken: token,
      vaultPath: reopened.walletPath,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { "content-type": "application/json", origin };
    assert.equal((await fetch(`${base}/v1/pairing-prompt`,
      { method: "POST", headers })).status, 202);
    assert.equal(shown, 1);
    const paired = await fetch(`${base}/v1/pair`, { method: "POST", headers,
      body: JSON.stringify({ code: "98765432" }) });
    assert.equal(paired.status, 200);
    assert.equal((await paired.json()).sessionToken, token);
    const authorized = { ...headers, "x-nir-bridge-token": token };
    const wallet = await (await fetch(`${base}/v1/wallet`, { headers: authorized })).json();
    assert.equal(wallet.address, created.address);
    const accountsResponse = await fetch(`${base}/v1/accounts`, { headers: authorized });
    const body = await accountsResponse.text();
    assert.equal(body.includes(root), false);
    assert.equal(JSON.parse(body).accounts.length, 1);
    for (const path of ["/v1/mining-demo", "/v1/native-security", "/v1/local-update", "/v1/wallet-sync"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST", headers: authorized, body: "{}",
      });
      assert.equal(response.status, 404, `${path} must remain unavailable in the local app`);
    }
  } finally {
    if (server?.listening) {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
