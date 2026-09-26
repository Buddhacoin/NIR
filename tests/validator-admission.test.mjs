import assert from "node:assert/strict";
import test from "node:test";

import { MIN_TRANSFER_FEE } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  VALIDATOR_ADMISSION_DELAY_BLOCKS,
  VALIDATOR_ADMISSION_EXPIRY_BLOCKS,
  MAX_RETIRED_VALIDATOR_TOMBSTONES,
  VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS,
  assertValidatorIdentityCapacity,
  compareValidatorAdmissions,
  createValidatorAdmission,
  createValidatorAdmissionRecord,
  createValidatorAdmissionReadiness,
  verifyValidatorAdmission,
  verifyValidatorAdmissionReadiness,
} from "../blockchain/validator-admission.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";

const networkId = "nir-validator-admission-v31-test";
const tlsCertificateSha256 = "a".repeat(64);

test("validator admission binds exact bond, endpoint, TLS pin and separate transport possession", () => {
  const wallet = generateWallet();
  const transportWallet = generateWallet();
  const transaction = createValidatorAdmission({
    endpoint: "https://validator.example", networkId, nonce: 0, operatorId: "operator-a",
    tlsCertificateSha256, transportWallet, wallet,
  });
  const verified = verifyValidatorAdmission(transaction, networkId);
  assert.equal(verified.payload.amount, MIN_VALIDATOR_BOND.toString());
  assert.equal(verified.payload.endpoint, "https://validator.example");
  assert.notEqual(verified.transport.address, wallet.address);

  assert.throws(() => verifyValidatorAdmission({ ...transaction,
    endpoint: "https://validator.example/other" }, networkId), /origin|non-canonical/);
  assert.throws(() => verifyValidatorAdmission({ ...transaction,
    amount: (MIN_VALIDATOR_BOND + 1n).toString() }, networkId), /context|signature/);
  assert.throws(() => verifyValidatorAdmission({ ...transaction,
    signature: `${transaction.signature}=` }, networkId), /non-canonical/);
});

test("v32 admission binds both signatures to genesis and a bounded finalized-height window", () => {
  const wallet = generateWallet(); const transportWallet = generateWallet();
  const chainIdentityGenesisHash = "d".repeat(64); const referenceHeight = 100;
  const transaction = createValidatorAdmission({ chainIdentityGenesisHash,
    endpoint: "https://validator.example", networkId, nonce: 0, operatorId: "operator-v32",
    referenceHeight, tlsCertificateSha256, transportWallet, wallet });
  assert.equal(transaction.validUntilHeight,
    referenceHeight + VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS);
  assert.equal(verifyValidatorAdmission(transaction, networkId, { chainIdentityGenesisHash,
    currentHeight: 101, protocolVersion: 32 }).payload.referenceHeight, referenceHeight);
  assert.equal(verifyValidatorAdmission(transaction, networkId, { chainIdentityGenesisHash,
    currentHeight: transaction.validUntilHeight, protocolVersion: 32 }).payload.validUntilHeight,
  transaction.validUntilHeight);
  assert.throws(() => verifyValidatorAdmission(transaction, networkId, {
    chainIdentityGenesisHash: "e".repeat(64), currentHeight: 101, protocolVersion: 32,
  }), /context/);
  assert.throws(() => verifyValidatorAdmission(transaction, networkId, {
    chainIdentityGenesisHash, currentHeight: referenceHeight, protocolVersion: 32,
  }), /context/);
  assert.throws(() => verifyValidatorAdmission(transaction, networkId, {
    chainIdentityGenesisHash, currentHeight: transaction.validUntilHeight + 1,
    protocolVersion: 32 }), /context/);
  assert.throws(() => verifyValidatorAdmission(transaction, networkId, {
    chainIdentityGenesisHash, currentHeight: 101, protocolVersion: 31,
  }), /non-canonical/);
  assert.throws(() => verifyValidatorAdmission({ ...transaction,
    validUntilHeight: transaction.validUntilHeight - 1 }, networkId, {
    chainIdentityGenesisHash, currentHeight: 101, protocolVersion: 32,
  }), /context|signature/);
});

test("readiness envelope is canonical and carries quorum-certificate context", () => {
  const wallet = generateWallet();
  const transportWallet = generateWallet();
  const transaction = createValidatorAdmissionReadiness({
    admissionId: "b".repeat(64), endpoint: "https://validator.example",
    expiresAtHeight: 110, fee: MIN_TRANSFER_FEE.toString(), networkId, nonce: 1,
    observedHeight: 100, readinessAttestations: [], tlsCertificateSha256,
    transportWallet, validatorSetId: "c".repeat(64), wallet,
  });
  const verified = verifyValidatorAdmissionReadiness(transaction, networkId);
  assert.equal(verified.payload.observedHeight, 100);
  assert.equal(verified.payload.expiresAtHeight, 110);
  assert.throws(() => verifyValidatorAdmissionReadiness({ ...transaction,
    endpoint: "https://VALIDATOR.example" }, networkId), /non-canonical/);
});

test("queue is FIFO across heights and uses a deterministic tie-break only within one height", () => {
  const records = [1, 2, 3].map((index) => {
    const wallet = generateWallet();
    return createValidatorAdmissionRecord({
      admissionId: String(index).repeat(64), member: { address: wallet.address,
        algorithm: "ML-DSA-65", operatorId: `operator-${index}`, publicKey: wallet.publicKey },
      networkId, submittedHeight: index === 3 ? 11 : 10,
    });
  });
  const sorted = [...records].sort(compareValidatorAdmissions);
  assert.equal(sorted.at(-1).submittedHeight, 11);
  assert.equal(sorted[0].submittedHeight, 10);
  assert.equal(sorted[0].eligibleHeight, 10 + VALIDATOR_ADMISSION_DELAY_BLOCKS);
  assert.equal(sorted[0].expiryHeight,
    10 + VALIDATOR_ADMISSION_DELAY_BLOCKS + VALIDATOR_ADMISSION_EXPIRY_BLOCKS);
});

test("v31 identity capacity rejects an oversized legacy migration before mutation", () => {
  assert.doesNotThrow(() => assertValidatorIdentityCapacity(
    4, MAX_RETIRED_VALIDATOR_TOMBSTONES - 4,
  ));
  assert.throws(() => assertValidatorIdentityCapacity(
    4, MAX_RETIRED_VALIDATOR_TOMBSTONES - 3,
  ), /tombstone capacity/);
  assert.throws(() => assertValidatorIdentityCapacity(0,
    MAX_RETIRED_VALIDATOR_TOMBSTONES + 1), /tombstone capacity/);
});
