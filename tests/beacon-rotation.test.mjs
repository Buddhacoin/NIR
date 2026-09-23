import assert from "node:assert/strict";
import test from "node:test";

import {
  NirChain,
  blockHash,
  computeChainStateRoot,
  createBeaconBond,
  createBeaconRetirement,
  createCandidateBond,
  createEvaluatorBond,
  createProgressCommitment,
  createTransfer,
  createValidatorBond,
  finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  BEACON_ROTATION_DELAY_BLOCKS,
  BEACON_RETIREMENT_DELAY_BLOCKS,
  MAX_REGISTERED_BEACON_AUTHORITIES,
  createBeaconRotationApproval,
  createBeaconRotationProposal,
  verifyBeaconRotation,
} from "../blockchain/beacon-rotation.mjs";
import {
  ATOMIC_UNITS, MIN_BEACON_BOND, MIN_PROGRESS_CANDIDATE_BOND, MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createEpochRandomnessCommit, createEpochRandomnessReveal,
} from "../blockchain/operators.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const genesis = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      contentHash: `sha256:${"2".repeat(64)}`,
      behaviorCommitment: "3".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluators: members(evaluators, "evaluator"), genesisTimestamp: 0,
    networkId: "nir-beacon-rotation-test", safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address, validators: members(validators, "validator"),
  };
  return { beacons, chain: new NirChain(genesis), genesis, treasury, validators };
}

function quorum(block, validators) {
  const proposer = validators.find((wallet) => wallet.address === block.proposer);
  return [proposer, ...validators.filter((wallet) => wallet !== proposer).slice(0, 2)];
}

function append(chain, validators, options = {}) {
  const block = chain.buildBlock({ timestamp: TREASURY_VESTING_MS, ...options });
  chain.appendBlock(finalizeBlock(block, quorum(block, validators)));
  return block;
}

function approvals(proposal, wallets, kind) {
  return wallets.map((wallet) => createBeaconRotationApproval({ wallet, proposal, kind }))
    .sort((left, right) => left.authority.localeCompare(right.authority));
}

function advanceEpoch(chain, validators, wallets) {
  const status = chain.epochRandomnessStatus();
  const committee = status.committee.map((address) =>
    wallets.find((wallet) => wallet.address === address));
  const secrets = committee.map((_, index) => `${index + 4}`.repeat(64));
  append(chain, validators, { epochRandomnessCommits: committee.map((wallet, index) =>
    createEpochRandomnessCommit({ wallet, networkId: chain.networkId, round: status.round,
      generation: status.generation, secret: secrets[index] })) });
  append(chain, validators, { epochRandomnessReveals: committee.map((wallet, index) =>
    createEpochRandomnessReveal({ wallet, networkId: chain.networkId, round: status.round,
      generation: status.generation, secret: secrets[index] })) });
}

