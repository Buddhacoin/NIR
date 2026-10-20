import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMiningPracticeApp } from "../blockchain/mining-practice-app.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";

const PASSWORD = "app-connect-password-2026";
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

// One click in Model Lab: its service asks the wallet open on this Mac, the
// wallet shows its own dialog, and the address is linked with no copying.
test("Model Lab links the open NIR Wallet with one confirmation in the wallet", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-app-connect-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const { address } = createWalletFile({ path: vaultPath, password: PASSWORD });
  let answer = PASSWORD;
  const prompts = [];
  const bridge = createWalletBridgeServer({ appConnect: true, origin: "http://127.0.0.1:8765",
    sessionToken: "a".repeat(64), vaultPath,
    authorize: async (intent) => { prompts.push(intent); return answer; } });
  await listen(bridge);
  const walletBridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
  const lab = createMiningPracticeApp({ root: join(import.meta.dirname, ".."), walletBridgeUrl,
    miningDirectory: join(directory, "mining"), miningHttpPort: null });
  await listen(lab);
  const base = `http://127.0.0.1:${lab.address().port}`;
  const connect = () => fetch(`${base}/wallet-link/connect`, { method: "POST", headers: {
    origin: base, "content-length": "0", "X-NIR-Session": lab.localSessionToken } });
  try {
    const linked = await connect();
    assert.equal(linked.status, 200);
    assert.deepEqual(await linked.json(), { address });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].type, "local-operator-wallet-link");
    assert.equal(prompts[0].address, address);
    // Mining rewards now go to the linked wallet.
    const status = await (await fetch(`${base}/mining/status`,
      { headers: { "X-NIR-Session": lab.localSessionToken } })).json();
    assert.equal(status.wallet.address, address);

    // A web page cannot use the route: browsers always send Origin.
    const fromPage = await fetch(`${walletBridgeUrl}/v1/app-connect`, { method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.invalid" },
      body: JSON.stringify({ app: "model-lab", challenge: "b".repeat(64) }) });
    assert.equal(fromPage.status, 403);
    assert.equal(prompts.length, 1);

    // Declining in the wallet links nothing.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    answer = null;
    const declined = await connect();
    assert.equal(declined.status, 409);
    assert.equal((await declined.json()).error, "wallet-declined");
    // Without the session token Model Lab refuses before asking the wallet.
    const foreign = await fetch(`${base}/wallet-link/connect`, { method: "POST",
      headers: { origin: base, "content-length": "0" } });
    assert.equal(foreign.status, 403);
    assert.equal(prompts.length, 2);
  } finally {
    await close(lab);
    await close(bridge);
  }
  // With the wallet closed Model Lab says to open it.
  const alone = createMiningPracticeApp({ root: join(import.meta.dirname, ".."), walletBridgeUrl,
    miningDirectory: join(directory, "mining"), miningHttpPort: null });
  await listen(alone);
  try {
    const aloneBase = `http://127.0.0.1:${alone.address().port}`;
    const missing = await fetch(`${aloneBase}/wallet-link/connect`, { method: "POST", headers: {
      origin: aloneBase, "content-length": "0", "X-NIR-Session": alone.localSessionToken } });
    assert.equal(missing.status, 503);
    assert.equal((await missing.json()).error, "wallet-not-open");
  } finally {
    await close(alone);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the wallet bridge offers one-click linking only when the Mac app enables it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-app-connect-off-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: PASSWORD });
  const bridge = createWalletBridgeServer({ origin: "http://127.0.0.1:8765", sessionToken: "a".repeat(64),
    vaultPath, authorize: async () => assert.fail("must not prompt") });
  await listen(bridge);
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.address().port}/v1/app-connect`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "model-lab", challenge: "c".repeat(64) }) });
    assert.equal(response.status, 403);
  } finally {
    await close(bridge);
    rmSync(directory, { recursive: true, force: true });
  }
});
