import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NirChain, blockHeader, computeChainStateRoot, createBeaconBond, createTransfer,
  createValidatorBond, finalizeBlock, finalizeValidatorRecoveryBlock, prepareCertificateHash,
  transactionId }
  from "../blockchain/chain.mjs";
import { MIN_BEACON_BOND, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT, TREASURY_VESTING_MS } from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject, verifyObject } from "../blockchain/crypto.mjs";
import { createReleaseAuthoritySet, createReleaseTransparencyAnchor }
  from "../blockchain/offline-release-governance.mjs";
import { approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload } from "../blockchain/protocol-upgrade-authorization.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import { createPeerRegistry, EMPTY_PEER_REGISTRY_HASH } from "../blockchain/peer-registry.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import { createValidatorAdmission, createValidatorAdmissionReadiness,
  VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS, validatorAdmissionObservationPayload }
  from "../blockchain/validator-admission.mjs";
import { initializeBlockStore, persistBlock } from "../blockchain/block-store.mjs";
import { ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { createValidatorRecoveryPlan, createValidatorRecoveryPlanTransaction }
  from "../blockchain/validator-recovery.mjs";
import { createAdmissionInclusionReceipt } from "../blockchain/admission-inclusion.mjs";
import { createValidatorAdmissionOmissionEvidence,
  createValidatorAdmissionOmissionTransaction }
  from "../blockchain/validator-admission-omission.mjs";
import { createValidatorRecoveryCheckpointCertificate, verifyValidatorRecoveryCheckpoint }
  from "../blockchain/validator-recovery.mjs";
import { ValidatorRecoveryLockStore } from "../blockchain/validator-recovery-store.mjs";
import {
  createValidatorAdmissionReadinessCandidateResponse,
  createValidatorAdmissionReadinessCertificate,
  createValidatorAdmissionReadinessChallenge,
  createValidatorAdmissionReadinessReceipt,
  verifyValidatorAdmissionReadinessCertificate,
  verifyValidatorAdmissionReadinessReceipt,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import { createFinalityProof, verifyValidatorRecoveryTransition }
  from "../blockchain/light-client.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

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
  return { ...unsigned, entryHash: `sha3-256:${hashObject(unsigned,
    "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
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
function fixture(targetProtocolVersion = 31, legacyReserves = []) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorTransports = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const releases = Array.from({ length: 4 }, generateWallet);
  const set = createReleaseAuthoritySet({ authorities: members(releases, "release"), generation: 1,
    rotationDelayEntries: 2, threshold: 3 });
  const networkId = "nir-validator-admission-v31-test";
  const peerRegistry = createPeerRegistry({ activationHeight: 0, epoch: 0, networkId,
    peers: validators.map((wallet, index) => ({ tlsCertificateSha256: "9".repeat(64),
      transport: publicWallet(validatorTransports[index]), url: `https://old-${index}.example`,
      validatorAddress: wallet.address })), previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  }, validators.slice(0, 3));
  const genesis = { beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 }, evaluators: members(Array.from({ length: 4 }, generateWallet), "eval"),
    genesisProtocolVersion: 27, genesisTimestamp: 0, networkId,
    protocolUpgradeReleaseAnchor: createReleaseTransparencyAnchor({ initialSet: set,
      logId: "nir-protocol-releases", networkId }),
    peerRegistry, safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT], treasuryAddress: treasury.address,
    validators: members(validators, "validator") };
  const chain = new NirChain(genesis);
  append(chain, {}, validators);
  if (legacyReserves.length > 0) {
    append(chain, { timestamp: TREASURY_VESTING_MS, transactions: legacyReserves
      .map((wallet, nonce) => createTransfer({
        amount: (MIN_VALIDATOR_BOND + 2n * MIN_TRANSFER_FEE).toString(),
        networkId: chain.networkId, nonce, recipient: wallet.address, wallet: treasury,
      })) }, validators);
    append(chain, { transactions: legacyReserves.map((wallet, index) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0,
      operatorId: `legacy-reserve-${index}`, wallet,
    })) }, validators);
  }
  for (const version of [28, 29, 30, 31, 32, 33, 34]
    .filter((version) => version <= targetProtocolVersion)) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(chain, { protocolUpgrade: version === 28
      ? { activationHeight, format: "nir-protocol-upgrade-v1", version }
      : authorizedUpgrade(chain, set, releases, version, activationHeight) }, validators);
    while (chain.height < activationHeight) append(chain, {}, validators);
  }
  return { chain, genesis, releases, set, treasury, validators, validatorTransports };
}

function readinessTransaction({ candidate, chain, endpoint, nonce, tlsCertificateSha256,
  transport, validators, observedHeight = chain.height }) {
  const pending = chain.validatorAdmission(candidate.address);
  const expiresAtHeight = observedHeight + 16;
  const observation = validatorAdmissionObservationPayload({ admissionId: pending.admissionId,
    chainIdentityGenesisHash: chain.blocks()[0].hash, endpoint, expiresAtHeight,
    networkId: chain.networkId, nonce, observedHeight, tlsCertificateSha256,
    transportAddress: transport.address, validatorSetId: chain.validatorSetId });
  const readinessAttestations = validators.map((wallet) => ({ validator: wallet.address,
    signature: signObject(observation, wallet, "VALIDATOR_ADMISSION_LIVE_OBSERVATION_V1") }))
    .sort((a, b) => a.validator.localeCompare(b.validator)).slice(0, 3);
  return createValidatorAdmissionReadiness({ admissionId: pending.admissionId, endpoint,
    expiresAtHeight, networkId: chain.networkId, nonce, observedHeight, readinessAttestations,
    tlsCertificateSha256, transportWallet: transport, validatorSetId: chain.validatorSetId,
    wallet: candidate });
}

function verifiedSnapshotEnvelope(chain) {
  const snapshot = chain.consensusSnapshot();
  return { capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1), evaluationAssignmentRoot: chain.evaluationAssignmentRoot,
    height: chain.height, networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment, state: snapshot.state,
    stateRoot: chain.stateRoot, tipHash: chain.tipHash, validatorSetId: chain.validatorSetId };
}

function restore(chain, genesis) {
  return NirChain.fromVerifiedSnapshot(genesis, verifiedSnapshotEnvelope(chain));
}

function persistedReplica({ chain, genesis, readinessProbe, validator, validatorTransport }) {
  const temporary = mkdtempSync(join(tmpdir(), "nir-readiness-observer-replica-"));
  const directory = join(temporary, "validator");
  for (const name of ["blocks", "commits", "mempool", "prepares", "timeouts"]) {
    mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
  }
  const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(directory, "genesis.json"), serialized(genesis), { mode: 0o600 });
  writeFileSync(join(directory, "VALIDATOR-KEY.json"), serialized(validator), { mode: 0o600 });
  writeFileSync(join(directory, "TRANSPORT-KEY.json"), serialized(validatorTransport),
    { mode: 0o600 });
  writeFileSync(join(directory, "AUTHORIZED-COORDINATOR.json"),
    serialized(publicWallet(generateWallet())), { mode: 0o600 });
  const stored = new NirChain(genesis);
  initializeBlockStore(directory, stored);
  for (const block of chain.blocks().slice(1)) {
    stored.appendBlock(block);
    persistBlock(directory, block, stored);
  }
  const replica = new ValidatorReplica(directory, { readinessProbe });
  return { cleanup() {
    replica.closeSecurityState();
    rmSync(temporary, { recursive: true, force: true });
  }, replica };
}

