import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NirChain, blockHeader, createBeaconBond, createCandidateBond, createTransfer, createValidatorBond,
  finalizeBlock, finalizeValidatorRecoveryBlock, prepareCertificateHash, transactionId,
} from "../blockchain/chain.mjs";
import { createAdmissionInclusionReceipt } from "../blockchain/admission-inclusion.mjs";
import {
  createFinalityProof, verifyAndPersistValidatorRecoveryTransition,
  verifyValidatorRecoveryTransition,
} from "../blockchain/light-client.mjs";
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
  createValidatorRecoveryPlan,
  createValidatorRecoveryPlanTransaction,
  validatorRecoveryStateCommitment,
  verifyValidatorRecoveryCheckpoint,
  verifyValidatorRecoveryPlan,
} from "../blockchain/validator-recovery.mjs";
import { ValidatorRecoveryLockStore } from "../blockchain/validator-recovery-store.mjs";
import {
  advanceValidatorRecoveryTrustStore, createValidatorRecoveryTrustStore,
  loadValidatorRecoveryTrustStore,
} from "../blockchain/validator-recovery-trust-store.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import {
  createValidatorRecoveryPeerRegistry, peerRegistryHash,
} from "../blockchain/peer-registry.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";
import { transactionRoot } from "../blockchain/transaction-tree.mjs";

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

function recoverySigners(wallets, t, prefix = "nir-recovery-signers-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t?.after(() => rmSync(directory, { recursive: true, force: true }));
  return wallets.map((wallet, index) =>
    new ValidatorRecoveryLockStore(join(directory, `${index}.json`), wallet));
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

function prepareRecovery(t) {
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
  const reserveSigners = recoverySigners(reserves, t);
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
    prepares: reserveSigners.slice(0, 3).map((signer) =>
      signer.checkpointVote(checkpoint, "prepare")),
    commits: reserveSigners.slice(0, 3).map((signer) =>
      signer.checkpointVote(checkpoint, "commit")),
  });
  const verifiedCheckpoint = verifyValidatorRecoveryCheckpoint(
    checkpointCertificate, checkpoint, plan,
  );
  const transition = { checkpoint, checkpointCertificate, evidenceTransaction,
    format: "nir-validator-recovery-transition-v1", generation: plan.generation,
    planHash: plan.planHash, type: "validator-recovery" };
  return { ...values, checkpointHash: verifiedCheckpoint.certificateHash, evidence,
    omission, plan, reserveSigners, safetyBondAmount, transition };
}

function snapshotRestore(chain, genesisConfig) {
  const snapshot = chain.consensusSnapshot();
  return NirChain.fromVerifiedSnapshot(genesisConfig, { capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1), height: chain.height, networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment,
    state: snapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash });
}

