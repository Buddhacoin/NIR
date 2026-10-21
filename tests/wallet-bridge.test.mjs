import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { nameCommitment } from "../blockchain/name-registry.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { decryptWallet, encryptWallet } from "../blockchain/vault.mjs";
import { createAccountProof } from "../blockchain/account-proof.mjs";
import { createAssetProof } from "../blockchain/asset-proof.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import { createTransfer, finalizeBlock, nativeAssetId, NirChain } from "../blockchain/chain.mjs";
import {
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";

const walletBuildSequence = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).walletBuildSequence;
import {
  committedTransactionId,
  createTransactionProof,
} from "../blockchain/transaction-tree.mjs";
import {
  createAccountHistoryProof,
  emptyAccountHistory,
} from "../blockchain/account-history.mjs";

async function close(server) {
  if (!server.listening) return;
  const done = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await done;
}

function request(url, origin, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin,
      "x-nir-bridge-token": token,
      ...options.headers,
    },
  });
}

function rawStatus(url, headers) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      headers, hostname: parsed.hostname, method: "GET", path: parsed.pathname,
      port: parsed.port,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function validatorMembers(wallets) {
  return wallets.map((wallet) => ({
    ...publicWallet(wallet), operatorId: `validator-${wallet.address.slice(4, 16)}`,
  }));
}