test("read-only live-readiness collection does not change candidate consensus state", () => {
  const { chain, treasury, validators } = fixture(32);
  const candidate = generateWallet(); const transport = generateWallet();
  append(chain, { timestamp: TREASURY_VESTING_MS, transactions: [createTransfer({
    amount: (MIN_VALIDATOR_BOND + 4n * MIN_TRANSFER_FEE).toString(), networkId: chain.networkId,
    nonce: chain.nextNonce(treasury.address), recipient: candidate.address, wallet: treasury,
  })] }, validators);
  append(chain, { transactions: [createValidatorAdmission({
    chainIdentityGenesisHash: chain.blocks()[0].hash, endpoint: "https://candidate-live.example",
    networkId: chain.networkId, nonce: 0, operatorId: "candidate-live",
    referenceHeight: chain.height, tlsCertificateSha256: "a".repeat(64),
    transportWallet: transport, wallet: candidate,
  })] }, validators);
  const before = { height: chain.height, nonce: chain.nextNonce(candidate.address),
    root: chain.stateRoot, snapshot: chain.consensusSnapshot(),
    admission: chain.validatorAdmission(candidate.address) };
  const context = chain.validatorAdmissionReadinessContext(candidate.address);
  assert.deepEqual(context.checkpoint, { blockHash: chain.tipHash, height: chain.height,
    stateRoot: chain.stateRoot, validatorSetId: chain.validatorSetId });
  const receipts = validators.slice(0, 3).map((observerWallet, index) => {
    const challenge = createValidatorAdmissionReadinessChallenge({
      challengeNonce: String(index + 1).padStart(64, "0"), context, observerWallet,
      validators: chain.validatorMembers });
    const candidateResponse = createValidatorAdmissionReadinessCandidateResponse({
      candidateWallet: candidate, challenge, context, transportWallet: transport,
      validators: chain.validatorMembers });
    return createValidatorAdmissionReadinessReceipt({ candidateResponse, observerWallet,
      validators: chain.validatorMembers });
  });
  const certificate = createValidatorAdmissionReadinessCertificate({ context, receipts,
    validators: chain.validatorMembers });
  assert.equal(verifyValidatorAdmissionReadinessCertificate(certificate, {
    validators: chain.validatorMembers }).status, "certificate-collected");
  assert.deepEqual({ height: chain.height, nonce: chain.nextNonce(candidate.address),
    root: chain.stateRoot, snapshot: chain.consensusSnapshot(),
    admission: chain.validatorAdmission(candidate.address) }, before);
  assert.equal(chain.validatorAdmission(candidate.address).readiness, false);
  assert.throws(() => chain.validatorAdmissionReadinessContext(validators[0].address),
    /not eligible/);

  const legacy = generateWallet();
  const legacyChain = fixture(31, [legacy]).chain;
  assert.equal(legacyChain.validatorAdmission(legacy.address).legacy, true);
  assert.throws(() => legacyChain.validatorAdmissionReadinessContext(legacy.address),
    /not eligible/);
});

test("validator replica privately orchestrates fresh readiness observations and rejects races",
  async () => {
    const { chain, genesis, treasury, validators, validatorTransports } = fixture(32);
    const candidate = generateWallet(); const transport = generateWallet();
    append(chain, { timestamp: TREASURY_VESTING_MS, transactions: [createTransfer({
      amount: (MIN_VALIDATOR_BOND + 4n * MIN_TRANSFER_FEE).toString(), networkId: chain.networkId,
      nonce: chain.nextNonce(treasury.address), recipient: candidate.address, wallet: treasury,
    })] }, validators);
    append(chain, { transactions: [createValidatorAdmission({
      chainIdentityGenesisHash: chain.blocks()[0].hash, endpoint: "https://observer.example",
      networkId: chain.networkId, nonce: 0, operatorId: "observer-candidate",
      referenceHeight: chain.height, tlsCertificateSha256: "b".repeat(64),
      transportWallet: transport, wallet: candidate,
    })] }, validators);

    const challenges = []; let gate = null; let release = null;
    const readinessProbe = async ({ challenge, context, signal, validators: active }) => {
      challenges.push(challenge);
      if (gate !== null) {
        const pending = [gate];
        if (signal !== null) pending.push(new Promise((_, reject) => signal.addEventListener("abort",
          () => reject(new Error("probe aborted")), { once: true })));
        await Promise.race(pending);
      }
      return createValidatorAdmissionReadinessCandidateResponse({ candidateWallet: candidate,
        challenge, context, transportWallet: transport, validators: active });
    };
    const persisted = persistedReplica({ chain, genesis, readinessProbe,
      validator: validators[0], validatorTransport: validatorTransports[0] });
    try {
      const context = persisted.replica.validatorAdmissionReadinessContext(candidate.address);
      const before = { height: persisted.replica.height, root: persisted.replica.stateRoot };
      const first = await persisted.replica.observeValidatorAdmissionReadiness(context);
      assert.deepEqual(verifyValidatorAdmissionReadinessReceipt(first,
        { context, validators: chain.validatorMembers }), first);
      assert.match(challenges[0].challengeNonce, /^[0-9a-f]{64}$/);
      assert.deepEqual({ height: persisted.replica.height, root: persisted.replica.stateRoot }, before);
      const second = await persisted.replica.observeValidatorAdmissionReadiness(context);
      assert.notEqual(challenges[1].challengeNonce, challenges[0].challengeNonce);
      assert.deepEqual(verifyValidatorAdmissionReadinessReceipt(second,
        { context, validators: chain.validatorMembers }), second);

      gate = new Promise((resolve) => { release = resolve; });
      const controller = new AbortController();
      const active = persisted.replica.observeValidatorAdmissionReadiness(context,
        { signal: controller.signal });
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(() => persisted.replica.observeValidatorAdmissionReadiness(context),
        /already active/);
      controller.abort();
      await assert.rejects(() => active, /probe aborted|was aborted/);
      release(); gate = null;
      await persisted.replica.observeValidatorAdmissionReadiness(context);

      gate = new Promise((resolve) => { release = resolve; });
      const stale = persisted.replica.observeValidatorAdmissionReadiness(context);
      const staleRejected = assert.rejects(stale, /context is not current/);
      await new Promise((resolve) => setImmediate(resolve));
      const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
      const block = finalizeBlock(proposal, quorumFor(proposal, validators));
      chain.appendBlock(block);
      persisted.replica.commit(block);
      release();
      await staleRejected;
    } finally {
      release?.();
      persisted.cleanup();
    }
  });

