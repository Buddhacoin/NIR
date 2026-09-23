import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NirChain, blockHeader, createBeaconBond, createCandidateBond, createTransfer, createValidatorBond,
  finalizeBlock, finalizeValidatorRecoveryBlock, prepareCertificateHash, transactionId,
} from "../blockchain/chain.mjs";
import { createAdmissionInclusionReceipt } from "../blockchain/admission-inclusion.mjs";
import { createFinalityProof, verifyValidatorRecoveryTransition } from "../blockchain/light-client.mjs";
import {
  MIN_BEACON_BOND, MIN_TRANSFER_FEE, SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  ADMISSION_OMISSION_REPORTER_REWARD_BPS,
  createValidatorAdmissionOmissionEvidence,
  createValidatorAdmissionOmissionTransaction,
} from "../blockchain/validator-admission-omission.mjs";
import {
  createValidatorRecoveryCheckpointCertificate,
  createValidatorRecoveryCheckpointVote,
  createValidatorRecoveryPlan,
  createValidatorRecoveryPlanTransaction,
  verifyValidatorRecoveryCheckpoint,
  verifyValidatorRecoveryPlan,
} from "../blockchain/validator-recovery.mjs";
import { ValidatorRecoveryLockStore } from "../blockchain/validator-recovery-store.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import {
  createValidatorRecoveryPeerRegistry, peerRegistryHash,
} from "../blockchain/peer-registry.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function quorumFor(block, wallets) {
  const proposer = wallets.find(({ address }) => address === block.proposer);
  return [...new Map([proposer, ...wallets].filter(Boolean)
    .map((wallet) => [wallet.address, wallet])).values()].slice(0, 3);
}

function append(chain, proposal, wallets) {
  const block = finalizeBlock(proposal, quorumFor(proposal, wallets));
  chain.appendBlock(block); return block;
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const reserves = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const genesisConfig = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 },
      contentHash: `sha256:${"3".repeat(64)}` }],
    evaluators: members(evaluators, "evaluator"), genesisTimestamp: 0,
    networkId: "nir-validator-recovery-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address, validators: members(validators, "validator"),
  };
  return { chain: new NirChain(genesisConfig), genesisConfig, reserves, treasury, validators };
}

function prepareRecovery() {
  const values = fixture();
  const { chain, reserves, treasury, validators } = values;
  const all = [...validators, ...reserves];
  append(chain, chain.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: all.map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE * 2n).toString(),
      networkId: chain.networkId, nonce, recipient: wallet.address, wallet: treasury,
    })) }), validators);
  append(chain, chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 1,
    transactions: all.map((wallet, index) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0,
      ...(index >= validators.length ? { operatorId: `reserve-${index - validators.length}` } : {}),
      wallet,
    })) }), validators);
  const reserveMembers = members(reserves, "reserve");
  const plan = createValidatorRecoveryPlan({
    activationHeight: 67, activeValidators: members(validators, "validator"), generation: 1,
    networkId: chain.networkId,
    reserveWallets: reserves.map((wallet, index) => ({ member: reserveMembers[index], wallet })),
    scheduledHeight: 3,
  });
  const safetyBondAmount = 1n;
  const planNonce = chain.nextNonce(treasury.address);
  append(chain, chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 2,
    transactions: [createValidatorRecoveryPlanTransaction({ networkId: chain.networkId,
      nonce: planNonce, plan, wallet: treasury }), createCandidateBond({
      amount: safetyBondAmount.toString(), candidateId: "f".repeat(64),
      networkId: chain.networkId, nonce: planNonce + 1, wallet: treasury,
    })] }), validators);
  for (let height = 4; height <= 66; height += 1) {
    append(chain, chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }), validators);
  }
  const candidate = generateWallet();
  const admission = createBeaconBond({ activationHeight: 131,
    amount: MIN_BEACON_BOND.toString(), networkId: chain.networkId, nonce: 0,
    operatorId: "recovery-trigger", wallet: candidate });
  const receipts = validators.slice(0, 3).map((validatorWallet) =>
    createAdmissionInclusionReceipt({ acceptedHeight: 66, networkId: chain.networkId,
      transaction: admission, validatorWallet, validators: members(validators, "validator") }));
  const omission = finalizeBlock(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 67 }),
    validators.slice(1, 4));
  chain.appendBlock(omission);
  const evidence = createValidatorAdmissionOmissionEvidence({
    certificate: omission.certificate, finalizedHeader: blockHeader(omission),
    prepareCertificateHash: prepareCertificateHash(omission.prepareCertificate), receipts,
    round: omission.round, transaction: admission,
    transactionIds: omission.transactions.map(transactionId),
    validators: members(validators, "validator"),
  });
  const evidenceTransaction = createValidatorAdmissionOmissionTransaction({ evidence,
    networkId: chain.networkId, nonce: chain.nextNonce(treasury.address), wallet: treasury });
  const checkpoint = { blockHash: omission.hash, format: "nir-validator-recovery-checkpoint-v1",
    generation: plan.generation, height: omission.height, networkId: chain.networkId,
    planHash: plan.planHash, previousHash: omission.previousHash,
    reserveSetId: plan.reserveSetId, stateRoot: omission.stateRoot };
  const checkpointCertificate = createValidatorRecoveryCheckpointCertificate({
    prepares: reserves.slice(0, 3).map((wallet) =>
      createValidatorRecoveryCheckpointVote(checkpoint, wallet, "prepare")),
    commits: reserves.slice(0, 3).map((wallet) =>
      createValidatorRecoveryCheckpointVote(checkpoint, wallet, "commit")),
  });
  const verifiedCheckpoint = verifyValidatorRecoveryCheckpoint(
    checkpointCertificate, checkpoint, plan,
  );
  const transition = { checkpoint, checkpointCertificate, evidenceTransaction,
    format: "nir-validator-recovery-transition-v1", generation: plan.generation,
    planHash: plan.planHash, type: "validator-recovery" };
  return { ...values, checkpointHash: verifiedCheckpoint.certificateHash, evidence,
    omission, plan, safetyBondAmount, transition };
}

