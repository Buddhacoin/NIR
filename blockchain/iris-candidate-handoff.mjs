import { createHash } from "node:crypto";

import { addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { evaluateIrisLinearCandidate, recheckIrisPostCommitRecord,
  MAX_IRIS_MODEL_BYTES } from "./iris-linear-candidate.mjs";

// Portable identity for a user-supplied data-only model, not a chain admission,
// execution attestation, independent evaluation, or reward authorization.
const FORMAT = "nir-iris-candidate-handoff-v1";
const DOMAIN = "NIR_IRIS_CANDIDATE_HANDOFF_V1";
const ARTIFACT_DOMAIN = "NIR_IRIS_CANDIDATE_EXACT_BYTES_V1\0";
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const FIELDS = ["format", "scope", "model", "networkId", "chainIdentityGenesisHash",
  "submitter", "recipient", "nonce", "artifactHash", "contentHash", "datasetHash",
  "localCommitHash", "postCommitRecordHash", "executionVerified", "independentlyVerified",
  "networkSubmitted", "admissionEligible", "rewardEligible"];

function validNetworkId(networkId) {
  return typeof networkId === "string" && networkId.length > 0 &&
    Buffer.byteLength(networkId, "utf8") <= 64 && !/[\u0000-\u001f\u007f]/.test(networkId);
}

function validIntent(intent) {
  return intent && typeof intent === "object" && !Array.isArray(intent) &&
    Object.keys(intent).sort().join(",") === [...FIELDS].sort().join(",") &&
    intent.format === FORMAT && intent.scope === "pre-admission-only" &&
    intent.model === "user-iris-integer-linear-v1" && validNetworkId(intent.networkId) &&
    HEX.test(intent.chainIdentityGenesisHash ?? "") && ADDRESS.test(intent.submitter ?? "") &&
    ADDRESS.test(intent.recipient ?? "") && HEX.test(intent.nonce ?? "") &&
    HASH.test(intent.artifactHash ?? "") && HASH.test(intent.contentHash ?? "") &&
    HASH.test(intent.datasetHash ?? "") && HASH.test(intent.localCommitHash ?? "") &&
    HEX.test(intent.postCommitRecordHash ?? "") && intent.executionVerified === false &&
    intent.independentlyVerified === false && intent.networkSubmitted === false &&
    intent.admissionEligible === false && intent.rewardEligible === false;
}

function canonicalBase64(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value;
}

function irisCandidateArtifactHash(modelBytes) {
  if (!Buffer.isBuffer(modelBytes) || modelBytes.length < 1 ||
      modelBytes.length > MAX_IRIS_MODEL_BYTES) throw new Error("invalid data-only Iris model bytes");
  return `sha256:${createHash("sha256").update(ARTIFACT_DOMAIN).update(modelBytes).digest("hex")}`;
}

export function createIrisCandidateHandoffIntent({ root, modelBytes, postCommitRecord,
  submitter, recipient, nonce, networkId, chainIdentityGenesisHash }) {
  if (!ADDRESS.test(submitter ?? "") || !ADDRESS.test(recipient ?? "") ||
      !HEX.test(nonce ?? "") || !validNetworkId(networkId) ||
      !HEX.test(chainIdentityGenesisHash ?? "")) throw new Error("invalid handoff context");
  if (!Buffer.isBuffer(modelBytes) || modelBytes.length < 1 ||
      modelBytes.length > MAX_IRIS_MODEL_BYTES)
    throw new Error("data-only Iris model requires bounded exact bytes");
  if (!postCommitRecord || typeof postCommitRecord !== "object" ||
      Array.isArray(postCommitRecord) ||
      Buffer.byteLength(JSON.stringify(postCommitRecord)) > 4096)
    throw new Error("local Iris post-commit record is invalid or too large");
  const bytes = Buffer.from(modelBytes);
  const checked = evaluateIrisLinearCandidate(root, bytes);
  const record = structuredClone(postCommitRecord);
  if (recheckIrisPostCommitRecord(root, bytes, record).status !== "local-iris-recheck-matched")
    throw new Error("local Iris post-commit record does not match exact model bytes");
  return {
    format: FORMAT, scope: "pre-admission-only", model: "user-iris-integer-linear-v1",
    networkId, chainIdentityGenesisHash, submitter, recipient, nonce,
    artifactHash: irisCandidateArtifactHash(bytes), contentHash: checked.modelHash,
    datasetHash: checked.datasetHash, localCommitHash: record.commitHash,
    postCommitRecordHash: hashObject(record, "NIR_IRIS_POSTCOMMIT_RECORD_V1"),
    executionVerified: false, independentlyVerified: false, networkSubmitted: false,
    admissionEligible: false, rewardEligible: false,
  };
}

export function signIrisCandidateHandoff({ wallet, intent }) {
  if (!validIntent(intent) || wallet?.address !== intent.submitter ||
      !canonicalBase64(wallet.publicKey, 4096) ||
      addressFromPublicKey(wallet.publicKey) !== wallet.address)
    throw new Error("handoff submitter or intent is invalid");
  const signed = { ...intent, publicKey: wallet.publicKey };
  return { ...signed, signature: signObject(signed, wallet, DOMAIN) };
}

export function verifyIrisCandidateHandoff(handoff, { root, modelBytes, postCommitRecord,
  expectedNetworkId, expectedGenesisHash } = {}) {
  if (!validNetworkId(expectedNetworkId) || !HEX.test(expectedGenesisHash ?? ""))
    throw new Error("trusted handoff target context is required");
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff) ||
      Object.keys(handoff).sort().join(",") !== [...FIELDS, "publicKey", "signature"].sort().join(","))
    throw new Error("invalid Iris candidate handoff");
  const { publicKey, signature, ...intent } = handoff;
  if (!validIntent(intent) || intent.networkId !== expectedNetworkId ||
      intent.chainIdentityGenesisHash !== expectedGenesisHash)
    throw new Error("Iris candidate handoff target context differs");
  if (!canonicalBase64(publicKey, 4096) || !canonicalBase64(signature, 10_000) ||
      addressFromPublicKey(publicKey) !== intent.submitter ||
      !verifyObject({ ...intent, publicKey }, signature, publicKey, DOMAIN))
    throw new Error("invalid Iris candidate handoff signature");
  const expected = createIrisCandidateHandoffIntent({ root, modelBytes, postCommitRecord,
    submitter: intent.submitter, recipient: intent.recipient, nonce: intent.nonce,
    networkId: expectedNetworkId, chainIdentityGenesisHash: expectedGenesisHash });
  if (canonicalJson(expected) !== canonicalJson(intent))
    throw new Error("Iris candidate handoff exact bytes or record differ");
  return { status: "local-iris-candidate-handoff-checked", submitter: intent.submitter,
    recipient: intent.recipient, signatureValid: true, exactModelBytesBound: true,
    localReplayMatched: true, executionVerified: false, independentlyVerified: false,
    networkSubmitted: false, admissionEligible: false, rewardEligible: false };
}