test("v32 admission survives restart and rotation cannot skip the FIFO head", () => {
  const { chain, genesis, treasury, validators, validatorTransports } = fixture(32);
  const candidates = [generateWallet(), generateWallet()];
  const transports = [generateWallet(), generateWallet()];
  const funded = [...candidates, ...validators];
  append(chain, { timestamp: TREASURY_VESTING_MS, transactions: funded.map((wallet, nonce) =>
    createTransfer({ amount: (MIN_VALIDATOR_BOND + 8n * MIN_TRANSFER_FEE).toString(),
      networkId: chain.networkId, nonce, recipient: wallet.address, wallet: treasury })) }, validators);
  append(chain, { transactions: validators.map((wallet) => createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0, wallet,
  })) }, validators);
  append(chain, { transactions: candidates.map((candidate, index) => createValidatorAdmission({
    chainIdentityGenesisHash: chain.blocks()[0].hash,
    endpoint: `https://validator-${index}.example`, networkId: chain.networkId, nonce: 0,
    operatorId: `candidate-${index}`, tlsCertificateSha256: String(index + 5).repeat(64),
    referenceHeight: chain.height,
    transportWallet: transports[index], wallet: candidate })) }, validators);
  const snapshot = chain.consensusSnapshot();
  const chainIdentityGenesisHash = chain.blocks()[0].hash;
  const restored = NirChain.fromVerifiedSnapshot(genesis, { capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1), evaluationAssignmentRoot: chain.evaluationAssignmentRoot,
    height: chain.height, networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment, state: snapshot.state,
    stateRoot: chain.stateRoot, tipHash: chain.tipHash, validatorSetId: chain.validatorSetId });
  assert.deepEqual(restored.validatorAdmissionQueue(), chain.validatorAdmissionQueue());
  const attestReadiness = (index, nonce) => {
    const pending = restored.validatorAdmission(candidates[index].address);
    const observedHeight = restored.height;
    const expiresAtHeight = observedHeight + 16;
    const observation = validatorAdmissionObservationPayload({ admissionId: pending.admissionId,
      chainIdentityGenesisHash,
      endpoint: `https://validator-${index}.example`, expiresAtHeight,
      networkId: restored.networkId, nonce, observedHeight,
      tlsCertificateSha256: String(index + 5).repeat(64),
      transportAddress: transports[index].address, validatorSetId: restored.validatorSetId });
    const readinessAttestations = validators.map((wallet) => ({ validator: wallet.address,
      signature: signObject(observation, wallet, "VALIDATOR_ADMISSION_LIVE_OBSERVATION_V1") }))
      .sort((a, b) => a.validator.localeCompare(b.validator)).slice(0, 3);
    for (const attestation of readinessAttestations) {
      const wallet = validators.find(({ address }) => address === attestation.validator);
      assert.ok(verifyObject(observation, attestation.signature, wallet.publicKey,
        "VALIDATOR_ADMISSION_LIVE_OBSERVATION_V1"));
    }
    append(restored, { transactions: [createValidatorAdmissionReadiness({
      admissionId: pending.admissionId, endpoint: `https://validator-${index}.example`,
      expiresAtHeight, networkId: restored.networkId, nonce, observedHeight,
      readinessAttestations, tlsCertificateSha256: String(index + 5).repeat(64),
      transportWallet: transports[index], validatorSetId: restored.validatorSetId,
      wallet: candidates[index] })] }, validators);
  };
  for (let index = 0; index < candidates.length; index += 1) attestReadiness(index, 1);
  while (restored.height < Math.max(...restored.validatorAdmissionQueue()
    .map(({ eligibleHeight }) => eligibleHeight))) append(restored, {}, validators);
  const staleHead = restored.validatorAdmissionQueue()[0];
  assert.throws(() => restored.buildBlock({ validatorRotation: {
    activationHeight: restored.height + 5,
    validators: [...restored.validatorMembers.slice(1), { address: staleHead.address,
      algorithm: staleHead.algorithm, operatorId: staleHead.operatorId,
      publicKey: staleHead.publicKey }],
  } }), /skips deterministic admission priority/);
  for (let index = 0; index < candidates.length; index += 1) attestReadiness(index, 2);
  const [head, second] = restored.validatorAdmissionQueue();
  const wrong = [...restored.validatorMembers.slice(1), { address: second.address,
    algorithm: second.algorithm, operatorId: second.operatorId, publicKey: second.publicKey }];
  assert.throws(() => restored.buildBlock({ validatorRotation: {
    activationHeight: restored.height + 5, validators: wrong,
  } }), /skips deterministic admission priority/);
  assert.ok(head.readiness);
  const headWallet = candidates.find(({ address }) => address === head.address);
  const correct = [...restored.validatorMembers.slice(1), { address: head.address,
    algorithm: head.algorithm, operatorId: head.operatorId, publicKey: head.publicKey }];
  const activationHeight = restored.height + 5;
  const nextWallets = correct.map(({ address }) => address === head.address ? headWallet :
    validators.find((wallet) => wallet.address === address));
  const nextTransports = nextWallets.map((wallet) => wallet.address === head.address
    ? transports[candidates.indexOf(headWallet)]
    : validatorTransports[validators.indexOf(wallet)]);
  const onboarding = createValidatorOnboarding({ activationHeight,
    currentValidators: restored.validatorMembers, networkId: restored.networkId,
    nextValidators: correct, peers: nextWallets.map((wallet, index) => ({
      tlsCertificateSha256: wallet.address === head.address
        ? restored.validatorAdmission(head.address).tlsCertificateSha256 : "9".repeat(64),
      transport: publicWallet(nextTransports[index]),
      url: wallet.address === head.address ? restored.validatorAdmission(head.address).endpoint
        : `https://old-${validators.indexOf(wallet)}.example`,
      validatorAddress: wallet.address,
    })) }, validators.slice(0, 3), nextWallets, nextTransports);
  const wrongTransport = generateWallet();
  const wrongTransports = nextTransports.map((wallet, index) =>
    nextWallets[index].address === head.address ? wrongTransport : wallet);
  const mismatchedOnboarding = createValidatorOnboarding({ activationHeight,
    currentValidators: restored.validatorMembers, networkId: restored.networkId,
    nextValidators: correct, peers: nextWallets.map((wallet, index) => ({
      tlsCertificateSha256: wallet.address === head.address ? "8".repeat(64) : "9".repeat(64),
      transport: publicWallet(wrongTransports[index]),
      url: wallet.address === head.address ? "https://wrong.example"
        : `https://old-${validators.indexOf(wallet)}.example`,
      validatorAddress: wallet.address,
    })) }, validators.slice(0, 3), nextWallets, wrongTransports);
  assert.throws(() => restored.buildBlock({ validatorRotation: { activationHeight,
    onboarding: mismatchedOnboarding, validators: correct } }),
  /does not match the selected admission binding/);
  append(restored, { validatorRotation: { activationHeight, onboarding,
    validators: correct } }, validators);
  while (restored.height + 1 < activationHeight) append(restored, {}, validators);
  const activationProposal = restored.buildBlock({
    timestamp: restored.blocks().at(-1).timestamp + 1,
  });
  restored.appendBlock(finalizeBlock(activationProposal, [...validators, headWallet]));
  const excludedAddress = chain.validatorMembers[0].address;
  const requeued = restored.validatorAdmission(excludedAddress);
  assert.ok(requeued);
  assert.equal(requeued.readiness, false);
  assert.equal(requeued.submittedHeight, activationHeight);
  const restoredAfterRotation = restore(restored, genesis);
  assert.equal(restoredAfterRotation.protocolVersion, 32);
  assert.equal(restoredAfterRotation.stateRoot, restored.stateRoot);
  assert.deepEqual(restoredAfterRotation.validatorAdmissionQueue(),
    restored.validatorAdmissionQueue());
});

