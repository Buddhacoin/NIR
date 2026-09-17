import assert from "node:assert/strict";
import test from "node:test";

import { OFFLINE_PACKAGE_FORMAT, OFFLINE_SIGNED_FORMAT, decodeOfflineQrFrames, encodeOfflineQrFrames, validateOfflineSignedEnvelope, validateOfflineSigningPackage } from "../wallet-ui/offline-signing.js";

const networkId = "nir-offline-ui-test";
const address = `nir1${"a".repeat(64)}`;
const recipient = `nir1${"b".repeat(64)}`;
const intent = { type: "transfer", networkId, nonce: 4, requestId: "c".repeat(64), amount: "100", fee: "1", recipient };
const simulation = {
  result: {
    type: "transfer", networkId, stateHeight: 8, intent, proof: { verified: true, tipHash: "d".repeat(64), stateRoot: "e".repeat(64) },
    authority: [{ address, role: "sender", required: true }], fee: { atomic: "1", payer: address },
    deltas: { balance: [], resources: [], nonce: [] }, risks: [], simulationId: "f".repeat(64),
  },
  stateEvidence: { networkId, height: 8, tipHash: "d".repeat(64), stateRoot: "e".repeat(64), verified: true },
};

function packet(overrides = {}) {
  return { format: OFFLINE_PACKAGE_FORMAT, version: 1, createdAt: 1_000_000, expiresAt: 1_120_000, networkId, intent,
    simulation, simulationCommitment: "f".repeat(64), checkpoint: { networkId, height: 8, tipHash: "d".repeat(64), stateRoot: "e".repeat(64), validatorSetId: "1".repeat(64) }, ...overrides };
}

test("offline signing package binds the exact reviewed intent to a finalized checkpoint", () => {
  const value = packet();
  assert.equal(value.checkpoint.height, 8);
  assert.equal(value.simulationCommitment.length, 64);
  assert.deepEqual(validateOfflineSigningPackage(value, { now: 1_001_000 }), value);
  assert.throws(() => validateOfflineSigningPackage({ ...value, intent: { ...intent, amount: "101" } }, { now: 1_001_000 }), /симуляция/);
  assert.throws(() => validateOfflineSigningPackage({ ...value, expiresAt: 1_001_000 }, { now: 1_001_000 }), /срок/);
});

test("signed import fails closed on unknown fields, mismatched intent, or a changed reviewed package", () => {
  const value = packet();
  const envelope = { format: OFFLINE_SIGNED_FORMAT, version: 1, package: value, transaction: { ...intent, sender: address }, signingPackageHash: "2".repeat(64), checkpoint: value.checkpoint, createdAt: 1_002_000, networkId };
  const checked = validateOfflineSignedEnvelope(envelope, { now: 1_001_000, expected: value });
  assert.equal(checked.transaction.recipient, recipient);
  assert.throws(() => validateOfflineSignedEnvelope({ ...envelope, extra: true }, { now: 1_001_000 }), /неизвестное/);
  assert.throws(() => validateOfflineSignedEnvelope({ ...envelope, transaction: { ...envelope.transaction, amount: "999" } }, { now: 1_001_000 }), /amount/);
  assert.throws(() => validateOfflineSignedEnvelope(envelope, { now: 1_001_000, expected: { ...value, networkId: "other" } }), /показанной/);
});

test("fragmented offline QR text requires every unique frame and preserves its content", () => {
  const encoded = JSON.stringify({ hello: "offline", text: "x".repeat(1_300) });
  const frames = encodeOfflineQrFrames(encoded, 200);
  assert.equal(decodeOfflineQrFrames([...frames].reverse().join("\n")), encoded);
  assert.throws(() => decodeOfflineQrFrames(frames.slice(1).join("\n")), /неполны/);
  assert.throws(() => decodeOfflineQrFrames(`${frames[0]}\n${frames[0]}`), /повторяются/);
});