test("bonded old/new beacon rotation is delayed, generation-bound, and restart-safe", () => {
  const { beacons, chain, genesis, treasury, validators } = fixture();
  const replacements = Array.from({ length: 2 }, generateWallet);
  const funded = [...beacons, ...replacements];
  append(chain, validators, { transactions: funded.map((wallet, index) => createTransfer({
    wallet: treasury, networkId: chain.networkId, recipient: wallet.address,
    amount: (MIN_BEACON_BOND + MIN_TRANSFER_FEE).toString(), nonce: index,
  })) });
  append(chain, validators, { transactions: [
    ...beacons.map((wallet) => createBeaconBond({ wallet, networkId: chain.networkId,
      amount: MIN_BEACON_BOND.toString(), nonce: 0 })),
    ...replacements.map((wallet, index) => createBeaconBond({ wallet, networkId: chain.networkId,
      amount: MIN_BEACON_BOND.toString(), nonce: 0, operatorId: `replacement-beacon-${index}` })),
  ] });
  assert.equal(chain.beaconBondingActive, true);

  const submitter = generateWallet();
  const admission = createProgressCommitment({ wallet: submitter, networkId: chain.networkId,
    recipient: submitter.address, artifactHash: `sha256:${"4".repeat(64)}`,
    baselineHash: `sha256:${"1".repeat(64)}`,
    baselineContentHash: `sha256:${"2".repeat(64)}`,
    contentHash: `sha256:${"5".repeat(64)}`, suiteCommitment: "6".repeat(64), nonce: 0 });
  append(chain, validators, { transactions: [createCandidateBond({ wallet: treasury,
    networkId: chain.networkId, candidateId: admission.candidateId,
    candidateOwner: submitter.address, purpose: "progress",
    amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), fee: "0", nonce: funded.length })] });
  append(chain, validators, { transactions: [admission] });
  advanceEpoch(chain, validators, beacons);
  assert.notEqual(chain.progressBeaconCommittee(admission.candidateId), null);

  const current = members(beacons, "beacon");
  const nextWallets = [beacons[0], beacons[1], ...replacements];
  const next = [current[0], current[1], ...members(replacements, "replacement-beacon")];
  const proposal = createBeaconRotationProposal({
    activationHeight: chain.height + BEACON_ROTATION_DELAY_BLOCKS,
    authorities: next, generation: 1, networkId: chain.networkId,
    previousAuthorities: current,
  });
  const rotation = { ...proposal,
    oldApprovals: approvals(proposal, beacons.slice(0, 3), "old"),
    possessionProofs: approvals(proposal, nextWallets, "possession") };
  append(chain, validators, { beaconRotation: rotation });
  assert.equal(chain.beaconAuthorityStatus().pendingRotation.nextSetId, proposal.nextSetId);

  const pendingSnapshot = chain.consensusSnapshot();
  const checkpoint = chain.blocks().at(-1);
  const restarted = NirChain.fromVerifiedSnapshot(genesis, {
    capabilityMemory: pendingSnapshot.capabilityMemory,
    checkpoint, height: chain.height, networkId: chain.networkId,
    state: pendingSnapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
  });
  assert.deepEqual(restarted.beaconAuthorityStatus(), chain.beaconAuthorityStatus());
  const tampered = structuredClone({
    capabilityMemory: pendingSnapshot.capabilityMemory,
    checkpoint, height: chain.height, networkId: chain.networkId,
    state: pendingSnapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
  });
  tampered.state.beaconGeneration += 1;
  tampered.stateRoot = computeChainStateRoot(tampered.state);
  tampered.checkpoint.stateRoot = tampered.stateRoot;
  tampered.checkpoint.hash = blockHash(tampered.checkpoint);
  tampered.tipHash = tampered.checkpoint.hash;
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesis, tampered),
    /rotation lineage, generation, or delay/);
  const fork = restarted.fork();
  while (restarted.height + 1 < proposal.activationHeight) append(restarted, validators);
  const oldStatus = restarted.epochRandomnessStatus();
  const oldMember = beacons.find((wallet) => wallet.address === oldStatus.committee[0]);
  const stale = createEpochRandomnessCommit({ wallet: oldMember, networkId: restarted.networkId,
    round: oldStatus.round, generation: 0, secret: "3".repeat(64) });
  const staleBoundaryBlock = restarted.buildBlock({ epochRandomnessCommits: [stale],
    timestamp: TREASURY_VESTING_MS });
  assert.throws(() => restarted.appendBlock(finalizeBlock(
    staleBoundaryBlock, quorum(staleBoundaryBlock, validators),
  )), /forbidden at the rotation boundary/);
  append(restarted, validators);
  assert.equal(restarted.beaconAuthorityStatus().generation, 1);
  assert.equal(restarted.epochRandomnessStatus().generation, 1);
  assert.equal(restarted.epochRandomnessStatus().round, oldStatus.round + 1);
  assert.equal(restarted.beaconAuthorityStatus().pendingRotation, null);
  const activatedSnapshot = restarted.consensusSnapshot();
  const activatedState = activatedSnapshot.state;
  assert.equal(activatedState.progressCommitments.some(([candidateId]) =>
    candidateId === admission.candidateId), false);
  assert.equal(activatedState.candidateBonds.some(([candidateId]) =>
    candidateId === admission.candidateId), false);
  const conserved = activatedState.balances.reduce((sum, [, amount]) => sum + BigInt(amount), 0n) +
    activatedState.evaluatorBonds.reduce((sum, [, amount]) => sum + BigInt(amount), 0n) +
    activatedState.beaconBonds.reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
  assert.equal(conserved + restarted.burned, restarted.issued);
  const mismatchedGeneration = structuredClone({
    capabilityMemory: activatedSnapshot.capabilityMemory,
    checkpoint: restarted.blocks().at(-1), height: restarted.height,
    networkId: restarted.networkId, state: activatedState,
    stateRoot: restarted.stateRoot, tipHash: restarted.tipHash,
  });
  mismatchedGeneration.state.epochRandomness.generation = 0;
  mismatchedGeneration.stateRoot = computeChainStateRoot(mismatchedGeneration.state);
  mismatchedGeneration.checkpoint.stateRoot = mismatchedGeneration.stateRoot;
  mismatchedGeneration.checkpoint.hash = blockHash(mismatchedGeneration.checkpoint);
  mismatchedGeneration.tipHash = mismatchedGeneration.checkpoint.hash;
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesis, mismatchedGeneration),
    /epoch randomness and beacon generations are inconsistent/);
  assert.throws(() => restarted.buildBlock({ beaconRotation: rotation,
    timestamp: TREASURY_VESTING_MS }), /lineage, generation, or delay|not registered/);

  const newStatus = restarted.epochRandomnessStatus();
  const overlapping = beacons[0];
  const replay = createEpochRandomnessCommit({ wallet: overlapping, networkId: restarted.networkId,
    round: newStatus.round, generation: 0, secret: "4".repeat(64) });
  const replayBlock = restarted.buildBlock({ epochRandomnessCommits: [replay],
    timestamp: TREASURY_VESTING_MS });
  assert.throws(() => restarted.appendBlock(finalizeBlock(
    replayBlock, quorum(replayBlock, validators),
  )), /invalid or duplicated/);
  while (fork.height < proposal.activationHeight) append(fork, validators);
  assert.deepEqual(fork.beaconAuthorityStatus(), restarted.beaconAuthorityStatus());
  assert.equal(fork.stateRoot, restarted.stateRoot);
  advanceEpoch(restarted, validators, nextWallets);
  advanceEpoch(fork, validators, nextWallets);
  assert.equal(restarted.epochRandomnessStatus().round, newStatus.round + 1);
  assert.equal(fork.stateRoot, restarted.stateRoot);
});