test("v32 admission expiry is chain-bound, atomic, restart-safe, and replay-resistant", () => {
  const { chain, genesis, treasury, validators } = fixture(32);
  const candidates = Array.from({ length: 5 }, generateWallet);
  const transports = Array.from({ length: 5 }, generateWallet);
  append(chain, { timestamp: TREASURY_VESTING_MS, transactions: candidates.map((wallet, nonce) =>
    createTransfer({ amount: (MIN_VALIDATOR_BOND + 4n * MIN_TRANSFER_FEE).toString(),
      networkId: chain.networkId, nonce, recipient: wallet.address, wallet: treasury })) }, validators);
  const genesisHash = chain.blocks()[0].hash;
  const make = (index, overrides = {}) => createValidatorAdmission({
    chainIdentityGenesisHash: genesisHash, endpoint: `https://v32-${index}.example`,
    networkId: chain.networkId, nonce: 0, operatorId: `candidate-v32-${index}`,
    referenceHeight: chain.height, tlsCertificateSha256: String(index + 1).repeat(64),
    transportWallet: transports[index], wallet: candidates[index], ...overrides });
  const rejectAtomically = (transaction, pattern) => {
    const before = { height: chain.height, root: chain.stateRoot,
      balance: chain.balance(transaction.sender), queue: chain.validatorAdmissionQueue() };
    assert.throws(() => {
      const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1,
        transactions: [transaction] });
      chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators)));
    }, pattern);
    assert.deepEqual({ height: chain.height, root: chain.stateRoot,
      balance: chain.balance(transaction.sender), queue: chain.validatorAdmissionQueue() }, before);
  };
  rejectAtomically(make(0, { chainIdentityGenesisHash: "f".repeat(64) }), /genesis|context|state root/);
  rejectAtomically(make(1, { referenceHeight: chain.height + 1,
    validUntilHeight: chain.height + 1 + VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS }),
  /context|state root/);
  const staleReference = chain.height - VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS;
  rejectAtomically(make(2, { referenceHeight: staleReference,
    validUntilHeight: staleReference + VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS }),
  /context|state root/);
  const changedExpiry = make(3); changedExpiry.validUntilHeight -= 1;
  rejectAtomically(changedExpiry, /context|signature|state root/);

  const transaction = make(4);
  const included = append(chain, { transactions: [transaction] }, validators);
  assert.equal(included.height, transaction.referenceHeight + 1);
  const pending = chain.validatorAdmission(candidates[4].address);
  const { signature: _signature, transportSignature: _transportSignature, ...payload } = transaction;
  assert.equal(pending.admissionId, hashObject(payload, "VALIDATOR_ADMISSION_ID_V1"));
  assert.equal(pending.rank, chain.validatorAdmissionQueue().find(({ address }) =>
    address === candidates[4].address).rank);
  rejectAtomically(transaction, /nonce|pending|protocol role|state root/);

  const snapshot = chain.consensusSnapshot();
  const restored = NirChain.fromVerifiedSnapshot(genesis, { capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1), evaluationAssignmentRoot: chain.evaluationAssignmentRoot,
    height: chain.height, networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment, state: snapshot.state,
    stateRoot: chain.stateRoot, tipHash: chain.tipHash, validatorSetId: chain.validatorSetId });
  assert.equal(restored.protocolVersion, 32);
  assert.deepEqual(restored.validatorAdmissionQueue(), chain.validatorAdmissionQueue());
});

