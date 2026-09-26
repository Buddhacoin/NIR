import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NirChain, createTransfer, createValidatorBond, finalizeBlock, transactionId }
  from "../blockchain/chain.mjs";
import { MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, MIN_TRANSFER_FEE,
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
function fixture(targetProtocolVersion = 31) {
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
  for (const version of [28, 29, 30, 31, 32].filter((version) => version <= targetProtocolVersion)) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(chain, { protocolUpgrade: version === 28
      ? { activationHeight, format: "nir-protocol-upgrade-v1", version }
      : authorizedUpgrade(chain, set, releases, version, activationHeight) }, validators);
    while (chain.height < activationHeight) append(chain, {}, validators);
  }
  return { chain, genesis, releases, set, treasury, validators, validatorTransports };
}

test("v31 admission survives restart and rotation cannot skip the FIFO head", () => {
  const { chain, genesis, treasury, validators, validatorTransports } = fixture();
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
    endpoint: `https://validator-${index}.example`, networkId: chain.networkId, nonce: 0,
    operatorId: `candidate-${index}`, tlsCertificateSha256: String(index + 5).repeat(64),
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
