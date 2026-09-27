import assert from "node:assert/strict";
import test from "node:test";

import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  assembleCheckpointTrustPackage,
  createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy,
} from "../blockchain/checkpoint-trust-package.mjs";
import {
  CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import {
  addressFromPublicKey, generateWallet, hashObject, publicWallet,
} from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import { createValidatorAdmissionReadinessContext }
  from "../blockchain/validator-admission-readiness-auth.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";
import {
  createValidatorReadinessSession,
  createValidatorReadinessRolePackage,
  MAX_VALIDATOR_READINESS_SESSION_BYTES,
  VALIDATOR_READINESS_SESSION_MAX_LIFETIME_MS,
  verifyValidatorReadinessRolePackage,
  verifyValidatorReadinessSession,
} from "../blockchain/validator-readiness-session.mjs";

const NOW = 1_800_000_000_000;

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet),
    operatorId: `${prefix}-${index}` }));
}

function rehashSession(value) {
  const { sessionHash: _sessionHash, ...payload } = value;
  return { ...payload,
    sessionHash: `sha3-256:${hashObject(payload, "VALIDATOR_READY_SESSION_V1")}` };
}

function rehashJoinPlan(session) {
  const { format: _format, planCommitment: _planCommitment, version: _version,
    ...fields } = session.joinPlan;
  session.joinPlan.planCommitment = hashObject(fields, "VALIDATOR_ADMISSION_PLAN_V1");
  session.joinPlanHash = `sha3-256:${hashObject(session.joinPlan,
    "VALIDATOR_READY_JOIN_PLAN_V1")}`;
  return rehashSession(session);
}

function fixture() {
  const networkId = "nir-readiness-session-test";
  const validatorWallets = Array.from({ length: 4 }, generateWallet);
  const validators = members(validatorWallets, "validator");
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const candidate = generateWallet();
  const transport = generateWallet();
  const chain = new NirChain({
    beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 },
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisProtocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    genesisTimestamp: 0, networkId, safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address, validators,
  });
  const append = (options = {}) => {
    const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1,
      ...options });
    const block = finalizeBlock(proposal, validatorWallets.slice(0, 3));
    chain.appendBlock(block);
    return block;
  };
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append({ protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
    version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION } });
  while (chain.height < activationHeight) append();
  const checkpointBlock = chain.blocks().at(-1);
  const finalityProof = createFinalityProof(checkpointBlock);
  const genesisHash = chain.blocks()[0].hash;
  const policy = createCheckpointWitnessPolicy({ chainIdentityGenesisHash: genesisHash,
    generation: 1, networkId, threshold: 3, witnesses: members(witnesses, "witness") });
  const attestations = witnesses.slice(0, 3).map((wallet, index) =>
    createCheckpointWitnessAttestation({ finalityProof, observedAt: NOW - 1_000 + index,
      operatorId: `witness-${index}`, policy, sequence: 8, validators, wallet }));
  const checkpointTrustPackage = assembleCheckpointTrustPackage({ attestations, finalityProof,
    policy, sequence: 8, validators });
  const joinFields = { candidateContextMaxWitnessAgeMs: 300_000,
    candidateContextMinimumCheckpointHeight: 1, candidateContextMinimumSequence: 8,
    consensus: { ...publicWallet(candidate), label: "candidate consensus" },
    endpoint: "https://candidate.example",
    expectedChainIdentityGenesisHash: genesisHash, expectedCheckpointPolicyId: policy.policyId,
    networkId, operatorId: "candidate-one", tlsCertificateSha256: "a".repeat(64),
    transport: { ...publicWallet(transport), label: "candidate transport" } };
  const joinPlan = { ...joinFields, format: "nir-validator-admission-public-plan-v1",
    planCommitment: hashObject(joinFields, "VALIDATOR_ADMISSION_PLAN_V1"), version: 1 };
  const context = createValidatorAdmissionReadinessContext({ admission: {
    address: candidate.address, admissionId: "b".repeat(64), algorithm: candidate.algorithm,
    endpoint: joinPlan.endpoint, operatorId: joinPlan.operatorId, publicKey: candidate.publicKey,
    tlsCertificateSha256: joinPlan.tlsCertificateSha256, transport: publicWallet(transport),
  }, chainIdentityGenesisHash: genesisHash, checkpoint: { blockHash: checkpointBlock.hash,
    height: checkpointBlock.height, stateRoot: checkpointBlock.stateRoot,
    validatorSetId: validatorSetId(validators) }, expiresAtHeight: checkpointBlock.height + 16,
  networkId, nonce: 11 });
  const releaseSigner = generateWallet();
  const releasePayload = { files: [{ executable: false, path: "blockchain/example.mjs",
    sha3_256: "c".repeat(64), size: 42 }], format: "nir-source-release-v1",
  releaseVersion: "1.2.3", sourceRevision: "d".repeat(40) };
  const signedRelease = signReleaseManifest({ ...releasePayload,
    manifestHash: hashObject(releasePayload, "RELEASE_MANIFEST_HASH") }, releaseSigner);
  const input = { checkpointTrustPackage, context, expiresAt: NOW + 30_000, issuedAt: NOW,
    joinPlan, sessionId: "e".repeat(64), signedRelease,
    trustedReleaseAddress: releaseSigner.address, validators: checkpointTrustPackage.validators };
  const session = createValidatorReadinessSession(input, { now: NOW });
  return { ...input, candidate, checkpointBlock, genesisHash, policy, session, transport };
}

