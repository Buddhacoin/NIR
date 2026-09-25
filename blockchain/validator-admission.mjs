import { addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { MIN_TRANSFER_FEE, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";

export const VALIDATOR_ADMISSION_DELAY_BLOCKS = 64;
export const VALIDATOR_ADMISSION_EXPIRY_BLOCKS = 256;
export const MAX_PENDING_VALIDATOR_ADMISSIONS = 256;
export const MAX_VALIDATOR_ADMISSIONS_PER_BLOCK = 16;
export const MAX_RETIRED_VALIDATOR_TOMBSTONES = 512;

export function assertValidatorIdentityCapacity(registeredSize, retiredSize) {
  if (!Number.isSafeInteger(registeredSize) || registeredSize < 0 ||
      !Number.isSafeInteger(retiredSize) || retiredSize < 0 ||
      retiredSize > MAX_RETIRED_VALIDATOR_TOMBSTONES ||
      registeredSize + retiredSize > MAX_RETIRED_VALIDATOR_TOMBSTONES) {
    throw new Error("validator identity tombstone capacity is exceeded");
  }
}

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function assertCanonicalEnvelope(transaction, payload, fields) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
      Object.keys(transaction).sort().join("\0") !== [...fields, "signature", "transportSignature"].sort().join("\0") ||
      canonicalJson(Object.fromEntries(fields.map((field) => [field, transaction[field]]))) !==
        canonicalJson(payload) || !CANONICAL_BASE64.test(transaction.signature ?? "") ||
      !CANONICAL_BASE64.test(transaction.transportSignature ?? "")) {
    throw new Error("validator admission envelope is non-canonical");
  }
}

function normalizeEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error("validator admission endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("validator admission endpoint must be an HTTPS origin");
  }
  return endpoint.origin;
}

function transportIdentity(publicKey) {
  const address = addressFromPublicKey(publicKey);
  return { address, algorithm: SIGNATURE_ALGORITHM, publicKey };
}

function admissionPayload({ amount, endpoint, fee, networkId, nonce, operatorId, publicKey,
  sender, tlsCertificateSha256, transportPublicKey, type }) {
  return {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    endpoint: normalizeEndpoint(endpoint),
    fee: String(fee),
    networkId,
    nonce,
    operatorId,
    publicKey,
    sender,
    tlsCertificateSha256,
    transportAlgorithm: SIGNATURE_ALGORITHM,
    transportPublicKey,
    type,
  };
}

export function validatorAdmissionObservationPayload({ admissionId, chainIdentityGenesisHash,
  endpoint, expiresAtHeight, networkId, nonce, observedHeight, tlsCertificateSha256,
  transportAddress, validatorSetId }) {
  return { admissionId, chainIdentityGenesisHash, endpoint: normalizeEndpoint(endpoint),
    expiresAtHeight, networkId, nonce, observedHeight, tlsCertificateSha256,
    transportAddress, validatorSetId };
}

function readinessPayload({ admissionId, endpoint, expiresAtHeight, fee, networkId, nonce,
  observedHeight, publicKey, readinessAttestations, sender, tlsCertificateSha256,
  transportPublicKey, type, validatorSetId }) {
  return {
    admissionId,
    algorithm: SIGNATURE_ALGORITHM,
    endpoint: normalizeEndpoint(endpoint),
    fee: String(fee),
    networkId,
    nonce,
    observedHeight,
    publicKey,
    sender,
    tlsCertificateSha256,
    transportAlgorithm: SIGNATURE_ALGORITHM,
    transportPublicKey,
    type,
    validatorSetId,
    expiresAtHeight,
    readinessAttestations,
  };
}

function validateCommon(payload, transportSignature, signature, domain) {
  const transport = transportIdentity(payload.transportPublicKey);
  if (payload.algorithm !== SIGNATURE_ALGORITHM ||
      payload.transportAlgorithm !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(payload.publicKey) !== payload.sender ||
      transport.address === payload.sender || !HASH.test(payload.tlsCertificateSha256 ?? "") ||
      !Number.isSafeInteger(payload.nonce) || payload.nonce < 0 ||
      !/^(0|[1-9][0-9]*)$/.test(payload.fee) || BigInt(payload.fee) < MIN_TRANSFER_FEE ||
      !verifyObject(payload, transportSignature, transport.publicKey,
        "VALIDATOR_ADMISSION_TRANSPORT_V1") ||
      !verifyObject({ ...payload, transportSignature }, signature, payload.publicKey, domain)) {
    throw new Error("validator admission signature or transport proof is invalid");
  }
  return transport;
}

