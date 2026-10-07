import { addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { MAX_CERTIFICATE_RECORDS } from "./certificate-lifecycle.mjs";
import { MAX_VALIDATORS, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { MAX_CHECKPOINT_TRUST_PACKAGE_BYTES, validateCheckpointWitnessPolicy }
  from "./checkpoint-trust-package.mjs";
import { verifyRecentFinalityCheckpoint } from "./light-client.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

// V2 witnesses bind a certificate-history commitment to their checkpoint view.
// The finalized chain state does not itself contain this commitment.
const FORMAT = "nir-checkpoint-trust-package-v2";
const ATTESTATION_FORMAT = "nir-checkpoint-witness-attestation-v2";
const EQUIVOCATION_FORMAT = "nir-checkpoint-witness-equivocation-v2";
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const OPERATOR = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VIEW_FIELDS = ["certificateHistoryHead", "certificateRecordCount",
  "chainIdentityGenesisHash", "checkpointHeight", "checkpointStateRoot",
  "checkpointTipHash", "finalityProofHash", "networkId", "validatorSetId"];
const ATTESTATION_FIELDS = ["address", "certificateHistoryHead", "certificateRecordCount",
  ...VIEW_FIELDS.slice(2), "format", "observedAt", "operatorId", "policyId", "sequence",
  "version", "viewHash"];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function certificateCommitment(head, count) {
  if (!HASH.test(head ?? "") || !Number.isSafeInteger(count) ||
      count < 1 || count > MAX_CERTIFICATE_RECORDS) {
    throw new Error("checkpoint certificate commitment is invalid");
  }
  return { certificateHistoryHead: head, certificateRecordCount: count };
}

function canonicalBase64(value, maximum) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("checkpoint signature or public key is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > maximum || bytes.toString("base64") !== value) {
    throw new Error("checkpoint signature or public key is not canonical base64");
  }
}

function normalizeValidators(values) {
  if (!Array.isArray(values) || values.length < 4 || values.length > MAX_VALIDATORS) {
    throw new Error("checkpoint validator set is invalid");
  }
  const addresses = new Set(); const operators = new Set(); const keys = new Set();
  return values.map((value) => {
    exact(value, ["address", "algorithm", "operatorId", "publicKey"], "checkpoint validator");
    canonicalBase64(value.publicKey, 8 * 1024);
    if (value.algorithm !== SIGNATURE_ALGORITHM || !ADDRESS.test(value.address ?? "") ||
        !OPERATOR.test(value.operatorId ?? "") ||
        addressFromPublicKey(value.publicKey) !== value.address ||
        addresses.has(value.address) || operators.has(value.operatorId) || keys.has(value.publicKey)) {
      throw new Error("checkpoint validator identity is duplicate or invalid");
    }
    addresses.add(value.address); operators.add(value.operatorId); keys.add(value.publicKey);
    return structuredClone(value);
  }).sort((left, right) => compareText(left.address, right.address));
}

function checkpointView(finalityProof, validators, policy, commitment) {
  const checkpoint = verifyRecentFinalityCheckpoint(finalityProof, {
    expectedGenesisHash: policy.chainIdentityGenesisHash,
    expectedNetworkId: policy.networkId, trustedValidators: validators,
  });
  const view = {
    ...commitment,
    chainIdentityGenesisHash: policy.chainIdentityGenesisHash,
    checkpointHeight: checkpoint.height,
    checkpointStateRoot: checkpoint.stateRoot,
    checkpointTipHash: checkpoint.tipHash,
    finalityProofHash: `sha3-256:${hashObject(finalityProof, "CHECKPOINT_FINALITY_PROOF_V1")}`,
    networkId: policy.networkId,
    validatorSetId: checkpoint.validatorSetId,
  };
  return { checkpoint, view, viewHash: `sha3-256:${hashObject(view, "CHECKPOINT_VIEW_V2")}` };
}

function attestationPayload(value) {
  exact(value, ATTESTATION_FIELDS, "checkpoint v2 witness attestation");
  certificateCommitment(value.certificateHistoryHead, value.certificateRecordCount);
  if (value.format !== ATTESTATION_FORMAT || value.version !== 2 ||
      !ADDRESS.test(value.address ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
      !NETWORK.test(value.networkId ?? "") || !HASH.test(value.chainIdentityGenesisHash ?? "") ||
      !Number.isSafeInteger(value.checkpointHeight) || value.checkpointHeight < 1 ||
      !HASH.test(value.checkpointStateRoot ?? "") || !HASH.test(value.checkpointTipHash ?? "") ||
      !HASH.test(value.validatorSetId ?? "") || !TAGGED_HASH.test(value.finalityProofHash ?? "") ||
      !TAGGED_HASH.test(value.policyId ?? "") || !TAGGED_HASH.test(value.viewHash ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt < 0) {
    throw new Error("checkpoint v2 witness attestation fields are invalid");
  }
  const view = Object.fromEntries(VIEW_FIELDS.map((field) => [field, value[field]]));
  if (value.viewHash !== `sha3-256:${hashObject(view, "CHECKPOINT_VIEW_V2")}`) {
    throw new Error("checkpoint v2 witness attestation view hash is invalid");
  }
  return structuredClone(value);
}

function signedPayload(value) {
  const { address: _address, format: _format, version: _version, ...signed } = value;
  return signed;
}

export function createCheckpointWitnessAttestationV2({
  certificateHistoryHead, certificateRecordCount, finalityProof, observedAt, operatorId,
  policy: policyValue, sequence, validators: validatorValues, wallet,
}) {
  const commitment = certificateCommitment(certificateHistoryHead, certificateRecordCount);
  const policy = validateCheckpointWitnessPolicy(policyValue);
  const validators = normalizeValidators(validatorValues);
  const witness = policy.witnesses.find((entry) => entry.operatorId === operatorId);
  if (!witness || witness.address !== wallet?.address || witness.publicKey !== wallet?.publicKey) {
    throw new Error("checkpoint v2 witness signer is not in the trusted policy");
  }
  const { view, viewHash } = checkpointView(finalityProof, validators, policy, commitment);
  const payload = attestationPayload({ address: witness.address, ...view,
    format: ATTESTATION_FORMAT, observedAt, operatorId, policyId: policy.policyId,
    sequence, version: 2, viewHash });
  const signature = signObject(signedPayload(payload), wallet,
    "CHECKPOINT_WITNESS_ATTESTATION_V2");
  return { ...payload, signature, attestationHash:
    `sha3-256:${hashObject({ ...payload, signature }, "CHECKPOINT_WITNESS_ATTESTATION_HASH_V2")}` };
}

export function validateCheckpointWitnessAttestationV2(value, {
  expectedView = null, expectedViewHash = null, policy: policyValue,
} = {}) {
  exact(value, [...ATTESTATION_FIELDS, "attestationHash", "signature"],
    "checkpoint v2 witness attestation envelope");
  canonicalBase64(value.signature, 16 * 1024);
  const { attestationHash, signature, ...unsigned } = value;
  const payload = attestationPayload(unsigned);
  const policy = validateCheckpointWitnessPolicy(policyValue);
  const witness = policy.witnesses.find((entry) => entry.operatorId === payload.operatorId);
  const expectedHash = `sha3-256:${hashObject({ ...payload, signature },
    "CHECKPOINT_WITNESS_ATTESTATION_HASH_V2")}`;
  const view = Object.fromEntries(VIEW_FIELDS.map((field) => [field, payload[field]]));
  if (!witness || payload.address !== witness.address || payload.policyId !== policy.policyId ||
      payload.networkId !== policy.networkId ||
      payload.chainIdentityGenesisHash !== policy.chainIdentityGenesisHash ||
      (expectedView !== null && canonicalJson(view) !== canonicalJson(expectedView)) ||
      (expectedViewHash !== null && payload.viewHash !== expectedViewHash) ||
      attestationHash !== expectedHash ||
      !verifyObject(signedPayload(payload), signature, witness.publicKey,
        "CHECKPOINT_WITNESS_ATTESTATION_V2")) {
    throw new Error("checkpoint v2 witness attestation has invalid identity, context, hash, or signature");
  }
  return { ...payload, signature, attestationHash };
}

export function createCheckpointWitnessEquivocationEvidenceV2(firstValue, secondValue, { policy }) {
  const first = validateCheckpointWitnessAttestationV2(firstValue, { policy });
  const second = validateCheckpointWitnessAttestationV2(secondValue, { policy });
  if (first.operatorId !== second.operatorId || first.address !== second.address ||
      first.policyId !== second.policyId || first.sequence !== second.sequence ||
      first.viewHash === second.viewHash) {
    throw new Error("checkpoint v2 attestations do not prove equivocation");
  }
  const attestations = [first, second]
    .sort((left, right) => compareText(left.attestationHash, right.attestationHash));
  const payload = { attestations, format: EQUIVOCATION_FORMAT, operatorId: first.operatorId,
    policyId: first.policyId, sequence: first.sequence, version: 2 };
  return { ...payload, evidenceHash:
    `sha3-256:${hashObject(payload, "CHECKPOINT_WITNESS_EQUIVOCATION_V2")}` };
}

export function validateCheckpointWitnessEquivocationEvidenceV2(value, { policy }) {
  exact(value, ["attestations", "evidenceHash", "format", "operatorId", "policyId",
    "sequence", "version"], "checkpoint v2 equivocation evidence");
  if (value.format !== EQUIVOCATION_FORMAT || value.version !== 2 ||
      !TAGGED_HASH.test(value.evidenceHash ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
      !TAGGED_HASH.test(value.policyId ?? "") || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || !Array.isArray(value.attestations) || value.attestations.length !== 2) {
    throw new Error("checkpoint v2 equivocation evidence is invalid");
  }
  const attestations = value.attestations.map((attestation) =>
    validateCheckpointWitnessAttestationV2(attestation, { policy }));
  if (attestations[0].attestationHash >= attestations[1].attestationHash ||
      attestations.some((entry) => entry.operatorId !== value.operatorId ||
        entry.policyId !== value.policyId || entry.sequence !== value.sequence) ||
      attestations[0].address !== attestations[1].address ||
      attestations[0].viewHash === attestations[1].viewHash) {
    throw new Error("checkpoint v2 evidence does not prove equivocation");
  }
  const { evidenceHash, ...payload } = value;
  if (evidenceHash !== `sha3-256:${hashObject(payload, "CHECKPOINT_WITNESS_EQUIVOCATION_V2")}`) {
    throw new Error("checkpoint v2 equivocation evidence hash is invalid");
  }
  return structuredClone(value);
}

export function assembleCheckpointTrustPackageV2({
  attestations: attestationValues, certificateHistoryHead, certificateRecordCount,
  finalityProof, policy: policyValue, sequence, validators: validatorValues,
}) {
  const commitment = certificateCommitment(certificateHistoryHead, certificateRecordCount);
  const policy = validateCheckpointWitnessPolicy(policyValue);
  const validators = normalizeValidators(validatorValues);
  const { view, viewHash } = checkpointView(finalityProof, validators, policy, commitment);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Array.isArray(attestationValues) ||
      attestationValues.length > 64) throw new Error("checkpoint v2 package input is invalid");
  const attestations = attestationValues.map((entry) =>
    validateCheckpointWitnessAttestationV2(entry,
      { expectedView: view, expectedViewHash: viewHash, policy }))
    .sort((left, right) => compareText(left.operatorId, right.operatorId));
  if (attestations.some((entry) => entry.sequence !== sequence) ||
      new Set(attestations.map(({ operatorId }) => operatorId)).size !== attestations.length ||
      attestations.length < policy.threshold) {
    throw new Error("checkpoint v2 package witness quorum is invalid");
  }
  const payload = { attestations, finalityProof: structuredClone(finalityProof),
    format: FORMAT, policy, sequence, validators, version: 2, view, viewHash };
  return { ...payload, packageHash:
    `sha3-256:${hashObject(payload, "CHECKPOINT_TRUST_PACKAGE_V2")}` };
}

export function verifyCheckpointTrustPackageV2(value, {
  expectedChainIdentityGenesisHash, expectedNetworkId, expectedPolicyId,
  maxAgeMs = null, maxFutureSkewMs = 0, minimumCheckpointHeight, minimumSequence, now = null,
} = {}) {
  exact(value, ["attestations", "finalityProof", "format", "packageHash", "policy",
    "sequence", "validators", "version", "view", "viewHash"], "checkpoint v2 package");
  if (value.format !== FORMAT || value.version !== 2 ||
      !TAGGED_HASH.test(value.packageHash ?? "") || !TAGGED_HASH.test(value.viewHash ?? "") ||
      !TAGGED_HASH.test(expectedPolicyId ?? "") || !NETWORK.test(expectedNetworkId ?? "") ||
      !HASH.test(expectedChainIdentityGenesisHash ?? "") ||
      !Number.isSafeInteger(minimumSequence) || minimumSequence < 0 ||
      !Number.isSafeInteger(minimumCheckpointHeight) || minimumCheckpointHeight < 1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < minimumSequence ||
      !Array.isArray(value.attestations) || value.attestations.length > 64) {
    throw new Error("checkpoint v2 package envelope or anti-replay floor is invalid");
  }
  exact(value.view, VIEW_FIELDS, "checkpoint v2 view");
  const commitment = certificateCommitment(value.view.certificateHistoryHead,
    value.view.certificateRecordCount);
  const policy = validateCheckpointWitnessPolicy(value.policy);
  if (policy.policyId !== expectedPolicyId || policy.networkId !== expectedNetworkId ||
      policy.chainIdentityGenesisHash !== expectedChainIdentityGenesisHash) {
    throw new Error("checkpoint v2 package does not match the pinned trust policy");
  }
  const validators = normalizeValidators(value.validators);
  if (canonicalJson(value.validators) !== canonicalJson(validators)) {
    throw new Error("checkpoint v2 validator set is not canonically ordered");
  }
  const { checkpoint, view, viewHash } = checkpointView(value.finalityProof, validators,
    policy, commitment);
  if (canonicalJson(value.view) !== canonicalJson(view) || value.viewHash !== viewHash ||
      checkpoint.height < minimumCheckpointHeight ||
      validatorSetId(validators) !== view.validatorSetId) {
    throw new Error("checkpoint v2 package view is invalid or replayed");
  }
  const attestations = value.attestations.map((entry) =>
    validateCheckpointWitnessAttestationV2(entry,
      { expectedView: view, expectedViewHash: viewHash, policy }));
  if (attestations.length < policy.threshold ||
      new Set(attestations.map(({ operatorId }) => operatorId)).size !== attestations.length ||
      attestations.some((entry) => entry.sequence !== value.sequence) ||
      attestations.some((entry, index) => index > 0 &&
        attestations[index - 1].operatorId >= entry.operatorId)) {
    throw new Error("checkpoint v2 package witness quorum is invalid");
  }
  if (now !== null && (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 0 || !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 ||
      attestations.some(({ observedAt }) => observedAt < now - maxAgeMs ||
        observedAt > now + maxFutureSkewMs))) {
    throw new Error("checkpoint v2 package witness time policy failed");
  }
  const { packageHash, ...payload } = value;
  if (packageHash !== `sha3-256:${hashObject(payload, "CHECKPOINT_TRUST_PACKAGE_V2")}`) {
    throw new Error("checkpoint v2 package hash is invalid");
  }
  return { certificateHistoryHead: commitment.certificateHistoryHead,
    certificateRecordCount: commitment.certificateRecordCount, checkpoint, packageHash,
    policyGeneration: policy.generation, policyId: policy.policyId, sequence: value.sequence,
    trustedValidators: validators, viewHash,
    witnessOperators: attestations.map(({ operatorId }) => operatorId) };
}

export function serializeCheckpointTrustPackageV2(value) {
  return `${canonicalJson(value)}\n`;
}

export function parseAndVerifyCheckpointTrustPackageV2(input, options) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? "", "utf8");
  if (bytes.length < 2 || bytes.length > MAX_CHECKPOINT_TRUST_PACKAGE_BYTES) {
    throw new Error("checkpoint v2 package bytes are outside the bounded limit");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("checkpoint v2 package is not canonical UTF-8 JSON"); }
  if (!text.endsWith("\n")) throw new Error("checkpoint v2 package is not canonical UTF-8 JSON");
  let value;
  try { value = parseConsensusJson(text.slice(0, -1)); }
  catch { throw new Error("checkpoint v2 package is not valid JSON"); }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error("checkpoint v2 package JSON is not canonical");
  }
  return verifyCheckpointTrustPackageV2(value, options);
}