test("rotation rejects abrupt takeover, missing possession, minority old approval, and weak bonds", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newWallets = Array.from({ length: 4 }, generateWallet);
  const current = members(oldWallets, "old-beacon");
  const next = members(newWallets, "new-beacon");
  const networkId = "nir-beacon-rotation-model";
  const base = createBeaconRotationProposal({ activationHeight: 74, authorities: next,
    generation: 1, networkId, previousAuthorities: current });
  const bonds = new Map(next.map(({ address }) => [address, MIN_BEACON_BOND]));
  const full = { ...base, oldApprovals: approvals(base, oldWallets.slice(0, 3), "old"),
    possessionProofs: approvals(base, newWallets, "possession") };
  assert.throws(() => verifyBeaconRotation(full, { bonds, currentAuthorities: current,
    currentGeneration: 0, currentHeight: 10, networkId }), /one-third old\/new overlap/);

  const overlappingWallets = [oldWallets[0], oldWallets[1], newWallets[0], newWallets[1]];
  const overlapping = [current[0], current[1], next[0], next[1]];
  const proposal = createBeaconRotationProposal({ activationHeight: 74, authorities: overlapping,
    generation: 1, networkId, previousAuthorities: current });
  const validBonds = new Map(overlapping.map(({ address }) => [address, MIN_BEACON_BOND]));
  const valid = { ...proposal, oldApprovals: approvals(proposal, oldWallets.slice(0, 3), "old"),
    possessionProofs: approvals(proposal, overlappingWallets, "possession") };
  assert.throws(() => verifyBeaconRotation({ ...valid,
    oldApprovals: approvals(proposal, oldWallets.slice(0, 2), "old") }, {
    bonds: validBonds, currentAuthorities: current, currentGeneration: 0,
    currentHeight: 10, networkId,
  }), /old beacon rotation approval quorum/);
  assert.throws(() => verifyBeaconRotation({ ...valid,
    possessionProofs: valid.possessionProofs.slice(0, 3) }, {
    bonds: validBonds, currentAuthorities: current, currentGeneration: 0,
    currentHeight: 10, networkId,
  }), /new beacon possession proof quorum/);
  validBonds.set(overlapping[3].address, 999n * ATOMIC_UNITS);
  assert.throws(() => verifyBeaconRotation(valid, { bonds: validBonds,
    currentAuthorities: current, currentGeneration: 0, currentHeight: 10, networkId,
  }), /bond is below minimum/);
});