test("Firefox pairing binds one exact installation origin before exposing a bridge session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-firefox-bridge-pair-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "firefox-test-password-2026" });
  const first = "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d";
  const second = "moz-extension://46d1a996-3b60-4cea-8b12-a544bff7e999";
  const token = "a".repeat(64);
  let prompts = 0;
  const server = createWalletBridgeServer({
    authorize: async () => null, firefoxPairing: true, origin: "http://127.0.0.1:8765",
    pairingCode: "12345678", presentPairingCode: () => { prompts += 1; },
    sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const preflight = await fetch(`${base}/v1/pair`, { method: "OPTIONS", headers: {
      origin: first, "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), first);
    assert.equal((await fetch(`${base}/v1/wallet`, { method: "OPTIONS", headers: {
      origin: first, "access-control-request-method": "GET",
    } })).status, 403);
    assert.equal((await request(`${base}/v1/pair?code=12345678`, first, "", {
      method: "POST", body: JSON.stringify({ code: "12345678" }),
    })).status, 403);
    assert.equal((await fetch(`${base}/v1/pair`, { method: "OPTIONS", headers: {
      origin: first, "access-control-request-method": "DELETE",
      "access-control-request-headers": "x-nir-bridge-token",
    } })).status, 403);
    const deniedBeforePairing = await request(`${base}/v1/wallet`, first, token);
    assert.equal(deniedBeforePairing.status, 403);
    assert.equal(deniedBeforePairing.headers.get("access-control-allow-origin"), null);
    assert.equal((await request(`${base}/v1/pairing-prompt`, first, "", { method: "POST" })).status, 202);
    assert.equal(prompts, 1);
    assert.equal((await request(`${base}/v1/pairing-prompt`, second, "", { method: "POST" })).status, 429);
    assert.equal(prompts, 1);
    const wrong = await request(`${base}/v1/pair`, second, "", {
      method: "POST", body: JSON.stringify({ code: "00000000" }),
    });
    assert.equal(wrong.status, 400);
    const paired = await request(`${base}/v1/pair`, first, "", {
      method: "POST", body: JSON.stringify({ code: "12345678" }),
    });
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get("access-control-allow-origin"), first);
    assert.equal((await paired.json()).sessionToken, token);
    assert.equal((await request(`${base}/v1/wallet`, first, token)).status, 200);
    assert.equal((await request(`${base}/v1/wallet`, second, token)).status, 403);
    assert.equal((await fetch(`${base}/v1/wallet`, { method: "OPTIONS", headers: {
      origin: second, "access-control-request-method": "GET",
    } })).status, 403);
    assert.equal((await request(`${base}/v1/pair`, second, "", {
      method: "POST", body: JSON.stringify({ code: "12345678" }),
    })).status, 403);
    assert.equal((await request(`${base}/v1/wallet`,
      "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d.evil", token)).status, 403);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an incomplete Firefox pairing body releases its global reservation promptly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-firefox-bridge-stall-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "firefox-stall-password-2026" });
  const origin = "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d";
  const server = createWalletBridgeServer({
    authorize: async () => null, firefoxPairing: true, origin: "http://127.0.0.1:8765",
    pairingCode: "12345678", sessionToken: "a".repeat(64), vaultPath,
  });
  let stalled;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    stalled = httpRequest({ hostname: "127.0.0.1", port, path: "/v1/pair", method: "POST",
      headers: { host: `127.0.0.1:${port}`, origin, "content-type": "application/json",
        "content-length": "128" } });
    stalled.on("error", () => {});
    stalled.write("{");
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const paired = await request(`http://127.0.0.1:${port}/v1/pair`, origin, "", {
      method: "POST", body: JSON.stringify({ code: "12345678" }),
    });
    assert.equal(paired.status, 200);
  } finally {
    stalled?.destroy();
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Firefox pairing attempts are globally bounded across extension origins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-firefox-bridge-limit-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "firefox-limit-password-2026" });
  const server = createWalletBridgeServer({
    authorize: async () => null, firefoxPairing: true, origin: "http://127.0.0.1:8765",
    pairingCode: "12345678", sessionToken: "a".repeat(64), vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (let index = 0; index < 5; index += 1) {
      const other = `moz-extension://00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      assert.equal((await request(`${base}/v1/pair`, other, "", {
        method: "POST", body: JSON.stringify({ code: "00000000" }),
      })).status, 400);
    }
    const legitimate = "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d";
    assert.equal((await request(`${base}/v1/pair`, legitimate, "", {
      method: "POST", body: JSON.stringify({ code: "12345678" }),
    })).status, 403);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paired bridge keeps distinct same-address vault copies selectable without exposing paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-vault-ids-"));
  const firstPath = join(directory, "first.nirvault.json");
  const secondPath = join(directory, "second.nirvault.json");
  const thirdPath = join(directory, "third.nirvault.json");
  const first = createWalletFile({ path: firstPath, password: "first-vault-password-2026" });
  const copiedKey = decryptWallet(JSON.parse(readFileSync(firstPath, "utf8")),
    "first-vault-password-2026");
  try {
    writeFileSync(secondPath, `${JSON.stringify(encryptWallet(copiedKey,
      "second-vault-password-2026", { label: "Recovered copy" }))}\n`, { mode: 0o600, flag: "wx" });
  } finally { copiedKey.privateKey = ""; }
  const third = createWalletFile({ path: thirdPath, password: "third-vault-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "e".repeat(64);
  const server = createWalletBridgeServer({
    accounts: [{ address: first.address, path: firstPath },
      { address: first.address, path: secondPath }],
    authorize: async () => null,
    createAccount: async () => ({ address: third.address, path: thirdPath }),
    origin, sessionToken: token, vaultPath: firstPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const listResponse = await request(`${base}/v1/accounts`, origin, token);
    assert.equal(listResponse.status, 200);
    const listText = await listResponse.text();
    assert.equal(listText.includes(directory), false);
    const list = JSON.parse(listText);
    assert.equal(list.accounts.length, 2);
    assert.equal(list.canCreate, true);
    assert.equal(list.accounts[0].address, list.accounts[1].address);
    assert.notEqual(list.accounts[0].id, list.accounts[1].id);
    assert.match(list.accounts[0].id, /^[0-9a-f]{32}$/);
    assert.equal(list.activeId, list.accounts[0].id);
    assert.equal((await request(`${base}/v1/select-account`, origin, "0".repeat(64), {
      method: "POST", body: JSON.stringify({ id: list.accounts[1].id }),
    })).status, 401);
    const switched = await request(`${base}/v1/select-account`, origin, token, {
      method: "POST", body: JSON.stringify({ id: list.accounts[1].id }),
    });
    assert.equal(switched.status, 200);
    assert.deepEqual(await switched.json(), { id: list.accounts[1].id, address: first.address });
    assert.equal((await (await request(`${base}/v1/wallet`, origin, token)).json()).label,
      "Recovered copy");
    assert.equal((await (await request(`${base}/v1/accounts`, origin, token)).json()).activeId,
      list.accounts[1].id);
    assert.equal((await request(`${base}/v1/select-account`, origin, token, {
      method: "POST", body: JSON.stringify({ id: "f".repeat(32) }),
    })).status, 400);
    const added = await request(`${base}/v1/create-account`, origin, token, {
      method: "POST", body: "{}",
    });
    assert.equal(added.status, 200);
    const newAccount = await added.json();
    assert.equal(newAccount.address, third.address);
    assert.equal(JSON.stringify(newAccount).includes(directory), false);
    assert.equal((await (await request(`${base}/v1/accounts`, origin, token)).json()).accounts.length, 3);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("account creation errors never disclose a native vault path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-create-path-"));
  const vaultPath = join(directory, "first.nirvault.json");
  createWalletFile({ path: vaultPath, password: "first-account-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "c".repeat(64);
  let createdPath = null;
  const server = createWalletBridgeServer({
    authorize: async () => null,
    createAccount: async () => {
      if (createdPath === null) {
        createdPath = join(directory, "native-error.nirvault.json");
        throw new Error(`private wallet path: ${createdPath}`);
      }
      return { address: "nir1" + "a".repeat(64), path: createdPath };
    },
    origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(`${base}/v1/create-account`, origin, token,
        { method: "POST", body: "{}" });
      assert.equal(response.status, 400);
      const body = await response.text();
      assert.equal(body.includes(directory), false);
      assert.equal(body.includes("private wallet path"), false);
    }
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("removed selected vault never exposes its absolute path over the bridge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-removed-path-"));
  const firstPath = join(directory, "first.nirvault.json");
  const secondPath = join(directory, "second.nirvault.json");
  const first = createWalletFile({ path: firstPath, password: "first-removed-password-2026" });
  const second = createWalletFile({ path: secondPath, password: "second-removed-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  const server = createWalletBridgeServer({
    accounts: [{ address: first.address, path: firstPath },
      { address: second.address, path: secondPath }],
    authorize: async () => null, origin, sessionToken: token, vaultPath: firstPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const list = await (await request(`${base}/v1/accounts`, origin, token)).json();
    assert.equal(list.canCreate, false);
    const selected = await request(`${base}/v1/select-account`, origin, token,
      { method: "POST", body: JSON.stringify({ id: list.accounts[1].id }) });
    assert.equal(selected.status, 200);
    rmSync(secondPath);
    const response = await request(`${base}/v1/wallet`, origin, token);
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.equal(body.includes(directory), false);
    assert.match(body, /wallet request could not be completed/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native pairing prompt shows the code only on the device, never over HTTP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-pairing-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "native-pairing-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "1".repeat(64);
  let shown = 0;
  const server = createWalletBridgeServer({
    authorize: async () => null, origin, pairingCode: "12345678",
    presentPairingCode: () => { shown += 1; }, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const prompt = await request(`${base}/v1/pairing-prompt`, origin, "", { method: "POST" });
    assert.equal(prompt.status, 202);
    const body = await prompt.text();
    assert.deepEqual(JSON.parse(body), { shownOnDevice: true });
    assert.equal(body.includes("12345678"), false);
    assert.equal(body.includes(token), false);
    assert.equal(shown, 1);
    const wrongOrigin = await request(`${base}/v1/pairing-prompt`, "http://evil.invalid", "",
      { method: "POST" });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(shown, 1);
    const paired = await request(`${base}/v1/pair`, origin, "",
      { method: "POST", body: JSON.stringify({ code: "12345678" }) });
    assert.equal(paired.status, 200);
    assert.equal((await request(`${base}/v1/pairing-prompt`, origin, "",
      { method: "POST" })).status, 409);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rehearsal CLI exposes sibling vault copies and disables unsupported creation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-cli-accounts-"));
  const walletDirectory = join(directory, "Wallets");
  mkdirSync(walletDirectory, { mode: 0o700 });
  const firstPath = join(walletDirectory, "first.nirvault.json");
  const secondPath = join(walletDirectory, "second.nirvault.json");
  const first = createWalletFile({ path: firstPath, password: "first-cli-password-2026" });
  const copiedKey = decryptWallet(JSON.parse(readFileSync(firstPath, "utf8")),
    "first-cli-password-2026");
  try {
    writeFileSync(secondPath, `${JSON.stringify(encryptWallet(copiedKey,
      "second-cli-password-2026"))}\n`, { mode: 0o600, flag: "wx" });
  } finally { copiedKey.privateKey = ""; }
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = "http://127.0.0.1:8765";
  const child = spawn(process.execPath,
    [new URL("../blockchain/wallet-bridge-cli.mjs", import.meta.url).pathname,
      firstPath, String(port), origin], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const pairingCode = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("bridge CLI did not start")), 10_000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = /One-time pairing code: ([0-9]{8})/.exec(output);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`bridge CLI exited: ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const paired = await fetch(`${base}/v1/pair`, { method: "POST", body: JSON.stringify({ code: pairingCode }),
      headers: { "content-type": "application/json", origin } });
    assert.equal(paired.status, 200);
    const { sessionToken } = await paired.json();
    const response = await request(`${base}/v1/accounts`, origin, sessionToken);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(directory), false);
    const list = JSON.parse(text);
    assert.equal(list.canCreate, false);
    assert.equal(list.accounts.length, 2);
    assert.equal(list.accounts[0].address, first.address);
    assert.equal(list.accounts[1].address, first.address);
    assert.notEqual(list.accounts[0].id, list.accounts[1].id);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disconnect during account creation cannot activate a new vault in the revoked session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-create-race-"));
  const firstPath = join(directory, "first.nirvault.json");
  const nextPath = join(directory, "next.nirvault.json");
  createWalletFile({ path: firstPath, password: "first-account-password-2026" });
  const next = createWalletFile({ path: nextPath, password: "next-account-password-2026" });
  let complete;
  const origin = "http://127.0.0.1:8765";
  const token = "d".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null,
    createAccount: () => new Promise((resolve) => { complete = resolve; }),
    origin, sessionToken: token, vaultPath: firstPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const creation = request(`${base}/v1/create-account`, origin, token,
      { method: "POST", body: "{}" });
    for (let attempt = 0; attempt < 100 && !complete; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(typeof complete, "function");
    assert.equal((await request(`${base}/v1/session`, origin, token,
      { method: "DELETE" })).status, 200);
    complete({ address: next.address, path: nextPath });
    assert.equal((await creation).status, 400);
    assert.equal((await request(`${base}/v1/accounts`, origin, token)).status, 401);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet checkpoint advances only through a verified finality header chain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-light-client-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const wallet = createWalletFile({ path: vaultPath, password: "wallet-light-client-password" });
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const members = validatorMembers(validators);
  const networkId = "nir-wallet-light-client";
  const treasury = generateWallet();
  const chain = new NirChain({
    beaconAuthorities: beacons.map((entry, index) => ({
      ...publicWallet(entry), operatorId: `beacon-${index}`,
    })),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluators: evaluators.map((entry, index) => ({
      ...publicWallet(entry), operatorId: `evaluator-${index}`,
    })),
    genesisTimestamp: 0,
    networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members,
  });
  const append = (timestamp, transactions = []) => {
    const block = finalizeBlock(
      chain.buildBlock({ timestamp, transactions }), validators.slice(0, 3),
    );
    chain.appendBlock(block);
    return block;
  };
  const account = (height) => {
    const authenticated = chain.accountStateProof(wallet.address);
    return createAccountProof({
      account: authenticated.account,
      accountStateRoot: authenticated.accountStateRoot,
      inclusionProof: authenticated.inclusionProof,
      height, networkId, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
      validators: members, validatorWallets: validators.slice(0, 3),
    });
  };
  const genesisBlock = chain.blocks()[0];
  const firstBlock = append(1);
  const origin = "http://127.0.0.1:8765";
  const token = "6".repeat(64);
  let pauseAuthorization = false;
  let authorizationStarted;
  let releaseAuthorization;
  const server = createWalletBridgeServer({
    authorize: async () => {
      if (!pauseAuthorization) return "wallet-light-client-password";
      authorizationStarted();
      return new Promise((resolve) => {
        releaseAuthorization = () => resolve("wallet-light-client-password");
      });
    },
    origin, sessionToken: token,
    trustAnchor: {
      expectedNetworkId: networkId,
      genesisCheckpoint: {
        accountStateRoot: genesisBlock.accountStateRoot,
        height: 0,
        stateRoot: genesisBlock.stateRoot,
        tipHash: genesisBlock.hash,
        validatorSetId: chain.validatorSetId,
      },
      handoffs: [], trustedValidators: members,
    },
    headerHistoryPath: join(directory, "wallet.headers.json"),
    trustCheckpointPath: join(directory, "wallet.trust.json"), vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const derivedAsset = await request(`${base}/v1/derive-asset-id`, origin, token, {
      body: JSON.stringify({ networkId, nonce: 0 }), method: "POST",
    });
    assert.equal(derivedAsset.status, 200);
    assert.equal((await derivedAsset.json()).assetId,
      nativeAssetId({ creator: wallet.address, networkId, nonce: 0 }));
    const malformedDerivation = await request(`${base}/v1/derive-asset-id`, origin, token, {
      body: JSON.stringify({ networkId, nonce: 0, unknown: true }), method: "POST",
    });
    assert.equal(malformedDerivation.status, 400);
    const unverifiedBootstrap = await request(
      `${base}/v1/verify-account-proof`, origin, token, {
        body: JSON.stringify({ address: wallet.address, minimumHeight: 1, proof: account(1) }),
        method: "POST",
      },
    );
    assert.equal(unverifiedBootstrap.status, 400);
    assert.match((await unverifiedBootstrap.json()).error, /verified finality chain/);
    const firstSync = await request(`${base}/v1/verify-finality-chain`, origin, token, {
      body: JSON.stringify({ proofs: [createFinalityProof(firstBlock)] }), method: "POST",
    });
    assert.equal(firstSync.status, 200);
    const bootstrap = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: wallet.address, minimumHeight: 1, proof: account(1) }),
      method: "POST",
    });
    assert.equal(bootstrap.status, 200);
    const transfer = createTransfer({
      amount: "100000000",
      fee: MIN_TRANSFER_FEE.toString(),
      networkId,
      nonce: 0,
      recipient: wallet.address,
      wallet: treasury,
    });
    const second = append(TREASURY_VESTING_MS, [transfer]);
    const laterProof = account(2);
    const premature = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: wallet.address, minimumHeight: 2, proof: laterProof }),
      method: "POST",
    });
    assert.equal(premature.status, 400);
    assert.match((await premature.json()).error, /verified finality chain/);
    const lightSync = await request(`${base}/v1/verify-finality-chain`, origin, token, {
      body: JSON.stringify({ proofs: [createFinalityProof(second)] }), method: "POST",
    });
    assert.equal(lightSync.status, 200);
    assert.equal((await lightSync.json()).tip.height, 2);
    const transactionEnvelope = {
      blockHash: second.hash,
      height: second.height,
      proof: createTransactionProof(second.transactions, 0),
      transaction: transfer,
      transactionsRoot: second.transactionsRoot,
    };
    const verifiedTransaction = await request(
      `${base}/v1/verify-transaction-proof`, origin, token, {
        body: JSON.stringify({
          proof: transactionEnvelope,
          transactionId: committedTransactionId(second.transactions[0]),
        }),
        method: "POST",
      },
    );
    assert.equal(verifiedTransaction.status, 200);
    assert.equal((await verifiedTransaction.json()).height, 2);
    const forgedTransaction = await request(
      `${base}/v1/verify-transaction-proof`, origin, token, {
        body: JSON.stringify({
          proof: { ...transactionEnvelope, transaction: { ...transfer, amount: "200000000" } },
        }),
        method: "POST",
      },
    );
    assert.equal(forgedTransaction.status, 400);
    const accepted = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: wallet.address, minimumHeight: 2, proof: laterProof }),
      method: "POST",
    });
    assert.equal(accepted.status, 200);
    const newAssetId = nativeAssetId({ creator: wallet.address, networkId, nonce: 0 });
    const assetProof = createAssetProof({ asset: null, assetId: newAssetId, balance: "0",
      height: 2, holder: wallet.address, networkId, stateRoot: chain.stateRoot,
      tipHash: chain.tipHash, validators: members, validatorWallets: validators.slice(0, 3) });
    const verifiedAsset = await request(`${base}/v1/verify-asset-proof`, origin, token, {
      body: JSON.stringify({ assetId: newAssetId, holder: wallet.address, minimumHeight: 2, proof: assetProof }),
      method: "POST",
    });
    assert.equal(verifiedAsset.status, 200);
    const staleAsset = await request(`${base}/v1/verify-asset-proof`, origin, token, {
      body: JSON.stringify({ assetId: newAssetId, holder: wallet.address, minimumHeight: 3, proof: assetProof }),
      method: "POST",
    });
    assert.equal(staleAsset.status, 400);
    const assetSimulation = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({ intent: { type: "asset-create", assetId: newAssetId,
        fee: MIN_TRANSFER_FEE.toString(), fixedSupply: false, initialSupply: "10", maxSupply: "100",
        metadataHash: "9".repeat(64), networkId, nonce: 0 }, network: { height: 2, networkId },
      verifiedAccount: { address: wallet.address, height: 2, proofVerified: true } }), method: "POST",
    });
    assert.equal(assetSimulation.status, 200);
    const assetSimulationBody = await assetSimulation.json();
    assert.equal(assetSimulationBody.simulation.deltas.asset[0].supplyAfter, "10");
    const offlineAsset = await request(`${base}/v1/create-offline-signing-package`, origin, token, {
      body: JSON.stringify({ simulationId: assetSimulationBody.simulation.simulationId }), method: "POST",
    });
    assert.equal(offlineAsset.status, 200);
    assert.equal((await offlineAsset.json()).signingPackage.intent.type, "asset-create");
    const browserAssetSigning = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({ ...assetSimulationBody.simulation.intent,
        requestId: "8".repeat(64), simulationId: assetSimulationBody.simulation.simulationId }),
      method: "POST",
    });
    assert.equal(browserAssetSigning.status, 400);
    assert.match((await browserAssetSigning.json()).error, /resource intent is invalid/);
    const unprovenSimulation = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({
        intent: { amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
          recipient: treasury.address, type: "transfer" },
        network: { height: 2, networkId },
      }), method: "POST",
    });
    assert.equal(unprovenSimulation.status, 400);
    assert.match((await unprovenSimulation.json()).error, /verified account proof/);
    const simulated = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({
        intent: { amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
          recipient: treasury.address, type: "transfer" },
        network: { height: 2, networkId },
        verifiedAccount: { address: wallet.address, height: 2, proofVerified: true },
      }), method: "POST",
    });
    assert.equal(simulated.status, 200);
    const simulation = await simulated.json();
    assert.equal(simulation.verified, true);
    assert.equal(simulation.simulation.deltas.balance[0].atomicDelta, "-1001");
    assert.equal(simulation.simulation.proof.verified, true);
    const unsignedWithoutReview = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify({
        amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
        recipient: treasury.address, requestId: "e".repeat(64),
      }), method: "POST",
    });
    assert.equal(unsignedWithoutReview.status, 400);
    assert.match((await unsignedWithoutReview.json()).error, /simulation is required/);
    const changedAfterReview = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify({
        amount: "2", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
        recipient: treasury.address, requestId: "d".repeat(64),
        simulationId: simulation.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(changedAfterReview.status, 400);
    assert.match((await changedAfterReview.json()).error, /differs from the reviewed simulation/);
    const signedAfterReview = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify({
        amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
        recipient: treasury.address, requestId: "e".repeat(64),
        simulationId: simulation.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(signedAfterReview.status, 200);
    assert.equal((await signedAfterReview.json()).simulationId, simulation.simulation.simulationId);
    const paymentExpiresAt = Date.now() + 60_000;
    const paymentPreview = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({
        intent: { amount: "1", expiresAt: paymentExpiresAt, memo: "preview", networkId,
          requestId: "f".repeat(64), type: "payment-request" },
        network: { height: 2, networkId },
        verifiedAccount: { address: wallet.address, height: 2, proofVerified: true },
      }), method: "POST",
    });
    assert.equal(paymentPreview.status, 200);
    const paymentPreviewValue = await paymentPreview.json();
    const unsignedRequestWithoutReview = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "1", expiresAt: paymentExpiresAt, memo: "preview", networkId,
        requestId: "0".repeat(64),
      }), method: "POST",
    });
    assert.equal(unsignedRequestWithoutReview.status, 400);
    assert.match((await unsignedRequestWithoutReview.json()).error, /simulation is required/);
    const changedPaymentPreview = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "2", expiresAt: paymentExpiresAt, memo: "preview", networkId,
        requestId: "f".repeat(64), simulationId: paymentPreviewValue.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(changedPaymentPreview.status, 400);
    assert.match((await changedPaymentPreview.json()).error, /differs from the reviewed simulation/);
    const signedPaymentPreview = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "1", expiresAt: paymentExpiresAt, memo: "preview", networkId,
        requestId: "f".repeat(64), simulationId: paymentPreviewValue.simulation.simulationId,
      }), method: "POST",
    });
    assert.equal(signedPaymentPreview.status, 200);
    assert.equal((await signedPaymentPreview.json()).paymentRequest.recipient, wallet.address);
    const completeHistory = await request(
      `${base}/v1/verify-account-history`, origin, token, {
        body: JSON.stringify({ transactionIds: [committedTransactionId(transfer)] }),
        method: "POST",
      },
    );
    assert.equal(completeHistory.status, 200);
    assert.equal((await completeHistory.json()).count, 1);
    const omittedHistory = await request(
      `${base}/v1/verify-account-history`, origin, token, {
        body: JSON.stringify({ transactionIds: [] }), method: "POST",
      },
    );
    assert.equal(omittedHistory.status, 400);
    assert.match((await omittedHistory.json()).error, /incomplete or reordered/);
    const page = {
      count: 1,
      entries: [{
        id: committedTransactionId(transfer),
        index: 0,
        proof: createAccountHistoryProof([committedTransactionId(transfer)], 0),
      }],
      nextBefore: null,
      start: 0,
    };
    const verifiedPage = await request(
      `${base}/v1/verify-account-history-page`, origin, token, {
        body: JSON.stringify({ before: 1, limit: 20, page }), method: "POST",
      },
    );
    assert.equal(verifiedPage.status, 200);
    const missingPage = await request(
      `${base}/v1/verify-account-history-page`, origin, token, {
        body: JSON.stringify({ before: 1, limit: 20, page: { ...page, entries: [] } }),
        method: "POST",
      },
    );
    assert.equal(missingPage.status, 400);

    const revokePreview = await request(`${base}/v1/simulate-transaction`, origin, token, {
      body: JSON.stringify({
        intent: { amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
          recipient: treasury.address, type: "transfer" },
        network: { height: 2, networkId },
        verifiedAccount: { address: wallet.address, height: 2, proofVerified: true },
      }), method: "POST",
    });
    assert.equal(revokePreview.status, 200);
    const revokeSimulation = await revokePreview.json();
    pauseAuthorization = true;
    const started = new Promise((resolve) => { authorizationStarted = resolve; });
    const signing = request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify({
        amount: "1", fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 0,
        recipient: treasury.address, requestId: "a".repeat(64),
        simulationId: revokeSimulation.simulation.simulationId,
      }), method: "POST",
    });
    await started;
    const current = await (await request(`${base}/v1/accounts`, origin, token)).json();
    const switchDuringSigning = await request(`${base}/v1/select-account`, origin, token, {
      body: JSON.stringify({ id: current.activeId }), method: "POST",
    });
    assert.equal(switchDuringSigning.status, 409);
    const disconnected = await request(`${base}/v1/session`, origin, token, { method: "DELETE" });
    assert.equal(disconnected.status, 200);
    releaseAuthorization();
    const revokedSigning = await signing;
    assert.equal(revokedSigning.status, 400);
    assert.match((await revokedSigning.json()).error, /session ended/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet account trust advances through verified validator handoffs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-proof-rotation-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const account = createWalletFile({ path: vaultPath, password: "wallet-proof-password-long" });
  const first = Array.from({ length: 4 }, generateWallet);
  const second = [first[0], first[1], generateWallet(), generateWallet()];
  const firstMembers = validatorMembers(first);
  const secondMembers = validatorMembers(second);
  const networkId = "nir-wallet-rotation-test";
  const handoff = createValidatorHandoff({
    activationBlockHash: "a".repeat(64),
    activationHeight: 10,
    activationStateRoot: "b".repeat(64),
    networkId,
    nextValidators: secondMembers,
    previousValidators: firstMembers,
  }, first.slice(0, 3), second.slice(0, 3));
  const accountState = {
    address: account.address,
    atomicBalance: "500000000",
    history: emptyAccountHistory(),
    nextNonce: 2,
    resources: {
      atomicStake: "0", availableTransferCredits: "0", delegations: [], pendingUnstake: null,
    },
  };
  const proof = createAccountProof({
    account: accountState,
    height: 10,
    networkId,
    stateRoot: "b".repeat(64),
    tipHash: "a".repeat(64),
    validators: secondMembers,
    validatorWallets: second.slice(0, 3),
  });
  const staleAuthority = createAccountProof({
    account: accountState,
    height: 10,
    networkId,
    stateRoot: "b".repeat(64),
    tipHash: "a".repeat(64),
    validators: firstMembers,
    validatorWallets: first.slice(0, 3),
  });
  const origin = "http://127.0.0.1:8765";
  const token = "0".repeat(64);
  const trustCheckpointPath = join(directory, "wallet.trust.json");
  const trustHistoryPath = join(directory, "wallet.handoffs.json");
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    sessionToken: token,
    trustAnchor: {
      expectedNetworkId: networkId,
      handoffs: [],
      trustedValidators: firstMembers,
    },
    trustCheckpointPath,
    trustHistoryPath,
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const updated = await request(`${base}/v1/update-validator-trust`, origin, token, {
      body: JSON.stringify({ handoffs: [handoff] }), method: "POST",
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).handoffs, 1);
    assert.equal(existsSync(trustHistoryPath), true);
    const verified = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({ address: account.address, minimumHeight: 10, proof }), method: "POST",
    });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).verified, true);
    assert.equal(existsSync(trustCheckpointPath), true);
    const rejected = await request(`${base}/v1/verify-account-proof`, origin, token, {
      body: JSON.stringify({
        address: account.address, minimumHeight: 10, proof: staleAuthority,
      }),
      method: "POST",
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /trust anchor/);
    const wrongActivationProof = createAccountProof({
      account: accountState,
      height: 10,
      networkId,
      stateRoot: "c".repeat(64),
      tipHash: "d".repeat(64),
      validators: secondMembers,
      validatorWallets: second.slice(0, 3),
    });
    const wrongActivation = await request(
      `${base}/v1/verify-account-proof`, origin, token, {
        body: JSON.stringify({
          address: account.address, minimumHeight: 10, proof: wrongActivationProof,
        }),
        method: "POST",
      },
    );
    assert.equal(wrongActivation.status, 400);
    assert.match((await wrongActivation.json()).error, /activation block/);
    await close(server);
    assert.throws(() => createWalletBridgeServer({
      authorize: async () => null,
      origin,
      sessionToken: token,
      trustAnchor: {
        expectedNetworkId: networkId,
        handoffs: [],
        trustedValidators: firstMembers,
      },
      trustCheckpointPath,
      vaultPath,
    }), /rolls back/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge requires a verified simulation before an exact-origin signing request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-bridge-password-long";
  const wallet = createWalletFile({ path: vaultPath, password });
  const recipient = generateWallet();
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  const approvals = [];
  const server = createWalletBridgeServer({
    authorize: async (intent) => { approvals.push(intent); return password; },
    origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await request(`${base}/v1/wallet`, "http://evil.invalid", token)).status, 403);
    assert.equal((await request(`${base}/v1/wallet`, origin, "b".repeat(64))).status, 401);
    const publicInfo = await request(`${base}/v1/wallet`, origin, token);
    assert.equal(publicInfo.status, 200);
    assert.equal((await publicInfo.json()).address, wallet.address);

    const intent = {
      amount: "250000000",
      networkId: "nir-testnet",
      nonce: 0,
      recipient: recipient.address,
      requestId: "c".repeat(64),
    };
    const signed = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(signed.status, 400);
    assert.match((await signed.json()).error, /simulation is required/);
    assert.equal(approvals.length, 0);
    const replay = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge never broadcasts a request that has no reviewed simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-reject-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const recipient = generateWallet();
  const origin = "http://localhost:8765";
  const token = "d".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const intent = {
      amount: "1", networkId: "nir-testnet", nonce: 0,
      recipient: recipient.address, requestId: "e".repeat(64),
    };
    const rejected = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /simulation is required/);
    assert.equal((await request(`${base}/v1/transactions`, origin, token, {
      body: "{}", method: "POST",
    })).status, 404);
    const replay = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent), method: "POST",
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge rejects a resource operation without a reviewed simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-resource-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-resource-password-long";
  createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8765";
  const token = "3".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => password, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({
        amount: "10000000000", fee: "1000", networkId: "nir-testnet", nonce: 0,
        requestId: "4".repeat(64), type: "credit-stake",
      }),
      method: "POST",
    });
    assert.equal(signed.status, 400);
    assert.match((await signed.json()).error, /simulation is required/);

    const invalid = await request(`${base}/v1/sign-resource`, origin, token, {
      body: JSON.stringify({
        networkId: "nir-testnet", nonce: 1, requestId: "5".repeat(64), type: "validator-bond",
      }),
      method: "POST",
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /invalid/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge rejects payment-request signing without a reviewed simulation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-request-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-payment-request-password";
  const wallet = createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8765";
  const token = "7".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => password, origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = await request(`${base}/v1/sign-payment-request`, origin, token, {
      body: JSON.stringify({
        amount: "300000000",
        expiresAt: Date.now() + 3_600_000,
        memo: "Invoice 17",
        networkId: "nir-testnet",
        requestId: "8".repeat(64),
      }),
      method: "POST",
    });
    assert.equal(signed.status, 400);
    assert.match((await signed.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge rejects unreviewed requests before opening a confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-lock-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "wallet-bridge-password-long";
  createWalletFile({ path: vaultPath, password });
  const recipient = generateWallet();
  const origin = "http://127.0.0.1:8765";
  const token = "f".repeat(64);
  let releaseApproval;
  let approvalStarted;
  const started = new Promise((resolve) => { approvalStarted = resolve; });
  const server = createWalletBridgeServer({
    authorize: async () => {
      approvalStarted();
      return new Promise((resolve) => { releaseApproval = () => resolve(password); });
    },
    origin, sessionToken: token, vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const intent = (requestId) => ({
      amount: "1", networkId: "nir-testnet", nonce: 0,
      recipient: recipient.address, requestId,
    });
    const first = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent("1".repeat(64))), method: "POST",
    });
    const second = await request(`${base}/v1/sign`, origin, token, {
      body: JSON.stringify(intent("2".repeat(64))), method: "POST",
    });
    assert.equal(first.status, 400);
    assert.match((await first.json()).error, /simulation is required/);
    assert.equal(second.status, 400);
    assert.match((await second.json()).error, /simulation is required/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge exchanges a short-lived one-time code for one in-memory session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-pair-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const token = "9".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    pairingCode: "12345678",
    sessionToken: token,
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const wrong = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "00000000" }), method: "POST",
    });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /invalid/);
    const paired = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "12345678" }), method: "POST",
    });
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get("cache-control"), "no-store");
    assert.equal(paired.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(paired.headers.get("x-frame-options"), "DENY");
    assert.deepEqual(await paired.json(), { sessionToken: token });
    const unauthenticatedVerification = await request(
      `${base}/v1/verify-offline-signed-package`, origin, "", {
        body: JSON.stringify({ networkId: "nir-testnet", signedPackage: {} }), method: "POST",
      });
    assert.equal(unauthenticatedVerification.status, 401);
    const authenticatedVerification = await request(
      `${base}/v1/verify-offline-signed-package`, origin, token, {
        body: JSON.stringify({ networkId: "nir-testnet", signedPackage: {} }), method: "POST",
      });
    assert.equal(authenticatedVerification.status, 400);
    const reused = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "12345678" }), method: "POST",
    });
    assert.equal(reused.status, 400);
    assert.match((await reused.json()).error, /unavailable/);
    assert.equal((await request(`${base}/v1/wallet`, origin, token)).status, 200);
    const disconnected = await request(`${base}/v1/session`, origin, token, {
      method: "DELETE",
    });
    assert.equal(disconnected.status, 200);
    assert.deepEqual(await disconnected.json(), { disconnected: true });
    assert.equal((await request(`${base}/v1/wallet`, origin, token)).status, 401);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge pairing is atomic under concurrent tabs and strict about its body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-pair-race-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const token = "5".repeat(64);
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    pairingCode: "11223344",
    sessionToken: token,
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const extraField = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "11223344", session: "fix-me" }), method: "POST",
    });
    assert.equal(extraField.status, 400);
    assert.match((await extraField.json()).error, /invalid/);
    const oversized = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "0".repeat(256) }), method: "POST",
    });
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /too large/);

    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      request(`${base}/v1/pair`, origin, "", {
        body: JSON.stringify({ code: "11223344" }), method: "POST",
      })));
    const statuses = attempts.map(({ status }) => status);
    assert.equal(statuses.filter((status) => status === 200).length, 1);
    assert.equal(statuses.filter((status) => status === 400).length, 7);
    const successful = attempts.find(({ status }) => status === 200);
    assert.deepEqual(await successful.json(), { sessionToken: token });
    assert.equal((await request(`${base}/v1/wallet?confused=1`, origin, token)).status, 404);
    assert.equal(await rawStatus(`${base}/v1/wallet`, {
      host: "evil.invalid", origin, "x-nir-bridge-token": token,
    }), 403);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet bridge disables pairing after five incorrect attempts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-attempt-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const server = createWalletBridgeServer({
    authorize: async () => null,
    origin,
    pairingCode: "87654321",
    sessionToken: "6".repeat(64),
    vaultPath,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await request(`${base}/v1/pair`, origin, "", {
        body: JSON.stringify({ code: "00000000" }), method: "POST",
      });
      assert.equal(rejected.status, 400);
    }
    const locked = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "87654321" }), method: "POST",
    });
    assert.equal(locked.status, 400);
    assert.match((await locked.json()).error, /unavailable/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridge restart invalidates the previous pairing code and session token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-bridge-restart-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const firstToken = "1".repeat(64);
  const first = createWalletBridgeServer({ authorize: async () => null, origin,
    pairingCode: "10101010", sessionToken: firstToken, vaultPath });
  let second;
  try {
    await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    const paired = await request(`${firstBase}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "10101010" }), method: "POST",
    });
    assert.equal(paired.status, 200);
    assert.equal((await request(`${firstBase}/v1/wallet`, origin, firstToken)).status, 200);
    await close(first);

    second = createWalletBridgeServer({ authorize: async () => null, origin,
      pairingCode: "20202020", sessionToken: "2".repeat(64), vaultPath });
    await new Promise((resolve) => second.listen(0, "127.0.0.1", resolve));
    const secondBase = `http://127.0.0.1:${second.address().port}`;
    assert.equal((await request(`${secondBase}/v1/wallet`, origin, firstToken)).status, 401);
    const staleCode = await request(`${secondBase}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "10101010" }), method: "POST",
    });
    assert.equal(staleCode.status, 400);
    const fresh = await request(`${secondBase}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "20202020" }), method: "POST",
    });
    assert.equal(fresh.status, 200);
    assert.deepEqual(await fresh.json(), { sessionToken: "2".repeat(64) });
  } finally {
    await close(first);
    if (second) await close(second);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native security requires the paired origin and session, returns no secret, and cannot outlive logout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-security-test-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-native-security-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let calls = 0;
  const server = createWalletBridgeServer({
    authorize: async () => null, origin, sessionToken: token, vaultPath,
    nativeSecurity: async ({ vaultPath: selected }) => {
      assert.equal(selected, vaultPath);
      calls += 1;
      return calls === 1 ? true : "NEVER_RETURN_THIS_SECRET";
    },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/native-security`;
    assert.equal((await request(endpoint, origin, "b".repeat(64), { method: "POST" })).status, 401);
    assert.equal((await request(endpoint, "http://127.0.0.1:9999", token,
      { method: "POST" })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await (await request(`http://127.0.0.1:${server.address().port}/v1/wallet`,
      origin, token)).json()).nativeSecurityAvailable, true);
    const buildEndpoint = `http://127.0.0.1:${server.address().port}/v1/app-build`;
    assert.equal((await request(buildEndpoint, origin, "b".repeat(64))).status, 401);
    assert.equal((await request(buildEndpoint, "http://127.0.0.1:9999", token)).status, 403);
    assert.deepEqual(await (await request(buildEndpoint, origin, token)).json(), {
      version: "0.2.0", localBuildSequence: walletBuildSequence, updateChannel: "unavailable",
    });
    const result = await request(endpoint, origin, token, { method: "POST" });
    assert.equal(result.status, 200);
    const body = await result.text();
    assert.deepEqual(JSON.parse(body), { opened: true });
    assert.equal(body.includes("wallet-native-security-2026"), false);
    assert.equal(calls, 1);
    const unexpected = await request(endpoint, origin, token, { method: "POST" });
    assert.deepEqual(await unexpected.json(), { opened: false });
    assert.equal(calls, 2);
    assert.equal((await request(`http://127.0.0.1:${server.address().port}/v1/session`, origin,
      token, { method: "DELETE" })).status, 200);
    assert.equal((await request(endpoint, origin, token, { method: "POST" })).status, 401);
    assert.equal(calls, 2);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native password change is Mac-capability gated, session-bound, and never returns passwords", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-password-change-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "old-wallet-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let calls = 0;
  const server = createWalletBridgeServer({
    authorize: async () => null, origin, sessionToken: token, vaultPath,
    nativePasswordChange: async ({ vaultPath: selected }) => {
      assert.equal(selected, vaultPath);
      calls += 1;
      return calls === 1 ? true : "DO_NOT_EXPOSE_THIS_PASSWORD";
    },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const endpoint = `${base}/v1/native-password-change`;
    assert.equal((await request(endpoint, origin, "b".repeat(64), { method: "POST" })).status, 401);
    assert.equal((await request(endpoint, "http://127.0.0.1:9999", token,
      { method: "POST" })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await (await request(`${base}/v1/wallet`, origin, token)).json())
      .nativePasswordChangeAvailable, true);
    assert.deepEqual(await (await request(endpoint, origin, token,
      { method: "POST" })).json(), { changed: true });
    const second = await (await request(endpoint, origin, token,
      { method: "POST" })).text();
    assert.deepEqual(JSON.parse(second), { changed: false });
    assert.equal(second.includes("DO_NOT_EXPOSE_THIS_PASSWORD"), false);
    assert.equal((await request(`${base}/v1/session`, origin, token,
      { method: "DELETE" })).status, 200);
    assert.equal((await request(endpoint, origin, token, { method: "POST" })).status, 401);
    assert.equal(calls, 2);
  } finally { await close(server); rmSync(directory, { recursive: true, force: true }); }
});

