import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admissionReceiptEquivocation,
  assertAdmissionReceiptGenerationWindow,
  assertAdmissionInclusionObligations,
  createAdmissionInclusionReceipt,
  verifyAdmissionInclusionCertificate,
} from "../blockchain/admission-inclusion.mjs";
import {
  NirChain, blockHeader, createBeaconBond, createTransfer, finalizeBlock,
  prepareCertificateHash, transactionId,
} from "../blockchain/chain.mjs";
import {
  MIN_BEACON_BOND, MIN_TRANSFER_FEE, SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  initializeDistributedDevnet, ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import {
  createValidatorAdmissionOmissionEvidence,
  verifyValidatorAdmissionOmissionEvidence,
} from "../blockchain/validator-admission-omission.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const candidate = generateWallet();
  const networkId = "nir-admission-inclusion-test";
  const transaction = createBeaconBond({
    activationHeight: 65,
    amount: MIN_BEACON_BOND.toString(),
    networkId,
    nonce: 0,
    operatorId: "candidate-beacon",
    wallet: candidate,
  });
  return { candidate, networkId, transaction, validators,
    validatorMembers: members(validators, "validator") };
}

test("quorum receipts bind one exact admission and one-block inclusion window", () => {
  const values = fixture();
  const receipts = values.validators.slice(0, 3).map((validatorWallet) =>
    createAdmissionInclusionReceipt({
      acceptedHeight: 0, networkId: values.networkId, transaction: values.transaction,
      validatorWallet, validators: values.validatorMembers,
    }));
  const certificate = verifyAdmissionInclusionCertificate(receipts, {
    acceptedHeight: 0, networkId: values.networkId, transaction: values.transaction,
    validators: values.validatorMembers,
  });
  assert.equal(certificate.length, 3);
  const obligations = new Map([[transactionId(values.transaction), certificate[0]]]);
  assert.equal(assertAdmissionInclusionObligations({
    height: 1, transactions: [values.transaction],
  }, obligations), true);
  assert.throws(() => assertAdmissionInclusionObligations({
    height: 1, transactions: [],
  }, obligations), /omits a quorum-receipted beacon admission/);
  assert.throws(() => assertAdmissionInclusionObligations({
    height: 2, transactions: [],
  }, obligations), /expired unsatisfied/);
  assert.throws(() => verifyAdmissionInclusionCertificate(receipts.slice(0, 2), {
    acceptedHeight: 0, networkId: values.networkId, transaction: values.transaction,
    validators: values.validatorMembers,
  }), /quorum is not reached/);
  assert.throws(() => verifyAdmissionInclusionCertificate(receipts, {
    acceptedHeight: 0, currentHeight: 10, networkId: values.networkId,
    transaction: values.transaction, validators: values.validatorMembers,
  }), /receipt is invalid/);
  assert.throws(() => verifyAdmissionInclusionCertificate([receipts[0], receipts[0], receipts[1]], {
    acceptedHeight: 0, networkId: values.networkId, transaction: values.transaction,
    validators: values.validatorMembers,
  }), /duplicate/);
});

test("receipt and evidence windows cannot cross a validator generation boundary", () => {
  assert.equal(assertAdmissionReceiptGenerationWindow({ acceptedHeight: 10,
    pendingValidatorRotation: { activationHeight: 13 } }), true);
  for (const activationHeight of [11, 12]) {
    assert.throws(() => assertAdmissionReceiptGenerationWindow({
      acceptedHeight: 10, pendingValidatorRotation: { activationHeight },
    }), /cannot cross a validator rotation boundary/);
  }
});

