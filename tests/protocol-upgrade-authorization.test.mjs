import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeBlockStore, loadBlockStore, persistBlock } from "../blockchain/block-store.mjs";
import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, PROTOCOL_VERSION, SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import {
  createReleaseAuthoritySet, createReleaseTransparencyAnchor,
} from "../blockchain/offline-release-governance.mjs";
import { createFinalityProof, verifyFinalityProofChain } from "../blockchain/light-client.mjs";
import {
  approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload,
} from "../blockchain/protocol-upgrade-authorization.mjs";
import { normalizeProtocolUpgrade } from "../blockchain/protocol-upgrade.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function releaseEntry({ authoritySet, networkId, previousEntryHash, sequence, targetVersion, wallets }) {
  const payload = {
    bundleHash: `sha3-256:${"a".repeat(64)}`,
    manifestHash: `sha3-256:${"b".repeat(64)}`,
    networkId,
    previousBundleHash: null,
    protocolVersion: targetVersion,
    releaseVersion: "0.3.0",
    sourceRevision: "c".repeat(40),
  };
  const proposal = {
    activeSetId: authoritySet.setId,
    format: "nir-release-log-proposal-v1",
    logId: "nir-protocol-releases",
    networkId,
    payload,
    previousEntryHash,
    sequence,
    type: "release",
    version: 1,
  };
  proposal.proposalHash = `sha3-256:${hashObject(proposal, "RELEASE_LOG_PROPOSAL_V1")}`;
  const approvals = wallets.slice(0, authoritySet.threshold).map((wallet, index) => ({
    address: wallet.address,
    format: "nir-release-governance-approval-v1",
    operatorId: `release-${index}`,
    proposalHash: proposal.proposalHash,
    role: "active",
    setId: authoritySet.setId,
    signature: signObject({ proposalHash: proposal.proposalHash, sequence,
      role: "active", setId: authoritySet.setId }, wallet, "RELEASE_GOVERNANCE_APPROVAL_V1"),
    version: 1,
  }));
  const unsigned = {
    activeSetId: proposal.activeSetId,
    activationApprovals: [],
    approvals,
    format: "nir-release-transparency-entry-v1",
    logId: proposal.logId,
    networkId,
    nextSetAcceptances: [],
    payload,
    previousEntryHash,
    proposalHash: proposal.proposalHash,
    sequence,
    type: "release",
    version: 1,
  };
  return { ...unsigned, entryHash: `sha3-256:${hashObject(unsigned, "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
}

function fixture() {
  const networkId = "nir-authorized-upgrade-test";
  const releaseWallets = Array.from({ length: 4 }, generateWallet);
  const authoritySet = createReleaseAuthoritySet({
    authorities: members(releaseWallets, "release"), generation: 1,
    rotationDelayEntries: 2, threshold: 3,
  });
  const anchor = createReleaseTransparencyAnchor({
    initialSet: authoritySet, logId: "nir-protocol-releases", networkId,
  });
  const validators = Array.from({ length: 4 }, generateWallet);
  const genesis = {
    beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`, timeout_seconds: 60 },
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisTimestamp: 0,
    networkId,
    protocolUpgradeReleaseAnchor: anchor,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address,
    validators: members(validators, "validator"),
  };
  const supported = [24, 25, 26, 27, 28, 29, 30];
  const chain = new NirChain(genesis, { supportedProtocolVersions: supported });
  return { anchor, authoritySet, chain, genesis, releaseWallets, supported, validators };
}

function authorization(values, overrides = {}) {
  const { authoritySet, chain, releaseWallets } = values;
  const activationHeight = overrides.activationHeight ?? chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  const targetVersion = overrides.targetVersion ?? chain.protocolVersion + 1;
  const entry = overrides.entry ?? releaseEntry({
    authoritySet,
    networkId: chain.networkId,
    previousEntryHash: chain.protocolReleaseHead.entryHash,
    sequence: chain.protocolReleaseHead.sequence + 1,
    targetVersion,
    wallets: releaseWallets,
  });
  const input = {
    activationHeight,
    authoritySetId: authoritySet.setId,
    baseHeight: chain.height,
    baseTipHash: chain.tipHash,
    bundleHash: entry.payload.bundleHash,
    chainIdentityGenesisHash: chain.blocks()[0].hash,
    currentVersion: chain.protocolVersion,
    entryHash: entry.entryHash,
    manifestHash: entry.payload.manifestHash,
    networkId: chain.networkId,
    releaseVersion: entry.payload.releaseVersion,
    sourceRevision: entry.payload.sourceRevision,
    targetVersion,
    ...overrides.payload,
  };
  const payload = createProtocolUpgradeAuthorizationPayload(input);
  const approvals = releaseWallets.slice(0, authoritySet.threshold)
    .map((wallet, index) => approveProtocolUpgradeAuthorization(payload, authoritySet,
      { operatorId: `release-${index}`, wallet }));
  return {
    activationHeight,
    authorization: assembleProtocolUpgradeAuthorization(payload, entry,
      approvals.sort((a, b) => a.operatorId.localeCompare(b.operatorId))),
    format: "nir-protocol-upgrade-v2",
    version: targetVersion,
  };
}

function append(chain, validators, options = {}) {
  const block = finalizeBlock(chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1, ...options,
  }), validators.slice(0, 3));
  chain.appendBlock(block);
  return block;
}

