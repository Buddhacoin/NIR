import assert from "node:assert/strict";
import test from "node:test";

import { createAccountProof } from "../blockchain/account-proof.mjs";
import {
  assembleCheckpointTrustPackage, createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy,
} from "../blockchain/checkpoint-trust-package.mjs";
import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import { MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, SAFETY_POLICY_V1_COMMITMENT }
  from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import { createReleaseAuthoritySet, createReleaseTransparencyAnchor }
  from "../blockchain/offline-release-governance.mjs";
import { approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload } from "../blockchain/protocol-upgrade-authorization.mjs";
import { createValidatorCandidateProof } from "../blockchain/validator-candidate-proof.mjs";
import { createValidatorAdmissionRecord } from "../blockchain/validator-admission.mjs";
import { assertValidatorCandidateContextSize, MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES,
  synchronizeValidatorCandidateContext, validateValidatorCandidateContext,
  validateValidatorCandidateSyncInput }
  from "../blockchain/validator-candidate-context.mjs";

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));
function quorumFor(proposal, wallets) {
  const quorum = Math.floor(wallets.length * 2 / 3) + 1;
  return [wallets.find(({ address }) => address === proposal.proposer),
    ...wallets.filter(({ address }) => address !== proposal.proposer)].slice(0, quorum);
}
function append(chain, wallets, options = {}) {
  const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1, ...options });
  const block = finalizeBlock(proposal, quorumFor(proposal, wallets)); chain.appendBlock(block); return block;
}
function releaseEntry(chain, set, wallets, version) {
  const tagged = (char) => `sha3-256:${char.repeat(64)}`;
  const payload = { bundleHash: tagged(String(version % 10)), manifestHash: tagged("b"),
    networkId: chain.networkId, previousBundleHash: version === 29 ? null : tagged(String((version - 1) % 10)),
    protocolVersion: version, releaseVersion: `0.${version}.0`, sourceRevision: "c".repeat(40) };
  const proposal = { activeSetId: set.setId, format: "nir-release-log-proposal-v1",
    logId: "nir-protocol-releases", networkId: chain.networkId, payload,
    previousEntryHash: chain.protocolReleaseHead.entryHash,
    sequence: chain.protocolReleaseHead.sequence + 1, type: "release", version: 1 };
  proposal.proposalHash = `sha3-256:${hashObject(proposal, "RELEASE_LOG_PROPOSAL_V1")}`;
  const approvals = wallets.slice(0, 3).map((wallet, index) => ({ address: wallet.address,
    format: "nir-release-governance-approval-v1", operatorId: `release-${index}`,
    proposalHash: proposal.proposalHash, role: "active", setId: set.setId,
    signature: signObject({ proposalHash: proposal.proposalHash, sequence: proposal.sequence,
      role: "active", setId: set.setId }, wallet, "RELEASE_GOVERNANCE_APPROVAL_V1"), version: 1 }));
  const unsigned = { activeSetId: set.setId, activationApprovals: [], approvals,
    format: "nir-release-transparency-entry-v1", logId: proposal.logId, networkId: chain.networkId,
    nextSetAcceptances: [], payload, previousEntryHash: proposal.previousEntryHash,
    proposalHash: proposal.proposalHash, sequence: proposal.sequence, type: "release", version: 1 };
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
  const approvals = wallets.slice(0, 3).map((wallet, index) =>
    approveProtocolUpgradeAuthorization(payload, set, { operatorId: `release-${index}`, wallet }))
    .sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  return { activationHeight, authorization: assembleProtocolUpgradeAuthorization(payload, entry,
    approvals), format: "nir-protocol-upgrade-v2", version: targetVersion };
}
function fixture(now = 100_000, validatorCount = 4) {
  const validators = Array.from({ length: validatorCount }, generateWallet);
  const validatorMembers = members(validators, "validator");
  const releases = Array.from({ length: 4 }, generateWallet);
  const releaseSet = createReleaseAuthoritySet({ authorities: members(releases, "release"),
    generation: 1, rotationDelayEntries: 2, threshold: 3 });
  const networkId = "nir-candidate-context-test";
  const chain = new NirChain({ beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`, timeout_seconds: 60 },
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisProtocolVersion: 27, genesisTimestamp: 0, networkId,
    protocolUpgradeReleaseAnchor: createReleaseTransparencyAnchor({ initialSet: releaseSet,
      logId: "nir-protocol-releases", networkId }),
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT], treasuryAddress: generateWallet().address,
    validators: validatorMembers });
  append(chain, validators);
  for (const version of [28, 29, 30, 31]) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(chain, validators, { protocolUpgrade: version === 28
      ? { activationHeight, format: "nir-protocol-upgrade-v1", version }
      : authorizedUpgrade(chain, releaseSet, releases, version, activationHeight) });
    while (chain.height < activationHeight) append(chain, validators);
  }
  const candidate = generateWallet();
  const block = chain.blocks().at(-1); const finalityProof = createFinalityProof(block);
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const policy = createCheckpointWitnessPolicy({ chainIdentityGenesisHash: chain.blocks()[0].hash,
    generation: 0, networkId, threshold: 3, witnesses: members(witnesses, "witness") });
  const attestations = witnesses.slice(0, 3).map((wallet, index) =>
    createCheckpointWitnessAttestation({ finalityProof, observedAt: now - index,
      operatorId: `witness-${index}`, policy, sequence: 1, validators: validatorMembers, wallet }));
  const checkpointTrustPackage = assembleCheckpointTrustPackage({ attestations, finalityProof,
    policy, sequence: 1, validators: validatorMembers });
  const account = chain.accountStateProof(candidate.address);
  const responses = validators.map((wallet) => ({ accountProof: createAccountProof({
    account: account.account, accountStateRoot: account.accountStateRoot,
    inclusionProof: account.inclusionProof, height: chain.height, networkId,
    pendingProtocolUpgrade: chain.pendingProtocolUpgrade, protocolVersion: chain.protocolVersion,
    stateRoot: chain.stateRoot, tipHash: chain.tipHash, validators: validatorMembers,
    validatorWallets: [wallet] }), candidateProof: createValidatorCandidateProof({
    accountStateRoot: chain.accountStateRoot, address: candidate.address, admission: null,
    height: chain.height, networkId, protocolVersion: chain.protocolVersion, queuePosition: null,
    queueSize: 0, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
    validators: validatorMembers, wallet }), finalityProof }));
  const peers = validatorMembers.map((member, index) => ({
    tlsCertificateSha256: ((index + 1) % 16).toString(16).repeat(64),
    url: `https://validator-${index}.example`, validatorAddress: member.address }));
  const plan = { candidateContextMaxWitnessAgeMs: 300_000,
    candidateContextMinimumCheckpointHeight: chain.height, candidateContextMinimumSequence: 1,
    consensus: publicWallet(candidate), expectedChainIdentityGenesisHash: chain.blocks()[0].hash,
    expectedCheckpointPolicyId: policy.policyId, format: "nir-validator-join-plan-v2",
    networkId, version: 2 };
  return { candidate, chain, checkpointTrustPackage, now, peers, plan, responses,
    validatorMembers, validators };
}

test("candidate context synchronizes one exact finalized v31 view from 3-of-4 nodes", async () => {
  const value = fixture();
  const context = await synchronizeValidatorCandidateContext({ now: value.now, plan: value.plan,
    syncInput: { checkpointTrustPackage: value.checkpointTrustPackage,
      format: "nir-validator-candidate-sync-v1", peers: value.peers, version: 1 },
    request: async (url) => ({ body: value.responses[Number(new URL(url).hostname.match(/(\d+)/)[1])],
      ok: true, status: 200 }) });
  assert.equal(context.status, "not-admitted"); assert.equal(context.account.nextNonce, 0);
  assert.equal(context.observedNodes, 4); assert.equal(context.nodeQuorum, 3);
  assert.equal(validateValidatorCandidateContext(context, value.plan, { now: value.now }).contextHash,
    context.contextHash);
  const counterTamper = structuredClone(context); counterTamper.observedNodes = 3;
  const { contextHash: _old, ...counterPayload } = counterTamper;
  counterTamper.contextHash = hashObject(counterPayload, "VALIDATOR_CANDIDATE_CONTEXT_V1");
  assert.throws(() => validateValidatorCandidateContext(counterTamper, value.plan,
    { now: value.now }), /binding/);
  const packageTamper = structuredClone(context);
  packageTamper.checkpointTrustPackageHash = `sha3-256:${"0".repeat(64)}`;
  const { contextHash: _oldPackage, ...packagePayload } = packageTamper;
  packageTamper.contextHash = hashObject(packagePayload, "VALIDATOR_CANDIDATE_CONTEXT_V1");
  assert.throws(() => validateValidatorCandidateContext(packageTamper, value.plan,
    { now: value.now }), /trust package/);
});

test("candidate context rejects minority and stale trust but tolerates one malformed peer", async () => {
  const value = fixture(); const input = { checkpointTrustPackage: value.checkpointTrustPackage,
    format: "nir-validator-candidate-sync-v1", peers: value.peers, version: 1 };
  await assert.rejects(() => synchronizeValidatorCandidateContext({ now: value.now, plan: value.plan,
    syncInput: input, request: async (url) => {
      const index = Number(new URL(url).hostname.match(/(\d+)/)[1]);
      if (index > 1) throw new Error("offline");
      return { body: value.responses[index], ok: true, status: 200 };
    } }), /quorum/);
  await assert.rejects(() => synchronizeValidatorCandidateContext({ now: value.now + 400_000,
    plan: value.plan, syncInput: input, request: async () => assert.fail("must not query stale trust") }),
  /time policy/);
  const conflicting = structuredClone(value.responses[0]); conflicting.finalityProof.header.height += 1;
  const context = await synchronizeValidatorCandidateContext({ now: value.now, plan: value.plan,
    syncInput: input, request: async (url) => {
      const index = Number(new URL(url).hostname.match(/(\d+)/)[1]);
      return { body: index === 0 ? conflicting : value.responses[index], ok: true, status: 200 };
    } });
  assert.equal(context.observedNodes, 3);

  const admission = createValidatorAdmissionRecord({ admissionId: "9".repeat(64),
    endpoint: "https://candidate.example", legacy: false,
    member: { ...publicWallet(value.candidate), operatorId: "candidate-one" },
    networkId: value.chain.networkId, submittedHeight: value.chain.height,
    tlsCertificateSha256: "8".repeat(64), transport: publicWallet(generateWallet()) });
  const divergent = structuredClone(value.responses[0]);
  divergent.candidateProof = createValidatorCandidateProof({
    accountStateRoot: value.chain.accountStateRoot, address: value.candidate.address, admission,
    height: value.chain.height, networkId: value.chain.networkId,
    protocolVersion: value.chain.protocolVersion, queuePosition: 0, queueSize: 1,
    stateRoot: value.chain.stateRoot, tipHash: value.chain.tipHash,
    validators: value.validatorMembers, wallet: value.validators[0] });
  await assert.rejects(() => synchronizeValidatorCandidateContext({ now: value.now,
    plan: value.plan, syncInput: input, request: async (url) => {
      const index = Number(new URL(url).hostname.match(/(\d+)/)[1]);
      return { body: index === 0 ? divergent : value.responses[index], ok: true, status: 200 };
    } }), /conflicting candidate/);
});

test("candidate sync accepts the protocol validator cap and bounds concurrent requests", async () => {
  const peers = Array.from({ length: 256 }, (_, index) => ({
    tlsCertificateSha256: index.toString(16).padStart(64, "0"),
    url: `https://validator-${index}.example`,
    validatorAddress: `nir1${(index + 1).toString(16).padStart(64, "0")}`,
  }));
  assert.equal(validateValidatorCandidateSyncInput({ checkpointTrustPackage: {},
    format: "nir-validator-candidate-sync-v1", peers, version: 1 }).peers.length, 256);
  assert.throws(() => validateValidatorCandidateSyncInput({ checkpointTrustPackage: {},
    format: "nir-validator-candidate-sync-v1", peers: [...peers, {
      tlsCertificateSha256: "f".repeat(64), url: "https://overflow.example",
      validatorAddress: `nir1${"f".repeat(64)}` }], version: 1 }), /invalid/);

  const value = fixture(100_000, 12); let active = 0; let maximum = 0;
  const context = await synchronizeValidatorCandidateContext({ now: value.now, plan: value.plan,
    syncInput: { checkpointTrustPackage: value.checkpointTrustPackage,
      format: "nir-validator-candidate-sync-v1", peers: value.peers, version: 1 },
    request: async (url) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { body: value.responses[Number(new URL(url).hostname.match(/(\d+)/)[1])],
        ok: true, status: 200 };
    } });
  assert.equal(context.observedNodes, 12);
  assert.ok(maximum > 1 && maximum <= 8);
});

test("persisted candidate context has a dedicated bounded envelope", () => {
  assert.doesNotThrow(() => assertValidatorCandidateContextSize({
    padding: "x".repeat(MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES - 1024),
  }));
  assert.throws(() => assertValidatorCandidateContextSize({
    padding: "x".repeat(MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES + 1),
  }), /too large/);
});