test("native password change excludes other native security dialogs and account actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-password-change-overlap-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "old-wallet-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let securityCalls = 0;
  const server = createWalletBridgeServer({ authorize: async () => null,
    origin, sessionToken: token, vaultPath,
    nativePasswordChange: async () => { entered(); await gate; return true; },
    nativeSecurity: async () => { securityCalls += 1; return true; },
    createAccount: async () => { throw new Error("must not create while password dialog is open"); },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const pending = request(`${base}/v1/native-password-change`, origin, token,
      { method: "POST" });
    await started;
    assert.equal((await request(`${base}/v1/native-security`, origin, token,
      { method: "POST" })).status, 409);
    assert.equal((await request(`${base}/v1/native-password-change`, origin, token,
      { method: "POST" })).status, 409);
    assert.equal((await request(`${base}/v1/create-account`, origin, token,
      { method: "POST", body: "{}" })).status, 409);
    assert.equal(securityCalls, 0);
    release();
    assert.deepEqual(await (await pending).json(), { changed: true });
  } finally {
    release?.(); await close(server); rmSync(directory, { recursive: true, force: true });
  }
});

test("native security cannot switch accounts or return success after session revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-security-race-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const otherPath = join(directory, "other.nirvault.json");
  const first = createWalletFile({ path: vaultPath, password: "wallet-native-security-2026" });
  const second = createWalletFile({ path: otherPath, password: "other-native-security-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let aborted = false;
  const server = createWalletBridgeServer({
    accounts: [{ address: first.address, path: vaultPath },
      { address: second.address, path: otherPath }],
    authorize: async () => null, origin, sessionToken: token, vaultPath,
    nativeSecurity: async ({ signal }) => {
      signal.addEventListener("abort", () => { aborted = true; release(); });
      started();
      await blocked;
    },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const pending = request(`${base}/v1/native-security`, origin, token, { method: "POST" });
    await entered;
    const list = await (await request(`${base}/v1/accounts`, origin, token)).json();
    const switchResponse = await request(`${base}/v1/select-account`, origin, token,
      { method: "POST", body: JSON.stringify({ id: list.accounts[1].id }) });
    assert.equal(switchResponse.status, 409);
    assert.equal((await request(`${base}/v1/native-security`, origin, token,
      { method: "POST" })).status, 409);
    assert.equal((await request(`${base}/v1/sign`, origin, token,
      { method: "POST", body: "{}" })).status, 409);
    assert.equal((await request(`${base}/v1/session`, origin, token,
      { method: "DELETE" })).status, 200);
    assert.equal(aborted, true);
    assert.equal((await pending).status, 409);
  } finally {
    release();
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creating another account blocks native security before a second Mac password dialog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-create-race-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const otherPath = join(directory, "other.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-native-security-2026" });
  const second = createWalletFile({ path: otherPath, password: "other-native-security-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let securityCalls = 0;
  const server = createWalletBridgeServer({
    authorize: async () => null, origin, sessionToken: token, vaultPath,
    createAccount: async () => { started(); await blocked;
      return { address: second.address, path: otherPath }; },
    nativeSecurity: async () => { securityCalls += 1; return true; },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const creating = request(`${base}/v1/create-account`, origin, token,
      { method: "POST", body: "{}" });
    await entered;
    assert.equal((await request(`${base}/v1/native-security`, origin, token,
      { method: "POST" })).status, 409);
    assert.equal(securityCalls, 0);
    release();
    assert.equal((await creating).status, 200);
    assert.equal((await request(`${base}/v1/native-security`, origin, token,
      { method: "POST" })).status, 200);
    assert.equal(securityCalls, 1);
  } finally {
    release();
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a delayed signing body cannot pass an earlier native-security check", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-security-body-race-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-native-security-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const server = createWalletBridgeServer({ authorize: async () => null,
    origin, sessionToken: token, vaultPath,
    nativeSecurity: async () => { started(); await blocked; return true; },
  });
  let outgoing;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const signing = new Promise((resolve, reject) => {
      outgoing = httpRequest({ hostname: "127.0.0.1", port, path: "/v1/sign",
        method: "POST", headers: { origin, "x-nir-bridge-token": token,
          "content-type": "application/json", "transfer-encoding": "chunked" } },
      (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      outgoing.once("error", reject);
    });
    await new Promise((resolve) => outgoing.write("{", resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const native = request(`http://127.0.0.1:${port}/v1/native-security`, origin,
      token, { method: "POST" });
    await entered;
    outgoing.end("}");
    assert.equal(await signing, 409);
    release();
    assert.equal((await native).status, 200);
  } finally {
    outgoing?.destroy();
    release();
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generic paired bridge advertises no native recovery action", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-generic-recovery-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "generic-wallet-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  const server = createWalletBridgeServer({ authorize: async () => null, origin,
    sessionToken: token, vaultPath });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const info = await (await request(`${base}/v1/wallet`, origin, token)).json();
    assert.equal(info.nativeSecurityAvailable, false);
    assert.equal(info.nativePasswordChangeAvailable, false);
    assert.equal((await request(`${base}/v1/native-security`, origin, token,
      { method: "POST" })).status, 404);
    assert.equal((await request(`${base}/v1/native-password-change`, origin, token,
      { method: "POST" })).status, 404);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native bootstrap requires a full one-time secret and never exposes a session to a blind caller", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-native-bootstrap-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "wallet-bridge-password-long" });
  const origin = "http://127.0.0.1:8765";
  const code = "ab".repeat(32);
  const token = "cd".repeat(32);
  const server = createWalletBridgeServer({ authorize: async () => null, origin,
    pairingCode: code, sessionToken: token, vaultPath });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await request(`${base}/v1/wallet`, origin, token)).status, 401);
    const blind = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code: "ab".repeat(31) }), method: "POST",
    });
    assert.equal(blind.status, 400);
    const paired = await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code }), method: "POST",
    });
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), { sessionToken: token });
    assert.equal((await request(`${base}/v1/wallet`, origin, token)).status, 200);
    assert.equal((await request(`${base}/v1/pair`, origin, "", {
      body: JSON.stringify({ code }), method: "POST",
    })).status, 400);
  } finally { await close(server); rmSync(directory, { recursive: true, force: true }); }
});


