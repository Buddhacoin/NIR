import test from "node:test";
import assert from "node:assert/strict";
import { createSyntheticTransferSession } from "../blockchain/synthetic-transfer.mjs";
import { createMiningPracticeApp } from "../blockchain/mining-practice-app.mjs";
import { join } from "node:path";

const address = `nir1${"a".repeat(64)}`;
const other = `nir1${"b".repeat(64)}`;

test("explicitly synthetic training credit can be transferred once to a NIR-shaped address", () => {
  const ledger = createSyntheticTransferSession();
  assert.equal(ledger.snapshot().remaining, "0");
  ledger.startTraining();
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
  ledger.startTraining();
  assert.throws(() => ledger.startTraining(), /already/);
  assert.throws(() => ledger.transfer({ recipient: "nir1bad", amount: "1", id: "x" }), /recipient/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "1", id: "x", networkId: "nir-mainnet-1" }), /network/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "0", id: "x" }), /amount/);
  assert.throws(() => ledger.transfer({ recipient: address, amount: "8", id: "x" }), /balance/);
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
    const started = await post("/synthetic-transfer/start");
    assert.equal(started.status, 200);
    assert.equal((await started.json()).remaining, "7");
    assert.equal((await post("/synthetic-transfer/start")).status, 409);
    const input = { recipient: address, amount: "3", id: "test-1", networkId: "nir-synthetic-local-1" };
    const sent = await post("/synthetic-transfer", JSON.stringify(input));
    assert.equal(sent.status, 200);
    const result = await sent.json();
    assert.equal(result.state.balances[address], "3");
    assert.equal(result.state.transferableNir, "0");
    assert.equal(result.state.walletChanged, false);
    assert.equal(result.state.networkSubmitted, false);
    assert.equal((await post("/synthetic-transfer", JSON.stringify(input))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-2", networkId: "nir-mainnet-1" }))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-3", recipient: "bad" }))).status, 400);
    assert.equal((await post("/synthetic-transfer", JSON.stringify({ ...input, id: "test-4", amount: "5" }))).status, 400);
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
