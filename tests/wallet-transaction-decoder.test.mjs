import assert from "node:assert/strict";
import test from "node:test";
import { decodeVerifiedSimulation } from "../wallet-ui/transaction-decoder.js";

const intent = { type: "transfer", amount: "125000000", fee: "100", recipient: `nir1${"a".repeat(64)}`,
  networkId: "nir-local", nonce: 7, requestId: "f".repeat(64) };

function response(overrides = {}) {
  return { verified: true, simulation: {
    type: "transfer", intent: { ...intent, sender: `nir1${"b".repeat(64)}` }, networkId: intent.networkId,
    proof: { verified: true, stateRoot: "c".repeat(64), tipHash: "d".repeat(64) }, stateHeight: 42,
    authority: [{ address: `nir1${"b".repeat(64)}`, role: "sender", required: true }],
    deltas: { balance: [{ address: `nir1${"b".repeat(64)}`, atomicDelta: "-125000100", role: "sender" }],
      fee: { atomic: "100", payer: `nir1${"b".repeat(64)}`, recipient: "next" }, resources: [],
      nonce: [{ address: `nir1${"b".repeat(64)}`, before: 7, after: 8, role: "sender" }] },
    risks: ["manual broadcast"], simulationId: "e".repeat(64), ...overrides,
  } };
}

test("decoder accepts only proof-backed exact simulation", () => {
  const decoded = decodeVerifiedSimulation(response(), intent);
  assert.equal(decoded.fee.amount, "100");
  assert.equal(decoded.balance[0].delta, "-125000100");
});

test("decoder preserves bounded delegated-resource changes for human review", () => {
  const decoded = decodeVerifiedSimulation(response({ deltas: {
    ...response().simulation.deltas,
    resources: [{ role: "delegation", owner: `nir1${"b".repeat(64)}`, before: { limit: 2, spent: 1 }, after: { limit: 4, spent: 1 } }],
  } }), intent);
  assert.match(decoded.resources[0].details, /"limit":4/);
});

test("decoder fails closed for unknown type, proof, intent, nonce and malformed delta", () => {
  for (const candidate of [
    response({ type: "future-unsafe-type" }), { ...response(), verified: false },
    response({ intent: { ...intent, amount: "1" } }),
    response({ proof: { verified: false } }),
    response({ deltas: { ...response().simulation.deltas, nonce: [{ address: `nir1${"b".repeat(64)}`, before: 7, after: 9, role: "sender" }] } }),
    response({ deltas: { ...response().simulation.deltas, balance: [{ address: `nir1${"b".repeat(64)}`, atomicDelta: "not-a-number", role: "sender" }] } }),
  ]) assert.throws(() => decodeVerifiedSimulation(candidate, intent), /Симуляция отклонена/);
});

test("decoder preserves bounded asset deltas and rejects unknown asset fields", () => {
  const assetIntent = { type: "asset-burn", assetId: "1".repeat(64), amount: "5", fee: "100",
    networkId: intent.networkId, nonce: 7 };
  const assetResponse = response({ type: assetIntent.type,
    intent: { ...assetIntent, sender: `nir1${"b".repeat(64)}` }, deltas: {
      ...response().simulation.deltas,
      asset: [{ assetId: assetIntent.assetId, holder: `nir1${"b".repeat(64)}`,
        balanceBefore: "9", balanceAfter: "4", supplyBefore: "20", supplyAfter: "15" }],
    } });
  const decoded = decodeVerifiedSimulation(assetResponse, assetIntent);
  assert.equal(decoded.assets[0].balanceAfter, "4");
  const unknown = structuredClone(assetResponse);
  unknown.simulation.deltas.asset[0].browserAuthority = true;
  assert.throws(() => decodeVerifiedSimulation(unknown, assetIntent), /Симуляция отклонена/);
});
