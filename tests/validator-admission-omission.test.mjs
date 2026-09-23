import assert from "node:assert/strict";
import test from "node:test";

import {
  NirChain,
  blockHeader,
  blockHeaderHash,
  computeChainStateRoot,
  createBeaconBond,
  createTransfer,
  createValidatorBond,
  finalizeBlock,
  prepareCertificateHash,
  transactionId,
} from "../blockchain/chain.mjs";
import {
  MIN_BEACON_BOND,
  MIN_TRANSFER_FEE,
  MAX_BLOCK_BYTES,
  MAX_TRANSACTIONS_PER_BLOCK,
  MAX_VALIDATORS,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { canonicalJson, generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import { createAdmissionInclusionReceipt } from "../blockchain/admission-inclusion.mjs";
import {
  ADMISSION_OMISSION_REPORTER_REWARD_BPS,
  MAX_ADMISSION_OMISSION_EVIDENCE_BYTES,
  createValidatorAdmissionOmissionEvidence,
  createValidatorAdmissionOmissionTransaction,
} from "../blockchain/validator-admission-omission.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const genesisConfig = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
      contentHash: `sha256:${"3".repeat(64)}`,
    }],
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    networkId: "nir-validator-admission-omission-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members(validators, "validator"),
  };
  return { chain: new NirChain(genesisConfig), genesisConfig, treasury, validators };
}

function quorumFor(block, wallets, preferred = wallets) {
  const proposer = wallets.find(({ address }) => address === block.proposer);
  const ordered = [proposer, ...preferred, ...wallets].filter(Boolean);
  return [...new Map(ordered.map((wallet) => [wallet.address, wallet])).values()].slice(0, 3);
}

function append(chain, proposal, wallets, preferred) {
  const block = finalizeBlock(proposal, quorumFor(proposal, wallets, preferred));
  chain.appendBlock(block);
  return block;
}

function restoreAtHead(chain, genesisConfig) {
  const snapshot = chain.consensusSnapshot();
  return NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1),
    height: chain.height,
    networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment,
    state: snapshot.state,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
  });
}

function prepareSlashableOmission() {
  const values = fixture();
  const { chain, treasury, validators } = values;
  append(chain, chain.buildBlock({
    timestamp: TREASURY_VESTING_MS,
    transactions: validators.map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE * 2n).toString(),
      networkId: chain.networkId, nonce, recipient: wallet.address, wallet: treasury,
    })),
  }), validators);
  append(chain, chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 1,
    transactions: validators.map((wallet) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0, wallet,
    })),
  }), validators);
  const candidate = generateWallet();
  const admission = createBeaconBond({
    activationHeight: chain.height + 1 + 64,
    amount: MIN_BEACON_BOND.toString(),
    networkId: chain.networkId,
    nonce: 0,
    operatorId: "omitted-candidate",
    wallet: candidate,
  });
  const validatorMembers = members(validators, "validator");
  const receipts = validators.slice(0, 3).map((validatorWallet) =>
    createAdmissionInclusionReceipt({
      acceptedHeight: chain.height,
      networkId: chain.networkId,
      transaction: admission,
      validatorWallet,
      validators: validatorMembers,
    }));
  const proposal = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 2, transactions: [] });
  const omittingBlock = finalizeBlock(proposal, validators.slice(1, 4));
  chain.appendBlock(omittingBlock);
  const evidence = createValidatorAdmissionOmissionEvidence({
    certificate: omittingBlock.certificate,
    finalizedHeader: blockHeader(omittingBlock),
    prepareCertificateHash: prepareCertificateHash(omittingBlock.prepareCertificate),
    receipts,
    round: omittingBlock.round,
    transaction: admission,
    transactionIds: omittingBlock.transactions.map(transactionId),
    validators: validatorMembers,
  });
  return { ...values, admission, evidence, omittingBlock };
}

function evidenceTransaction(values, evidence = values.evidence, nonce) {
  return createValidatorAdmissionOmissionTransaction({
    evidence,
    networkId: values.chain.networkId,
    nonce: nonce ?? values.chain.nextNonce(values.treasury.address),
    wallet: values.treasury,
  });
}

