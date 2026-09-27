import { randomBytes } from "node:crypto";

import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  MAX_CHECKPOINT_TRUST_PACKAGE_BYTES, verifyCheckpointTrustPackage,
} from "./checkpoint-trust-package.mjs";
import { validateValidatorAdmissionPublicPlan }
  from "./validator-admission-public-plan.mjs";
import { verifyValidatorAdmissionReadinessContext }
  from "./validator-admission-readiness-auth.mjs";
import { validatorSetId } from "./validator-rotation.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";

const FORMAT = "nir-validator-readiness-session-v1";
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const VALIDATOR_READINESS_SESSION_MAX_LIFETIME_MS = 60_000;
export const VALIDATOR_READINESS_SESSION_MAX_FUTURE_SKEW_MS = 30_000;
export const MAX_VALIDATOR_READINESS_SESSION_BYTES =
  MAX_CHECKPOINT_TRUST_PACKAGE_BYTES + 2 * 1024 * 1024;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function release(value) {
  exact(value, ["manifestHash", "releaseVersion", "signerAddress", "sourceRevision"],
    "validator readiness release provenance");
  if (!HASH.test(value.manifestHash ?? "") ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
        value.releaseVersion ?? "") ||
      !/^nir1[0-9a-f]{64}$/.test(value.signerAddress ?? "") ||
      !REVISION.test(value.sourceRevision ?? "")) {
    throw new Error("validator readiness release provenance is invalid");
  }
  return structuredClone(value);
}

function trustedRelease(signedRelease, trustedReleaseAddress) {
  const { manifest, signer } = verifySignedRelease(signedRelease,
    { trustedAddress: trustedReleaseAddress });
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
    manifest.releaseVersion)) {
    throw new Error("validator readiness signed release version is invalid");
  }
  return release({ manifestHash: manifest.manifestHash, releaseVersion: manifest.releaseVersion,
    signerAddress: signer.address, sourceRevision: manifest.sourceRevision });
}

function packagePayload(value, { now }) {
  if (Buffer.byteLength(canonicalJson(value)) > MAX_VALIDATOR_READINESS_SESSION_BYTES) {
    throw new Error("validator readiness session is too large");
  }
  exact(value, ["checkpointTrustPackage", "checkpointTrustPackageHash", "context", "expiresAt",
    "expiresAtHeight", "format", "issuedAt", "joinPlan", "joinPlanHash",
    "releaseProvenance", "releaseProvenanceHash", "sessionId", "validators", "version"],
  "validator readiness session payload");
  if (value.format !== FORMAT || value.version !== 1 || !HASH.test(value.sessionId ?? "") ||
      !TAGGED_HASH.test(value.joinPlanHash ?? "") ||
      !TAGGED_HASH.test(value.releaseProvenanceHash ?? "") ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
      value.issuedAt < 0 || value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > VALIDATOR_READINESS_SESSION_MAX_LIFETIME_MS ||
      value.issuedAt > now + VALIDATOR_READINESS_SESSION_MAX_FUTURE_SKEW_MS ||
      value.expiresAt <= now) {
    throw new Error("validator readiness session lifetime is invalid or expired");
  }
  const joinPlan = validateValidatorAdmissionPublicPlan(value.joinPlan);
  const releaseProvenance = release(value.releaseProvenance);
  if (value.joinPlanHash !== `sha3-256:${hashObject(joinPlan,
    "VALIDATOR_READY_JOIN_PLAN_V1")}` ||
      value.releaseProvenanceHash !== `sha3-256:${hashObject(releaseProvenance,
        "VALIDATOR_READY_RELEASE_V1")}`) {
    throw new Error("validator readiness session provenance hash is invalid");
  }
  const context = verifyValidatorAdmissionReadinessContext(value.context);
  const trust = verifyCheckpointTrustPackage(value.checkpointTrustPackage, {
    expectedChainIdentityGenesisHash: joinPlan.expectedChainIdentityGenesisHash,
    expectedNetworkId: joinPlan.networkId,
    expectedPolicyId: joinPlan.expectedCheckpointPolicyId,
    maxAgeMs: joinPlan.candidateContextMaxWitnessAgeMs,
    maxFutureSkewMs: VALIDATOR_READINESS_SESSION_MAX_FUTURE_SKEW_MS,
    minimumCheckpointHeight: joinPlan.candidateContextMinimumCheckpointHeight,
    minimumSequence: joinPlan.candidateContextMinimumSequence,
    now,
  });
  if (value.checkpointTrustPackageHash !== trust.packageHash ||
      !TAGGED_HASH.test(value.checkpointTrustPackageHash ?? "")) {
    throw new Error("validator readiness checkpoint package hash is invalid");
  }
  if (!Array.isArray(value.validators) ||
      canonicalJson(value.validators) !== canonicalJson(trust.trustedValidators) ||
      validatorSetId(value.validators) !== context.checkpoint.validatorSetId) {
    throw new Error("validator readiness session validator set is invalid");
  }
  const expectedCandidate = { address: joinPlan.consensus.address,
    algorithm: joinPlan.consensus.algorithm, operatorId: joinPlan.operatorId,
    publicKey: joinPlan.consensus.publicKey };
  const expectedTransport = { address: joinPlan.transport.address,
    algorithm: joinPlan.transport.algorithm, publicKey: joinPlan.transport.publicKey };
  if (context.networkId !== joinPlan.networkId ||
      context.chainIdentityGenesisHash !== joinPlan.expectedChainIdentityGenesisHash ||
      canonicalJson(context.candidate) !== canonicalJson(expectedCandidate) ||
      canonicalJson(context.transport) !== canonicalJson(expectedTransport) ||
      context.endpoint !== joinPlan.endpoint ||
      context.tlsCertificateSha256 !== joinPlan.tlsCertificateSha256 ||
      context.checkpoint.height !== trust.checkpoint.height ||
      context.checkpoint.blockHash !== trust.checkpoint.tipHash ||
      context.checkpoint.stateRoot !== trust.checkpoint.stateRoot ||
      context.checkpoint.validatorSetId !== trust.checkpoint.validatorSetId ||
      value.expiresAtHeight !== context.expiresAtHeight ||
      context.expiresAtHeight !== context.checkpoint.height + 16 ||
      !HASH.test(context.admissionId ?? "") || !Number.isSafeInteger(context.nonce) ||
      context.nonce < 0) {
    throw new Error("validator readiness session context binding is invalid");
  }
  return { checkpointTrustPackage: structuredClone(value.checkpointTrustPackage),
    checkpointTrustPackageHash: value.checkpointTrustPackageHash, context,
    expiresAt: value.expiresAt, expiresAtHeight: value.expiresAtHeight,
    format: FORMAT, issuedAt: value.issuedAt, joinPlan,
    joinPlanHash: value.joinPlanHash, releaseProvenance,
    releaseProvenanceHash: value.releaseProvenanceHash, sessionId: value.sessionId,
    validators: structuredClone(value.validators), version: 1 };
}