test("precommitted reserve quorum recovers exactly H+1 and preserves slashing economics", (t) => {
  const values = prepareRecovery(t);
  assert.equal(values.omission.recoveryStateCommitment, validatorRecoveryStateCommitment({
    activePlanHash: values.plan.planHash, generation: 0, networkId: values.chain.networkId,
  }));
  const replacementHeight = values.chain.height + 1;
  const replacementPlan = createValidatorRecoveryPlan({
    activationHeight: replacementHeight + 64,
    activeValidators: members(values.validators, "validator"), generation: 1,
    networkId: values.chain.networkId,
    reserveWallets: values.reserves.map((wallet, index) => ({
      member: members(values.reserves, "reserve")[index], wallet,
    })),
    scheduledHeight: replacementHeight,
  });
  const replacementProposal = values.chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 68,
    transactions: [createValidatorRecoveryPlanTransaction({
      networkId: values.chain.networkId, nonce: values.chain.nextNonce(values.treasury.address),
      plan: replacementPlan, wallet: values.treasury,
    })],
  });
  assert.throws(() => values.chain.appendBlock(finalizeBlock(replacementProposal,
    quorumFor(replacementProposal, values.validators))), /conflicts with pending membership state/);
  const rotationFork = values.chain.fork();
  const rotationHeight = rotationFork.height + 1;
  const rotatedMembers = members([
    ...values.validators.slice(0, 3), values.reserves[0],
  ], "rotation");
  const rotationProposal = rotationFork.buildBlock({
    timestamp: TREASURY_VESTING_MS + 68,
    validatorRotation: { activationHeight: rotationHeight + 5, onboarding: null,
      validators: rotatedMembers },
  });
  rotationFork.appendBlock(finalizeBlock(rotationProposal,
    quorumFor(rotationProposal, values.validators)));
  assert.equal(rotationFork.validatorRecoveryPlan, null);
  assert.equal(rotationFork.recoveryStateCommitment, validatorRecoveryStateCommitment({
    activePlanHash: null, generation: 0, networkId: values.chain.networkId,
  }));
  const fork = values.chain.fork();
  const restoredBefore = snapshotRestore(values.chain, values.genesisConfig);
  const burnedBefore = values.chain.burned;
  const reporterBefore = values.chain.balance(values.treasury.address);
  const proposal = values.chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 68,
    transactions: [values.transition] });
  assert.throws(() => finalizeValidatorRecoveryBlock(proposal, values.reserves.slice(0, 3),
    values.plan, { checkpointHash: values.checkpointHash,
      evidenceHash: values.evidence.evidenceHash }), /durable reserve signers/);
  const recovered = finalizeValidatorRecoveryBlock(proposal, values.reserveSigners.slice(0, 3),
    values.plan, { checkpointHash: values.checkpointHash,
      evidenceHash: values.evidence.evidenceHash });
  const oldProof = createFinalityProof(values.omission);
  for (const replica of [values.chain, fork, restoredBefore]) replica.appendBlock(recovered);
  assert.equal(values.chain.validatorRecoveryGeneration, 1);
  assert.equal(values.chain.validatorRecoveryPlan, null);
  assert.equal(recovered.recoveryStateCommitment, validatorRecoveryStateCommitment({
    activePlanHash: null, generation: 1, networkId: values.chain.networkId,
  }));
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
  const trustDirectory = mkdtempSync(join(tmpdir(), "nir-recovery-light-trust-"));
  t.after(() => rmSync(trustDirectory, { recursive: true, force: true }));
  const trustPath = join(trustDirectory, "trust.json");
  const trust = createValidatorRecoveryTrustStore(trustPath, {
    checkpoint: { height: oldProof.header.height, recoveryGeneration: 0,
      recoveryStateCommitment: oldProof.header.recoveryStateCommitment,
      stateRoot: oldProof.header.stateRoot, tipHash: oldProof.hash },
    networkId: values.chain.networkId,
  });
  const persistedLight = verifyAndPersistValidatorRecoveryTransition({
    expectedNetworkId: values.chain.networkId, plan: values.plan, previousProof: oldProof,
    recoveryBlock: recovered, recoveryTrustStore: trust, recoveryTrustStorePath: trustPath,
    trustedValidators: members(values.validators, "validator"),
  });
  assert.equal(persistedLight.recoveryTrustStore.checkpoint.recoveryGeneration, 1);
  assert.deepEqual(loadValidatorRecoveryTrustStore(trustPath, {
    networkId: values.chain.networkId,
  }), persistedLight.recoveryTrustStore);
  assert.throws(() => verifyAndPersistValidatorRecoveryTransition({
    expectedNetworkId: values.chain.networkId, plan: values.plan, previousProof: oldProof,
    recoveryBlock: recovered, recoveryTrustStore: persistedLight.recoveryTrustStore,
    recoveryTrustStorePath: trustPath,
    trustedValidators: members(values.validators, "validator"),
  }), /does not authenticate the previous header/);
  const unscheduledProposal = { ...structuredClone(values.omission), certificate: [], hash: null,
    prepareCertificate: [], recoveryStateCommitment: validatorRecoveryStateCommitment({
      activePlanHash: null, generation: 0, networkId: values.chain.networkId,
    }) };
  const forgedSchedule = createFinalityProof(finalizeBlock(unscheduledProposal,
    values.validators.slice(1, 4)));
  assert.throws(() => verifyValidatorRecoveryTransition({
    expectedNetworkId: values.chain.networkId, plan: values.plan,
    previousProof: forgedSchedule, recoveryBlock: recovered,
    trustedValidators: members(values.validators, "validator"),
  }), /not authenticated by the finalized header/);

  const fakeEvidenceProposal = structuredClone(proposal);
  fakeEvidenceProposal.transactions[0].evidenceTransaction.evidence.evidenceHash = "a".repeat(64);
  fakeEvidenceProposal.transactionsRoot = transactionRoot(fakeEvidenceProposal.transactions);
  const fakeEvidence = finalizeValidatorRecoveryBlock(fakeEvidenceProposal,
    recoverySigners(values.reserves, t, "nir-fake-evidence-signers-").slice(0, 3), values.plan,
    { checkpointHash: values.checkpointHash, evidenceHash: "a".repeat(64) });
  assert.throws(() => verifyValidatorRecoveryTransition({
    expectedNetworkId: values.chain.networkId, plan: values.plan, previousProof: oldProof,
    recoveryBlock: fakeEvidence,
    trustedValidators: members(values.validators, "validator"),
  }), /omission|signature|evidence/);

  const swappedPeerProposal = { ...structuredClone(proposal), peerRegistryHash: "b".repeat(64) };
  const swappedPeer = finalizeValidatorRecoveryBlock(swappedPeerProposal,
    recoverySigners(values.reserves, t, "nir-peer-swap-signers-").slice(0, 3), values.plan,
    { checkpointHash: values.checkpointHash, evidenceHash: values.evidence.evidenceHash });
  assert.throws(() => verifyValidatorRecoveryTransition({
    expectedNetworkId: values.chain.networkId, plan: values.plan, previousProof: oldProof,
    recoveryBlock: swappedPeer,
    trustedValidators: members(values.validators, "validator"),
  }), /peer registry commitment/);
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
    registeredValidators: registered }), /unknown or unbonded/);
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