test("v34 recovery plan reserves exact pending admissions in place and clears readiness", () => {
  const { chain, genesis, treasury, validators, validatorTransports } = fixture(34);
  const reserves = Array.from({ length: 4 }, generateWallet);
  const transports = Array.from({ length: 4 }, generateWallet);
  const treasuryNonce = chain.nextNonce(treasury.address);
  append(chain, { timestamp: TREASURY_VESTING_MS,
    transactions: [...reserves, ...validators].map((wallet, nonce) => createTransfer({
    amount: (MIN_VALIDATOR_BOND + 8n * MIN_TRANSFER_FEE).toString(),
    networkId: chain.networkId, nonce: treasuryNonce + nonce,
    recipient: wallet.address, wallet: treasury,
  })) }, validators);
  append(chain, { transactions: validators.map((wallet) => createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0, wallet,
  })) }, validators);
  append(chain, { transactions: reserves.map((wallet, index) => createValidatorAdmission({
    chainIdentityGenesisHash: chain.blocks()[0].hash,
    endpoint: `https://reserve-${index}.example`, networkId: chain.networkId, nonce: 0,
    operatorId: `reserve-v34-${index}`, referenceHeight: chain.height,
    tlsCertificateSha256: String(index + 1).repeat(64),
    transportWallet: transports[index], wallet,
  })) }, validators);
  for (let index = 0; index < reserves.length; index += 1) {
    append(chain, { transactions: [readinessTransaction({ candidate: reserves[index], chain,
      endpoint: `https://reserve-${index}.example`, nonce: 1,
      tlsCertificateSha256: String(index + 1).repeat(64), transport: transports[index],
      validators })] }, validators);
  }
  const scheduledHeight = chain.height + 1;
  const reserveMembers = reserves.map((wallet, index) => ({ ...publicWallet(wallet),
    operatorId: `reserve-v34-${index}` }));
  const reserveWallets = reserves.map((wallet, index) => ({ member: reserveMembers[index],
    peer: { tlsCertificateSha256: String(index + 1).repeat(64),
      transport: publicWallet(transports[index]), url: `https://reserve-${index}.example`,
      validatorAddress: wallet.address }, transportWallet: transports[index], wallet }));
  const plan = createValidatorRecoveryPlan({ activationHeight: scheduledHeight + 64,
    activeValidators: chain.validatorMembers, generation: 1, networkId: chain.networkId,
    reserveWallets, scheduledHeight });
  const beforeInvalid = { nonce: chain.nextNonce(treasury.address), root: chain.stateRoot,
    queue: chain.validatorAdmissionQueue() };
  const missing = generateWallet();
  const missingTransport = generateWallet();
  const invalidPlan = createValidatorRecoveryPlan({ activationHeight: scheduledHeight + 64,
    activeValidators: chain.validatorMembers, generation: 1, networkId: chain.networkId,
    scheduledHeight, reserveWallets: [...reserveWallets.slice(0, 3), {
      member: { ...publicWallet(missing), operatorId: "missing-reserve" },
      peer: { tlsCertificateSha256: "f".repeat(64), transport: publicWallet(missingTransport),
        url: "https://missing-reserve.example", validatorAddress: missing.address },
      transportWallet: missingTransport, wallet: missing }] });
  assert.throws(() => {
    const proposal = chain.buildBlock({ transactions: [createValidatorRecoveryPlanTransaction({
      networkId: chain.networkId, nonce: beforeInvalid.nonce, plan: invalidPlan,
      wallet: treasury })] });
    chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators)));
  }, /unknown or unbonded|exact pending admission/);
  assert.deepEqual({ nonce: chain.nextNonce(treasury.address), root: chain.stateRoot,
    queue: chain.validatorAdmissionQueue() }, beforeInvalid);
  append(chain, { transactions: [createValidatorRecoveryPlanTransaction({
    networkId: chain.networkId, nonce: beforeInvalid.nonce, plan, wallet: treasury })] }, validators);
  assert.equal(chain.validatorRecoveryPlan.planHash, plan.planHash);
  for (const reserve of reserves) {
    const admission = chain.validatorAdmission(reserve.address);
    assert.ok(admission);
    assert.equal(admission.readiness, false);
  }
  const restored = restore(chain, genesis);
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.deepEqual(restored.validatorAdmissionQueue(), chain.validatorAdmissionQueue());
  assert.equal(restored.validatorRecoveryPlan.planHash, plan.planHash);
  const cancellationHeight = Math.max(...reserves.map((reserve) =>
    chain.validatorAdmission(reserve.address).expiryHeight));
  const balancesBeforeCancellation = new Map(reserves.map((reserve) =>
    [reserve.address, chain.balance(reserve.address)]));
  while (chain.height + 1 < cancellationHeight) append(chain, {}, validators);
  assert.ok(reserves.every((reserve) => chain.validatorAdmission(reserve.address) !== null));
  const rotationActivationHeight = cancellationHeight + 5;
  const onboarding = createValidatorOnboarding({ activationHeight: rotationActivationHeight,
    currentValidators: chain.validatorMembers, networkId: chain.networkId,
    nextValidators: chain.validatorMembers, peers: chain.peerRegistry.peers },
  validators.slice(0, 3), validators, validatorTransports);
  append(chain, { validatorRotation: { activationHeight: rotationActivationHeight,
    onboarding, validators: chain.validatorMembers } }, validators);
  assert.equal(chain.height, cancellationHeight);
  assert.equal(chain.validatorRecoveryPlan, null);
  for (const reserve of reserves) {
    assert.equal(chain.validatorAdmission(reserve.address), null);
    assert.equal(chain.validatorBond(reserve.address), 0n);
    assert.equal(chain.balance(reserve.address),
      balancesBeforeCancellation.get(reserve.address) + MIN_VALIDATOR_BOND);
    assert.equal(chain.validatorRetired(reserve.address), true);
  }
  const cancelledSnapshot = chain.consensusSnapshot();
  for (const reserve of reserves) {
    const tombstone = cancelledSnapshot.state.retiredValidators
      .find(([address]) => address === reserve.address)?.[1];
    assert.equal(tombstone?.retiredHeight, cancellationHeight);
    assert.equal(cancelledSnapshot.state.registeredValidators
      .some(([address]) => address === reserve.address), false);
  }
  const restarted = restore(chain, genesis);
  assert.deepEqual(restarted.consensusSnapshot(), cancelledSnapshot);
  const replayed = new NirChain(genesis);
  for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);
  assert.equal(replayed.stateRoot, chain.stateRoot);
  assert.deepEqual(replayed.consensusSnapshot(), cancelledSnapshot);
});