export function createValidatorAdmission({ wallet, transportWallet, networkId, nonce, operatorId,
  endpoint, tlsCertificateSha256, amount = MIN_VALIDATOR_BOND.toString(),
  fee = MIN_TRANSFER_FEE.toString() }) {
  const payload = admissionPayload({ amount, endpoint, fee, networkId, nonce, operatorId,
    publicKey: wallet.publicKey, sender: wallet.address, tlsCertificateSha256,
    transportPublicKey: transportWallet.publicKey, type: "validator-admission" });
  const transportSignature = signObject(payload, transportWallet,
    "VALIDATOR_ADMISSION_TRANSPORT_V1");
  return { ...payload, transportSignature,
    signature: signObject({ ...payload, transportSignature }, wallet,
      "VALIDATOR_ADMISSION_V1") };
}

export function verifyValidatorAdmission(transaction, networkId) {
  const { signature, transportSignature, ...unsigned } = transaction ?? {};
  const payload = admissionPayload(unsigned ?? {});
  assertCanonicalEnvelope(transaction, payload, Object.keys(payload));
  if (payload.type !== "validator-admission" || payload.networkId !== networkId ||
      payload.amount !== MIN_VALIDATOR_BOND.toString() || !OPERATOR.test(payload.operatorId ?? "")) {
    throw new Error("validator admission context is invalid");
  }
  const transport = validateCommon(payload, transportSignature, signature,
    "VALIDATOR_ADMISSION_V1");
  return { payload, transport };
}

export function createValidatorAdmissionReadiness({ wallet, transportWallet, admissionId,
  networkId, nonce, endpoint, tlsCertificateSha256, validatorSetId, observedHeight,
  expiresAtHeight, readinessAttestations, fee = MIN_TRANSFER_FEE.toString() }) {
  const payload = readinessPayload({ admissionId, endpoint, fee, networkId, nonce,
    observedHeight, expiresAtHeight, readinessAttestations, validatorSetId,
    publicKey: wallet.publicKey, sender: wallet.address, tlsCertificateSha256,
    transportPublicKey: transportWallet.publicKey, type: "validator-admission-readiness" });
  const transportSignature = signObject(payload, transportWallet,
    "VALIDATOR_ADMISSION_TRANSPORT_V1");
  return { ...payload, transportSignature,
    signature: signObject({ ...payload, transportSignature }, wallet,
      "VALIDATOR_ADMISSION_READINESS_V1") };
}

export function verifyValidatorAdmissionReadiness(transaction, networkId) {
  const { signature, transportSignature, ...unsigned } = transaction ?? {};
  const payload = readinessPayload(unsigned ?? {});
  assertCanonicalEnvelope(transaction, payload, Object.keys(payload));
  if (payload.type !== "validator-admission-readiness" || payload.networkId !== networkId ||
      !HASH.test(payload.admissionId ?? "")) {
    throw new Error("validator admission readiness context is invalid");
  }
  const transport = validateCommon(payload, transportSignature, signature,
    "VALIDATOR_ADMISSION_READINESS_V1");
  return { payload, transport };
}

export function validatorAdmissionRank({ address, admissionId, networkId, operatorId,
  publicKey, submittedHeight }) {
  if (!ADDRESS.test(address ?? "") || !HASH.test(admissionId ?? "") ||
      !OPERATOR.test(operatorId ?? "") || addressFromPublicKey(publicKey) !== address ||
      typeof networkId !== "string" || networkId.length < 1 || networkId.length > 128 ||
      !Number.isSafeInteger(submittedHeight) || submittedHeight < 1) {
    throw new Error("validator admission rank context is invalid");
  }
  return hashObject({ address, admissionId, networkId, operatorId, publicKey, submittedHeight },
    "VALIDATOR_ADMISSION_RANK_V1");
}

export function createValidatorAdmissionRecord({ member, admissionId, networkId, submittedHeight,
  endpoint = null, tlsCertificateSha256 = null, transport = null, legacy = false,
  readiness = false, observedHeight = null, readinessExpiresHeight = null,
  readinessValidatorSetId = null, readinessCertificateHash = null }) {
  const rank = validatorAdmissionRank({ ...member, admissionId, networkId, submittedHeight });
  return {
    address: member.address,
    admissionId,
    algorithm: member.algorithm,
    eligibleHeight: submittedHeight + VALIDATOR_ADMISSION_DELAY_BLOCKS,
    endpoint,
    expiryHeight: submittedHeight + VALIDATOR_ADMISSION_DELAY_BLOCKS +
      VALIDATOR_ADMISSION_EXPIRY_BLOCKS,
    legacy,
    operatorId: member.operatorId,
    publicKey: member.publicKey,
    rank,
    readiness,
    readinessCertificateHash,
    readinessExpiresHeight,
    readinessValidatorSetId,
    observedHeight,
    submittedHeight,
    tlsCertificateSha256,
    transport,
  };
}

export function compareValidatorAdmissions(left, right) {
  return left.submittedHeight - right.submittedHeight ||
    (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 :
      left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
}
