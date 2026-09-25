import assert from "node:assert/strict";
import test from "node:test";

import {
  NirChain, blockHash, computeChainStateRoot, createCandidateBond, createTransfer, createValidatorBond,
  createValidatorExitRequest, createValidatorWithdrawalClaim, finalizeBlock,
  voteForBlock,
} from "../blockchain/chain.mjs";
import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS,
  VALIDATOR_WITHDRAWAL_DELAY_BLOCKS,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import {
  createReleaseAuthoritySet, createReleaseTransparencyAnchor,
} from "../blockchain/offline-release-governance.mjs";
import {
  approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload,
} from "../blockchain/protocol-upgrade-authorization.mjs";
import {
  assembleValidatorPrepareEquivocationEvidence, createValidatorEquivocationTransaction,
} from "../blockchain/validator-equivocation.mjs";
import { createRandomnessCommit } from "../blockchain/operators.mjs";
import {
  createValidatorRecoveryPlan, createValidatorRecoveryPlanTransaction,
  VALIDATOR_RECOVERY_DELAY_BLOCKS,
} from "../blockchain/validator-recovery.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));

function releaseEntry(chain, authoritySet, releaseWallets, targetVersion) {
  const bundleHashFor = (version) =>
    `sha3-256:${String(version).padStart(64, "a").slice(-64)}`;
  const payload = {
    bundleHash: bundleHashFor(targetVersion),
    manifestHash: `sha3-256:${String(targetVersion).padStart(64, "b").slice(-64)}`,
    networkId: chain.networkId,
    previousBundleHash: targetVersion === 29 ? null : bundleHashFor(targetVersion - 1),
    protocolVersion: targetVersion,
    releaseVersion: `0.${targetVersion}.0`,
    sourceRevision: String(targetVersion).padStart(40, "c").slice(-40),
  };
  const proposal = {
    activeSetId: authoritySet.setId, format: "nir-release-log-proposal-v1",
    logId: "nir-protocol-releases", networkId: chain.networkId, payload,
    previousEntryHash: chain.protocolReleaseHead.entryHash,
    sequence: chain.protocolReleaseHead.sequence + 1, type: "release", version: 1,
  };
  proposal.proposalHash = `sha3-256:${hashObject(proposal, "RELEASE_LOG_PROPOSAL_V1")}`;
  const approvals = releaseWallets.slice(0, authoritySet.threshold).map((wallet, index) => ({
    address: wallet.address, format: "nir-release-governance-approval-v1",
    operatorId: `release-${index}`, proposalHash: proposal.proposalHash, role: "active",
    setId: authoritySet.setId,
    signature: signObject({ proposalHash: proposal.proposalHash, sequence: proposal.sequence,
      role: "active", setId: authoritySet.setId }, wallet, "RELEASE_GOVERNANCE_APPROVAL_V1"),
    version: 1,
  }));
  const unsigned = {
    activeSetId: authoritySet.setId, activationApprovals: [], approvals,
    format: "nir-release-transparency-entry-v1", logId: proposal.logId,
    networkId: chain.networkId, nextSetAcceptances: [], payload,
    previousEntryHash: proposal.previousEntryHash, proposalHash: proposal.proposalHash,
    sequence: proposal.sequence, type: "release", version: 1,
  };
  return { ...unsigned,
    entryHash: `sha3-256:${hashObject(unsigned, "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
}

function authorizedUpgrade(chain, authoritySet, releaseWallets, targetVersion, activationHeight) {
  const entry = releaseEntry(chain, authoritySet, releaseWallets, targetVersion);
  const payload = createProtocolUpgradeAuthorizationPayload({
    activationHeight, authoritySetId: authoritySet.setId, baseHeight: chain.height,
    baseTipHash: chain.tipHash, bundleHash: entry.payload.bundleHash,
    chainIdentityGenesisHash: chain.blocks()[0].hash, currentVersion: chain.protocolVersion,
    entryHash: entry.entryHash, manifestHash: entry.payload.manifestHash,
    networkId: chain.networkId, releaseVersion: entry.payload.releaseVersion,
    sourceRevision: entry.payload.sourceRevision, targetVersion,
  });
  const approvals = releaseWallets.slice(0, authoritySet.threshold).map((wallet, index) =>
    approveProtocolUpgradeAuthorization(payload, authoritySet, {
      operatorId: `release-${index}`, wallet,
    })).sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  return { activationHeight,
    authorization: assembleProtocolUpgradeAuthorization(payload, entry, approvals),
    format: "nir-protocol-upgrade-v2", version: targetVersion };
}

function quorumFor(proposal, wallets) {
  const proposer = wallets.find(({ address }) => address === proposal.proposer);
  assert.ok(proposer);
  return [proposer, ...wallets.filter((wallet) => wallet !== proposer)]
    .slice(0, Math.floor(wallets.length * 2 / 3) + 1);
}

function append(chain, options, wallets) {
  const proposal = chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1, ...options,
  });
  const block = finalizeBlock(proposal, quorumFor(proposal, wallets));
  chain.appendBlock(block);
  return block;
}

function fixture(targetProtocolVersion = 30) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const releaseWallets = Array.from({ length: 4 }, generateWallet);
  const beaconAuthorities = Array.from({ length: 4 }, generateWallet);
  const authoritySet = createReleaseAuthoritySet({
    authorities: members(releaseWallets, "release"), generation: 1,
    rotationDelayEntries: 2, threshold: 3,
  });
  const networkId = "nir-validator-exit-v30-test";
  const anchor = createReleaseTransparencyAnchor({
    initialSet: authoritySet, logId: "nir-protocol-releases", networkId,
  });
  const genesis = {
    beaconAuthorities: members(beaconAuthorities, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 },
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisProtocolVersion: 27, genesisTimestamp: 0, networkId,
    protocolUpgradeReleaseAnchor: anchor,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address, validators: members(validators, "validator"),
  };
  const chain = new NirChain(genesis);
  append(chain, {}, validators);
  for (const targetVersion of [28, 29, 30].filter((version) =>
    version <= targetProtocolVersion)) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    const protocolUpgrade = targetVersion === 28
      ? { activationHeight, format: "nir-protocol-upgrade-v1", version: 28 }
      : authorizedUpgrade(chain, authoritySet, releaseWallets, targetVersion, activationHeight);
    append(chain, { protocolUpgrade }, validators);
    while (chain.height < activationHeight) append(chain, {}, validators);
  }
  return { authoritySet, beaconAuthorities, chain, genesis, releaseWallets, treasury, validators };
}

function restoreWithState(chain, genesis, state) {
  const stateRoot = computeChainStateRoot(state);
  const snapshot = chain.consensusSnapshot();
  return NirChain.fromVerifiedSnapshot(genesis, {
    capabilityMemory: snapshot.capabilityMemory,
    checkpoint: { ...chain.blocks().at(-1), stateRoot },
    evaluationAssignmentRoot: state.evaluationAssignmentRoot,
    height: chain.height,
    networkId: chain.networkId,
    recoveryStateCommitment: state.recoveryStateCommitment,
    state,
    stateRoot,
    tipHash: chain.tipHash,
    validatorSetId: chain.validatorSetId,
  });
}

function fundAndBond(chain, treasury, validators, wallets) {
  append(chain, {
    timestamp: TREASURY_VESTING_MS,
    transactions: wallets.map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE * 4n).toString(), networkId: chain.networkId,
      nonce, recipient: wallet.address, wallet: treasury,
    })),
  }, validators);
  append(chain, { transactions: wallets.map((wallet, index) => createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0,
    ...(validators.includes(wallet) ? {} : { operatorId: `candidate-${index}` }), wallet,
  })) }, validators);
}

test("active exit starts cooldown only after exclusion and remains slashable", () => {
  const { chain, treasury, validators } = fixture();
  const newcomer = generateWallet();
  fundAndBond(chain, treasury, validators, [...validators, newcomer]);
  const exiting = validators[0];
  append(chain, { transactions: [createValidatorExitRequest({
    networkId: chain.networkId, nonce: 1, wallet: exiting,
  })] }, validators);
  assert.deepEqual(chain.validatorExit(exiting.address), {
    address: exiting.address, exclusionHeight: null,
    requestedHeight: chain.height, unlockHeight: null,
  });
  assert.throws(() => chain.buildBlock({ validatorRotation: {
    activationHeight: chain.height + 5,
    validators: chain.validatorMembers,
  } }), /exiting or retired/);

  const nextWallets = [...validators.slice(1), newcomer];
  const nextMembers = [
    ...chain.validatorMembers.filter(({ address }) => address !== exiting.address),
    { ...publicWallet(newcomer), operatorId: "candidate-4" },
  ];
  const activationHeight = chain.height + 5;
  append(chain, { validatorRotation: { activationHeight, validators: nextMembers } }, validators);
  while (chain.height + 1 < activationHeight) append(chain, {}, validators);
  const first = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
  const second = chain.buildBlock({ timestamp: first.timestamp + 1 });
  const evidence = assembleValidatorPrepareEquivocationEvidence({
    first: { blockHash: blockHash(first), header: chain.finalityHeaderForProposal(first),
      signature: voteForBlock(first, exiting).signature },
    second: { blockHash: blockHash(second), header: chain.finalityHeaderForProposal(second),
      signature: voteForBlock(second, exiting).signature },
    height: first.height, networkId: chain.networkId, round: first.round,
    validator: exiting.address,
  });
  const activation = finalizeBlock(first, [...validators, newcomer]);
  chain.appendBlock(activation);
  assert.deepEqual(chain.validatorExit(exiting.address), {
    address: exiting.address, exclusionHeight: activationHeight,
    requestedHeight: activationHeight - 5,
    unlockHeight: activationHeight + VALIDATOR_WITHDRAWAL_DELAY_BLOCKS,
  });
  append(chain, { transactions: [createValidatorEquivocationTransaction({
    evidence, networkId: chain.networkId, nonce: chain.nextNonce(treasury.address),
    wallet: treasury,
  })] }, nextWallets);
  assert.equal(chain.validatorBond(exiting.address), 0n);
  assert.throws(() => append(chain, { transactions: [createValidatorWithdrawalClaim({
    networkId: chain.networkId, nonce: 2, wallet: exiting,
  })] }, nextWallets), /not finalized or mature/);
  while (chain.height < activationHeight + VALIDATOR_WITHDRAWAL_DELAY_BLOCKS) {
    append(chain, {}, nextWallets);
  }
  append(chain, { transactions: [createValidatorWithdrawalClaim({
    networkId: chain.networkId, nonce: 2, wallet: exiting,
  })] }, nextWallets);
  assert.equal(chain.validatorRetired(exiting.address), true);
  assert.equal(chain.validatorExit(exiting.address), null);
  assert.equal(chain.validatorBond(exiting.address), 0n);
  assert.throws(() => append(chain, { transactions: [createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 3,
    operatorId: "validator-reused", wallet: exiting,
  })] }, nextWallets), /retired validator identity/);
});

test("inactive bonded candidate exits immediately, survives restart, and conserves supply", () => {
  const { chain, genesis, treasury, validators } = fixture();
  const candidate = generateWallet();
  fundAndBond(chain, treasury, validators, [candidate]);
  const issued = chain.issued;
  const burned = chain.burned;
  const before = chain.balance(candidate.address);
  append(chain, { transactions: [createValidatorExitRequest({
    networkId: chain.networkId, nonce: 1, wallet: candidate,
  })] }, validators);
  const pending = chain.validatorExit(candidate.address);
  assert.equal(pending.exclusionHeight, chain.height);
  assert.equal(pending.unlockHeight, chain.height + VALIDATOR_WITHDRAWAL_DELAY_BLOCKS);
  const snapshot = chain.consensusSnapshot();
  const restored = NirChain.fromVerifiedSnapshot(genesis, {
    capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1), evaluationAssignmentRoot: chain.evaluationAssignmentRoot,
    height: chain.height, networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment,
    state: snapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
    validatorSetId: chain.validatorSetId,
  });
  while (restored.height < pending.unlockHeight) append(restored, {}, validators);
  append(restored, { transactions: [createValidatorWithdrawalClaim({
    networkId: restored.networkId, nonce: 2, wallet: candidate,
  })] }, validators);
  assert.equal(restored.balance(candidate.address), before - MIN_TRANSFER_FEE * 2n + MIN_VALIDATOR_BOND);
  assert.equal(restored.issued, issued);
  assert.equal(restored.burned, burned);
  assert.equal(restored.validatorRetired(candidate.address), true);
  const root = restored.stateRoot;
  assert.throws(() => append(restored, { transactions: [createValidatorWithdrawalClaim({
    networkId: restored.networkId, nonce: 2, wallet: candidate,
  })] }, validators), /not finalized or mature/);
  assert.equal(restored.stateRoot, root);
});

test("exit envelopes, fees, replay, top-up and same-block rotation fail atomically", () => {
  const { chain, treasury, validators } = fixture();
  const candidate = generateWallet();
  fundAndBond(chain, treasury, validators, [...validators, candidate]);
  const reject = (options, pattern, wallets = validators) => {
    const root = chain.stateRoot;
    assert.throws(() => append(chain, options, wallets), pattern);
    assert.equal(chain.stateRoot, root);
  };
  reject({ transactions: [createValidatorExitRequest({
    networkId: "foreign-network", nonce: 1, wallet: candidate,
  })] }, /lifecycle transaction/);
  reject({ transactions: [createValidatorExitRequest({
    fee: "0", networkId: chain.networkId, nonce: 1, wallet: candidate,
  })] }, /fee is invalid/);
  const request = createValidatorExitRequest({
    networkId: chain.networkId, nonce: 1, wallet: candidate,
  });
  append(chain, { transactions: [request] }, validators);
  reject({ transactions: [request] }, /unknown, retired, or already pending|unexpected nonce/);
  reject({ transactions: [createValidatorBond({
    amount: "1", networkId: chain.networkId, nonce: 2, wallet: candidate,
  })] }, /exiting validator identity/);
  reject({ transactions: [createCandidateBond({
    amount: "1", candidateId: "e".repeat(64), networkId: chain.networkId,
    nonce: 2, wallet: candidate,
  })] }, /cannot create a protocol obligation/);
  reject({ transactions: [createValidatorWithdrawalClaim({
    networkId: chain.networkId, nonce: 2, wallet: candidate,
  })] }, /not finalized or mature/);

  const activeRequest = createValidatorExitRequest({
    networkId: chain.networkId, nonce: 1, wallet: validators[0],
  });
  reject({
    transactions: [activeRequest],
    validatorRotation: {
      activationHeight: chain.height + 5,
      validators: chain.validatorMembers,
    },
  }, /lifecycle conflicts with membership transition/);
});

test("an outstanding randomness commitment blocks an exit request", () => {
  const { chain, treasury, validators } = fixture();
  fundAndBond(chain, treasury, validators, validators);
  const candidateId = "d".repeat(64);
  append(chain, { transactions: [createCandidateBond({
    amount: "1", candidateId, networkId: chain.networkId,
    nonce: chain.nextNonce(treasury.address), wallet: treasury,
  })] }, validators);
  append(chain, { randomnessCommits: [createRandomnessCommit({
    candidateId, networkId: chain.networkId, secret: "c".repeat(64),
    wallet: validators[0],
  })] }, validators);
  const root = chain.stateRoot;
  assert.throws(() => append(chain, { transactions: [createValidatorExitRequest({
    networkId: chain.networkId, nonce: 1, wallet: validators[0],
  })] }, validators), /unknown, retired, or already pending/);
  assert.equal(chain.stateRoot, root);
});

test("pre-existing rotation and recovery obligations block exit and withdrawal", () => {
  {
    const { chain, treasury, validators } = fixture();
    const candidate = generateWallet();
    fundAndBond(chain, treasury, validators, [...validators, candidate]);
    const next = [
      ...chain.validatorMembers.slice(1),
      { ...publicWallet(candidate), operatorId: "candidate-0" },
    ];
    append(chain, { validatorRotation: {
      activationHeight: chain.height + 20, validators: next,
    } }, validators);
    const root = chain.stateRoot;
    assert.throws(() => append(chain, { transactions: [createValidatorExitRequest({
      networkId: chain.networkId, nonce: 1, wallet: candidate,
    })] }, validators), /unknown, retired, or already pending/);
    assert.throws(() => append(chain, { transactions: [createValidatorWithdrawalClaim({
      networkId: chain.networkId, nonce: 1, wallet: candidate,
    })] }, validators), /not finalized or mature/);
    assert.equal(chain.stateRoot, root);
  }

  {
    const { chain, treasury, validators } = fixture();
    const reserves = Array.from({ length: 4 }, generateWallet);
    fundAndBond(chain, treasury, validators, reserves);
    const scheduledHeight = chain.height + 1;
    const reserveMembers = members(reserves, "candidate");
    const plan = createValidatorRecoveryPlan({
      activationHeight: scheduledHeight + VALIDATOR_RECOVERY_DELAY_BLOCKS,
      activeValidators: chain.validatorMembers,
      generation: 1,
      networkId: chain.networkId,
      reserveWallets: reserves.map((wallet, index) => ({
        member: reserveMembers[index], wallet,
      })),
      scheduledHeight,
    });
    append(chain, { transactions: [createValidatorRecoveryPlanTransaction({
      networkId: chain.networkId,
      nonce: chain.nextNonce(treasury.address),
      plan,
      wallet: treasury,
    })] }, validators);
    const reserve = reserves[0];
    const root = chain.stateRoot;
    assert.throws(() => append(chain, { transactions: [createValidatorExitRequest({
      networkId: chain.networkId, nonce: 1, wallet: reserve,
    })] }, validators), /unknown, retired, or already pending/);
    assert.throws(() => append(chain, { transactions: [createValidatorWithdrawalClaim({
      networkId: chain.networkId, nonce: 1, wallet: reserve,
    })] }, validators), /not finalized or mature/);
    assert.equal(chain.stateRoot, root);
  }
});

test("v30 snapshot invariants reject impossible exits and retired identity reuse", () => {
  const active = fixture();
  fundAndBond(active.chain, active.treasury, active.validators, active.validators);
  append(active.chain, { transactions: [createValidatorExitRequest({
    networkId: active.chain.networkId, nonce: 1, wallet: active.validators[0],
  })] }, active.validators);
  const inconsistentMembership = structuredClone(active.chain.consensusSnapshot().state);
  const pending = inconsistentMembership.pendingValidatorExits.find(
    ([address]) => address === active.validators[0].address)[1];
  pending.exclusionHeight = active.chain.height;
  pending.unlockHeight = active.chain.height + VALIDATOR_WITHDRAWAL_DELAY_BLOCKS;
  assert.throws(() => restoreWithState(active.chain, active.genesis, inconsistentMembership),
    /membership is inconsistent/);

  const retired = fixture();
  const candidate = generateWallet();
  fundAndBond(retired.chain, retired.treasury, retired.validators, [candidate]);
  append(retired.chain, { transactions: [createValidatorExitRequest({
    networkId: retired.chain.networkId, nonce: 1, wallet: candidate,
  })] }, retired.validators);
  const unlockHeight = retired.chain.validatorExit(candidate.address).unlockHeight;
  while (retired.chain.height < unlockHeight) append(retired.chain, {}, retired.validators);
  append(retired.chain, { transactions: [createValidatorWithdrawalClaim({
    networkId: retired.chain.networkId, nonce: 2, wallet: candidate,
  })] }, retired.validators);

  const bondedRetired = structuredClone(retired.chain.consensusSnapshot().state);
  bondedRetired.validatorBonds.push([candidate.address, "1"]);
  assert.throws(() => restoreWithState(retired.chain, retired.genesis, bondedRetired),
    /retired validator snapshot is invalid/);

  const disabledRetired = structuredClone(retired.chain.consensusSnapshot().state);
  disabledRetired.disabledValidators.push(candidate.address);
  assert.throws(() => restoreWithState(retired.chain, retired.genesis, disabledRetired),
    /retired validator snapshot is invalid/);

  const reusedIdentity = structuredClone(retired.chain.consensusSnapshot().state);
  const tombstone = reusedIdentity.retiredValidators[0][1];
  tombstone.operatorId = reusedIdentity.registeredValidators[0][1].operatorId;
  assert.throws(() => restoreWithState(retired.chain, retired.genesis, reusedIdentity),
    /retired validator identity is reused/);
});

test("v29 schema remains unchanged and v30 activation commits empty lifecycle maps", () => {
  const { authoritySet, chain, genesis, releaseWallets, validators } = fixture(29);
  const before = chain.consensusSnapshot();
  assert.equal(Object.hasOwn(before.state, "pendingValidatorExits"), false);
  assert.equal(Object.hasOwn(before.state, "retiredValidators"), false);
  assert.equal(computeChainStateRoot(before.state), chain.stateRoot);

  const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, { protocolUpgrade: authorizedUpgrade(
    chain, authoritySet, releaseWallets, 30, activationHeight,
  ) }, validators);
  while (chain.height < activationHeight) append(chain, {}, validators);
  const after = chain.consensusSnapshot();
  assert.deepEqual(after.state.pendingValidatorExits, []);
  assert.deepEqual(after.state.retiredValidators, []);
  assert.equal(computeChainStateRoot(after.state), chain.stateRoot);
  assert.doesNotThrow(() => restoreWithState(chain, genesis, after.state));
});