test("v34 safely binds legacy reserves and recovery consumes them after expiry", (t) => {
  const reserves = Array.from({ length: 4 }, generateWallet);
  const { chain, genesis, treasury, validators, validatorTransports } = fixture(34, reserves);
  assert.ok(reserves.every((wallet) => {
    const admission = chain.validatorAdmission(wallet.address);
    return admission?.legacy && !admission.readiness && admission.endpoint === null;
  }));
  const extra = generateWallet(); const extraTransport = generateWallet();
  const treasuryNonce = chain.nextNonce(treasury.address);
  append(chain, { transactions: [...validators, extra].map((wallet, nonce) => createTransfer({
    amount: (MIN_VALIDATOR_BOND + 4n * MIN_TRANSFER_FEE).toString(),
    networkId: chain.networkId, nonce: treasuryNonce + nonce, recipient: wallet.address,
    wallet: treasury })) }, validators);
  append(chain, { transactions: validators.map((wallet) => createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0, wallet,
  })) }, validators);
  append(chain, { transactions: [createValidatorAdmission({
    chainIdentityGenesisHash: chain.blocks()[0].hash,
    endpoint: "https://non-reserve.example", networkId: chain.networkId, nonce: 0,
    operatorId: "non-reserve-collision", referenceHeight: chain.height,
    tlsCertificateSha256: "e".repeat(64), transportWallet: extraTransport, wallet: extra,
  })] }, validators);
  append(chain, { transactions: [readinessTransaction({ candidate: extra, chain,
    endpoint: "https://non-reserve.example", nonce: 1,
    tlsCertificateSha256: "e".repeat(64), transport: extraTransport, validators })] }, validators);
  const members = reserves.map((wallet, index) => ({ ...publicWallet(wallet),
    operatorId: `legacy-reserve-${index}` }));
  const transports = Array.from({ length: 4 }, generateWallet);
  const normalPeer = (index, transportWallet = transports[index], overrides = {}) => ({
    tlsCertificateSha256: String(index + 1).repeat(64),
    transport: publicWallet(transportWallet), url: `https://legacy-reserve-${index}.example`,
    validatorAddress: reserves[index].address, ...overrides,
  });
  const scheduledHeight = chain.height + 1;
  const planWith = (peerOverrides = new Map(), transportOverrides = new Map()) =>
    createValidatorRecoveryPlan({ activationHeight: scheduledHeight + 64,
      activeValidators: chain.validatorMembers, generation: 1, networkId: chain.networkId,
      scheduledHeight, reserveWallets: reserves.map((wallet, index) => {
        const transportWallet = transportOverrides.get(index) ?? transports[index];
        return { member: members[index], peer: normalPeer(index, transportWallet,
          peerOverrides.get(index)), transportWallet, wallet };
      }) });
  const activePeer = chain.peerRegistry.peers[0];
  const activeTransportWallet = validatorTransports[validators.findIndex(({ address }) =>
    address === activePeer.validatorAddress)];
  const attempts = [
    planWith(new Map([[0, { ...activePeer,
      validatorAddress: reserves[0].address }]]), new Map([[0, activeTransportWallet]])),
    planWith(new Map([[0, { tlsCertificateSha256: "e".repeat(64),
      transport: publicWallet(extraTransport), url: "https://non-reserve.example",
      validatorAddress: reserves[0].address }]]), new Map([[0, extraTransport]])),
    planWith(new Map([[0, { transport: publicWallet(validators[0]) }]]),
      new Map([[0, validators[0]]])),
  ];
  for (const plan of attempts) {
    const before = { nonce: chain.nextNonce(treasury.address), root: chain.stateRoot,
      queue: chain.validatorAdmissionQueue() };
    assert.throws(() => {
      const proposal = chain.buildBlock({ transactions: [createValidatorRecoveryPlanTransaction({
        networkId: chain.networkId, nonce: before.nonce, plan, wallet: treasury })] });
      chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators)));
    }, /exact pending admission binding/);
    assert.deepEqual({ nonce: chain.nextNonce(treasury.address), root: chain.stateRoot,
      queue: chain.validatorAdmissionQueue() }, before);
  }
  const plan = planWith();
  append(chain, { transactions: [createValidatorRecoveryPlanTransaction({
    networkId: chain.networkId, nonce: chain.nextNonce(treasury.address), plan,
    wallet: treasury })] }, validators);
  for (let index = 0; index < reserves.length; index += 1) {
    const admission = chain.validatorAdmission(reserves[index].address);
    assert.equal(admission.legacy, false);
    assert.equal(admission.readiness, false);
    assert.equal(admission.endpoint, `https://legacy-reserve-${index}.example`);
    assert.equal(admission.transport.address, transports[index].address);
  }
  const restored = restore(chain, genesis);
  assert.equal(restored.stateRoot, chain.stateRoot);
  const replayed = new NirChain(genesis);
  for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);
  assert.equal(replayed.stateRoot, chain.stateRoot);

  const reserveExpiry = Math.max(...reserves.map((reserve) =>
    chain.validatorAdmission(reserve.address).expiryHeight));
  while (chain.height < reserveExpiry) append(chain, {}, validators);
  assert.ok(reserves.every((reserve) => chain.validatorAdmission(reserve.address) !== null));
  assert.equal(chain.validatorAdmission(extra.address).readiness, true);
  const omitted = createBeaconBond({ activationHeight: chain.height + 65,
    amount: MIN_BEACON_BOND.toString(), networkId: chain.networkId, nonce: 0,
    operatorId: "v34-recovery-trigger", wallet: generateWallet() });
  const receipts = validators.slice(0, 3).map((validatorWallet) =>
    createAdmissionInclusionReceipt({ acceptedHeight: chain.height, networkId: chain.networkId,
      transaction: omitted, validatorWallet, validators: chain.validatorMembers }));
  const omission = finalizeBlock(chain.buildBlock({}), validators.slice(1, 4));
  chain.appendBlock(omission);
  const evidence = createValidatorAdmissionOmissionEvidence({ certificate: omission.certificate,
    finalizedHeader: blockHeader(omission),
    prepareCertificateHash: prepareCertificateHash(omission.prepareCertificate), receipts,
    round: omission.round, transaction: omitted,
    transactionIds: omission.transactions.map(transactionId), validators: chain.validatorMembers });
  const evidenceTransaction = createValidatorAdmissionOmissionTransaction({ evidence,
    networkId: chain.networkId, nonce: chain.nextNonce(treasury.address), wallet: treasury });
  const checkpoint = { blockHash: omission.hash, format: "nir-validator-recovery-checkpoint-v1",
    generation: plan.generation, height: omission.height, networkId: chain.networkId,
    planHash: plan.planHash, previousHash: omission.previousHash,
    reserveSetId: plan.reserveSetId, stateRoot: omission.stateRoot };
  const directory = mkdtempSync(join(tmpdir(), "nir-v34-recovery-consume-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const signers = reserves.map((wallet, index) =>
    new ValidatorRecoveryLockStore(join(directory, `${index}.json`), wallet));
  const checkpointCertificate = createValidatorRecoveryCheckpointCertificate({
    prepares: signers.slice(0, 3).map((signer) => signer.checkpointVote(checkpoint, "prepare")),
    commits: signers.slice(0, 3).map((signer) => signer.checkpointVote(checkpoint, "commit")),
  });
  const checkpointHash = verifyValidatorRecoveryCheckpoint(
    checkpointCertificate, checkpoint, plan).certificateHash;
  const transition = { checkpoint, checkpointCertificate, evidenceTransaction,
    format: "nir-validator-recovery-transition-v1", generation: plan.generation,
    planHash: plan.planHash, type: "validator-recovery" };
  const balancesBeforeRecovery = new Map(reserves.map((reserve) =>
    [reserve.address, chain.balance(reserve.address)]));
  const fork = chain.fork();
  const restoredBefore = restore(chain, genesis);
  const previousPeerRegistry = chain.peerRegistry;
  const previousValidators = chain.validatorMembers;
  const previousProof = createFinalityProof(omission);
  const proposal = chain.buildBlock({ transactions: [transition] });
  assert.equal(proposal.validatorSetId, plan.reserveSetId);
  const recovered = finalizeValidatorRecoveryBlock(proposal, signers.slice(0, 3), plan,
    { checkpointHash, evidenceHash: evidence.evidenceHash });
  assert.equal(verifyValidatorRecoveryTransition({ expectedNetworkId: chain.networkId, plan,
    previousPeerRegistry, previousProof, recoveryBlock: recovered,
    trustedValidators: previousValidators }).validatorSetId, plan.reserveSetId);
  for (const [label, forgedValidatorSetId] of [
    ["current", validatorSetId(previousValidators)], ["random", "f".repeat(64)],
  ]) {
    const forgedProposal = { ...structuredClone(proposal),
      validatorSetId: forgedValidatorSetId };
    const forgedDirectory = mkdtempSync(join(tmpdir(), `nir-v34-recovery-${label}-set-`));
    t.after(() => rmSync(forgedDirectory, { recursive: true, force: true }));
    const forgedSigners = reserves.map((wallet, index) =>
      new ValidatorRecoveryLockStore(join(forgedDirectory, `${index}.json`), wallet));
    const forged = finalizeValidatorRecoveryBlock(forgedProposal, forgedSigners.slice(0, 3), plan,
      { checkpointHash, evidenceHash: evidence.evidenceHash });
    assert.throws(() => chain.fork().appendBlock(forged),
      /block validator set commitment is invalid/,
      `full node accepted the v34 ${label} validator set commitment`);
    assert.throws(() => verifyValidatorRecoveryTransition({
      expectedNetworkId: chain.networkId, plan, previousPeerRegistry, previousProof,
      recoveryBlock: forged, trustedValidators: previousValidators,
    }), /light client recovery validator set commitment is invalid/,
    `light client accepted the v34 ${label} validator set commitment`);
  }
  for (const replica of [chain, fork, restoredBefore]) replica.appendBlock(recovered);
  assert.equal(chain.validatorRecoveryPlan, null);
  assert.equal(chain.validatorRecoveryGeneration, 1);
  assert.deepEqual(chain.validatorMembers.map(({ address }) => address),
    members.map(({ address }) => address).sort());
  assert.deepEqual(chain.peerRegistry.peers, plan.peers);
  for (const reserve of reserves) {
    assert.equal(chain.validatorAdmission(reserve.address), null);
    assert.equal(chain.validatorBond(reserve.address), MIN_VALIDATOR_BOND);
    assert.equal(chain.balance(reserve.address), balancesBeforeRecovery.get(reserve.address) +
      (reserve.address === recovered.feeRecipient ? MIN_TRANSFER_FEE : 0n));
  }
  assert.equal(chain.validatorAdmission(extra.address).readiness, false);
  assert.equal(chain.consensusSnapshot().state.validatorReadinessObservationFloor, chain.height);
  assert.equal(fork.stateRoot, chain.stateRoot);
  assert.equal(restoredBefore.stateRoot, chain.stateRoot);
  const recoveredSnapshot = chain.consensusSnapshot();
  assert.deepEqual(restore(chain, genesis).consensusSnapshot(), recoveredSnapshot);
  const replayedRecovery = new NirChain(genesis);
  for (const block of chain.blocks().slice(1)) replayedRecovery.appendBlock(block);
  assert.equal(replayedRecovery.stateRoot, chain.stateRoot);
  assert.deepEqual(replayedRecovery.consensusSnapshot(), recoveredSnapshot);
});