function snapshotRestore(chain, genesisConfig) {
  const snapshot = chain.consensusSnapshot();
  return NirChain.fromVerifiedSnapshot(genesisConfig, { capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1), height: chain.height, networkId: chain.networkId,
    state: snapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash });
}

test("precommitted reserve quorum recovers exactly H+1 and preserves slashing economics", () => {
  const values = prepareRecovery();
  const fork = values.chain.fork();
  const restoredBefore = snapshotRestore(values.chain, values.genesisConfig);
  const burnedBefore = values.chain.burned;
  const reporterBefore = values.chain.balance(values.treasury.address);
  const proposal = values.chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 68,
    transactions: [values.transition] });
  const recovered = finalizeValidatorRecoveryBlock(proposal, values.reserves.slice(0, 3),
    values.plan, { checkpointHash: values.checkpointHash,
      evidenceHash: values.evidence.evidenceHash });
  const oldProof = createFinalityProof(values.omission);
  for (const replica of [values.chain, fork, restoredBefore]) replica.appendBlock(recovered);
  assert.equal(values.chain.validatorRecoveryGeneration, 1);
  assert.equal(values.chain.validatorRecoveryPlan, null);
  assert.deepEqual(values.chain.validatorMembers.map(({ address }) => address),
    members(values.reserves, "reserve").map(({ address }) => address).sort());
  assert.equal(values.chain.validatorDisabled(values.validators[1].address), true);
  assert.equal(values.chain.validatorDisabled(values.validators[2].address), true);
  const slashed = MIN_VALIDATOR_BOND * 2n;
  const reporterReward = slashed * BigInt(ADMISSION_OMISSION_REPORTER_REWARD_BPS) / 10_000n;
  assert.equal(values.chain.burned - burnedBefore, slashed - reporterReward);
  assert.equal(values.chain.balance(values.treasury.address),
    reporterBefore - MIN_TRANSFER_FEE + reporterReward + values.safetyBondAmount);
  assert.deepEqual(values.chain.consensusSnapshot().state.candidateBonds, []);
  assert.equal(fork.stateRoot, values.chain.stateRoot);
  assert.equal(restoredBefore.stateRoot, values.chain.stateRoot);
  const light = verifyValidatorRecoveryTransition({ expectedNetworkId: values.chain.networkId,
    plan: values.plan, previousProof: oldProof, recoveryBlock: recovered,
    trustedValidators: members(values.validators, "validator") });
  assert.equal(light.validatorSetId, values.plan.reserveSetId);
  const restored = snapshotRestore(values.chain, values.genesisConfig);
  assert.equal(restored.stateRoot, values.chain.stateRoot);
  assert.equal(restored.validatorRecoveryGeneration, 1);
  assert.equal(values.chain.fork().stateRoot, values.chain.stateRoot);
  assert.throws(() => values.chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 69,
    transactions: [values.transition] }), /recovery plan is unavailable/);
});

