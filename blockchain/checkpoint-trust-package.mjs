import { addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { MAX_VALIDATORS, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { verifyRecentFinalityCheckpoint } from "./light-client.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const POLICY_FORMAT = "nir-checkpoint-witness-policy-v1";
const ATTESTATION_FORMAT = "nir-checkpoint-witness-attestation-v1";
const PACKAGE_FORMAT = "nir-checkpoint-trust-package-v1";
const EQUIVOCATION_FORMAT = "nir-checkpoint-witness-equivocation-v1";
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const OPERATOR = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const MAX_WITNESSES = 64;
export const MAX_CHECKPOINT_TRUST_PACKAGE_BYTES = 4 * 1024 * 1024;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function canonicalBase64(value, maximum, label) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > maximum || bytes.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
}

function policyPayload(value) {
  exact(value, ["chainIdentityGenesisHash", "format", "generation", "networkId", "threshold",
    "version", "witnesses"], "checkpoint witness policy");
  if (value.format !== POLICY_FORMAT || value.version !== 1 ||
      !NETWORK.test(value.networkId ?? "") || !HASH.test(value.chainIdentityGenesisHash ?? "") ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      !Number.isSafeInteger(value.threshold) || value.threshold < 2 ||
      !Array.isArray(value.witnesses) || value.witnesses.length < value.threshold ||
      value.witnesses.length > MAX_WITNESSES ||
      value.threshold < Math.floor((value.witnesses.length * 2) / 3) + 1) {
    throw new Error("checkpoint witness policy is invalid");
  }
  const operators = new Set(); const addresses = new Set(); const keys = new Set();
  const witnesses = value.witnesses.map((witness, index) => {
    exact(witness, ["address", "algorithm", "operatorId", "publicKey"], "checkpoint witness");
    canonicalBase64(witness.publicKey, 8 * 1024, "checkpoint witness public key");
    if (!OPERATOR.test(witness.operatorId ?? "") || witness.algorithm !== SIGNATURE_ALGORITHM ||
        !ADDRESS.test(witness.address ?? "") || addressFromPublicKey(witness.publicKey) !== witness.address ||
        operators.has(witness.operatorId) || addresses.has(witness.address) || keys.has(witness.publicKey) ||
        (index > 0 && value.witnesses[index - 1].operatorId >= witness.operatorId)) {
      throw new Error("checkpoint witnesses are duplicate, unordered, or invalid");
    }
    operators.add(witness.operatorId); addresses.add(witness.address); keys.add(witness.publicKey);
    return structuredClone(witness);
  });
  return { chainIdentityGenesisHash: value.chainIdentityGenesisHash, format: POLICY_FORMAT,
    generation: value.generation, networkId: value.networkId, threshold: value.threshold,
    version: 1, witnesses };
}

export function createCheckpointWitnessPolicy({
  chainIdentityGenesisHash, generation = 0, networkId, threshold, witnesses,
}) {
  const payload = policyPayload({ chainIdentityGenesisHash, format: POLICY_FORMAT, generation,
    networkId, threshold, version: 1,
    witnesses: [...witnesses].sort((left, right) => compareText(left.operatorId, right.operatorId)) });
  return { ...payload, policyId: `sha3-256:${hashObject(payload, "CHECKPOINT_WITNESS_POLICY_V1")}` };
}

export function validateCheckpointWitnessPolicy(value) {
  exact(value, ["chainIdentityGenesisHash", "format", "generation", "networkId", "policyId",
    "threshold", "version", "witnesses"], "checkpoint witness policy envelope");
  const { policyId, ...unsigned } = value;
  const payload = policyPayload(unsigned);
  if (policyId !== `sha3-256:${hashObject(payload, "CHECKPOINT_WITNESS_POLICY_V1")}`) {
    throw new Error("checkpoint witness policy id is invalid");
  }
  return { ...payload, policyId };
}

function normalizeValidators(values) {
  if (!Array.isArray(values) || values.length < 4 || values.length > MAX_VALIDATORS) {
    throw new Error("checkpoint validator set is invalid");
  }
  const addresses = new Set(); const operators = new Set(); const keys = new Set();
  const validators = values.map((value) => {
    exact(value, ["address", "algorithm", "operatorId", "publicKey"], "checkpoint validator");
    canonicalBase64(value.publicKey, 8 * 1024, "checkpoint validator public key");
    if (value.algorithm !== SIGNATURE_ALGORITHM || !ADDRESS.test(value.address ?? "") ||
        !OPERATOR.test(value.operatorId ?? "") || addressFromPublicKey(value.publicKey) !== value.address ||
        addresses.has(value.address) || operators.has(value.operatorId) || keys.has(value.publicKey)) {
      throw new Error("checkpoint validator identity is duplicate or invalid");
    }
    addresses.add(value.address); operators.add(value.operatorId); keys.add(value.publicKey);
    return structuredClone(value);
  }).sort((left, right) => compareText(left.address, right.address));
  return validators;
}

function checkpointView(finalityProof, validators, policy) {
  const checkpoint = verifyRecentFinalityCheckpoint(finalityProof, {
    expectedGenesisHash: policy.chainIdentityGenesisHash,
    expectedNetworkId: policy.networkId,
    trustedValidators: validators,
  });
  const proofHash = `sha3-256:${hashObject(finalityProof, "CHECKPOINT_FINALITY_PROOF_V1")}`;
  const view = {
    chainIdentityGenesisHash: policy.chainIdentityGenesisHash,
    checkpointHeight: checkpoint.height,
    checkpointStateRoot: checkpoint.stateRoot,
    checkpointTipHash: checkpoint.tipHash,
    finalityProofHash: proofHash,
    networkId: policy.networkId,
    validatorSetId: checkpoint.validatorSetId,
  };
  return { checkpoint, view, viewHash: `sha3-256:${hashObject(view, "CHECKPOINT_VIEW_V1")}` };
}

function attestationPayload(value) {
  exact(value, ["address", "chainIdentityGenesisHash", "checkpointHeight", "checkpointStateRoot",
    "checkpointTipHash", "finalityProofHash", "format", "networkId", "observedAt", "operatorId",
    "policyId", "sequence", "validatorSetId", "version", "viewHash"],
  "checkpoint witness attestation");
  if (value.format !== ATTESTATION_FORMAT || value.version !== 1 ||
      !ADDRESS.test(value.address ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
      !NETWORK.test(value.networkId ?? "") || !HASH.test(value.chainIdentityGenesisHash ?? "") ||
      !Number.isSafeInteger(value.checkpointHeight) || value.checkpointHeight < 1 ||
      !HASH.test(value.checkpointStateRoot ?? "") || !HASH.test(value.checkpointTipHash ?? "") ||
      !HASH.test(value.validatorSetId ?? "") || !TAGGED_HASH.test(value.finalityProofHash ?? "") ||
      !TAGGED_HASH.test(value.policyId ?? "") || !TAGGED_HASH.test(value.viewHash ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt < 0) {
    throw new Error("checkpoint witness attestation fields are invalid");
  }
  const view = { chainIdentityGenesisHash: value.chainIdentityGenesisHash,
    checkpointHeight: value.checkpointHeight, checkpointStateRoot: value.checkpointStateRoot,
    checkpointTipHash: value.checkpointTipHash, finalityProofHash: value.finalityProofHash,
    networkId: value.networkId, validatorSetId: value.validatorSetId };
  if (value.viewHash !== `sha3-256:${hashObject(view, "CHECKPOINT_VIEW_V1")}`) {
    throw new Error("checkpoint witness attestation view hash is invalid");
  }
  return structuredClone(value);
}

function signedAttestationPayload(payload) {
  const { address: _address, format: _format, version: _version, ...signed } = payload;
  return signed;
}

export function createCheckpointWitnessAttestation({
  finalityProof, observedAt, operatorId, policy: policyValue, sequence, validators: validatorValues,
  wallet,
}) {
  const policy = validateCheckpointWitnessPolicy(policyValue);
  const validators = normalizeValidators(validatorValues);
  const witness = policy.witnesses.find((candidate) => candidate.operatorId === operatorId);
  if (!witness || witness.address !== wallet?.address || witness.publicKey !== wallet?.publicKey) {
    throw new Error("checkpoint witness signer is not in the trusted policy");
  }
  const { view, viewHash } = checkpointView(finalityProof, validators, policy);
  const payload = attestationPayload({ address: witness.address,
    chainIdentityGenesisHash: view.chainIdentityGenesisHash,
    checkpointHeight: view.checkpointHeight, checkpointStateRoot: view.checkpointStateRoot,
    checkpointTipHash: view.checkpointTipHash, finalityProofHash: view.finalityProofHash,
    format: ATTESTATION_FORMAT, networkId: view.networkId, observedAt, operatorId,
    policyId: policy.policyId, sequence, validatorSetId: view.validatorSetId, version: 1, viewHash });
  const signature = signObject(signedAttestationPayload(payload), wallet,
    "CHECKPOINT_WITNESS_ATTESTATION_V1");
  return { ...payload, signature, attestationHash:
    `sha3-256:${hashObject({ ...payload, signature }, "CHECKPOINT_WITNESS_ATTESTATION_HASH_V1")}` };
}

export function validateCheckpointWitnessAttestation(value, {
  expectedView = null, expectedViewHash = null, policy: policyValue,
} = {}) {
  exact(value, ["address", "attestationHash", "chainIdentityGenesisHash", "checkpointHeight",
    "checkpointStateRoot", "checkpointTipHash", "finalityProofHash", "format", "networkId",
    "observedAt", "operatorId", "policyId", "sequence", "signature", "validatorSetId", "version",
    "viewHash"], "checkpoint witness attestation envelope");
  canonicalBase64(value.signature, 16 * 1024, "checkpoint witness signature");
  const { attestationHash, signature, ...unsigned } = value;
  const payload = attestationPayload(unsigned);
  const policy = validateCheckpointWitnessPolicy(policyValue);
  const witness = policy.witnesses.find((candidate) => candidate.operatorId === payload.operatorId);
  const expectedHash = `sha3-256:${hashObject({ ...payload, signature },
    "CHECKPOINT_WITNESS_ATTESTATION_HASH_V1")}`;
  const viewMismatch = expectedView !== null && (
    payload.chainIdentityGenesisHash !== expectedView.chainIdentityGenesisHash ||
    payload.checkpointHeight !== expectedView.checkpointHeight ||
    payload.checkpointStateRoot !== expectedView.checkpointStateRoot ||
    payload.checkpointTipHash !== expectedView.checkpointTipHash ||
    payload.finalityProofHash !== expectedView.finalityProofHash ||
    payload.networkId !== expectedView.networkId ||
    payload.validatorSetId !== expectedView.validatorSetId);
  if (!witness || payload.address !== witness.address || payload.policyId !== policy.policyId ||
      payload.networkId !== policy.networkId ||
      payload.chainIdentityGenesisHash !== policy.chainIdentityGenesisHash ||
      viewMismatch ||
      (expectedViewHash !== null && payload.viewHash !== expectedViewHash) ||
      attestationHash !== expectedHash ||
      !verifyObject(signedAttestationPayload(payload), signature, witness.publicKey,
        "CHECKPOINT_WITNESS_ATTESTATION_V1")) {
    throw new Error("checkpoint witness attestation has invalid identity, context, hash, or signature");
  }
  return { ...payload, signature, attestationHash };
}

function sameAttestedView(left, right) {
  return left.viewHash === right.viewHash && left.finalityProofHash === right.finalityProofHash &&
    left.checkpointHeight === right.checkpointHeight && left.checkpointTipHash === right.checkpointTipHash &&
    left.checkpointStateRoot === right.checkpointStateRoot && left.validatorSetId === right.validatorSetId;
}

export function createCheckpointWitnessEquivocationEvidence(firstValue, secondValue, { policy }) {
  const first = validateCheckpointWitnessAttestation(firstValue, { policy });
  const second = validateCheckpointWitnessAttestation(secondValue, { policy });
  if (first.operatorId !== second.operatorId || first.address !== second.address ||
      first.policyId !== second.policyId || first.sequence !== second.sequence ||
      first.networkId !== second.networkId ||
      first.chainIdentityGenesisHash !== second.chainIdentityGenesisHash || sameAttestedView(first, second)) {
    throw new Error("checkpoint attestations do not prove equivocation");
  }
  const attestations = [first, second]
    .sort((left, right) => compareText(left.attestationHash, right.attestationHash));
  const payload = { attestations, format: EQUIVOCATION_FORMAT, operatorId: first.operatorId,
    policyId: first.policyId, sequence: first.sequence, version: 1 };
  return { ...payload, evidenceHash:
    `sha3-256:${hashObject(payload, "CHECKPOINT_WITNESS_EQUIVOCATION_V1")}` };
}

export function validateCheckpointWitnessEquivocationEvidence(value, { policy }) {
  exact(value, ["attestations", "evidenceHash", "format", "operatorId", "policyId", "sequence",
    "version"], "checkpoint witness equivocation evidence");
  if (value.format !== EQUIVOCATION_FORMAT || value.version !== 1 ||
      !TAGGED_HASH.test(value.evidenceHash ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
      !TAGGED_HASH.test(value.policyId ?? "") || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || !Array.isArray(value.attestations) || value.attestations.length !== 2) {
    throw new Error("checkpoint witness equivocation evidence is invalid");
  }
  const attestations = value.attestations.map((attestation) =>
    validateCheckpointWitnessAttestation(attestation, { policy }));
  if (attestations[0].attestationHash >= attestations[1].attestationHash ||
      attestations.some((attestation) => attestation.operatorId !== value.operatorId ||
        attestation.policyId !== value.policyId || attestation.sequence !== value.sequence) ||
      attestations[0].address !== attestations[1].address ||
      attestations[0].networkId !== attestations[1].networkId ||
      attestations[0].chainIdentityGenesisHash !== attestations[1].chainIdentityGenesisHash ||
      sameAttestedView(attestations[0], attestations[1])) {
    throw new Error("checkpoint witness evidence does not prove equivocation");
  }
  const { evidenceHash, ...payload } = value;
  if (evidenceHash !== `sha3-256:${hashObject(payload, "CHECKPOINT_WITNESS_EQUIVOCATION_V1")}`) {
    throw new Error("checkpoint witness equivocation evidence hash is invalid");
  }
  return structuredClone(value);
}

export function assembleCheckpointTrustPackage({
  attestations: attestationValues, finalityProof, policy: policyValue, sequence,
  validators: validatorValues,
}) {
  const policy = validateCheckpointWitnessPolicy(policyValue);
  const validators = normalizeValidators(validatorValues);
  const { view, viewHash } = checkpointView(finalityProof, validators, policy);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Array.isArray(attestationValues) ||
      attestationValues.length > MAX_WITNESSES) throw new Error("checkpoint trust package input is invalid");
  const attestations = attestationValues.map((value) =>
    validateCheckpointWitnessAttestation(value, { expectedView: view, expectedViewHash: viewHash, policy }))
    .sort((left, right) => compareText(left.operatorId, right.operatorId));
  if (attestations.some((value) => value.sequence !== sequence) ||
      new Set(attestations.map(({ operatorId }) => operatorId)).size !== attestations.length ||
      attestations.length < policy.threshold) {
    throw new Error("checkpoint trust package witness quorum is invalid");
  }
  const payload = { attestations, finalityProof: structuredClone(finalityProof),
    format: PACKAGE_FORMAT, policy, sequence, validators, version: 1, view, viewHash };
  return { ...payload, packageHash:
    `sha3-256:${hashObject(payload, "CHECKPOINT_TRUST_PACKAGE_V1")}` };
}

export function verifyCheckpointTrustPackage(value, {
  expectedChainIdentityGenesisHash, expectedNetworkId, expectedPolicyId,
  maxAgeMs = null, maxFutureSkewMs = 0, minimumCheckpointHeight, minimumSequence, now = null,
} = {}) {
  exact(value, ["attestations", "finalityProof", "format", "packageHash", "policy", "sequence",
    "validators", "version", "view", "viewHash"], "checkpoint trust package");
  if (value.format !== PACKAGE_FORMAT || value.version !== 1 ||
      !TAGGED_HASH.test(value.packageHash ?? "") || !TAGGED_HASH.test(value.viewHash ?? "") ||
      !TAGGED_HASH.test(expectedPolicyId ?? "") || !NETWORK.test(expectedNetworkId ?? "") ||
      !HASH.test(expectedChainIdentityGenesisHash ?? "") ||
      !Number.isSafeInteger(minimumSequence) || minimumSequence < 0 ||
      !Number.isSafeInteger(minimumCheckpointHeight) || minimumCheckpointHeight < 1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < minimumSequence ||
      !Array.isArray(value.attestations) || value.attestations.length > MAX_WITNESSES) {
    throw new Error("checkpoint trust package envelope or anti-replay floor is invalid");
  }
  const policy = validateCheckpointWitnessPolicy(value.policy);
  if (policy.policyId !== expectedPolicyId || policy.networkId !== expectedNetworkId ||
      policy.chainIdentityGenesisHash !== expectedChainIdentityGenesisHash) {
    throw new Error("checkpoint trust package does not match the pinned trust policy");
  }
  const validators = normalizeValidators(value.validators);
  if (canonicalJson(value.validators) !== canonicalJson(validators)) {
    throw new Error("checkpoint trust package validator set is not canonically ordered");
  }
  const { checkpoint, view, viewHash } = checkpointView(value.finalityProof, validators, policy);
  exact(value.view, ["chainIdentityGenesisHash", "checkpointHeight", "checkpointStateRoot",
    "checkpointTipHash", "finalityProofHash", "networkId", "validatorSetId"], "checkpoint view");
  if (canonicalJson(value.view) !== canonicalJson(view) || value.viewHash !== viewHash ||
      checkpoint.height < minimumCheckpointHeight || value.sequence < minimumSequence ||
      validatorSetId(validators) !== view.validatorSetId) {
    throw new Error("checkpoint trust package view is invalid or replayed");
  }
  const attestations = value.attestations.map((attestation) =>
    validateCheckpointWitnessAttestation(attestation,
      { expectedView: view, expectedViewHash: viewHash, policy }));
  if (attestations.length < policy.threshold ||
      new Set(attestations.map(({ operatorId }) => operatorId)).size !== attestations.length ||
      attestations.some((attestation) => attestation.sequence !== value.sequence) ||
      attestations.some((attestation, index) => index > 0 &&
        attestations[index - 1].operatorId >= attestation.operatorId)) {
    throw new Error("checkpoint trust package witness quorum is invalid");
  }
  if (now !== null) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
        !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 ||
        attestations.some(({ observedAt }) => observedAt < now - maxAgeMs) ||
        attestations.some(({ observedAt }) => observedAt > now + maxFutureSkewMs)) {
      throw new Error("checkpoint trust package witness time policy failed");
    }
  }
  const { packageHash, ...payload } = value;
  if (packageHash !== `sha3-256:${hashObject(payload, "CHECKPOINT_TRUST_PACKAGE_V1")}`) {
    throw new Error("checkpoint trust package hash is invalid");
  }
  return { checkpoint, packageHash, policyGeneration: policy.generation,
    policyId: policy.policyId, sequence: value.sequence,
    trustedValidators: validators, viewHash, witnessOperators: attestations.map(({ operatorId }) => operatorId) };
}

export function serializeCheckpointTrustPackage(value) {
  return `${canonicalJson(value)}\n`;
}

export function parseAndVerifyCheckpointTrustPackage(input, options) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? "", "utf8");
  if (bytes.length < 2 || bytes.length > MAX_CHECKPOINT_TRUST_PACKAGE_BYTES) {
    throw new Error("checkpoint trust package bytes are outside the bounded limit");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("checkpoint trust package is not canonical UTF-8 JSON"); }
  if (!text.endsWith("\n")) {
    throw new Error("checkpoint trust package is not canonical UTF-8 JSON");
  }
  let value;
  try { value = parseConsensusJson(text.slice(0, -1)); }
  catch { throw new Error("checkpoint trust package is not valid JSON"); }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error("checkpoint trust package JSON is not canonical");
  }
  return verifyCheckpointTrustPackage(value, options);
}