test("conflicting receipts are objective evidence and cannot be mixed silently", () => {
  const values = fixture();
  const conflicting = createBeaconBond({
    activationHeight: 65, amount: MIN_BEACON_BOND.toString(), networkId: values.networkId,
    nonce: 0, operatorId: "other-wrapper", wallet: values.candidate,
  });
  const first = createAdmissionInclusionReceipt({
    acceptedHeight: 0, networkId: values.networkId, transaction: values.transaction,
    validatorWallet: values.validators[0], validators: values.validatorMembers,
  });
  const second = createAdmissionInclusionReceipt({
    acceptedHeight: 0, networkId: values.networkId, transaction: conflicting,
    validatorWallet: values.validators[0], validators: values.validatorMembers,
  });
  const evidence = admissionReceiptEquivocation(first, second, {
    validators: values.validatorMembers,
  });
  assert.equal(evidence.validator, values.validators[0].address);
  assert.notEqual(evidence.receipts[0].transactionId, evidence.receipts[1].transactionId);
});

test("a quorum receipt and finalized omitting block identify the exact signer intersection", () => {
  const values = fixture();
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const chain = new NirChain({
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      contentHash: `sha256:${"2".repeat(64)}`, behaviorCommitment: "3".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluators: members(evaluators, "evaluator"), genesisTimestamp: 0,
    networkId: values.networkId, safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address, validators: values.validatorMembers,
  });
  const receipts = values.validators.slice(0, 3).map((validatorWallet) =>
    createAdmissionInclusionReceipt({
      acceptedHeight: 0, networkId: values.networkId, transaction: values.transaction,
      validatorWallet, validators: values.validatorMembers,
    }));
  const proposal = chain.buildBlock({ transactions: [], timestamp: 1 });
  const finalized = finalizeBlock(proposal, values.validators.slice(1, 4));
  const evidence = createValidatorAdmissionOmissionEvidence({
    certificate: finalized.certificate, finalizedHeader: blockHeader(finalized),
    prepareCertificateHash: prepareCertificateHash(finalized.prepareCertificate),
    receipts, round: finalized.round, transaction: values.transaction,
    transactionIds: finalized.transactions.map(transactionId),
    validators: values.validatorMembers,
  });
  const verified = verifyValidatorAdmissionOmissionEvidence(evidence, {
    canonicalBlockHash: finalized.hash, canonicalCertificate: finalized.certificate,
    canonicalHeader: blockHeader(finalized),
    canonicalPrepareCertificateHash: prepareCertificateHash(finalized.prepareCertificate),
    canonicalRound: finalized.round,
    canonicalTransactionIds: finalized.transactions.map(transactionId), currentHeight: 2,
    networkId: values.networkId, validators: values.validatorMembers,
  });
  assert.deepEqual(verified.offenders.sort(), values.validators.slice(1, 3)
    .map(({ address }) => address).sort());
  assert.throws(() => verifyValidatorAdmissionOmissionEvidence(evidence, {
    canonicalBlockHash: finalized.hash, canonicalCertificate: finalized.certificate,
    canonicalHeader: blockHeader(finalized),
    canonicalPrepareCertificateHash: prepareCertificateHash(finalized.prepareCertificate),
    canonicalRound: finalized.round,
    canonicalTransactionIds: finalized.transactions.map(transactionId), currentHeight: 2,
    networkId: values.networkId, rotationBoundary: true, validators: values.validatorMembers,
  }), /cannot cross a rotation boundary/);
  assert.throws(() => verifyValidatorAdmissionOmissionEvidence(evidence, {
    canonicalBlockHash: finalized.hash, canonicalCertificate: finalized.certificate,
    canonicalHeader: blockHeader(finalized),
    canonicalPrepareCertificateHash: prepareCertificateHash(finalized.prepareCertificate),
    canonicalRound: finalized.round, canonicalTransactionIds: [], currentHeight: 3,
    networkId: values.networkId, validators: values.validatorMembers,
  }), /stale or not canonical/);
});