test("reserve plan delay, possession, bonds, and role separation fail closed", () => {
  const activeWallets = Array.from({ length: 4 }, generateWallet);
  const reserveWallets = Array.from({ length: 4 }, generateWallet);
  const active = members(activeWallets, "active");
  const reserves = members(reserveWallets, "reserve");
  const plan = createValidatorRecoveryPlan({ activationHeight: 63,
    activeValidators: active, generation: 1, networkId: "nir-recovery-unit",
    reserveWallets: reserveWallets.map((wallet, index) => ({ member: reserves[index], wallet })),
    scheduledHeight: 0 });
  const registered = new Map([...active, ...reserves].map((member) => [member.address, member]));
  const bonds = new Map(reserves.map(({ address }) => [address, MIN_VALIDATOR_BOND]));
  assert.throws(() => verifyValidatorRecoveryPlan(plan, { activeValidators: active, bonds,
    currentHeight: 0, expectedGeneration: 1, networkId: "nir-recovery-unit",
    registeredValidators: registered }), /context is invalid/);
  const valid = createValidatorRecoveryPlan({ activationHeight: 64,
    activeValidators: active, generation: 1, networkId: "nir-recovery-unit",
    reserveWallets: reserveWallets.map((wallet, index) => ({ member: reserves[index], wallet })),
    scheduledHeight: 0 });
  bonds.delete(reserves[0].address);
  assert.throws(() => verifyValidatorRecoveryPlan(valid, { activeValidators: active, bonds,
    currentHeight: 0, expectedGeneration: 1, networkId: "nir-recovery-unit",
    registeredValidators: registered }), /unknown, or unbonded/);
  const overlapping = structuredClone(valid);
  overlapping.reserves[0] = active[0];
  assert.throws(() => verifyValidatorRecoveryPlan(overlapping, { activeValidators: active,
    bonds: new Map([...reserves, ...active].map(({ address }) => [address, MIN_VALIDATOR_BOND])),
    currentHeight: 0, expectedGeneration: 1, networkId: "nir-recovery-unit",
    registeredValidators: registered }), /context is invalid|commitment is invalid|active, unknown, or unbonded/);

  const transports = Array.from({ length: 4 }, generateWallet);
  const peers = reserveWallets.map((wallet, index) => ({
    tlsCertificateSha256: null,
    transport: publicWallet(transports[index]),
    url: `http://127.0.0.1:${9700 + index}`,
    validatorAddress: wallet.address,
  }));
  const networkPlan = createValidatorRecoveryPlan({ activationHeight: 64,
    activeValidators: active, generation: 1, networkId: "nir-recovery-unit",
    reserveWallets: reserveWallets.map((wallet, index) => ({ member: reserves[index],
      peer: peers[index], transportWallet: transports[index], wallet })), scheduledHeight: 0 });
  const fullBonds = new Map(reserves.map(({ address }) => [address, MIN_VALIDATOR_BOND]));
  assert.doesNotThrow(() => verifyValidatorRecoveryPlan(networkPlan, { activeValidators: active,
    bonds: fullBonds, currentHeight: 0, expectedGeneration: 1,
    networkId: "nir-recovery-unit", peerRegistryRequired: true,
    registeredValidators: registered }));
  const tampered = structuredClone(networkPlan);
  tampered.approvals[0].transportSignature = tampered.approvals[1].transportSignature;
  assert.throws(() => verifyValidatorRecoveryPlan(tampered, { activeValidators: active,
    bonds: fullBonds, currentHeight: 0, expectedGeneration: 1,
    networkId: "nir-recovery-unit", peerRegistryRequired: true,
    registeredValidators: registered }), /transport possession signature/);
  const priorRegistry = { activationHeight: 0, epoch: 0, networkId: "nir-recovery-unit",
    peers: activeWallets.map((wallet, index) => ({ tlsCertificateSha256: null,
      transport: publicWallet(generateWallet()), url: `http://127.0.0.1:${9600 + index}`,
      validatorAddress: wallet.address })), previousRegistryHash: "0".repeat(64) };
  const recoveredRegistry = createValidatorRecoveryPeerRegistry({ activationHeight: 65,
    generation: 1, networkId: "nir-recovery-unit", peers: networkPlan.peers,
    planHash: networkPlan.planHash, previousRegistry: priorRegistry });
  assert.equal(recoveredRegistry.previousRegistryHash, peerRegistryHash(priorRegistry));
  assert.match(peerRegistryHash(recoveredRegistry), /^[0-9a-f]{64}$/);
  assert.equal(validatorSetId(active), validatorSetId([...active].reverse()));
});