export function createValidatorReadinessSession({ checkpointTrustPackage, context, expiresAt,
  issuedAt, joinPlan, signedRelease, trustedReleaseAddress, validators } = {},
{ now = Date.now() } = {}) {
  const releaseProvenance = trustedRelease(signedRelease, trustedReleaseAddress);
  const sessionId = randomBytes(32).toString("hex");
  const payload = packagePayload({ checkpointTrustPackage,
    checkpointTrustPackageHash: checkpointTrustPackage?.packageHash, context, expiresAt,
    expiresAtHeight: context?.expiresAtHeight, format: FORMAT,
    issuedAt, joinPlan, joinPlanHash: `sha3-256:${hashObject(joinPlan,
      "VALIDATOR_READY_JOIN_PLAN_V1")}`, releaseProvenance,
    releaseProvenanceHash: `sha3-256:${hashObject(releaseProvenance,
      "VALIDATOR_READY_RELEASE_V1")}`, sessionId, validators, version: 1 }, { now });
  return { ...payload, sessionHash:
    `sha3-256:${hashObject(payload, "VALIDATOR_READY_SESSION_V1")}` };
}

export function verifyValidatorReadinessSession(value, { now = Date.now() } = {}) {
  exact(value, ["checkpointTrustPackage", "checkpointTrustPackageHash", "context", "expiresAt",
    "expiresAtHeight", "format", "issuedAt", "joinPlan", "joinPlanHash",
    "releaseProvenance", "releaseProvenanceHash", "sessionHash", "sessionId", "validators",
    "version"], "validator readiness session");
  const { sessionHash, ...unsigned } = value;
  const payload = packagePayload(unsigned, { now });
  if (sessionHash !== `sha3-256:${hashObject(payload, "VALIDATOR_READY_SESSION_V1")}`) {
    throw new Error("validator readiness session hash is invalid");
  }
  return { ...payload, sessionHash };
}

const ROLE_FORMATS = Object.freeze({
  consensus: "nir-validator-readiness-consensus-package-v1",
  gateway: "nir-validator-readiness-gateway-package-v1",
  transport: "nir-validator-readiness-transport-package-v1",
});

function roleHash(payload, role) {
  if (role === "gateway") {
    return `sha3-256:${hashObject(payload, "VALIDATOR_READY_GATEWAY_V1")}`;
  }
  if (role === "transport") {
    return `sha3-256:${hashObject(payload, "VALIDATOR_READY_TRANSPORT_V1")}`;
  }
  if (role === "consensus") {
    return `sha3-256:${hashObject(payload, "VALIDATOR_READY_CONSENSUS_V1")}`;
  }
  throw new Error("validator readiness role is invalid");
}

export function createValidatorReadinessRolePackage(sessionValue, role,
  { now = Date.now() } = {}) {
  const session = verifyValidatorReadinessSession(sessionValue, { now });
  if (!Object.hasOwn(ROLE_FORMATS, role)) throw new Error("validator readiness role is invalid");
  const payload = { format: ROLE_FORMATS[role], role, session, version: 1 };
  return { ...payload, rolePackageHash: roleHash(payload, role) };
}

export function verifyValidatorReadinessRolePackage(value, { expectedRole,
  now = Date.now() } = {}) {
  exact(value, ["format", "role", "rolePackageHash", "session", "version"],
    "validator readiness role package");
  if (!Object.hasOwn(ROLE_FORMATS, expectedRole) || value.role !== expectedRole ||
      value.format !== ROLE_FORMATS[expectedRole] || value.version !== 1 ||
      !TAGGED_HASH.test(value.rolePackageHash ?? "")) {
    throw new Error("validator readiness role package identity is invalid");
  }
  const session = verifyValidatorReadinessSession(value.session, { now });
  const payload = { format: value.format, role: value.role, session, version: 1 };
  if (value.rolePackageHash !== roleHash(payload, expectedRole)) {
    throw new Error("validator readiness role package hash is invalid");
  }
  return { ...payload, rolePackageHash: value.rolePackageHash };
}
