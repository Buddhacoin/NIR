import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  OperatorBondBook, ProgressAdmissionBook, combineRandomnessReveals,
  createAttestedRegistry, createOperatorCredential, randomnessCommitment,
  proveOperatorEquivocation, selectOperatorCommittee, signOperatorStatement,
} from "../blockchain/operators.mjs";

const fingerprint = (label) => createHash("sha256").update(label).digest("hex");

function fixture() {
  const networkId = "nir-operator-test";
  const authorityWallets = [generateWallet(), generateWallet()];
  const authorities = new Map(authorityWallets.map((wallet) => [wallet.address, wallet.publicKey]));
  const wallets = Array.from({ length: 6 }, generateWallet);
  const members = wallets.map((wallet, index) => {
    const operator = { ...publicWallet(wallet), bond: "100000000000", operatorId: `evaluator-${index}` };
    return { ...operator, credentials: authorityWallets.map((authorityWallet) => createOperatorCredential({
      authorityWallet, networkId, operator, role: "evaluator", validFromEpoch: 0, validUntilEpoch: 10_000,
    })) };
  });
  const registry = createAttestedRegistry({
    authorities, epoch: 10, members, minimumBond: "100000000000", networkId, role: "evaluator",
  });
  return { authorities, members, networkId, registry, wallets };
}

test("operators need two valid independent external attestations", () => {
  const setup = fixture();
  const members = structuredClone(setup.members);
  members[0].credentials = [members[0].credentials[0]];
  assert.throws(() => createAttestedRegistry({
    authorities: setup.authorities, epoch: 10, members, minimumBond: "100000000000",
    networkId: setup.networkId, role: "evaluator",
  }), /independent external attestations/);
});

test("tampered operator credentials are rejected", () => {
  const setup = fixture();
  const members = structuredClone(setup.members);
  members[0].credentials[0].operatorId = "attacker";
  members[0].credentials[1].operatorId = "attacker";
  assert.throws(() => createAttestedRegistry({
    authorities: setup.authorities, epoch: 10, members, minimumBond: "100000000000",
    networkId: setup.networkId, role: "evaluator",
  }), /independent external attestations/);
});

test("committee selection is deterministic, unique, and context-bound", () => {
  const { registry } = fixture();
  const args = { context: { artifact: fingerprint("model-a"), epoch: 12 }, randomness: fingerprint("future"), registry, size: 3 };
  const first = selectOperatorCommittee(args);
  assert.deepEqual(first, selectOperatorCommittee(args));
  assert.equal(new Set(first.map(({ address }) => address)).size, 3);
  assert.notDeepEqual(first, selectOperatorCommittee({ ...args, context: { artifact: fingerprint("model-b"), epoch: 12 } }));
});

test("distributed randomness requires a quorum of matching committed reveals", () => {
  const networkId = "nir-randomness-test";
  const candidateId = fingerprint("candidate-randomness");
  const addresses = Array.from({ length: 3 }, () => generateWallet().address).sort();
  const secrets = addresses.map((_, index) => fingerprint(`secret-${index}`));
  const commitments = new Map(addresses.map((address, index) => [address,
    randomnessCommitment({ networkId, candidateId, secret: secrets[index] })]));
  const reveals = new Map(addresses.map((address, index) => [address, secrets[index]]));
  const seed = combineRandomnessReveals({ networkId, candidateId, commitments, reveals, quorum: 3 });
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.throws(() => combineRandomnessReveals({
    networkId, candidateId, commitments,
    reveals: new Map([...reveals].slice(0, 2)), quorum: 3,
  }), /quorum not reached/);
  const forged = new Map(reveals);
  forged.set(addresses[0], fingerprint("forged-secret"));
  assert.throws(() => combineRandomnessReveals({
    networkId, candidateId, commitments, reveals: forged, quorum: 3,
  }), /does not match commitment/);
});

test("a candidate is fixed before future randomness assigns its evaluators", () => {
  const { networkId, registry } = fixture();
  const recipient = generateWallet();
  const admission = new ProgressAdmissionBook({ networkId, registry, committeeSize: 3 });
  const commitmentHash = admission.commit({
    artifactHash: `sha256:${fingerprint("candidate")}`,
    baselineHash: `sha256:${fingerprint("baseline")}`,
    committedEpoch: 20,
    recipient: recipient.address,
    suiteCommitment: fingerprint("suite"),
  });
  assert.throws(() => admission.assign({
    commitmentHash, randomness: fingerprint("same-epoch"), randomnessEpoch: 20,
  }), /future committee randomness/);
  const committee = admission.assign({
    commitmentHash, randomness: fingerprint("future-epoch"), randomnessEpoch: 21,
  });
  assert.equal(admission.verifyAssignedEvaluators({
    commitmentHash, evaluatorAddresses: committee.map(({ address }) => address),
  }), true);
  assert.equal(admission.verifyAssignedEvaluators({
    commitmentHash, evaluatorAddresses: committee.slice(0, 2).map(({ address }) => address),
  }), false);
  assert.throws(() => admission.assign({
    commitmentHash, randomness: fingerprint("later"), randomnessEpoch: 22,
  }), /already assigned/);
});

test("two incompatible signed statements slash the operator bond once", () => {
  const { networkId, registry, wallets } = fixture();
  const common = { epoch: 12, networkId, role: "evaluator", slot: "artifact-42", wallet: wallets[0] };
  const first = signOperatorStatement({ ...common, statementHash: fingerprint("pass") });
  const second = signOperatorStatement({ ...common, statementHash: fingerprint("fail") });
  const proof = proveOperatorEquivocation({ first, second, registry });
  const bonds = new OperatorBondBook(registry);
  assert.equal(bonds.slash({ first, second }), 100000000000n);
  assert.equal(bonds.balance(wallets[0].address), 0n);
  assert.equal(proof.penalty, 100000000000n);
  assert.throws(() => bonds.slash({ first, second }), /already used/);
});

test("a forged conflict cannot slash an honest operator", () => {
  const { networkId, registry, wallets } = fixture();
  const first = signOperatorStatement({ epoch: 12, networkId, role: "evaluator", slot: "artifact-42", statementHash: fingerprint("pass"), wallet: wallets[0] });
  const forged = signOperatorStatement({ epoch: 12, networkId, role: "evaluator", slot: "artifact-42", statementHash: fingerprint("fail"), wallet: wallets[1] });
  forged.operator = wallets[0].address;
  assert.throws(() => proveOperatorEquivocation({ first, second: forged, registry }), /signatures are invalid/);
});