test("recovery rejects forged checkpoints and mixed ordinary consensus work", (t) => {
  const values = prepareRecovery(t);
  const root = values.chain.stateRoot;
  const forged = structuredClone(values.transition);
  forged.checkpointCertificate.commits[0].signature += "A";
  const proposal = values.chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 68,
    transactions: [forged] });
  const block = finalizeValidatorRecoveryBlock(proposal, values.reserveSigners.slice(0, 3), values.plan,
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
    assert.throws(() => restarted.checkpointVote({ ...checkpoint,
      blockHash: "6".repeat(64), height: 11 }, "prepare"),
    /conflicts with a persisted vote/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("durable reserve signer re-reads under an exclusive interprocess lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-recovery-cas-"));
  const path = join(directory, "locks.json");
  const walletPath = join(directory, "wallet.json");
  const wallet = generateWallet();
  const context = { blockHash: "1".repeat(64), generation: 1, height: 10,
    networkId: "n", planHash: "2".repeat(64), previousHash: "3".repeat(64),
    reserveSetId: "4".repeat(64), stateRoot: "5".repeat(64) };
  try {
    writeFileSync(walletPath, JSON.stringify(wallet), { mode: 0o600 });
    const first = new ValidatorRecoveryLockStore(path, wallet);
    const stale = new ValidatorRecoveryLockStore(path, wallet);
    first.checkpointVote(context, "prepare");
    assert.throws(() => stale.checkpointVote({ ...context,
      blockHash: "6".repeat(64) }, "prepare"), /conflicts with a persisted vote/);
    const program = `
      import { readFileSync } from "node:fs";
      import { ValidatorRecoveryLockStore } from "./blockchain/validator-recovery-store.mjs";
      const [path, walletPath, encoded] = process.argv.slice(1);
      new ValidatorRecoveryLockStore(path, JSON.parse(readFileSync(walletPath, "utf8")))
        .checkpointVote(JSON.parse(encoded), "prepare");`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program,
      path, walletPath, JSON.stringify({ ...context, height: 11 })], {
      cwd: process.cwd(), encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /conflicts with a persisted vote/);
    const freshPath = join(directory, "crash-locks.json");
    symlinkSync("99999999", `${freshPath}.signer-lock`);
    assert.doesNotThrow(() => new ValidatorRecoveryLockStore(freshPath, wallet)
      .checkpointVote({ ...context, generation: 2 }, "prepare"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("durable reserve signer is poisoned by parent replacement without touching displaced journal", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-recovery-root-swap-"));
  const live = join(directory, "live");
  const displaced = join(directory, "displaced");
  mkdirSync(live, { mode: 0o700 });
  const path = join(live, "locks.json");
  const wallet = generateWallet();
  const context = { blockHash: "1".repeat(64), generation: 1, height: 10,
    networkId: "n", planHash: "2".repeat(64), previousHash: "3".repeat(64),
    reserveSetId: "4".repeat(64), stateRoot: "5".repeat(64) };
  try {
    const first = new ValidatorRecoveryLockStore(path, wallet);
    const preopened = new ValidatorRecoveryLockStore(path, wallet);
    first.checkpointVote(context, "prepare");
    const original = readFileSync(path, "utf8");
    renameSync(live, displaced);
    mkdirSync(live, { mode: 0o700 });
    assert.throws(() => first.checkpointVote({ ...context,
      blockHash: "6".repeat(64) }, "commit"), /root (?:changed|was replaced)/);
    assert.throws(() => preopened.checkpointVote({ ...context,
      blockHash: "6".repeat(64) }, "prepare"), /root (?:changed|was replaced)/);
    assert.equal(readFileSync(join(displaced, "locks.json"), "utf8"), original);
    assert.equal(existsSync(join(live, "locks.json")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("child reserve signer fails closed when its opened parent is swapped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-recovery-child-swap-"));
  const live = join(directory, "live");
  const displaced = join(directory, "displaced");
  const ready = join(directory, "ready");
  const proceed = join(directory, "proceed");
  const walletPath = join(directory, "wallet.json");
  mkdirSync(live, { mode: 0o700 });
  const path = join(live, "locks.json");
  const wallet = generateWallet();
  const context = { blockHash: "1".repeat(64), generation: 1, height: 10,
    networkId: "n", planHash: "2".repeat(64), previousHash: "3".repeat(64),
    reserveSetId: "4".repeat(64), stateRoot: "5".repeat(64) };
  const program = `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { ValidatorRecoveryLockStore } from "./blockchain/validator-recovery-store.mjs";
    const [path, walletPath, ready, proceed, encoded] = process.argv.slice(1);
    const store = new ValidatorRecoveryLockStore(path, JSON.parse(readFileSync(walletPath, "utf8")));
    writeFileSync(ready, "ready");
    while (!existsSync(proceed)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    store.checkpointVote(JSON.parse(encoded), "prepare");`;
  try {
    writeFileSync(walletPath, JSON.stringify(wallet), { mode: 0o600 });
    const child = spawn(process.execPath, ["--input-type=module", "-e", program,
      path, walletPath, ready, proceed, JSON.stringify(context)], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(existsSync(ready), true);
    renameSync(live, displaced);
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(proceed, "go");
    const status = await new Promise((resolve) => child.once("exit", resolve));
    assert.notEqual(status, 0);
    assert.match(stderr, /root changed/);
    assert.equal(existsSync(join(displaced, "locks.json")), false);
    assert.equal(existsSync(join(live, "locks.json")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("twenty concurrent reserve processes persist only one generation value", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-recovery-twenty-process-"));
  const path = join(directory, "locks.json");
  const walletPath = join(directory, "wallet.json");
  const wallet = generateWallet();
  const base = { blockHash: "1".repeat(64), generation: 1, height: 10,
    networkId: "n", planHash: "2".repeat(64), previousHash: "3".repeat(64),
    reserveSetId: "4".repeat(64), stateRoot: "5".repeat(64) };
  const program = `
    import { readFileSync } from "node:fs";
    import { ValidatorRecoveryLockStore } from "./blockchain/validator-recovery-store.mjs";
    const [path, walletPath, marker, encoded] = process.argv.slice(1);
    new ValidatorRecoveryLockStore(path, JSON.parse(readFileSync(walletPath, "utf8")))
      .checkpointVote(JSON.parse(encoded), "prepare");
    process.stdout.write(marker);`;
  try {
    writeFileSync(walletPath, JSON.stringify(wallet), { mode: 0o600 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      new Promise((resolve) => {
        const marker = index % 2 === 0 ? "A" : "B";
        const context = marker === "A" ? base : { ...base, blockHash: "6".repeat(64) };
        const child = spawn(process.execPath, ["--input-type=module", "-e", program,
          path, walletPath, marker, JSON.stringify(context)], {
          cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.once("exit", (status) => resolve({ marker, status, stdout }));
      })));
    const successful = results.filter(({ status }) => status === 0);
    assert.ok(successful.length >= 1);
    assert.equal(new Set(successful.map(({ stdout }) => stdout)).size, 1);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(Object.keys(persisted.checkpointLocks).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("recovery trust store rejects rollback, forks, mixed generations, and replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-recovery-trust-"));
  const path = join(directory, "trust.json");
  const networkId = "nir-recovery-trust-test";
  const inactive0 = validatorRecoveryStateCommitment({ activePlanHash: null,
    generation: 0, networkId });
  const planHash = "1".repeat(64);
  const active0 = validatorRecoveryStateCommitment({ activePlanHash: planHash,
    generation: 0, networkId });
  const inactive1 = validatorRecoveryStateCommitment({ activePlanHash: null,
    generation: 1, networkId });
  const genesis = { height: 0, recoveryGeneration: 0,
    recoveryStateCommitment: inactive0, stateRoot: "2".repeat(64), tipHash: "3".repeat(64) };
  try {
    let store = createValidatorRecoveryTrustStore(path, { checkpoint: genesis, networkId });
    const scheduled = { height: 8, recoveryGeneration: 0,
      recoveryStateCommitment: active0, stateRoot: "4".repeat(64), tipHash: "5".repeat(64) };
    store = advanceValidatorRecoveryTrustStore(path, store, { checkpoint: scheduled });
    assert.throws(() => advanceValidatorRecoveryTrustStore(path, store, {
      checkpoint: { ...scheduled, tipHash: "6".repeat(64) },
    }), /fork/);
    assert.throws(() => advanceValidatorRecoveryTrustStore(path, store, {
      checkpoint: genesis,
    }), /rollback/);
    const transition = { recoveryGeneration: 1, usedEvidenceHash: "7".repeat(64),
      usedPlanHash: planHash };
    const staleWriter = structuredClone(store);
    const recovered = { height: 9, recoveryGeneration: 1,
      recoveryStateCommitment: inactive1, stateRoot: "8".repeat(64), tipHash: "9".repeat(64) };
    store = advanceValidatorRecoveryTrustStore(path, store, { checkpoint: recovered, transition });
    assert.deepEqual(loadValidatorRecoveryTrustStore(path, { networkId }), store);
    assert.throws(() => advanceValidatorRecoveryTrustStore(path, staleWriter, {
      checkpoint: { ...scheduled, height: 9, stateRoot: "c".repeat(64),
        tipHash: "d".repeat(64) },
    }), /compare-and-swap failed/);
    assert.throws(() => advanceValidatorRecoveryTrustStore(path, store, {
      checkpoint: { ...recovered, height: 10, tipHash: "a".repeat(64) }, transition,
    }), /generation did not advance/);
    assert.throws(() => advanceValidatorRecoveryTrustStore(path, store, {
      checkpoint: { ...recovered, height: 10, recoveryGeneration: 2,
        recoveryStateCommitment: validatorRecoveryStateCommitment({ activePlanHash: null,
          generation: 2, networkId }), tipHash: "a".repeat(64) },
      transition: { recoveryGeneration: 2, usedEvidenceHash: "7".repeat(64),
        usedPlanHash: "b".repeat(64) },
    }), /invalid or replayed/);
    assert.throws(() => loadValidatorRecoveryTrustStore(path, { networkId: "other" }), /invalid/);
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