test("the bridge exposes owner-signed app updates only to the paired session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-app-update-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "app-update-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  const calls = [];
  const state = { available: true, configured: true, error: null, release: { sequence: 2, version: "0.3.0" },
    state: "idle" };
  const appUpdater = {
    apply: async () => { calls.push("apply"); },
    check: async () => { calls.push("check"); },
    status: () => state,
  };
  const server = createWalletBridgeServer({ appUpdater, authorize: async () => null, origin,
    sessionToken: token, vaultPath });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await request(`${base}/v1/app-update`, origin, "b".repeat(64))).status, 401);
    assert.equal((await request(`${base}/v1/app-update/apply`, origin, "b".repeat(64),
      { method: "POST" })).status, 401);
    assert.deepEqual(calls, []);
    assert.deepEqual(await (await request(`${base}/v1/app-update`, origin, token)).json(), state);
    assert.equal((await request(`${base}/v1/app-update/check`, origin, token, { method: "POST" })).status, 202);
    assert.equal((await request(`${base}/v1/app-update/apply`, origin, token, { method: "POST" })).status, 202);
    assert.deepEqual(calls, ["check", "apply"]);
    // Without an updater the routes do not exist.
    const plain = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token, vaultPath });
    await new Promise((resolve) => plain.listen(0, "127.0.0.1", resolve));
    try {
      const plainBase = `http://127.0.0.1:${plain.address().port}`;
      assert.equal((await request(`${plainBase}/v1/app-update`, origin, token)).status, 404);
    } finally {
      await close(plain);
    }
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accounts get the user's own names, unique among their accounts, with addresses unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-names-"));
  const firstPath = join(directory, "first.nirvault.json");
  const secondPath = join(directory, "second.nirvault.json");
  const first = createWalletFile({ path: firstPath, password: "first-names-password-2026" });
  const second = createWalletFile({ path: secondPath, password: "second-names-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  // A hand-edited file entry that breaks the rules is ignored.
  const names = { [second.address]: "bad‮name" };
  const server = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token,
    vaultPath: firstPath,
    accounts: [{ address: first.address, path: firstPath }, { address: second.address, path: secondPath }],
    accountNames: { read: () => ({ ...names }), write: (address, name) => { names[address] = name; } } });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const rename = (id, name) => request(`${base}/v1/rename-account`, origin, token,
      { method: "POST", body: JSON.stringify({ id, name }) });
    let list = await (await request(`${base}/v1/accounts`, origin, token)).json();
    assert.equal(list.canRename, true);
    assert.deepEqual(list.accounts.map(({ label }) => label), ["Кошелёк 1", "Кошелёк 2"]);
    const [one, two] = list.accounts;
    assert.equal((await rename(one.id, "  Копилка   🐷 ")).status, 200);
    assert.equal(names[first.address], "Копилка 🐷");
    // Another of the user's accounts cannot take the same name, in any case.
    assert.equal((await rename(two.id, "копилка 🐷")).status, 400);
    for (const bad of ["", " ", "a".repeat(33), "x​y", "line\nbreak"]) {
      assert.equal((await rename(two.id, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await rename(two.id, "Майнинг")).status, 200);
    list = await (await request(`${base}/v1/accounts`, origin, token)).json();
    assert.deepEqual(list.accounts.map(({ label, address }) => [label, address]),
      [["Копилка 🐷", first.address], ["Майнинг", second.address]]);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the secret phrase is shown only by the Mac app and only its outcome reaches the page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-phrase-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  createWalletFile({ path: vaultPath, password: "phrase-route-password-2026" });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  let calls = 0;
  const server = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token, vaultPath,
    nativeRevealPhrase: async ({ signal }) => { calls++; assert.ok(signal); return "wrong-password"; } });
  const plain = createWalletBridgeServer({ authorize: async () => null, origin, sessionToken: token, vaultPath });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => plain.listen(0, "127.0.0.1", resolve));
    const reveal = (port, sessionToken = token) => request(`http://127.0.0.1:${port}/v1/reveal-phrase`, origin,
      sessionToken, { method: "POST" });
    const shown = await reveal(server.address().port);
    assert.equal(shown.status, 200);
    assert.deepEqual(await shown.json(), { outcome: "wrong-password" });
    assert.equal((await reveal(server.address().port, "b".repeat(64))).status, 401);
    assert.equal(calls, 1);
    assert.equal((await reveal(plain.address().port)).status, 404);
  } finally {
    await close(server);
    await close(plain);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a name purchase is signed after one confirmation that shows the name and its burned price", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-wallet-name-"));
  const vaultPath = join(directory, "wallet.nirvault.json");
  const password = "name-route-password-2026";
  const { address } = createWalletFile({ path: vaultPath, password });
  const origin = "http://127.0.0.1:8765";
  const token = "a".repeat(64);
  const prompts = [];
  const server = createWalletBridgeServer({ origin, sessionToken: token, vaultPath,
    authorize: async (intent) => { prompts.push(intent); return password; } });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const sign = (body) => request(`${base}/v1/sign-name`, origin, token, { method: "POST", body: JSON.stringify({
      chainIdentityGenesisHash: "e".repeat(64), networkId: "nir-local-devnet", nonce: 4,
      requestId: randomBytes(32).toString("hex"), ...body }) });
    const response = await sign({ action: "register", name: "sasha" });
    assert.equal(response.status, 200);
    const { transactions: [commit, register] } = await response.json();
    assert.deepEqual([commit.type, commit.nonce, register.type, register.nonce, register.name],
      ["name-commit", 4, "name-register", 5, "sasha"]);
    assert.equal(commit.sender, address);
    assert.equal(nameCommitment({ name: "sasha", networkId: "nir-local-devnet", owner: address,
      salt: register.salt }), commit.commitment);
    assert.deepEqual([prompts[0].type, prompts[0].name, prompts[0].price], ["name-register", "sasha", "1 NIR"]);
    // Names the network would refuse are refused before any prompt.
    for (const name of ["ab", "Sasha", "support", "nirbank"]) {
      assert.equal((await sign({ action: "register", name })).status, 400, name);
    }
    assert.equal((await sign({ action: "transfer", recipient: address })).status, 400);
    assert.equal(prompts.length, 1);
    const released = await (await sign({ action: "release" })).json();
    assert.equal(released.transactions[0].type, "name-release");
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
