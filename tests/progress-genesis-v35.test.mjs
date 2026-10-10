import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NirChain, PROGRESS_BOND_BINDING_TIMEOUT_BLOCKS,
  createCandidateBond, createProgressCommitment, finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  MIN_PROGRESS_CANDIDATE_BOND, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import {
  createReleaseAuthoritySet, createReleaseTransparencyAnchor,
} from "../blockchain/offline-release-governance.mjs";
import {
  approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload,
} from "../blockchain/protocol-upgrade-authorization.mjs";
import { createStateSnapshot, restoreStateSnapshot } from "../blockchain/state-snapshot.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const submitter = generateWallet();
  const releaseWallets = Array.from({ length: 4 }, generateWallet);
  const authoritySet = createReleaseAuthoritySet({
    authorities: members(releaseWallets, "release"), generation: 1,
    rotationDelayEntries: 2, threshold: 3,
  });
  const networkId = "nir-progress-genesis-replay-test";
  const config = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${digest("baseline")}`,
      contentHash: `sha256:${digest("baseline-content")}`,
      behaviorCommitment: digest("baseline-behavior"),
      capabilitiesBps: { "reasoning-v1": 100 },
    }],
    evaluators: members(evaluators, "evaluator"),
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${digest("image")}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${digest("runner")}`,
      timeout_seconds: 60 },
    genesisProtocolVersion: 27,
    networkId,
    protocolUpgradeReleaseAnchor: createReleaseTransparencyAnchor({
      initialSet: authoritySet, logId: "nir-protocol-releases", networkId,
    }),
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members(validators, "validator"),
  };
  const left = new NirChain({ ...config, genesisTimestamp: 0 });
  const right = new NirChain({ ...config, genesisTimestamp: 1 });
  const append = (chain, transactions = [], protocolUpgrade = null) => {
    const block = chain.buildBlock({ transactions, protocolUpgrade,
      timestamp: Math.max(chain.blocks().at(-1).timestamp + 1, TREASURY_VESTING_MS + 1) });
    const signatures = [validators.find(({ address }) => address === block.proposer),
      ...validators.filter(({ address }) => address !== block.proposer).slice(0, 2)];
    chain.appendBlock(finalizeBlock(block, signatures));
  };
  const upgrade = (chain, target, activationTransactions = []) => {
    while (chain.protocolVersion < target) {
      const version = chain.protocolVersion + 1;
      const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
      let protocolUpgrade;
      if (version < 29) {
        protocolUpgrade = { activationHeight, format: "nir-protocol-upgrade-v1", version };
      } else {
        const previousEntryHash = chain.protocolReleaseHead.entryHash;
        const sequence = chain.protocolReleaseHead.sequence + 1;
        const payload = {
          bundleHash: `sha3-256:${"a".repeat(64)}`,
          manifestHash: `sha3-256:${"b".repeat(64)}`,
          networkId,
          previousBundleHash: version === 29 ? null : `sha3-256:${"a".repeat(64)}`,
          protocolVersion: version,
          releaseVersion: "0.3.0",
          sourceRevision: "c".repeat(40),
        };
        const proposal = { activeSetId: authoritySet.setId,
          format: "nir-release-log-proposal-v1", logId: "nir-protocol-releases",
          networkId, payload, previousEntryHash, sequence, type: "release", version: 1 };
        proposal.proposalHash = `sha3-256:${hashObject(proposal, "RELEASE_LOG_PROPOSAL_V1")}`;
        const approvals = releaseWallets.slice(0, 3).map((wallet, index) => ({
          address: wallet.address, format: "nir-release-governance-approval-v1",
          operatorId: `release-${index}`, proposalHash: proposal.proposalHash,
          role: "active", setId: authoritySet.setId,
          signature: signObject({ proposalHash: proposal.proposalHash, sequence,
            role: "active", setId: authoritySet.setId }, wallet, "RELEASE_GOVERNANCE_APPROVAL_V1"),
          version: 1,
        }));
        const unsignedEntry = { activeSetId: proposal.activeSetId,
          activationApprovals: [], approvals, format: "nir-release-transparency-entry-v1",
          logId: proposal.logId, networkId, nextSetAcceptances: [], payload,
          previousEntryHash, proposalHash: proposal.proposalHash, sequence,
          type: "release", version: 1 };
        const entry = { ...unsignedEntry,
          entryHash: `sha3-256:${hashObject(unsignedEntry, "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
        const authorizationPayload = createProtocolUpgradeAuthorizationPayload({
          activationHeight, authoritySetId: authoritySet.setId, baseHeight: chain.height,
          baseTipHash: chain.tipHash, bundleHash: payload.bundleHash,
          chainIdentityGenesisHash: chain.blocks()[0].hash, currentVersion: chain.protocolVersion,
          entryHash: entry.entryHash, manifestHash: payload.manifestHash, networkId,
          releaseVersion: payload.releaseVersion, sourceRevision: payload.sourceRevision,
          targetVersion: version,
        });
        const signed = releaseWallets.slice(0, 3).map((wallet, index) =>
          approveProtocolUpgradeAuthorization(authorizationPayload, authoritySet,
            { operatorId: `release-${index}`, wallet }));
        protocolUpgrade = { activationHeight,
          authorization: assembleProtocolUpgradeAuthorization(authorizationPayload,
            entry, signed), format: "nir-protocol-upgrade-v2", version };
      }
      append(chain, [], protocolUpgrade);
      while (chain.height < activationHeight) {
        append(chain, chain.height + 1 === activationHeight
          ? activationTransactions : []);
      }
    }
  };
  return { append, config, left, right, submitter, treasury, upgrade, validators };
}

function progressPair(chain, submitter, treasury, chainIdentityGenesisHash) {
  const commitment = createProgressCommitment({
    wallet: submitter, networkId: chain.networkId, chainIdentityGenesisHash,
    recipient: submitter.address, artifactHash: `sha256:${digest("candidate")}`,
    baselineHash: `sha256:${digest("baseline")}`,
    baselineContentHash: `sha256:${digest("baseline-content")}`,
    contentHash: `sha256:${digest("candidate-content")}`,
    suiteCommitment: digest("suite"), nonce: 0,
  });
  const bond = createCandidateBond({ wallet: treasury, networkId: chain.networkId,
    chainIdentityGenesisHash, candidateId: commitment.candidateId, candidateOwner: submitter.address,
    purpose: "progress", amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), fee: "0", nonce: 0 });
  return { bond, commitment };
}

test("v35 progress bond and commitment bind signatures and candidate ID to genesis", () => {
  const { append, config, left, right, submitter, treasury, upgrade, validators } = fixture();
  upgrade(left, 35);
  upgrade(right, 35);
  const genesisHash = left.blocks()[0].hash;
  const { bond, commitment } = progressPair(left, submitter, treasury, genesisHash);
  const legacy = progressPair(left, submitter, treasury);
  assert.notEqual(legacy.commitment.candidateId, commitment.candidateId);
  assert.throws(() => append(left, [legacy.bond]), /genesis/i);
  append(left, [bond]);
  assert.throws(() => append(left, [bond]), /duplicat|nonce/i);
  assert.throws(() => append(left, [legacy.commitment]), /genesis/i);
  append(left, [commitment]);
  assert.notEqual(genesisHash, right.blocks()[0].hash);
  assert.throws(() => append(right, [bond]), /genesis/i);
  const foreignBond = createCandidateBond({ wallet: treasury, networkId: right.networkId,
    chainIdentityGenesisHash: right.blocks()[0].hash, candidateId: commitment.candidateId,
    candidateOwner: submitter.address, purpose: "progress",
    amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), fee: "0", nonce: 0 });
  append(right, [foreignBond]);
  assert.throws(() => append(right, [commitment]), /genesis/i);
  assert.equal(right.nextNonce(submitter.address), 0);
  const staleNonce = createCandidateBond({ wallet: treasury, networkId: right.networkId,
    chainIdentityGenesisHash: right.blocks()[0].hash, candidateId: digest("stale-nonce"),
    candidateOwner: submitter.address, purpose: "progress",
    amount: MIN_PROGRESS_CANDIDATE_BOND.toString(), fee: "0", nonce: 0 });
  assert.throws(() => append(right, [staleNonce]), /nonce/i);
  const mixedSchema = { ...commitment, unexpected: true };
  assert.throws(() => append(left, [mixedSchema]), /schema/i);
  const snapshot = createStateSnapshot(left, validators.slice(0, 3));
  const restored = restoreStateSnapshot({ ...config, genesisTimestamp: 0 }, snapshot,
    { expectedNetworkId: left.networkId, trustedValidators: config.validators });
  assert.equal(restored.stateRoot, left.stateRoot);
  assert.equal(restored.protocolVersion, 35);
  assert.equal(restored.consensusSnapshot().state.progressCommitments.length, 1);
  assert.equal(right.height > 0, true);
});

test("v34 legacy cross-genesis replay remains historical behavior, not v35 policy", () => {
  const { append, left, right, submitter, treasury, upgrade } = fixture();
  upgrade(left, 34);
  upgrade(right, 34);
  const premature = progressPair(left, submitter, treasury, left.blocks()[0].hash);
  assert.throws(() => append(left, [premature.bond]), /premature/i);
  const { bond, commitment } = progressPair(left, submitter, treasury);
  append(left, [bond]);
  append(right, [bond]);
  append(left, [commitment]);
  append(right, [commitment]);
  assert.equal(left.height, right.height);
});

test("first v35 block rejects legacy progress and accepts v2; block-version downgrade fails", () => {
  const { append, left, submitter, treasury, upgrade, validators } = fixture();
  upgrade(left, 34);
  const oldPair = progressPair(left, submitter, treasury);
  const v2Pair = progressPair(left, submitter, treasury, left.blocks()[0].hash);
  assert.throws(() => upgrade(left, 35, [oldPair.bond]), /genesis/i);
  assert.equal(left.protocolVersion, 34);
  const v35Proposal = left.buildBlock({ transactions: [v2Pair.bond],
    timestamp: left.blocks().at(-1).timestamp + 1 });
  assert.equal(v35Proposal.protocolVersion, 35);
  const signers = [validators.find(({ address }) => address === v35Proposal.proposer),
    ...validators.filter(({ address }) => address !== v35Proposal.proposer).slice(0, 2)];
  const downgraded = finalizeBlock({ ...v35Proposal, protocolVersion: 34 }, signers);
  assert.throws(() => left.appendBlock(downgraded), /protocol version|activation height/i);
  append(left, [v2Pair.bond]);
  assert.equal(left.protocolVersion, 35);
  assert.throws(() => append(left, [oldPair.commitment]), /genesis/i);
  append(left, [v2Pair.commitment]);
});

test("pre-v35 unbound bond cannot downgrade v35 commitment and refunds after timeout", () => {
  const { append, left, submitter, treasury, upgrade } = fixture();
  upgrade(left, 34);
  const { bond, commitment } = progressPair(left, submitter, treasury);
  const initialBalance = left.balance(treasury.address);
  append(left, [bond]);
  assert.equal(left.balance(treasury.address), initialBalance - MIN_PROGRESS_CANDIDATE_BOND);
  upgrade(left, 35);
  assert.throws(() => append(left, [commitment]), /genesis/i);
  const committedHeight = left.consensusSnapshot().state.candidateBonds[0][1].committedHeight;
  while (left.height <= committedHeight + PROGRESS_BOND_BINDING_TIMEOUT_BLOCKS) append(left);
  assert.equal(left.balance(treasury.address), initialBalance);
  assert.equal(left.consensusSnapshot().state.candidateBonds.length, 0);
});

test("v35 activation cancels pending v34 commitment, refunds bond, and restores snapshot", () => {
  const { append, config, left, submitter, treasury, upgrade, validators } = fixture();
  upgrade(left, 34);
  const { bond, commitment } = progressPair(left, submitter, treasury);
  const initialBalance = left.balance(treasury.address);
  append(left, [bond]);
  append(left, [commitment]);
  const before = left.consensusSnapshot().state.progressCommitments[0][0];
  assert.equal(before, commitment.candidateId);
  upgrade(left, 35);
  assert.equal(left.consensusSnapshot().state.progressCommitments.length, 0);
  assert.equal(left.consensusSnapshot().state.candidateBonds.length, 0);
  assert.equal(left.balance(treasury.address), initialBalance);
  const snapshot = createStateSnapshot(left, validators.slice(0, 3));
  const restored = restoreStateSnapshot({ ...config, genesisTimestamp: 0 }, snapshot,
    { expectedNetworkId: left.networkId, trustedValidators: config.validators });
  assert.equal(restored.consensusSnapshot().state.progressCommitments.length, 0);
  assert.equal(restored.stateRoot, left.stateRoot);
});
