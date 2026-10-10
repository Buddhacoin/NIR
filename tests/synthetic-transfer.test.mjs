import test from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTransferSession } from "../blockchain/synthetic-transfer.mjs";
import { createMiningPracticeApp } from "../blockchain/mining-practice-app.mjs";
import { join } from "node:path";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createOperatorWalletProof } from "../blockchain/operator-wallet-link.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { createWalletBridgeServer } from "../blockchain/wallet-bridge.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const address = `nir1${"a".repeat(64)}`;
const other = `nir1${"b".repeat(64)}`;

test("explicitly synthetic training credit can be transferred once to a NIR-shaped address", () => {
  const ledger = createSyntheticTransferSession();
  assert.equal(ledger.snapshot().remaining, "0");
  ledger.startTraining(address);
  assert.equal(ledger.snapshot().remaining, "7");
  const entry = ledger.transfer({ recipient: address, amount: "3", id: "first" });
  assert.equal(entry.recipient, address);
  assert.equal(ledger.snapshot().remaining, "4");
  assert.equal(ledger.snapshot().balances[address], "3");
  assert.equal(BigInt(ledger.snapshot().remaining) +
    Object.values(ledger.snapshot().balances).reduce((sum, value) => sum + BigInt(value), 0n), 7n);
  assert.throws(() => ledger.transfer({ recipient: other, amount: "3", id: "first" }), /replay/);
  assert.equal(ledger.snapshot().balances[other], undefined);
});

test("synthetic transfer rejects malformed recipient, network, overspend, zero and repeated credit", () => {
  const ledger = createSyntheticTransferSession();
  assert.throws(() => ledger.transfer({ recipient: address, amount: "1", id: "x" }), /training/);
  ledger.startTraining(address);
  assert.throws(() => ledger.startTraining(address), /already/);
  assert.throws(() => ledger.transfer({ recipient: "nir1bad", amount: "1", id: "x" }), /recipient/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "1", id: "x", networkId: "nir-mainnet-1" }), /network/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "0", id: "x" }), /amount/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "8", id: "x" }), /balance/);
  assert.deepEqual(ledger.snapshot().balances, {});
});

test("training credit stays with the address that was verified when training began", () => {
  const ledger = createSyntheticTransferSession();
  ledger.startTraining(address);
  assert.equal(ledger.snapshot().trainingRecipient, address);
  assert.throws(() => ledger.transfer({ recipient: other, amount: "1", id: "reroute" }), /recipient/);
  assert.equal(ledger.snapshot().remaining, "7");
  assert.deepEqual(ledger.snapshot().balances, {});
});