test("future protocol versions require an exact threshold-authorized release and persist its head", () => {
  const values = fixture();
  while (values.chain.protocolVersion < 28) {
    const activationHeight = values.chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(values.chain, values.validators, { protocolUpgrade: {
      activationHeight, format: "nir-protocol-upgrade-v1", version: values.chain.protocolVersion + 1,
    } });
    while (values.chain.height < activationHeight) append(values.chain, values.validators);
  }
  const schedule = authorization(values);
  const checkpoint = {
    height: values.chain.height,
    protocolReleaseHead: values.chain.protocolReleaseHead,
    protocolVersion: values.chain.protocolVersion,
    stateRoot: values.chain.stateRoot,
    tipHash: values.chain.tipHash,
    validatorSetId: values.chain.validatorSetId,
  };
  const economicsBefore = {
    burned: values.chain.burned,
    issued: values.chain.issued,
    treasuryBalance: values.chain.balance(values.genesis.treasuryAddress),
  };
  const block = append(values.chain, values.validators, { protocolUpgrade: schedule });
  assert.deepEqual({
    burned: values.chain.burned,
    issued: values.chain.issued,
    treasuryBalance: values.chain.balance(values.genesis.treasuryAddress),
  }, economicsBefore);
  assert.equal(values.chain.protocolReleaseHead.entryHash, schedule.authorization.entryHash);
  assert.equal(values.chain.protocolReleaseHead.sequence, 1);
  assert.deepEqual(block.protocolUpgrade, schedule);
  const light = verifyFinalityProofChain([createFinalityProof(block)], {
    checkpoint,
    expectedChainIdentityGenesisHash: values.chain.blocks()[0].hash,
    expectedNetworkId: values.chain.networkId,
    protocolUpgradeReleaseAnchor: values.anchor,
    supportedProtocolVersions: values.supported,
    trustedValidators: values.genesis.validators,
  });
  assert.deepEqual(light.protocolReleaseHead, values.chain.protocolReleaseHead);
  assert.throws(() => verifyFinalityProofChain([createFinalityProof(block)], {
    checkpoint: { ...checkpoint, protocolReleaseHead: {
      ...checkpoint.protocolReleaseHead, activeSetId: `sha3-256:${"f".repeat(64)}`,
    } },
    expectedChainIdentityGenesisHash: values.chain.blocks()[0].hash,
    expectedNetworkId: values.chain.networkId,
    protocolUpgradeReleaseAnchor: values.anchor,
    supportedProtocolVersions: values.supported,
    trustedValidators: values.genesis.validators,
  }), /release head/);
  assert.throws(() => verifyFinalityProofChain([createFinalityProof(block)], {
    checkpoint,
    expectedNetworkId: values.chain.networkId,
    protocolUpgradeReleaseAnchor: values.anchor,
    supportedProtocolVersions: values.supported,
    trustedValidators: values.genesis.validators,
  }), /pinned chain genesis/);
  assert.throws(() => verifyFinalityProofChain([createFinalityProof(block)], {
    checkpoint,
    expectedChainIdentityGenesisHash: values.chain.blocks()[0].hash,
    expectedNetworkId: values.chain.networkId,
    supportedProtocolVersions: values.supported,
    trustedValidators: values.genesis.validators,
  }), /protocol upgrade|authorization/);

  const directory = mkdtempSync(join(tmpdir(), "nir-authorized-upgrade-"));
  try {
    const fresh = new NirChain(values.genesis, { supportedProtocolVersions: values.supported });
    initializeBlockStore(directory, fresh);
    for (const replay of values.chain.blocks().slice(1)) {
      fresh.appendBlock(replay);
      persistBlock(directory, replay, fresh);
    }
    const restarted = loadBlockStore(directory, values.genesis).chain;
    assert.deepEqual(restarted.protocolReleaseHead, values.chain.protocolReleaseHead);
    assert.deepEqual(restarted.pendingProtocolUpgrade, schedule);
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test("tamper, replay, foreign context, and unsigned release evidence fail closed", () => {
  const values = fixture();
  while (values.chain.protocolVersion < 28) {
    const activationHeight = values.chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(values.chain, values.validators, { protocolUpgrade: {
      activationHeight, format: "nir-protocol-upgrade-v1", version: values.chain.protocolVersion + 1,
    } });
    while (values.chain.height < activationHeight) append(values.chain, values.validators);
  }
  const good = authorization(values);
  assert.throws(() => normalizeProtocolUpgrade(good, {
    currentHeight: values.chain.height + 1,
    currentVersion: values.chain.protocolVersion,
  }), /authorization context/);
  for (const bad of [
    { ...good, activationHeight: good.activationHeight + 1 },
    { ...good, authorization: { ...good.authorization, networkId: "foreign-network" } },
    { ...good, authorization: { ...good.authorization, chainIdentityGenesisHash: "0".repeat(64) } },
    { ...good, authorization: { ...good.authorization,
      bundleHash: `sha3-256:${"d".repeat(64)}` } },
    { ...good, authorization: { ...good.authorization,
      sourceRevision: "d".repeat(40) } },
    { ...good, authorization: { ...good.authorization,
      approvals: good.authorization.approvals.slice(0, 2) } },
    { ...good, authorization: { ...good.authorization,
      approvals: good.authorization.approvals.map((approval, index) => index === 0
        ? { ...approval, signature: `${approval.signature}=` } : approval) } },
    { ...good, authorization: { ...good.authorization,
      releaseEntry: { ...good.authorization.releaseEntry,
        approvals: good.authorization.releaseEntry.approvals.slice(0, 2) } } },
  ]) assert.throws(() => values.chain.buildBlock({ protocolUpgrade: bad }), /authorization|quorum|release/);

  append(values.chain, values.validators, { protocolUpgrade: good });
  assert.throws(() => values.chain.buildBlock({ protocolUpgrade: good }), /already pending/);
});