test("readiness session binds verified join, release, finality, identities, and expiry", () => {
  const value = fixture();
  assert.deepEqual(verifyValidatorReadinessSession(value.session, { now: NOW }), value.session);
  assert.equal(value.session.context.candidate.address, value.candidate.address);
  assert.equal(value.session.context.transport.address, value.transport.address);
  assert.equal(value.session.context.checkpoint.blockHash, value.checkpointBlock.hash);
  assert.match(value.session.joinPlanHash, /^sha3-256:[0-9a-f]{64}$/);
  assert.match(value.session.releaseProvenanceHash, /^sha3-256:[0-9a-f]{64}$/);
  assert.match(value.session.sessionHash, /^sha3-256:[0-9a-f]{64}$/);
  const second = createValidatorReadinessSession(value, { now: NOW });
  assert.notEqual(second.sessionId, value.session.sessionId);
  assert.notEqual(second.sessionHash, value.session.sessionHash);
});

test("readiness session exact schema and commitments reject mutation", () => {
  const { session } = fixture();
  assert.throws(() => verifyValidatorReadinessSession({ ...session, extra: true }, { now: NOW }),
    /unknown or missing/);
  for (const mutate of [
    (copy) => { copy.sessionId = "0".repeat(64); },
    (copy) => { copy.releaseProvenance.releaseVersion = "1.2.4"; },
    (copy) => { copy.joinPlan.operatorId = "candidate-two"; },
    (copy) => { copy.context.nonce += 1; },
    (copy) => { copy.validators.reverse(); },
    (copy) => { copy.checkpointTrustPackage.sequence += 1; },
  ]) {
    const copy = structuredClone(session); mutate(copy);
    assert.throws(() => verifyValidatorReadinessSession(copy, { now: NOW }));
  }
  const missing = structuredClone(session); delete missing.context;
  assert.throws(() => verifyValidatorReadinessSession(missing, { now: NOW }),
    /unknown or missing/);
});

test("role packages use distinct formats and hashes and reject role swapping", () => {
  const { session } = fixture();
  const packages = ["gateway", "transport", "consensus"].map((role) =>
    createValidatorReadinessRolePackage(session, role, { now: NOW }));
  assert.equal(new Set(packages.map(({ format }) => format)).size, 3);
  assert.equal(new Set(packages.map(({ rolePackageHash }) => rolePackageHash)).size, 3);
  for (const [index, role] of ["gateway", "transport", "consensus"].entries()) {
    assert.deepEqual(verifyValidatorReadinessRolePackage(packages[index], {
      expectedRole: role, now: NOW }), packages[index]);
    const other = role === "gateway" ? "transport" : "gateway";
    assert.throws(() => verifyValidatorReadinessRolePackage(packages[index], {
      expectedRole: other, now: NOW }), /identity/);
    const swapped = structuredClone(packages[index]); swapped.role = other;
    assert.throws(() => verifyValidatorReadinessRolePackage(swapped, {
      expectedRole: other, now: NOW }), /identity|hash/);
  }
});

test("rehashed cross-field substitutions cannot splice network, identity, TLS, or checkpoint", () => {
  const value = fixture();
  const cases = [];
  const wrongCandidate = generateWallet();
  cases.push(() => createValidatorAdmissionReadinessContext({ admission: {
    address: wrongCandidate.address, admissionId: value.context.admissionId,
    algorithm: wrongCandidate.algorithm, endpoint: value.context.endpoint,
    operatorId: value.context.candidate.operatorId, publicKey: wrongCandidate.publicKey,
    tlsCertificateSha256: value.context.tlsCertificateSha256,
    transport: value.context.transport }, chainIdentityGenesisHash: value.genesisHash,
  checkpoint: value.context.checkpoint, expiresAtHeight: value.context.expiresAtHeight,
  networkId: value.context.networkId, nonce: value.context.nonce }));
  cases.push(() => createValidatorAdmissionReadinessContext({ admission: {
    ...value.context.candidate, admissionId: value.context.admissionId,
    endpoint: value.context.endpoint, tlsCertificateSha256: "f".repeat(64),
    transport: value.context.transport }, chainIdentityGenesisHash: value.genesisHash,
  checkpoint: value.context.checkpoint, expiresAtHeight: value.context.expiresAtHeight,
  networkId: value.context.networkId, nonce: value.context.nonce }));
  cases.push(() => createValidatorAdmissionReadinessContext({ admission: {
    ...value.context.candidate, admissionId: value.context.admissionId,
    endpoint: "https://other.example", tlsCertificateSha256: value.context.tlsCertificateSha256,
    transport: value.context.transport }, chainIdentityGenesisHash: value.genesisHash,
  checkpoint: value.context.checkpoint, expiresAtHeight: value.context.expiresAtHeight,
  networkId: value.context.networkId, nonce: value.context.nonce }));
  for (const contextForAttack of cases) {
    const attacked = structuredClone(value.session);
    attacked.context = contextForAttack();
    assert.throws(() => verifyValidatorReadinessSession(rehashSession(attacked), { now: NOW }),
      /context binding/);
  }
  const checkpoint = structuredClone(value.session);
  checkpoint.context = createValidatorAdmissionReadinessContext({ admission: {
    ...value.context.candidate, admissionId: value.context.admissionId,
    endpoint: value.context.endpoint, tlsCertificateSha256: value.context.tlsCertificateSha256,
    transport: value.context.transport }, chainIdentityGenesisHash: value.genesisHash,
  checkpoint: { ...value.context.checkpoint, blockHash: "f".repeat(64) },
  expiresAtHeight: value.context.expiresAtHeight, networkId: value.context.networkId,
  nonce: value.context.nonce });
  assert.throws(() => verifyValidatorReadinessSession(rehashSession(checkpoint), { now: NOW }),
    /context binding/);
});

