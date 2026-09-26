import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAccountProof } from "../blockchain/account-proof.mjs";
import {
  assembleCheckpointTrustPackage, createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy,
} from "../blockchain/checkpoint-trust-package.mjs";
import { createTransfer, finalizeBlock, NirChain, transactionId } from "../blockchain/chain.mjs";
import { MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, MIN_TRANSFER_FEE, SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS }
  from "../blockchain/constants.mjs";
import { canonicalJson, generateWallet, hashObject, publicWallet, signObject }
  from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import { createReleaseAuthoritySet, createReleaseTransparencyAnchor }
  from "../blockchain/offline-release-governance.mjs";
import { approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload } from "../blockchain/protocol-upgrade-authorization.mjs";
import { createValidatorCandidateProof } from "../blockchain/validator-candidate-proof.mjs";
import { createValidatorAdmission, createValidatorAdmissionRecord, verifyValidatorAdmission }
  from "../blockchain/validator-admission.mjs";
import { prepareValidatorAdmissionSigningPackage, resolveExpiredValidatorAdmissionIntent,
  signValidatorAdmissionPackage }
  from "../blockchain/validator-join.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
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
function fixture(now = 100_000, validatorCount = 4, targetProtocolVersion = 31,
  fundCandidate = false) {
  const validators = Array.from({ length: validatorCount }, generateWallet);
  const validatorMembers = members(validators, "validator");
  const releases = Array.from({ length: 4 }, generateWallet);
  const releaseSet = createReleaseAuthoritySet({ authorities: members(releases, "release"),
    generation: 1, rotationDelayEntries: 2, threshold: 3 });
  const networkId = "nir-candidate-context-test";
  const candidate = generateWallet(); const treasury = generateWallet();
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
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT], treasuryAddress: treasury.address,
    validators: validatorMembers });
  append(chain, validators);
  for (const version of [28, 29, 30, 31, 32].filter((version) =>
    version <= targetProtocolVersion)) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(chain, validators, { protocolUpgrade: version === 28
      ? { activationHeight, format: "nir-protocol-upgrade-v1", version }
      : authorizedUpgrade(chain, releaseSet, releases, version, activationHeight) });
    while (chain.height < activationHeight) append(chain, validators);
  }
  if (fundCandidate) append(chain, validators, { timestamp: TREASURY_VESTING_MS,
    transactions: [createTransfer({ amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(),
      networkId, nonce: 0, recipient: candidate.address, wallet: treasury })] });
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
  return { candidate, chain, checkpointTrustPackage, now, peers, plan, policy, responses,
    validatorMembers, validators, witnesses };
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