test("Model Lab exposes only authenticated in-memory synthetic transfers and never a wallet balance", async () => {
  const server = createMiningPracticeApp({ root: join(import.meta.dirname, "..") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: base, "X-NIR-Session": server.localSessionToken };
  const post = (path, body = "", extra = headers) => fetch(`${base}${path}`, {
    method: "POST", body, headers: { ...extra, ...(body ? { "Content-Type": "application/json" } : {}) },
  });
  try {
    assert.equal((await post("/synthetic-transfer/start", "", { ...headers, origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/synthetic-transfer/start", "", { origin: base })).status, 403);
    assert.equal((await post("/synthetic-transfer/start")).status, 403);
    const wallet = generateWallet();
    const otherWallet = generateWallet();
    const request = await post("/wallet-link/challenge");
    assert.equal(request.status, 200);
    const { challenge } = await request.json();
    const proof = createOperatorWalletProof({ wallet, challenge });
    assert.equal((await post("/wallet-link/complete", JSON.stringify(proof))).status, 200);
    const started = await post("/synthetic-transfer/start");
    assert.equal(started.status, 200);
    assert.equal((await started.json()).verifiedRecipient, wallet.address);
    assert.equal((await post("/synthetic-transfer/start")).status, 409);
    const input = { recipient: wallet.address, amount: "3", id: "test-1", networkId: "nir-synthetic-local-1" };
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, recipient: otherWallet.address }))).status, 400);
    const sent = await post("/synthetic-transfer", JSON.stringify(input));
    assert.equal(sent.status, 200);
    const result = await sent.json();
    assert.equal(result.state.balances[wallet.address], "3");
    assert.equal(result.state.transferableNir, "0");
    assert.equal(result.state.walletChanged, false);
    assert.equal(result.state.networkSubmitted, false);
    assert.equal((await post("/synthetic-transfer", JSON.stringify(input))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-2", networkId: "nir-mainnet-1" }))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-3", recipient: "bad" }))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-4", amount: "5" }))).status, 400);
    assert.equal((await post("/wallet-link/challenge")).status, 200);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-5", amount: "1" }))).status, 400);
    const secondChallenge = await post("/wallet-link/challenge");
    const secondProof = createOperatorWalletProof({ wallet: otherWallet,
      challenge: (await secondChallenge.json()).challenge });
    assert.equal((await post("/wallet-link/complete", JSON.stringify(secondProof))).status, 200);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({
      ...input, id: "test-6", amount: "1", recipient: otherWallet.address,
    }))).status, 400);
    const state = await fetch(`${base}/synthetic-transfer/state`, {
      headers: { "X-NIR-Session": server.localSessionToken },
    });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).remaining, "4");
    assert.equal((await fetch(`${base}/synthetic-transfer/state`, {
      headers: { ...headers, origin: "https://evil.example" },
    })).status, 403);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("temporary wallet bridge proof permits only an imaginary transfer without vault mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-synthetic-link-test-"));
  const vaultPath = join(directory, "wallet.json");
  const password = "temporary-test-password";
  const wallet = createWalletFile({ path: vaultPath, password });
  const vaultBefore = readFileSync(vaultPath);
  const walletOrigin = "http://127.0.0.1:8976";
  const bridgeToken = "f".repeat(64);
  const bridge = createWalletBridgeServer({ vaultPath, origin: walletOrigin,
    sessionToken: bridgeToken, authorize: async () => password });
  const lab = createMiningPracticeApp({ root: join(import.meta.dirname, "..") });
  try {
    for (const server of [bridge, lab])
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const labBase = `http://127.0.0.1:${lab.address().port}`;
    const bridgeBase = `http://127.0.0.1:${bridge.address().port}`;
    const labHeaders = { origin: labBase, "X-NIR-Session": lab.localSessionToken };
    const postLab = (path, body = "") => fetch(`${labBase}${path}`, {
      method: "POST", body, headers: { ...labHeaders,
        ...(body ? { "Content-Type": "application/json" } : {}) },
    });
    const challengeResponse = await postLab("/wallet-link/challenge");
    assert.equal(challengeResponse.status, 200);
    const { challenge } = await challengeResponse.json();
    const signed = await fetch(`${bridgeBase}/v1/sign-operator-link`, {
      method: "POST", body: JSON.stringify({ challenge, requestId: "d".repeat(64) }),
      headers: { origin: walletOrigin, "X-NIR-Bridge-Token": bridgeToken,
        "Content-Type": "application/json" },
    });
    assert.equal(signed.status, 200);
    const { proof } = await signed.json();
    assert.equal((await postLab("/wallet-link/complete", JSON.stringify(proof))).status, 200);
    assert.equal((await postLab("/synthetic-transfer/start")).status, 200);
    const moved = await postLab("/synthetic-transfer", JSON.stringify({
      recipient: wallet.address, amount: "2", id: "bridge-test-1",
      networkId: "nir-synthetic-local-1",
    }));
    assert.equal(moved.status, 200);
    const { state } = await moved.json();
    assert.equal(state.balances[wallet.address], "2");
    assert.equal(state.remaining, "5");
    assert.equal(state.verifiedRecipient, wallet.address);
    assert.equal(state.transferableNir, "0");
    assert.equal(state.walletChanged, false);
    assert.deepEqual(readFileSync(vaultPath), vaultBefore);
  } finally {
    for (const server of [bridge, lab]) {
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two rapid UI clicks send one stable imaginary transfer request", async () => {
  const element = () => ({ hidden: true, disabled: false, dataset: {}, textContent: "", value: "2",
    children: [], style: { setProperty() {} }, setAttribute() {},
    addEventListener(_, listener) { this.click = listener; },
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); } });
  const nodes = new Map();
  for (const id of ["start", "progress", "result", "error", "error-message", "connection",
    "language", "score", "technical", "event-pulses", "event-log", "synthetic-start",
    "synthetic-send", "synthetic-recipient", "synthetic-amount", "synthetic-balance",
    "synthetic-state", "synthetic-history", ".local-only"]) nodes.set(`#${id.replace(/^\./, "")}`, element());
  nodes.set(".local-only", element());
  let requests = 0;
  let stateReads = 0;
  const transferIds = [];
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  const snapshot = { simulationOnly: true, walletChanged: false, networkSubmitted: false,
    transferableNir: "0", started: true, remaining: "7", trainingRecipient: address,
    verifiedRecipient: address, history: [], balances: {} };
  runInNewContext(readFileSync(join(import.meta.dirname, "../mining-app/app.js"), "utf8"), {
    document: { documentElement: { lang: "ru" }, querySelector: (selector) => nodes.get(selector),
      querySelectorAll: () => [], createElement: element },
    navigator: { language: "ru-RU" }, AbortController, crypto: webcrypto,
    fetch: async (path, options) => {
      if (path === "/status") return { ok: true, json: async () => ({ status: "local-model-service-ready" }) };
      if (path === "/synthetic-transfer/state") {
        stateReads++;
        if (stateReads === 2) throw new TypeError("state response unavailable");
        return { ok: true, json: async () => snapshot };
      }
      if (path === "/synthetic-transfer") {
        requests++;
        transferIds.push(JSON.parse(options.body).id);
        if (requests === 1) {
          await pause;
          throw new TypeError("response lost after uncertain send");
        }
        return { ok: true, json: async () => ({ entry: { simulationOnly: true }, state: snapshot }) };
      }
      throw new Error(`unexpected ${path}`);
    },
    setInterval: () => 0, setTimeout, clearTimeout, TypeError,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const click = nodes.get("#synthetic-send").click;
  const first = click();
  const second = click();
  assert.equal(nodes.get("#synthetic-send").disabled, true);
  assert.equal(requests, 1);
  release();
  await Promise.all([first, second]);
  assert.match(nodes.get("#synthetic-state").textContent, /неизвестен/i);
  await click();
  assert.equal(requests, 2);
  assert.deepEqual(transferIds, [transferIds[0], transferIds[0]]);
});
