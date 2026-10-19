import assert from "node:assert/strict";
import test from "node:test";

import {
  NirChain, createProofAnswerCommit, createProofAnswerReveal, createTransfer, finalizeBlock,
} from "../blockchain/chain.mjs";
import { cliqueEdge, cliqueSearchParameters } from "../blockchain/clique-search.mjs";
import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, MIN_REWARD_INTERVAL_MS, PROGRESS_REWARD_ESCROW_DELAY_BLOCKS,
  PROOF_MINING_PROTOCOL_VERSION, SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS, scheduledEpochBudget,
  LEGACY_INITIAL_EPOCH_REWARD,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { createReleaseAuthoritySet, createReleaseTransparencyAnchor }
  from "../blockchain/offline-release-governance.mjs";
import { createEpochRandomnessCommit, createEpochRandomnessReveal } from "../blockchain/operators.mjs";
import { PROOF_MINING_V1, proofAnswerCommitment } from "../blockchain/proof-mining-state.mjs";
import { approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload } from "../blockchain/protocol-upgrade-authorization.mjs";

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));
const quorumFor = (proposal, wallets) => [
  wallets.find(({ address }) => address === proposal.proposer),
  ...wallets.filter(({ address }) => address !== proposal.proposer),
].slice(0, Math.floor(wallets.length * 2 / 3) + 1);

function append(chain, options, wallets) {
  const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1, ...options });
  const block = finalizeBlock(proposal, quorumFor(proposal, wallets));
  chain.appendBlock(block);
  return block;
}