test("session lifetime, witness freshness, and validator ordering fail closed", () => {
  const value = fixture();
  assert.throws(() => verifyValidatorReadinessSession(value.session,
    { now: value.session.expiresAt }), /expired/);
  assert.throws(() => createValidatorReadinessSession({ ...value,
    expiresAt: NOW + VALIDATOR_READINESS_SESSION_MAX_LIFETIME_MS + 1 }, { now: NOW }),
  /lifetime/);
  assert.throws(() => verifyValidatorReadinessSession(value.session, { now: NOW + 400_000 }),
    /expired|time policy/);
  const reversed = structuredClone(value.session); reversed.validators.reverse();
  reversed.sessionHash = `sha3-256:${hashObject((({ sessionHash: _hash, ...rest }) => rest)(reversed),
    "VALIDATOR_READY_SESSION_V1")}`;
  assert.throws(() => verifyValidatorReadinessSession(reversed, { now: NOW }),
    /validator set/);
});

test("duplicate identities, foreign genesis, stale sequence, and self-hash tricks fail closed", () => {
  const value = fixture();
  for (const field of ["publicKey", "operatorId"]) {
    const duplicate = structuredClone(value.session);
    duplicate.validators[1][field] = duplicate.validators[0][field];
    assert.throws(() => verifyValidatorReadinessSession(rehashSession(duplicate), { now: NOW }),
      /validator|identity|duplicate|trusted|vote/i);
  }

  const foreignGenesis = structuredClone(value.session);
  foreignGenesis.joinPlan.expectedChainIdentityGenesisHash = "f".repeat(64);
  assert.throws(() => verifyValidatorReadinessSession(rehashJoinPlan(foreignGenesis),
    { now: NOW }), /pinned trust policy/);

  const staleSequence = structuredClone(value.session);
  staleSequence.joinPlan.candidateContextMinimumSequence =
    staleSequence.checkpointTrustPackage.sequence + 1;
  assert.throws(() => verifyValidatorReadinessSession(rehashJoinPlan(staleSequence),
    { now: NOW - 500 }), /anti-replay|replayed/);

  const circular = structuredClone(value.session);
  circular.joinPlanHash = circular.sessionHash;
  assert.throws(() => verifyValidatorReadinessSession(rehashSession(circular), { now: NOW }),
    /provenance hash/);
  const role = createValidatorReadinessRolePackage(value.session, "transport", { now: NOW });
  role.rolePackageHash = role.session.sessionHash;
  assert.throws(() => verifyValidatorReadinessRolePackage(role, {
    expectedRole: "transport", now: NOW }), /package hash/);

  assert.throws(() => createValidatorReadinessSession({ ...value,
    trustedReleaseAddress: generateWallet().address }, { now: NOW }), /not trusted/);

  const malformedKey = structuredClone(value.session);
  malformedKey.joinPlan.consensus.publicKey = "YQ";
  malformedKey.joinPlan.consensus.address = addressFromPublicKey("YQ");
  assert.throws(() => verifyValidatorReadinessSession(rehashJoinPlan(malformedKey),
    { now: NOW }), /consensus identity is invalid/);
});

test("session parser rejects exotic, circular, and oversized hostile values", () => {
  const { session } = fixture();
  const exotic = Object.assign(Object.create({ inherited: true }), session);
  assert.throws(() => verifyValidatorReadinessSession(exotic, { now: NOW }),
    /unknown or missing|prototype|exotic/);

  const circular = structuredClone(session);
  circular.joinPlan.circular = circular.joinPlan;
  assert.throws(() => verifyValidatorReadinessSession(circular, { now: NOW }),
    /cyclic|circular|active|unknown|consensus value/i);

  const oversized = structuredClone(session);
  oversized.releaseProvenance.releaseVersion =
    `1.2.${"3".repeat(MAX_VALIDATOR_READINESS_SESSION_BYTES)}`;
  assert.throws(() => verifyValidatorReadinessSession(oversized, { now: NOW }),
    /too large/);
});