test("seeded quorum-intersection model blocks omission without a global mempool", () => {
  let seed = 0x51adbeef;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let scenario = 0; scenario < 1_000; scenario += 1) {
    const count = 4 + (random() % 28);
    const quorum = Math.floor((count * 2) / 3) + 1;
    const faultBound = Math.floor((count - 1) / 3);
    const shuffled = Array.from({ length: count }, (_, index) => index)
      .sort(() => (random() & 1) === 0 ? -1 : 1);
    const receiptSigners = new Set(shuffled.slice(0, quorum));
    const byzantine = new Set(shuffled.slice(count - faultBound));
    const willingToOmit = Array.from({ length: count }, (_, index) => index)
      .filter((index) => byzantine.has(index) || !receiptSigners.has(index));
    assert.equal(willingToOmit.length < quorum, true,
      `scenario ${scenario} admitted an omitting finality quorum`);
  }
});

test("validator receipt obligations survive restart and reject a censoring proposer", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-admission-receipt-test-"));
  const beacons = Array.from({ length: 4 }, generateWallet);
  const layout = initializeDistributedDevnet(join(temporary, "network"), {
    beaconWallets: beacons, networkId: "nir-admission-receipt-runtime-test",
  });
  let replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  try {
    const genesis = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "genesis.json"), "utf8",
    ));
    const treasury = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json"), "utf8",
    ));
    const validatorWallets = layout.validatorDirectories.map((directory) => JSON.parse(
      readFileSync(join(directory, "VALIDATOR-KEY.json"), "utf8"),
    ));
    const chain = new NirChain(genesis);
    const candidate = generateWallet();
    const commit = (proposal) => {
      const block = finalizeBlock(proposal, validatorWallets.slice(0, 3));
      chain.appendBlock(block);
      for (const replica of replicas) replica.commit(block);
      return block;
    };
    commit(chain.buildBlock({ timestamp: TREASURY_VESTING_MS,
      transactions: [...beacons, candidate].map((wallet, nonce) => createTransfer({
        amount: (MIN_BEACON_BOND + MIN_TRANSFER_FEE).toString(), networkId: chain.networkId,
        nonce, recipient: wallet.address, wallet: treasury,
      })) }));
    commit(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 1,
      transactions: beacons.map((wallet) => createBeaconBond({
        amount: MIN_BEACON_BOND.toString(), networkId: chain.networkId, nonce: 0, wallet,
      })) }));
    const admission = createBeaconBond({
      activationHeight: chain.height + 1 + 64, amount: MIN_BEACON_BOND.toString(),
      networkId: chain.networkId, nonce: 0, operatorId: "receipted-beacon", wallet: candidate,
    });
    const receipts = replicas.slice(0, 3).map((replica) =>
      replica.submitTransaction(admission).receipt);
    assert.equal(verifyAdmissionInclusionCertificate(receipts, {
      acceptedHeight: chain.height, networkId: chain.networkId, transaction: admission,
      validators: replicas[0].validatorMembers,
    }).length, 3);

    replicas[0].closeSecurityState();
    replicas[0] = new ValidatorReplica(layout.validatorDirectories[0]);
    const omitted = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 2, transactions: [] });
    for (const replica of replicas.slice(0, 3)) {
      assert.throws(() => replica.vote(omitted), /omits a quorum-receipted beacon admission/);
    }
    assert.equal(replicas[3].vote(omitted).validator, replicas[3].address);

    const included = chain.buildBlock({
      timestamp: TREASURY_VESTING_MS + 2, transactions: [admission],
    });
    const includedBlock = finalizeBlock(included, validatorWallets.slice(0, 3));
    chain.appendBlock(includedBlock);
    for (const replica of replicas.slice(1)) replica.commit(includedBlock);
    assert.throws(() => replicas[0].installStateSnapshotCandidates(
      replicas.slice(1).map((replica) => replica.stateSnapshotCandidate()),
    ), /cannot skip a durable beacon admission inclusion obligation/);
    replicas[0].commit(includedBlock);
    const next = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 3, transactions: [] });
    assert.equal(replicas[0].vote(next).validator, replicas[0].address);
  } finally {
    replicas.forEach((replica) => replica.closeSecurityState());
    rmSync(temporary, { recursive: true, force: true });
  }
});