function releaseEntry(chain, set, wallets, version) {
  const bundle = (value) => `sha3-256:${String(value).padStart(64, "a").slice(-64)}`;
  const payload = { bundleHash: bundle(version), manifestHash: `sha3-256:${String(version)
    .padStart(64, "b").slice(-64)}`, networkId: chain.networkId,
    previousBundleHash: version === 29 ? null : bundle(version - 1), protocolVersion: version,
    releaseVersion: `0.${version}.0`, sourceRevision: String(version).padStart(40, "c").slice(-40) };
  const proposal = { activeSetId: set.setId, format: "nir-release-log-proposal-v1",
    logId: "nir-protocol-releases", networkId: chain.networkId, payload,
    previousEntryHash: chain.protocolReleaseHead.entryHash,
    sequence: chain.protocolReleaseHead.sequence + 1, type: "release", version: 1 };
  proposal.proposalHash = `sha3-256:${hashObject(proposal, "RELEASE_LOG_PROPOSAL_V1")}`;
  const approvals = wallets.slice(0, set.threshold).map((wallet, index) => ({
    address: wallet.address, format: "nir-release-governance-approval-v1",
    operatorId: `release-${index}`, proposalHash: proposal.proposalHash, role: "active",
    setId: set.setId, signature: signObject({ proposalHash: proposal.proposalHash,
      sequence: proposal.sequence, role: "active", setId: set.setId }, wallet,
    "RELEASE_GOVERNANCE_APPROVAL_V1"), version: 1 }));
  const unsigned = { activeSetId: set.setId, activationApprovals: [], approvals,
    format: "nir-release-transparency-entry-v1", logId: proposal.logId,
    networkId: chain.networkId, nextSetAcceptances: [], payload,
    previousEntryHash: proposal.previousEntryHash, proposalHash: proposal.proposalHash,
    sequence: proposal.sequence, type: "release", version: 1 };
  return { ...unsigned, entryHash: `sha3-256:${hashObject(unsigned, "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
}

function authorizedUpgrade(chain, set, wallets, targetVersion, activationHeight) {
  const entry = releaseEntry(chain, set, wallets, targetVersion);
  const payload = createProtocolUpgradeAuthorizationPayload({ activationHeight,
    authoritySetId: set.setId, baseHeight: chain.height, baseTipHash: chain.tipHash,
    bundleHash: entry.payload.bundleHash, chainIdentityGenesisHash: chain.blocks()[0].hash,
    currentVersion: chain.protocolVersion, entryHash: entry.entryHash,
    manifestHash: entry.payload.manifestHash, networkId: chain.networkId,
    releaseVersion: entry.payload.releaseVersion, sourceRevision: entry.payload.sourceRevision,
    targetVersion });
  const approvals = wallets.slice(0, set.threshold).map((wallet, index) =>
    approveProtocolUpgradeAuthorization(payload, set, { operatorId: `release-${index}`, wallet }))
    .sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  return { activationHeight, authorization: assembleProtocolUpgradeAuthorization(
    payload, entry, approvals), format: "nir-protocol-upgrade-v2", version: targetVersion };
}

// A v27 genesis upgraded step by step to `targetVersion`, with a funded miner.
function fixture(targetVersion = PROOF_MINING_PROTOCOL_VERSION) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const miner = generateWallet();
  const releases = Array.from({ length: 4 }, generateWallet);
  const set = createReleaseAuthoritySet({ authorities: members(releases, "release"), generation: 1,
    rotationDelayEntries: 2, threshold: 3 });
  const networkId = "nir-proof-mining-test";
  const genesis = { beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 }, evaluators: members(Array.from({ length: 4 }, generateWallet), "eval"),
    genesisProtocolVersion: 27, genesisTimestamp: 0, networkId,
    protocolUpgradeReleaseAnchor: createReleaseTransparencyAnchor({ initialSet: set,
      logId: "nir-protocol-releases", networkId }),
    // The easiest level, where plain backtracking finds a clique at once.
    proofMiningInitialLevel: 0,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT], treasuryAddress: treasury.address,
    validators: members(validators, "validator") };
  const chain = new NirChain(genesis);
  append(chain, { timestamp: TREASURY_VESTING_MS, transactions: [createTransfer({
    amount: "100000000", networkId, nonce: 0, recipient: miner.address, wallet: treasury,
  })] }, validators);
  for (const version of [28, 29, 30, 31, 32, 33, 34, 35].filter((v) => v <= targetVersion)) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(chain, { protocolUpgrade: version === 28
      ? { activationHeight, format: "nir-protocol-upgrade-v1", version }
      : authorizedUpgrade(chain, set, releases, version, activationHeight) }, validators);
    while (chain.height < activationHeight) append(chain, {}, validators);
  }
  return { beacons, chain, genesis, miner, validators };
}

// One beacon round: a commit block and a reveal block.
function finalizeBeaconRound(chain, beacons, validators) {
  const status = chain.epochRandomnessStatus();
  const committee = status.committee.map((address) => beacons.find((w) => w.address === address));
  const secrets = committee.map((_, i) => hashObject({ i, round: status.round }, "TEST_SECRET"));
  append(chain, { epochRandomnessCommits: committee.map((wallet, i) => createEpochRandomnessCommit({
    networkId: chain.networkId, round: status.round, secret: secrets[i], wallet })) }, validators);
  append(chain, { epochRandomnessReveals: committee.map((wallet, i) => createEpochRandomnessReveal({
    networkId: chain.networkId, round: status.round, secret: secrets[i], wallet })) }, validators);
  return status.round;
}

function findClique(seed, level) {
  const { n, k } = cliqueSearchParameters(level);
  const adjacent = Array.from({ length: n }, () => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (cliqueEdge(seed, n, i, j)) adjacent[i][j] = adjacent[j][i] = 1;
  }
  const extend = (chosen, candidates) => {
    if (chosen.length === k) return chosen;
    if (chosen.length + candidates.length < k) return null;
    for (let x = 0; x < candidates.length; x++) {
      const v = candidates[x];
      const found = extend([...chosen, v], candidates.slice(x + 1).filter((u) => adjacent[v][u]));
      if (found) return found;
    }
    return null;
  };
  return extend([], [...Array(n).keys()]);
}

const openTask = (chain) => new Map(chain.proofMiningStatus().tasks.entries()).values().next().value;

test("a beacon round issues a task, an answer is committed and revealed, and the reward matures", () => {
  const { beacons, chain, miner, validators } = fixture();
  assert.equal(chain.protocolVersion, PROOF_MINING_PROTOCOL_VERSION);
  const state0 = chain.proofMiningStatus();
  assert.equal(state0.level, 0);
  assert.equal(state0.tasks.size, 0);

  const round = finalizeBeaconRound(chain, beacons, validators);
  const task = openTask(chain);
  assert.equal(task.round, round);
  assert.equal(task.status, "open");
  const vertices = findClique(task.seed, task.level);
  const salt = "ab".repeat(32);
  const recipient = generateWallet().address;
  const commitment = proofAnswerCommitment({ networkId: chain.networkId, recipient, salt,
    taskRound: task.round, vertices });
  const balanceBefore = chain.balance(miner.address);
  append(chain, { transactions: [createProofAnswerCommit({ commitment, networkId: chain.networkId,
    nonce: 0, taskRound: task.round, wallet: miner })] }, validators);
  assert.equal(chain.balance(miner.address), balanceBefore - 1_000n - PROOF_MINING_V1.commitBond);
  const reveal = createProofAnswerReveal({ commitment, networkId: chain.networkId, nonce: 1,
    recipient, salt, vertices, wallet: miner });
  // Too early: the reveal must wait for its delay.
  assert.throws(() => append(chain, { transactions: [reveal] }, validators), /outside its window/);
  append(chain, {}, validators);
  append(chain, { transactions: [reveal] }, validators);
  assert.equal(chain.balance(miner.address), balanceBefore - 2_000n);
  const solved = chain.proofMiningStatus();
  assert.equal(solved.tasks.get(task.round).status, "solved");
  assert.equal(solved.pendingRewards.length, 1);

  // The next block at least ten minutes after the last reward escrows one epoch budget.
  const issuedBefore = chain.issued;
  const epoch = chain.nextIssuanceEpoch;
  append(chain, { timestamp: chain.blocks().at(-1).timestamp + MIN_REWARD_INTERVAL_MS }, validators);
  const budget = scheduledEpochBudget(epoch, LEGACY_INITIAL_EPOCH_REWARD);
  assert.equal(chain.issued - issuedBefore, budget);
  assert.equal(chain.nextIssuanceEpoch, epoch + 1);
  assert.equal(chain.balance(recipient), 0n);
  for (let i = 0; i < PROGRESS_REWARD_ESCROW_DELAY_BLOCKS; i++) append(chain, {}, validators);
  assert.equal(chain.balance(recipient), budget);
  assert.equal(chain.proofMiningStatus().escrows.size, 0);
});

test("proof answers are refused before protocol version 35", () => {
  const { beacons, chain, miner, validators } = fixture(34);
  finalizeBeaconRound(chain, beacons, validators);
  assert.equal(chain.proofMiningStatus(), null);
  assert.throws(() => append(chain, { transactions: [createProofAnswerCommit({
    commitment: "1".repeat(64), networkId: chain.networkId, nonce: 0, taskRound: 0, wallet: miner,
  })] }, validators), /protocol version 35/);
});

test("proof mining state survives a verified snapshot restore", () => {
  const { beacons, chain, genesis, miner, validators } = fixture();
  finalizeBeaconRound(chain, beacons, validators);
  const task = openTask(chain);
  append(chain, { transactions: [createProofAnswerCommit({ commitment: "7".repeat(64),
    networkId: chain.networkId, nonce: 0, taskRound: task.round, wallet: miner })] }, validators);
  const snapshot = chain.consensusSnapshot();
  const restored = NirChain.fromVerifiedSnapshot(genesis, {
    capabilityMemory: snapshot.capabilityMemory, checkpoint: chain.blocks().at(-1),
    evaluationAssignmentRoot: chain.evaluationAssignmentRoot, height: chain.height,
    networkId: chain.networkId, recoveryStateCommitment: chain.recoveryStateCommitment,
    state: snapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
    validatorSetId: chain.validatorSetId });
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.deepEqual(restored.proofMiningStatus(), chain.proofMiningStatus());
  // The unrevealed commit is charged when its window ends, on both copies.
  for (const copy of [chain, restored]) {
    for (let i = 0; i < PROOF_MINING_V1.revealWindowBlocks; i++) append(copy, {}, validators);
  }
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.equal(chain.burned, PROOF_MINING_V1.commitBond);
});