test("v32 activation boundary rejects legacy admissions and accepts only the new envelope", () => {
  const { chain, releases, set, treasury, validators } = fixture(31);
  const candidates = [generateWallet(), generateWallet()];
  const transports = [generateWallet(), generateWallet()];
  append(chain, { timestamp: TREASURY_VESTING_MS, transactions: candidates.map((wallet, nonce) =>
    createTransfer({ amount: (MIN_VALIDATOR_BOND + 2n * MIN_TRANSFER_FEE).toString(),
      networkId: chain.networkId, nonce, recipient: wallet.address, wallet: treasury })) }, validators);
  const premature = createValidatorAdmission({ chainIdentityGenesisHash: chain.blocks()[0].hash,
    endpoint: "https://premature.example", networkId: chain.networkId, nonce: 0,
    operatorId: "premature-v32", referenceHeight: chain.height,
    tlsCertificateSha256: "6".repeat(64), transportWallet: transports[0], wallet: candidates[0] });
  assert.throws(() => chain.validateProposal(chain.buildBlock({ transactions: [premature] })),
    /schema|state root|non-canonical/);
  const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, { protocolUpgrade: authorizedUpgrade(chain, set, releases, 32,
    activationHeight) }, validators);
  while (chain.height + 1 < activationHeight) append(chain, {}, validators);
  const legacy = createValidatorAdmission({ endpoint: "https://legacy.example",
    networkId: chain.networkId, nonce: 0, operatorId: "legacy-at-v32",
    tlsCertificateSha256: "7".repeat(64), transportWallet: transports[0], wallet: candidates[0] });
  assert.throws(() => chain.validateProposal(chain.buildBlock({ transactions: [legacy] })),
    /schema|state root|non-canonical/);
  const admitted = createValidatorAdmission({ chainIdentityGenesisHash: chain.blocks()[0].hash,
    endpoint: "https://activation.example", networkId: chain.networkId, nonce: 0,
    operatorId: "activation-v32", referenceHeight: chain.height,
    tlsCertificateSha256: "8".repeat(64), transportWallet: transports[1], wallet: candidates[1] });
  const block = append(chain, { transactions: [admitted] }, validators);
  assert.equal(block.height, activationHeight);
  assert.equal(block.protocolVersion, 32);
  assert.ok(chain.validatorAdmission(candidates[1].address));
});