test("retired beacon bonds recycle slots without recycling identities", () => {
  const { beacons, chain, genesis, treasury, validators } = fixture();
  const replacements = Array.from({ length: 2 }, generateWallet);
  const funded = [...beacons, ...replacements];
  append(chain, validators, { transactions: funded.map((wallet, index) => createTransfer({
    wallet: treasury, networkId: chain.networkId, recipient: wallet.address,
    amount: (MIN_BEACON_BOND + MIN_TRANSFER_FEE).toString(), nonce: index,
  })) });
  append(chain, validators, { transactions: [
    ...beacons.map((wallet) => createBeaconBond({ wallet, networkId: chain.networkId,
      amount: MIN_BEACON_BOND.toString(), nonce: 0 })),
    ...replacements.map((wallet, index) => createBeaconBond({ wallet, networkId: chain.networkId,
      amount: MIN_BEACON_BOND.toString(), nonce: 0, operatorId: `replacement-beacon-${index}` })),
  ] });
  const current = members(beacons, "beacon");
  const nextWallets = [beacons[0], beacons[1], ...replacements];
  const next = [current[0], current[1], ...members(replacements, "replacement-beacon")];
  const proposal = createBeaconRotationProposal({
    activationHeight: chain.height + BEACON_ROTATION_DELAY_BLOCKS,
    authorities: next, generation: 1, networkId: chain.networkId,
    previousAuthorities: current,
  });
  const rotation = { ...proposal,
    oldApprovals: approvals(proposal, beacons.slice(0, 3), "old"),
    possessionProofs: approvals(proposal, nextWallets, "possession") };
  append(chain, validators, { beaconRotation: rotation });
  const scheduledRoot = chain.stateRoot;
  const prematureRetirement = chain.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: [createBeaconRetirement({ wallet: beacons[2], networkId: chain.networkId,
      nonce: 1 })] });
  assert.throws(() => chain.appendBlock(finalizeBlock(
    prematureRetirement, quorum(prematureRetirement, validators),
  )), /still referenced/);
  assert.equal(chain.stateRoot, scheduledRoot);
  assert.equal(chain.nextNonce(beacons[2].address), 1);
  const pendingMemberRetirement = chain.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: [createBeaconRetirement({ wallet: replacements[0], networkId: chain.networkId,
      nonce: 1 })] });
  assert.throws(() => chain.appendBlock(finalizeBlock(
    pendingMemberRetirement, quorum(pendingMemberRetirement, validators),
  )), /still referenced/);
  while (chain.height < proposal.activationHeight) append(chain, validators);

  const retiring = beacons.slice(2);
  const secondProposal = createBeaconRotationProposal({
    activationHeight: chain.height + BEACON_ROTATION_DELAY_BLOCKS,
    authorities: next, generation: 2, networkId: chain.networkId,
    previousAuthorities: next,
  });
  const secondRotation = { ...secondProposal,
    oldApprovals: approvals(secondProposal, nextWallets.slice(0, 3), "old"),
    possessionProofs: approvals(secondProposal, nextWallets, "possession") };
  const mixedRotation = chain.buildBlock({ beaconRotation: secondRotation,
    timestamp: TREASURY_VESTING_MS,
    transactions: [createBeaconRetirement({ wallet: retiring[0],
      networkId: chain.networkId, nonce: 1 })] });
  assert.throws(() => chain.appendBlock(finalizeBlock(
    mixedRotation, quorum(mixedRotation, validators),
  )), /require separate blocks/);
  const mixedLifecycle = chain.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: [
      createBeaconRetirement({ wallet: retiring[0], networkId: chain.networkId, nonce: 1 }),
      createBeaconBond({ wallet: retiring[0], networkId: chain.networkId,
        amount: "1", nonce: 2 }),
    ] });
  assert.throws(() => chain.appendBlock(finalizeBlock(
    mixedLifecycle, quorum(mixedLifecycle, validators),
  )), /require separate blocks/);
  append(chain, validators, { transactions: retiring.map((wallet) =>
    createBeaconRetirement({ wallet, networkId: chain.networkId, nonce: 1 })) });
  const requested = chain.beaconAuthorityStatus().pendingRetirements;
  assert.equal(requested.length, 2);
  assert.equal(requested[0].unlockHeight - requested[0].requestedHeight,
    BEACON_RETIREMENT_DELAY_BLOCKS);

  const pendingSnapshot = chain.consensusSnapshot();
  const checkpoint = chain.blocks().at(-1);
  const restarted = NirChain.fromVerifiedSnapshot(genesis, {
    capabilityMemory: pendingSnapshot.capabilityMemory,
    checkpoint, height: chain.height, networkId: chain.networkId,
    state: pendingSnapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
  });
  const fork = restarted.fork();
  const unlockHeight = requested[0].unlockHeight;
  while (restarted.height < unlockHeight) append(restarted, validators);
  while (fork.height < unlockHeight) append(fork, validators);
  assert.equal(restarted.stateRoot, fork.stateRoot);
  assert.equal(restarted.beaconAuthorityStatus().registeredCount, 4);
  assert.equal(restarted.beaconAuthorityStatus().retiredCount, 2);
  assert.equal(restarted.beaconAuthorityStatus().pendingRetirements.length, 0);
  for (const wallet of retiring) {
    assert.equal(restarted.balance(wallet.address), MIN_BEACON_BOND - MIN_TRANSFER_FEE);
    assert.equal(restarted.beaconBond(wallet.address), 0n);
  }
  const retiredState = restarted.consensusSnapshot().state;
  assert.equal(retiredState.retiredBeaconAuthorities.length, 2);
  assert.equal(retiredState.retiredBeaconAuthorities.every(([, record]) =>
    /^[0-9a-f]{64}$/.test(record.identityCommitment)), true);
  const tamperedHistory = structuredClone({
    capabilityMemory: restarted.consensusSnapshot().capabilityMemory,
    checkpoint: restarted.blocks().at(-1), height: restarted.height,
    networkId: restarted.networkId, state: retiredState,
    stateRoot: restarted.stateRoot, tipHash: restarted.tipHash,
  });
  tamperedHistory.state.retiredBeaconAuthorities[0][1].operatorId = "rewritten-history";
  tamperedHistory.stateRoot = computeChainStateRoot(tamperedHistory.state);
  tamperedHistory.checkpoint.stateRoot = tamperedHistory.stateRoot;
  tamperedHistory.checkpoint.hash = blockHash(tamperedHistory.checkpoint);
  tamperedHistory.tipHash = tamperedHistory.checkpoint.hash;
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesis, tamperedHistory),
    /retired beacon authority snapshot is invalid/);
  const conserved = retiredState.balances.reduce((sum, [, amount]) => sum + BigInt(amount), 0n) +
    retiredState.evaluatorBonds.reduce((sum, [, amount]) => sum + BigInt(amount), 0n) +
    retiredState.beaconBonds.reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
  assert.equal(conserved + restarted.burned, restarted.issued);

  const replayedKey = restarted.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: [createBeaconBond({ wallet: retiring[0], networkId: restarted.networkId,
      amount: MIN_BEACON_BOND.toString(), nonce: 2, operatorId: "replayed-beacon" })] });
  assert.throws(() => restarted.appendBlock(finalizeBlock(
    replayedKey, quorum(replayedKey, validators),
  )), /invalid or duplicated/);
  const reusedOperator = generateWallet();
  const replayedOperator = restarted.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: [createBeaconBond({ wallet: reusedOperator, networkId: restarted.networkId,
      amount: MIN_BEACON_BOND.toString(), nonce: 0, operatorId: "beacon-2" })] });
  assert.throws(() => restarted.appendBlock(finalizeBlock(
    replayedOperator, quorum(replayedOperator, validators),
  )), /invalid or duplicated/);
  const validatorReplay = restarted.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: [createValidatorBond({ wallet: retiring[0], networkId: restarted.networkId,
      amount: "1", nonce: 2, operatorId: "replayed-validator" })] });
  assert.throws(() => restarted.appendBlock(finalizeBlock(
    validatorReplay, quorum(validatorReplay, validators),
  )), /invalid or duplicated/);
  const evaluatorReplay = restarted.buildBlock({ timestamp: TREASURY_VESTING_MS,
    transactions: [createEvaluatorBond({ wallet: retiring[0], networkId: restarted.networkId,
      amount: "1", nonce: 2, operatorId: "replayed-evaluator", credentials: [],
      activationHeight: restarted.height + 64 })] });
  assert.throws(() => restarted.appendBlock(finalizeBlock(
    evaluatorReplay, quorum(evaluatorReplay, validators),
  )), /registration is invalid/);
  assert.equal(MAX_REGISTERED_BEACON_AUTHORITIES, 128);
});

test("bounded registry model supports more than 64 cumulative replacements", () => {
  let nextIdentity = 64;
  const active = new Set(Array.from({ length: 64 }, (_, index) => index));
  const registered = new Set(active);
  const retired = new Set();
  let seed = 0x5eed1234;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let generation = 1; generation <= 96; generation += 1) {
    const candidates = [...active].sort((left, right) => left - right);
    const retirementStart = random() % candidates.length;
    const retiring = Array.from({ length: 42 }, (_, offset) =>
      candidates[(retirementStart + offset) % candidates.length]);
    const replacements = Array.from({ length: 42 }, () => nextIdentity++);
    for (const replacement of replacements) registered.add(replacement);
    assert.equal(registered.size <= MAX_REGISTERED_BEACON_AUTHORITIES, true);
    for (const identity of retiring) { active.delete(identity); retired.add(identity); }
    for (const replacement of replacements) active.add(replacement);
    for (const identity of retiring) registered.delete(identity);
    assert.equal(active.size, 64);
    assert.equal(registered.size, 64);
    assert.equal([...active].some((identity) => retired.has(identity)), false);
  }
  assert.equal(retired.size, 96 * 42);
  assert.equal(nextIdentity, 64 + 96 * 42);
});