function rejectAtomically(chain, transaction, validators, pattern) {
  const root = chain.stateRoot;
  const nonce = chain.nextNonce(transaction.sender);
  const proposal = chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
    transactions: [transaction],
  });
  assert.throws(() => chain.appendBlock(finalizeBlock(
    proposal, quorumFor(proposal, validators),
  )), pattern);
  assert.equal(chain.stateRoot, root);
  assert.equal(chain.nextNonce(transaction.sender), nonce);
}

test("finalized omission slashes only receipt/commit intersection and conserves supply", () => {
  const values = prepareSlashableOmission();
  const { chain, genesisConfig, treasury, validators, evidence } = values;
  const before = chain.fork();
  const reporterBalance = chain.balance(treasury.address);
  const transaction = evidenceTransaction(values);
  const proposal = chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 3, transactions: [transaction],
  });
  const block = finalizeBlock(proposal, quorumFor(proposal, validators));
  chain.appendBlock(block);

  const offenders = validators.slice(1, 3);
  const untouched = [validators[0], validators[3]];
  for (const wallet of offenders) {
    assert.equal(chain.validatorBond(wallet.address), 0n);
    assert.equal(chain.validatorDisabled(wallet.address), true);
  }
  for (const wallet of untouched) {
    assert.equal(chain.validatorBond(wallet.address), MIN_VALIDATOR_BOND);
    assert.equal(chain.validatorDisabled(wallet.address), false);
  }
  const slashed = MIN_VALIDATOR_BOND * 2n;
  const reward = slashed * BigInt(ADMISSION_OMISSION_REPORTER_REWARD_BPS) / 10_000n;
  assert.equal(chain.burned - before.burned, slashed - reward);
  assert.equal(chain.balance(treasury.address), reporterBalance - MIN_TRANSFER_FEE + reward);
  assert.equal(chain.validatorAdmissionOmissionEvidenceUsed(evidence.evidenceHash), true);

  const fork = before.fork();
  fork.appendBlock(block);
  const restored = restoreAtHead(chain, genesisConfig);
  assert.equal(fork.stateRoot, chain.stateRoot);
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.equal(restored.validatorAdmissionOmissionEvidenceUsed(evidence.evidenceHash), true);

  const replay = evidenceTransaction({ ...values, chain });
  rejectAtomically(chain, replay, validators, /already used/);
});

test("late, forged, mixed-generation, and same-block duplicate evidence fail atomically", () => {
  const base = prepareSlashableOmission();
  const selfReport = createValidatorAdmissionOmissionTransaction({
    evidence: base.evidence, networkId: base.chain.networkId, nonce: 1,
    wallet: base.validators[1],
  });
  rejectAtomically(base.chain.fork(), selfReport, base.validators, /cannot report its own/);
  const rotationMix = base.chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 3,
    transactions: [evidenceTransaction(base)],
    validatorRotation: {
      activationHeight: base.chain.height + 5,
      validators: members(base.validators, "validator"),
    },
  });
  assert.throws(() => base.chain.fork().appendBlock(finalizeBlock(
    rotationMix, quorumFor(rotationMix, base.validators),
  )), /rotation require separate blocks/);
  const late = base.chain.fork();
  append(late, late.buildBlock({ timestamp: TREASURY_VESTING_MS + 3 }), base.validators);
  rejectAtomically(late, evidenceTransaction({ ...base, chain: late }), base.validators,
    /stale or not canonical/);

  for (const mutate of [
    (evidence) => { evidence.commitVotes[0].signature = `${evidence.commitVotes[0].signature}A`; },
    (evidence) => { evidence.validatorSetId = "f".repeat(64); },
  ]) {
    const chain = base.chain.fork();
    const evidence = structuredClone(base.evidence);
    mutate(evidence);
    const { evidenceHash: _old, ...payload } = evidence;
    evidence.evidenceHash = hashObject(payload, "VALIDATOR_ADMISSION_OMISSION_V1");
    rejectAtomically(chain, evidenceTransaction({ ...base, chain }, evidence), base.validators,
      /invalid|stale or not canonical|exact signer intersection/);
  }

  const duplicate = base.chain.fork();
  const nonce = duplicate.nextNonce(base.treasury.address);
  const transactions = [
    evidenceTransaction({ ...base, chain: duplicate }, base.evidence, nonce),
    evidenceTransaction({ ...base, chain: duplicate }, base.evidence, nonce + 1),
  ];
  const root = duplicate.stateRoot;
  const proposal = duplicate.buildBlock({
    timestamp: TREASURY_VESTING_MS + 3, transactions,
  });
  assert.throws(() => duplicate.appendBlock(finalizeBlock(
    proposal, quorumFor(proposal, base.validators),
  )), /already used/);
  assert.equal(duplicate.stateRoot, root);
  assert.equal(duplicate.nextNonce(base.treasury.address), nonce);
});