test("recovery rejects forged checkpoints and mixed ordinary consensus work", () => {
  const values = prepareRecovery();
  const root = values.chain.stateRoot;
  const forged = structuredClone(values.transition);
  forged.checkpointCertificate.commits[0].signature += "A";
  const proposal = values.chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 68,
    transactions: [forged] });
  const block = finalizeValidatorRecoveryBlock(proposal, values.reserves.slice(0, 3), values.plan,
    { checkpointHash: values.checkpointHash, evidenceHash: values.evidence.evidenceHash });
  assert.throws(() => values.chain.appendBlock(block), /(checkpoint|block) vote is invalid/);
  assert.equal(values.chain.stateRoot, root);
  assert.throws(() => values.chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 68,
    transactions: [values.transition], protocolUpgrade: { activationHeight: 100, version: 25 } }),
  /cannot contain ordinary consensus work/);
});

test("reserve locks survive restart and reject split checkpoint or recovery views", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-recovery-lock-"));
  const wallet = generateWallet();
  const checkpoint = { blockHash: "1".repeat(64), generation: 1, height: 10,
    networkId: "n", planHash: "2".repeat(64), previousHash: "3".repeat(64),
    reserveSetId: "4".repeat(64), stateRoot: "5".repeat(64) };
  try {
    new ValidatorRecoveryLockStore(join(directory, "locks.json"), wallet)
      .checkpointVote(checkpoint, "prepare");
    const restarted = new ValidatorRecoveryLockStore(join(directory, "locks.json"), wallet);
    restarted.checkpointVote(checkpoint, "commit");
    assert.throws(() => restarted.checkpointVote({ ...checkpoint,
      blockHash: "6".repeat(64) }, "prepare"), /conflicts with a persisted vote/);
    const recovery = { blockHash: "7".repeat(64), checkpointHash: "8".repeat(64),
      evidenceHash: "9".repeat(64), generation: 1, height: 11, networkId: "n",
      planHash: "2".repeat(64), reserveSetId: "4".repeat(64) };
    restarted.recoveryVote(recovery, "prepare");
    assert.throws(() => new ValidatorRecoveryLockStore(join(directory, "locks.json"), wallet)
      .recoveryVote({ ...recovery, evidenceHash: "a".repeat(64) }, "commit"),
    /conflicts with a persisted vote/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("seeded recovery model permits takeover only after objective quorum destruction", () => {
  let seed = 0x5afe1234;
  const random = () => (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0);
  for (let scenario = 0; scenario < 4_096; scenario += 1) {
    const size = 4 + (random() % 253);
    const quorum = Math.floor((size * 2) / 3) + 1;
    const receipt = new Set(Array.from({ length: size }, (_, index) => index)
      .sort(() => (random() & 1) ? 1 : -1).slice(0, quorum));
    const commits = new Set(Array.from({ length: size }, (_, index) => index)
      .sort(() => (random() & 1) ? 1 : -1).slice(0, quorum));
    const offenders = [...receipt].filter((index) => commits.has(index));
    assert.ok(offenders.length >= 2 * quorum - size);
    assert.ok(size - offenders.length < quorum,
      `scenario ${scenario} retained a normal quorum after proven omission`);
    const reserveSize = 4 + (random() % 61);
    const reserveQuorum = Math.floor((reserveSize * 2) / 3) + 1;
    assert.ok(reserveQuorum > (reserveSize - 1) / 2);
  }
});