test("B2a prepares and dual-signs one unresolved v32 admission without broadcasting", async () => {
  const value = fixture(1_000_000, 4, 32, true);
  const context = await synchronizeValidatorCandidateContext({ now: value.now, plan: value.plan,
    syncInput: { checkpointTrustPackage: value.checkpointTrustPackage,
      format: "nir-validator-candidate-sync-v1", peers: value.peers, version: 1 },
    request: async (url) => ({ body: value.responses[Number(new URL(url).hostname.match(/(\d+)/)[1])],
      ok: true, status: 200 }) });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nir-b2a-signing-"))); chmodSync(root, 0o700);
  try {
    const transport = generateWallet();
    const consensusPassword = "correct horse consensus";
    const transportPassword = "correct horse transport";
    const installVault = (name, wallet, password, label, suffix) => {
      const target = join(root, name); const generation = join(root,
        `.${name}.nir-private-${suffix.repeat(32)}`);
      writeFileSync(generation, `${JSON.stringify(encryptWallet(wallet, password, { label }), null, 2)}\n`,
        { mode: 0o600 });
      symlinkSync(generation.split("/").at(-1), target, "file");
      return { address: wallet.address, algorithm: wallet.algorithm, label,
        publicKey: wallet.publicKey };
    };
    const consensus = installVault("consensus.nirvault.json", value.candidate, consensusPassword,
      "NIR validator consensus identity", "a");
    const transportPublic = installVault("transport.nirvault.json", transport, transportPassword,
      "NIR validator transport identity", "b");
    const plan = { broadcast: false, candidateContextMaxWitnessAgeMs: 300_000,
      candidateContextMinimumCheckpointHeight: value.chain.height,
      candidateContextMinimumSequence: 1, consensus, endpoint: "https://candidate.example",
      expectedChainIdentityGenesisHash: value.chain.blocks()[0].hash,
      expectedCheckpointPolicyId: value.plan.expectedCheckpointPolicyId,
      format: "nir-validator-join-plan-v2", networkId: value.chain.networkId,
      operatorId: "candidate-offline", paths: {
        consensusVault: join(root, "consensus.nirvault.json"),
        transportVault: join(root, "transport.nirvault.json") },
      status: "awaiting-external-v31-candidate-service",
      tlsCertificateSha256: "d".repeat(64), transport: transportPublic, version: 2 };
    validateValidatorCandidateContext(context, plan, { now: value.now });
    writeFileSync(join(root, "join-plan.json"), `${canonicalJson(plan)}\n`, { mode: 0o600 });
    writeFileSync(join(root, `candidate-context-${context.contextHash}.json`),
      `${canonicalJson(context)}\n`, { mode: 0o600 });
    const packagePath = join(root, "offline-package.json");
    let competingPrepareRejected = false;
    const prepared = prepareValidatorAdmissionSigningPackage({ directory: root,
      outputPath: packagePath, now: value.now, _afterLockAcquire: () => {
        assert.throws(() => prepareValidatorAdmissionSigningPackage({ directory: root,
          outputPath: join(root, "competing-offline-package.json"), now: value.now }),
        /already in progress/);
        competingPrepareRejected = true;
      } });
    assert.equal(prepared.broadcast, false); assert.equal(prepared.intentCreated, true);
    assert.equal(competingPrepareRejected, true);
    assert.equal(readdirSync(root).filter((name) => name.startsWith("admission-intent-0-")).length, 1);
    assert.equal(prepareValidatorAdmissionSigningPackage({ directory: root,
      outputPath: packagePath, now: value.now }).intentCreated, false);
    const signedPath = join(root, "signed-admission.json");
    const substituted = createValidatorAdmission({ amount: MIN_VALIDATOR_BOND.toString(),
      chainIdentityGenesisHash: value.chain.blocks()[0].hash,
      endpoint: "https://substituted.example", fee: MIN_TRANSFER_FEE.toString(),
      networkId: value.chain.networkId, nonce: 0, operatorId: "candidate-offline",
      referenceHeight: value.chain.height, tlsCertificateSha256: "d".repeat(64),
      transportWallet: transport, validUntilHeight: value.chain.height + 64,
      wallet: value.candidate });
    const journalPath = join(root, `admission-signature-0-${prepared.packageHash}.json`);
    writeFileSync(journalPath, `${canonicalJson({ broadcast: false,
      format: "nir-signed-validator-admission-v1", packageHash: prepared.packageHash,
      transaction: substituted, transactionId: transactionId(substituted), version: 1 })}\n`,
    { mode: 0o600 });
    assert.throws(() => signValidatorAdmissionPackage({ directory: root, packagePath,
      outputPath: signedPath, consensusPassword, transportPassword, now: value.now }),
    /binding/);
    unlinkSync(journalPath);
    const lockPath = join(root, "admission-nonce-0.lock");
    const lock = (pid, startedAt = value.now, packageHash = prepared.packageHash) => ({
      format: "nir-validator-admission-signing-lock-v1",
      packageHash, pid, startedAt,
      token: "c".repeat(64), version: 1 });
    assert.throws(() => signValidatorAdmissionPackage({ directory: root, packagePath,
      outputPath: signedPath, consensusPassword, transportPassword, now: value.now,
      _afterLockAcquire: ({ lockPath: acquired }) => {
        const bytes = readFileSync(acquired); unlinkSync(acquired);
        writeFileSync(acquired, bytes, { mode: 0o600 });
      } }), /ownership/);
    assert.equal(existsSync(journalPath), false); assert.equal(existsSync(signedPath), false);
    unlinkSync(lockPath);
    writeFileSync(lockPath, `${canonicalJson(lock(process.pid))}\n`, { mode: 0o600 });
    assert.throws(() => signValidatorAdmissionPackage({ directory: root, packagePath,
      outputPath: signedPath, consensusPassword, transportPassword, now: value.now }),
    /already in progress/);
    unlinkSync(lockPath);
    writeFileSync(lockPath, `${canonicalJson(lock(2_000_000_000, value.now + 30_001))}\n`,
      { mode: 0o600 });
    assert.throws(() => signValidatorAdmissionPackage({ directory: root, packagePath,
      outputPath: signedPath, consensusPassword, transportPassword, now: value.now }),
    /lock is invalid/);
    unlinkSync(lockPath);
    writeFileSync(lockPath, `${canonicalJson(lock(process.pid, value.now - 300_001))}\n`,
      { mode: 0o600 });
    const signed = signValidatorAdmissionPackage({ directory: root, packagePath,
      outputPath: signedPath, consensusPassword, transportPassword, now: value.now });
    assert.equal(signed.broadcast, false); assert.match(signed.status, /not submitted/);
    unlinkSync(signedPath);
    const signedAgain = signValidatorAdmissionPackage({ directory: root, packagePath,
      outputPath: signedPath, consensusPassword: "wrong password value",
      transportPassword: "wrong transport value", now: value.now });
    assert.equal(signedAgain.journalCreated, false); assert.equal(signedAgain.outputCreated, true);
    const artifact = JSON.parse(readFileSync(signedPath, "utf8"));
    const verified = verifyValidatorAdmission(artifact.transaction, value.chain.networkId, {
      chainIdentityGenesisHash: value.chain.blocks()[0].hash,
      currentHeight: value.chain.height + 1, protocolVersion: 32 });
    assert.equal(verified.payload.sender, value.candidate.address);
    assert.equal(verified.transport.address, transport.address);
    assert.equal(verified.payload.referenceHeight, value.chain.height);
    assert.equal(verified.payload.validUntilHeight, value.chain.height + 64);

    const oldValidUntil = verified.payload.validUntilHeight;
    while (value.chain.height <= oldValidUntil) append(value.chain, value.validators);
    assert.equal(prepareValidatorAdmissionSigningPackage({ directory: root,
      outputPath: packagePath, now: value.now }).packageHash, prepared.packageHash);
    const newNow = value.now + 1_000;
    const block = value.chain.blocks().at(-1); const finalityProof = createFinalityProof(block);
    const attestations = value.witnesses.slice(0, 3).map((wallet, index) =>
      createCheckpointWitnessAttestation({ finalityProof, observedAt: newNow - index,
        operatorId: `witness-${index}`, policy: value.policy, sequence: 2,
        validators: value.validatorMembers, wallet }));
    const checkpointTrustPackage = assembleCheckpointTrustPackage({ attestations, finalityProof,
      policy: value.policy, sequence: 2, validators: value.validatorMembers });
    const account = value.chain.accountStateProof(value.candidate.address);
    const responses = value.validators.map((wallet) => ({ accountProof: createAccountProof({
      account: account.account, accountStateRoot: account.accountStateRoot,
      inclusionProof: account.inclusionProof, height: value.chain.height,
      networkId: value.chain.networkId, pendingProtocolUpgrade: value.chain.pendingProtocolUpgrade,
      protocolVersion: value.chain.protocolVersion, stateRoot: value.chain.stateRoot,
      tipHash: value.chain.tipHash, validators: value.validatorMembers,
      validatorWallets: [wallet] }), candidateProof: createValidatorCandidateProof({
      accountStateRoot: value.chain.accountStateRoot, address: value.candidate.address,
      admission: null, height: value.chain.height, networkId: value.chain.networkId,
      protocolVersion: value.chain.protocolVersion, queuePosition: null, queueSize: 0,
      stateRoot: value.chain.stateRoot, tipHash: value.chain.tipHash,
      validators: value.validatorMembers, wallet }), finalityProof }));
    const newer = await synchronizeValidatorCandidateContext({ now: newNow, plan: value.plan,
      syncInput: { checkpointTrustPackage, format: "nir-validator-candidate-sync-v1",
        peers: value.peers, version: 1 }, request: async (url) => ({
        body: responses[Number(new URL(url).hostname.match(/(\d+)/)[1])], ok: true, status: 200 }) });
    writeFileSync(join(root, `candidate-context-${newer.contextHash}.json`),
      `${canonicalJson(newer)}\n`, { mode: 0o600 });
    const resolution = resolveExpiredValidatorAdmissionIntent({ directory: root, now: newNow });
    assert.equal(resolution.oldPackageHash, prepared.packageHash);
    const second = prepareValidatorAdmissionSigningPackage({ directory: root,
      outputPath: join(root, "offline-package-2.json"), now: newNow });
    assert.notEqual(second.packageHash, prepared.packageHash);
    writeFileSync(lockPath, `${canonicalJson(lock(process.pid, newNow - 300_001,
      prepared.packageHash))}\n`, { mode: 0o600 });
    const secondSigned = signValidatorAdmissionPackage({ directory: root,
      packagePath: join(root, "offline-package-2.json"),
      outputPath: join(root, "signed-admission-2.json"), consensusPassword,
      transportPassword, now: newNow });
    assert.equal(secondSigned.packageHash, second.packageHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
