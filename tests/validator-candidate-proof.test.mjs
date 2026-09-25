import assert from "node:assert/strict";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createValidatorAdmissionRecord } from "../blockchain/validator-admission.mjs";
import {
  assembleValidatorCandidateProof, createValidatorCandidateProof,
  verifyValidatorCandidateProof,
} from "../blockchain/validator-candidate-proof.mjs";

const validators = Array.from({ length: 4 }, generateWallet);
const members = validators.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `validator-${index}` }));
const candidate = generateWallet(); const transport = generateWallet();
const admission = createValidatorAdmissionRecord({ admissionId: "a".repeat(64),
  endpoint: "https://candidate.example", legacy: false,
  member: { ...publicWallet(candidate), operatorId: "candidate-one" },
  networkId: "nir-candidate-proof-test", submittedHeight: 10,
  tlsCertificateSha256: "b".repeat(64), transport: publicWallet(transport) });

function proof(wallet, value = admission) {
  return createValidatorCandidateProof({ accountStateRoot: "c".repeat(64),
    address: candidate.address, admission: value, height: 20,
    networkId: "nir-candidate-proof-test", protocolVersion: 31,
    queuePosition: value ? 0 : null, queueSize: value ? 1 : 0,
    stateRoot: "d".repeat(64), tipHash: "e".repeat(64), validators: members, wallet });
}

test("candidate queue state needs an exact active-validator quorum", () => {
  const assembled = assembleValidatorCandidateProof(validators.slice(0, 3).map((wallet) => proof(wallet)), {
    expectedAddress: candidate.address, expectedNetworkId: "nir-candidate-proof-test",
    minimumHeight: 20, trustedValidators: members,
  });
  assert.equal(verifyValidatorCandidateProof(assembled, { expectedAddress: candidate.address,
    expectedNetworkId: "nir-candidate-proof-test", minimumHeight: 20,
    trustedValidators: members }).queuePosition, 0);
  assert.throws(() => assembleValidatorCandidateProof(validators.slice(0, 2).map((wallet) => proof(wallet)), {
    expectedAddress: candidate.address, expectedNetworkId: "nir-candidate-proof-test",
    minimumHeight: 20, trustedValidators: members,
  }), /quorum/);
});

test("candidate proof rejects signer equivocation and malformed admission bindings", () => {
  const first = proof(validators[0]);
  const absent = proof(validators[0], null);
  assert.throws(() => assembleValidatorCandidateProof([first, absent,
    proof(validators[1]), proof(validators[2])], {
    expectedAddress: candidate.address, expectedNetworkId: "nir-candidate-proof-test",
    minimumHeight: 20, trustedValidators: members,
  }), /equivocation/);
  assert.throws(() => createValidatorCandidateProof({ accountStateRoot: "c".repeat(64),
    address: candidate.address, admission: { ...admission, eligibleHeight: 11 }, height: 20,
    networkId: "nir-candidate-proof-test", protocolVersion: 31, queuePosition: 0, queueSize: 1,
    stateRoot: "d".repeat(64), tipHash: "e".repeat(64), validators: members,
    wallet: validators[0] }), /invalid/);
});

test("candidate proof mirrors v31 readiness height and binding invariants", () => {
  const ready = createValidatorAdmissionRecord({ admissionId: "f".repeat(64),
    endpoint: "https://candidate.example", legacy: false,
    member: { ...publicWallet(candidate), operatorId: "candidate-one" },
    networkId: "nir-candidate-proof-test", observedHeight: 18, readiness: true,
    readinessCertificateHash: "1".repeat(64), readinessExpiresHeight: 20,
    readinessValidatorSetId: "2".repeat(64), submittedHeight: 10,
    tlsCertificateSha256: "b".repeat(64), transport: publicWallet(transport) });
  assert.equal(proof(validators[0], ready).admission.readiness, true);
  for (const malformed of [
    { ...ready, observedHeight: 21 },
    { ...ready, readinessExpiresHeight: ready.observedHeight },
    { ...ready, readinessExpiresHeight: ready.observedHeight + 17 },
    { ...ready, transport: publicWallet(candidate) },
    { ...ready, readiness: false, observedHeight: null, readinessCertificateHash: null,
      readinessExpiresHeight: null, readinessValidatorSetId: null, endpoint: null },
  ]) assert.throws(() => proof(validators[0], malformed), /invalid|inconsistent|fields|membership/);
});