test("bounded replay state rejects an oversized snapshot", () => {
  const { chain, genesisConfig } = prepareSlashableOmission();
  const snapshot = chain.consensusSnapshot();
  snapshot.state.validatorAdmissionOmissionEvidence = Array.from(
    { length: 257 }, (_, index) => index.toString(16).padStart(64, "0"),
  );
  snapshot.stateRoot = computeChainStateRoot(snapshot.state);
  const checkpoint = structuredClone(chain.blocks().at(-1));
  checkpoint.stateRoot = snapshot.stateRoot;
  checkpoint.hash = blockHeaderHash(blockHeader(checkpoint));
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: snapshot.capabilityMemory,
    checkpoint,
    height: chain.height,
    networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment,
    state: snapshot.state,
    stateRoot: snapshot.stateRoot,
    tipHash: checkpoint.hash,
  }), /validator equivocation snapshot state is invalid/);
});

test("seeded omission-slashing model preserves exact attribution and conservation", () => {
  let seed = 0x0a11ce55;
  const random = () => (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0);
  for (let scenario = 0; scenario < 2_000; scenario += 1) {
    const count = 4 + (random() % 61);
    const quorum = Math.floor((count * 2) / 3) + 1;
    const shuffle = () => Array.from({ length: count }, (_, index) => index)
      .map((value) => ({ order: random(), value }))
      .sort((left, right) => left.order - right.order || left.value - right.value)
      .map(({ value }) => value);
    const receiptSigners = new Set(shuffle().slice(0, quorum));
    const commitSigners = new Set(shuffle().slice(0, quorum));
    const offenders = [...receiptSigners].filter((index) => commitSigners.has(index));
    assert.ok(offenders.length > 0, `scenario ${scenario} lost quorum intersection`);
    const bonds = Array.from({ length: count }, () =>
      MIN_VALIDATOR_BOND + BigInt(random() % 10_000));
    const slashed = offenders.reduce((sum, index) => sum + bonds[index], 0n);
    const reward = slashed * BigInt(ADMISSION_OMISSION_REPORTER_REWARD_BPS) / 10_000n;
    const burned = slashed - reward;
    assert.equal(reward + burned, slashed);
    for (let index = 0; index < count; index += 1) {
      assert.equal(offenders.includes(index), receiptSigners.has(index) && commitSigners.has(index));
    }
    const used = new Set([`evidence-${scenario}`]);
    const balancesAfterFirst = { burned, reward };
    if (used.has(`evidence-${scenario}`)) {
      assert.deepEqual({ burned, reward }, balancesAfterFirst,
        "replay must not execute a second economic transition");
    }
  }
});

test("maximum quorum evidence remains bounded below the consensus block envelope", () => {
  const { evidence } = prepareSlashableOmission();
  const quorum = Math.floor((MAX_VALIDATORS * 2) / 3) + 1;
  const maximum = structuredClone(evidence);
  maximum.receipts = Array.from({ length: quorum }, () => evidence.receipts[0]);
  maximum.commitVotes = Array.from({ length: quorum }, () => evidence.commitVotes[0]);
  maximum.transactionIds = Array.from({ length: MAX_TRANSACTIONS_PER_BLOCK }, (_, index) =>
    index.toString(16).padStart(64, "0"));
  const evidenceBytes = Buffer.byteLength(canonicalJson(maximum));
  assert.ok(evidenceBytes < MAX_ADMISSION_OMISSION_EVIDENCE_BYTES);
  assert.ok(evidenceBytes + 32 * 1024 < MAX_BLOCK_BYTES);
});