test("a v32 validator restart evicts an expired persisted admission", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-v32-admission-restart-"));
  let replica;
  try {
    const { chain, genesis, validators, validatorTransports } = fixture(32);
    const directory = join(temporary, "validator");
    for (const name of ["blocks", "commits", "mempool", "prepares", "timeouts"]) {
      mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
    }
    const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(directory, "genesis.json"), serialized(genesis), { mode: 0o600 });
    writeFileSync(join(directory, "VALIDATOR-KEY.json"), serialized(validators[0]), { mode: 0o600 });
    writeFileSync(join(directory, "TRANSPORT-KEY.json"), serialized(validatorTransports[0]),
      { mode: 0o600 });
    writeFileSync(join(directory, "AUTHORIZED-COORDINATOR.json"),
      serialized(publicWallet(generateWallet())), { mode: 0o600 });
    const stored = new NirChain(genesis);
    initializeBlockStore(directory, stored);
    for (const block of chain.blocks().slice(1)) {
      stored.appendBlock(block);
      persistBlock(directory, block, stored);
    }
    const candidate = generateWallet(); const transport = generateWallet();
    const referenceHeight = chain.height - VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS;
    const expired = createValidatorAdmission({ chainIdentityGenesisHash: chain.blocks()[0].hash,
      endpoint: "https://expired-restart.example", networkId: chain.networkId, nonce: 0,
      operatorId: "expired-restart", referenceHeight, tlsCertificateSha256: "e".repeat(64),
      transportWallet: transport, wallet: candidate });
    const persistedPath = join(directory, "mempool", `${transactionId(expired)}.json`);
    writeFileSync(persistedPath, serialized(expired), { mode: 0o600 });
    assert.equal(existsSync(persistedPath), true);
    replica = new ValidatorReplica(directory);
    assert.equal(replica.protocolVersion, 32);
    assert.equal(replica.mempoolSize, 0);
    assert.equal(existsSync(persistedPath), false);
  } finally {
    replica?.closeSecurityState();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("v33 resets stale readiness across cutover, registry change, rotation, snapshot, and replay", () => {
  const { chain, genesis, releases, set, treasury, validators, validatorTransports } = fixture(32);
  const candidates = Array.from({ length: 3 }, generateWallet);
  const transports = Array.from({ length: 3 }, generateWallet);
  append(chain, { timestamp: TREASURY_VESTING_MS, transactions: [...candidates, ...validators]
    .map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + 8n * MIN_TRANSFER_FEE).toString(),
      networkId: chain.networkId, nonce, recipient: wallet.address, wallet: treasury,
    })) }, validators);
  append(chain, { transactions: validators.map((wallet) => createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0, wallet,
  })) }, validators);
  append(chain, { transactions: candidates.map((candidate, index) => createValidatorAdmission({
    chainIdentityGenesisHash: chain.blocks()[0].hash,
    endpoint: `https://v33-${index}.example`, networkId: chain.networkId, nonce: 0,
    operatorId: `candidate-v33-${index}`, referenceHeight: chain.height,
    tlsCertificateSha256: String(index + 4).repeat(64),
    transportWallet: transports[index], wallet: candidate,
  })) }, validators);
  const ready = (target, nonce = chain.nextNonce(candidates[target].address)) => append(chain, {
    transactions: [readinessTransaction({ candidate: candidates[target], chain,
      endpoint: `https://v33-${target}.example`, nonce,
      tlsCertificateSha256: String(target + 4).repeat(64), transport: transports[target],
      validators })],
  }, validators);
  for (let index = 0; index < candidates.length; index += 1) ready(index);

  const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, { protocolUpgrade: authorizedUpgrade(chain, set, releases, 33,
    activationHeight) }, validators);
  while (chain.height + 1 < activationHeight) append(chain, {}, validators);
  const cutoverRegistry = createPeerRegistry({ activationHeight,
    epoch: chain.peerRegistry.epoch + 1, networkId: chain.networkId,
    peers: chain.peerRegistry.peers.map((peer, index) => ({ ...peer,
      url: `https://cutover-${index}.example` })),
    previousRegistryHash: chain.peerRegistryHash,
  }, validators.slice(0, 3));
  append(chain, { peerRegistryUpdate: cutoverRegistry }, validators);
  assert.equal(chain.protocolVersion, 33);
  assert.equal(chain.consensusSnapshot().state.validatorReadinessObservationFloor,
    activationHeight);
  assert.ok(chain.validatorAdmissionQueue().every(({ readiness }) => readiness === false));

  for (let index = 0; index < candidates.length; index += 1) ready(index);
  const registryActivationHeight = chain.height + 1;
  const registry = createPeerRegistry({ activationHeight: registryActivationHeight,
    epoch: chain.peerRegistry.epoch + 1, networkId: chain.networkId,
    peers: chain.peerRegistry.peers.map((peer, index) => ({ ...peer,
      url: `https://refreshed-${index}.example` })),
    previousRegistryHash: chain.peerRegistryHash,
  }, validators.slice(0, 3));
  append(chain, { peerRegistryUpdate: registry }, validators);
  assert.equal(chain.consensusSnapshot().state.validatorReadinessObservationFloor,
    registryActivationHeight);
  assert.ok(chain.validatorAdmissionQueue().every(({ readiness }) => readiness === false));
  const staleNonce = chain.nextNonce(candidates[0].address);
  const beforeStale = { nonce: staleNonce, root: chain.stateRoot,
    queue: chain.validatorAdmissionQueue() };
  const staleReadiness = readinessTransaction({ candidate: candidates[0], chain,
    endpoint: "https://v33-0.example", nonce: staleNonce,
    observedHeight: registryActivationHeight - 1,
    tlsCertificateSha256: "4".repeat(64), transport: transports[0], validators });
  assert.throws(() => {
    const staleProposal = chain.buildBlock({ transactions: [staleReadiness] });
    chain.appendBlock(finalizeBlock(staleProposal, quorumFor(staleProposal, validators)));
  }, /readiness certificate context/);
  assert.deepEqual({ nonce: chain.nextNonce(candidates[0].address), root: chain.stateRoot,
    queue: chain.validatorAdmissionQueue() }, beforeStale);
  ready(0, staleNonce);
  assert.equal(chain.validatorAdmission(candidates[0].address).observedHeight,
    registryActivationHeight);

  const eligibleHeight = Math.max(...chain.validatorAdmissionQueue()
    .map((entry) => entry.eligibleHeight));
  while (chain.height < eligibleHeight) append(chain, {}, validators);
  for (let index = 0; index < candidates.length; index += 1) ready(index);
  const restoredReady = restore(chain, genesis);
  assert.deepEqual(restoredReady.validatorAdmissionQueue(), chain.validatorAdmissionQueue());
  assert.equal(restoredReady.consensusSnapshot().state.validatorReadinessObservationFloor,
    registryActivationHeight);
  const forgedFloor = structuredClone(verifiedSnapshotEnvelope(chain));
  forgedFloor.state.validatorReadinessObservationFloor = registryActivationHeight - 1;
  forgedFloor.stateRoot = computeChainStateRoot(forgedFloor.state);
  forgedFloor.checkpoint.stateRoot = forgedFloor.stateRoot;
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesis, forgedFloor),
    /readiness observation floor snapshot/);

  const [head] = chain.validatorAdmissionQueue();
  const selectedWallet = candidates.find(({ address }) => address === head.address);
  const selectedTransport = transports[candidates.indexOf(selectedWallet)];
  const nextMembers = [...chain.validatorMembers.slice(1), {
    address: head.address, algorithm: head.algorithm, operatorId: head.operatorId,
    publicKey: head.publicKey,
  }];
  const nextWallets = nextMembers.map(({ address }) => address === selectedWallet.address
    ? selectedWallet : validators.find((wallet) => wallet.address === address));
  const activePeers = new Map(chain.peerRegistry.peers
    .map((peer) => [peer.validatorAddress, peer]));
  const rotationActivationHeight = chain.height + 5;
  const onboardingPeers = nextWallets.map((wallet) => wallet.address === selectedWallet.address
    ? { tlsCertificateSha256: head.tlsCertificateSha256,
      transport: publicWallet(selectedTransport), url: head.endpoint,
      validatorAddress: wallet.address }
    : activePeers.get(wallet.address));
  const nextTransports = nextWallets.map((wallet) => wallet.address === selectedWallet.address
    ? selectedTransport : validatorTransports[validators.indexOf(wallet)]);
  const onboarding = createValidatorOnboarding({ activationHeight: rotationActivationHeight,
    currentValidators: chain.validatorMembers, networkId: chain.networkId,
    nextValidators: nextMembers, peers: onboardingPeers }, validators.slice(0, 3),
  nextWallets, nextTransports);
  append(chain, { validatorRotation: { activationHeight: rotationActivationHeight,
    onboarding, validators: nextMembers } }, validators);
  assert.equal(chain.validatorAdmission(head.address).readiness, true,
    "selection preserves the chosen certificate until activation");
  while (chain.height + 1 < rotationActivationHeight) append(chain, {}, validators);
  const activationProposal = chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
  });
  chain.appendBlock(finalizeBlock(activationProposal, [...validators, selectedWallet]));
  assert.equal(chain.validatorAdmission(head.address), null);
  assert.ok(chain.validatorAdmissionQueue().every(({ readiness }) => readiness === false));
  assert.equal(chain.consensusSnapshot().state.validatorReadinessObservationFloor,
    rotationActivationHeight);

  const restored = restore(chain, genesis);
  assert.deepEqual(restored.consensusSnapshot(), chain.consensusSnapshot());
  const replayed = new NirChain(genesis);
  for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);
  assert.equal(replayed.stateRoot, chain.stateRoot);
  assert.deepEqual(replayed.validatorAdmissionQueue(), chain.validatorAdmissionQueue());
});
