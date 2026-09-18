import { hashObject, signObject, verifyObject } from "./crypto.mjs";

export const CERTIFICATE_RECORD_FORMAT = "nir-network-certificate-v1";
export const EMPTY_CERTIFICATE_RECORD_HASH = "0".repeat(64);
export const MAX_CERTIFICATE_RECORDS = 1_024;
export const MAX_CERTIFICATE_OVERLAP_BLOCKS = 10_000;

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const SERIAL = /^(?:[1-9a-f][0-9a-f]{0,63})$/;
const PAYLOAD_KEYS = [
  "activationHeight", "certificate", "format", "networkId", "operation",
  "overlapUntilHeight", "peerRegistryHash", "previousRecordHash", "sequence",
  "topologyHistoryHash", "validatorAddress",
];

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${name} shape is invalid`);
  }
}

function boundedText(value, name, minimum = 1, maximum = 128) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function certificate(value) {
  exactKeys(value, ["serial", "sha256"], "certificate identity");
  if (!value || !SERIAL.test(value.serial ?? "") || !HASH.test(value.sha256 ?? "")) {
    throw new Error("certificate identity is invalid");
  }
  return { serial: value.serial, sha256: value.sha256 };
}

function payload(record) {
  const keys = Object.keys(record ?? {}).sort().join("\0");
  const unsignedKeys = [...PAYLOAD_KEYS].sort().join("\0");
  const signedKeys = [...PAYLOAD_KEYS, "approvals", "recordHash"].sort().join("\0");
  if (keys !== unsignedKeys && keys !== signedKeys) {
    throw new Error("certificate record shape is invalid");
  }
  const operation = record?.operation;
  if (!['issue', 'renew', 'revoke'].includes(operation) ||
      record?.format !== CERTIFICATE_RECORD_FORMAT ||
      !ADDRESS.test(record.validatorAddress ?? "") ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 0 ||
      !Number.isSafeInteger(record.activationHeight) || record.activationHeight < 0 ||
      !Number.isSafeInteger(record.overlapUntilHeight) || record.overlapUntilHeight < 0 ||
      !HASH.test(record.previousRecordHash ?? "") ||
      !HASH.test(record.peerRegistryHash ?? "") ||
      !HASH.test(record.topologyHistoryHash ?? "")) {
    throw new Error("certificate record header is invalid");
  }
  const networkId = boundedText(record.networkId, "certificate network ID", 3, 128);
  let normalizedCertificate = null;
  if (operation === "revoke") {
    if (record.certificate !== null || record.overlapUntilHeight !== record.activationHeight) {
      throw new Error("certificate revocation fields are invalid");
    }
  } else {
    normalizedCertificate = certificate(record.certificate);
    if (operation === "issue" && record.overlapUntilHeight !== record.activationHeight) {
      throw new Error("initial certificate cannot declare an overlap window");
    }
    if (operation === "renew" &&
        (record.overlapUntilHeight < record.activationHeight ||
         record.overlapUntilHeight - record.activationHeight > MAX_CERTIFICATE_OVERLAP_BLOCKS)) {
      throw new Error("certificate overlap window is invalid");
    }
  }
  return {
    activationHeight: record.activationHeight,
    certificate: normalizedCertificate,
    format: CERTIFICATE_RECORD_FORMAT,
    networkId,
    operation,
    overlapUntilHeight: record.overlapUntilHeight,
    peerRegistryHash: record.peerRegistryHash,
    previousRecordHash: record.previousRecordHash,
    sequence: record.sequence,
    topologyHistoryHash: record.topologyHistoryHash,
    validatorAddress: record.validatorAddress,
  };
}

export function certificateRecordHash(record) {
  return hashObject(payload(record), "NETWORK_CERTIFICATE_RECORD");
}

export function topologyHistoryCommitment({ handoffs = [], onboardings = [] } = {}) {
  if (!Array.isArray(handoffs) || !Array.isArray(onboardings) ||
      handoffs.length !== onboardings.length || handoffs.length > 128 ||
      handoffs.some((entry) => !HASH.test(entry?.handoffHash ?? "")) ||
      onboardings.some((entry) => !HASH.test(entry?.onboardingHash ?? ""))) {
    throw new Error("validator topology history cannot be committed");
  }
  return hashObject({
    handoffHashes: handoffs.map(({ handoffHash }) => handoffHash),
    onboardingHashes: onboardings.map(({ onboardingHash }) => onboardingHash),
  }, "VALIDATOR_TOPOLOGY_HISTORY");
}

export function createCertificateRecord(fields, validatorWallets = []) {
  const unsigned = payload({ ...fields, format: CERTIFICATE_RECORD_FORMAT });
  if (!Array.isArray(validatorWallets) || validatorWallets.length > 512) {
    throw new Error("certificate approval wallets are invalid");
  }
  const approvals = validatorWallets.map((wallet) => ({
    signature: signObject(unsigned, wallet, "NETWORK_CERTIFICATE_APPROVAL"),
    validator: wallet.address,
  })).sort((left, right) => left.validator.localeCompare(right.validator));
  return { ...unsigned, approvals, recordHash: certificateRecordHash(unsigned) };
}

function verifyApprovals(record, unsigned, validators) {
  if (!Array.isArray(validators) || validators.length < 4 || validators.length > 512) {
    throw new Error("certificate validator set is invalid");
  }
  const validatorMap = new Map(validators.map((validator) => [validator?.address, validator]));
  if (validatorMap.size !== validators.length ||
      !Array.isArray(record.approvals) || record.approvals.length > validators.length) {
    throw new Error("certificate approvals are invalid");
  }
  const voters = new Set();
  for (const approval of record.approvals) {
    exactKeys(approval, ["signature", "validator"], "certificate approval");
    const validator = validatorMap.get(approval?.validator);
    if (!validator || voters.has(approval.validator) ||
        typeof approval.signature !== "string" || approval.signature.length > 7_000 ||
        !verifyObject(unsigned, approval.signature, validator.publicKey,
          "NETWORK_CERTIFICATE_APPROVAL")) {
      throw new Error("certificate approval is forged or duplicated");
    }
    voters.add(approval.validator);
  }
  if (voters.size < Math.floor((validators.length * 2) / 3) + 1) {
    throw new Error("certificate approval quorum not reached");
  }
  return structuredClone(record.approvals)
    .sort((left, right) => left.validator.localeCompare(right.validator));
}

function historiesByValidator(history) {
  const result = new Map();
  for (const record of history) {
    const entries = result.get(record.validatorAddress) ?? [];
    entries.push(record);
    result.set(record.validatorAddress, entries);
  }
  return result;
}

export function verifyCertificateHistory(history, {
  networkId,
  validators,
  validatorSetsByTopologyHash = null,
  expectedPeerRegistryHash = null,
  expectedTopologyHistoryHash = null,
} = {}) {
  if (!Array.isArray(history) || history.length > MAX_CERTIFICATE_RECORDS) {
    throw new Error("certificate history length is invalid");
  }
  const usedSerials = new Set();
  const usedFingerprints = new Set();
  const previousByValidator = new Map();
  const normalized = [];
  if (validatorSetsByTopologyHash !== null &&
      (typeof validatorSetsByTopologyHash !== "object" ||
       Array.isArray(validatorSetsByTopologyHash) ||
       Object.keys(validatorSetsByTopologyHash).length > 128)) {
    throw new Error("certificate topology validator sets are invalid");
  }
  for (const record of history) {
    const unsigned = payload(record);
    if (unsigned.networkId !== networkId ||
        (expectedPeerRegistryHash !== null &&
         unsigned.peerRegistryHash !== expectedPeerRegistryHash) ||
        (expectedTopologyHistoryHash !== null &&
         unsigned.topologyHistoryHash !== expectedTopologyHistoryHash)) {
      throw new Error("certificate record is bound to a different network topology");
    }
    const previous = previousByValidator.get(unsigned.validatorAddress) ?? null;
    if ((previous === null &&
         (unsigned.sequence !== 0 || unsigned.previousRecordHash !== EMPTY_CERTIFICATE_RECORD_HASH ||
          unsigned.operation !== "issue")) ||
        (previous !== null &&
         (unsigned.sequence !== previous.sequence + 1 ||
          unsigned.previousRecordHash !== previous.recordHash ||
          unsigned.activationHeight <= previous.activationHeight ||
          (previous.operation === "revoke" && unsigned.operation !== "issue")))) {
      throw new Error("certificate record lineage or sequence is invalid");
    }
    if (previous !== null && previous.operation !== "revoke" && unsigned.operation === "issue") {
      throw new Error("active certificate must be renewed, not issued again");
    }
    if (previous !== null && previous.operation === "revoke" &&
        unsigned.activationHeight <= previous.activationHeight) {
      throw new Error("certificate reissue rolls back activation height");
    }
    if (unsigned.operation === "renew" &&
        (previous === null || previous.operation === "revoke")) {
      throw new Error("certificate renewal has no active predecessor");
    }
    if (unsigned.operation === "revoke" &&
        (previous === null || previous.operation === "revoke")) {
      throw new Error("certificate revocation has no active predecessor");
    }
    if (unsigned.certificate) {
      if (usedSerials.has(unsigned.certificate.serial) ||
          usedFingerprints.has(unsigned.certificate.sha256)) {
        throw new Error("certificate serial or fingerprint was already used");
      }
      usedSerials.add(unsigned.certificate.serial);
      usedFingerprints.add(unsigned.certificate.sha256);
    }
    const recordHash = certificateRecordHash(unsigned);
    if (record.recordHash !== recordHash) throw new Error("certificate record hash is invalid");
    const recordValidators = validatorSetsByTopologyHash?.[unsigned.topologyHistoryHash] ?? validators;
    if (!recordValidators?.some(({ address }) => address === unsigned.validatorAddress)) {
      throw new Error("certificate owner is not in its bound validator topology");
    }
    const approvals = verifyApprovals(record, unsigned, recordValidators);
    const verified = { ...unsigned, approvals, recordHash };
    normalized.push(verified);
    previousByValidator.set(unsigned.validatorAddress, verified);
  }
  return structuredClone(normalized);
}

export function verifyCertificateRecord(record, {
  currentHeight,
  history = [],
  minimumActivationDelay = 2,
  networkId,
  peerRegistryHash,
  topologyHistoryHash,
  validators,
  validatorSetsByTopologyHash = null,
} = {}) {
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0 ||
      !Number.isSafeInteger(minimumActivationDelay) || minimumActivationDelay < 0 ||
      record?.activationHeight < currentHeight + minimumActivationDelay) {
    throw new Error("certificate activation is stale or lacks the required delay");
  }
  const unsigned = payload(record);
  if (unsigned.peerRegistryHash !== peerRegistryHash ||
      unsigned.topologyHistoryHash !== topologyHistoryHash) {
    throw new Error("certificate record is bound to a different network topology");
  }
  verifyCertificateHistory(history, { networkId, validators, validatorSetsByTopologyHash });
  return verifyCertificateHistory([...history, record], {
    networkId,
    validators,
    validatorSetsByTopologyHash,
  }).at(-1);
}

export function certificatePinsAtHeight(history, validatorAddress, height) {
  if (!ADDRESS.test(validatorAddress ?? "") || !Number.isSafeInteger(height) || height < 0) {
    throw new Error("certificate pin lookup is invalid");
  }
  const records = historiesByValidator(history).get(validatorAddress) ?? [];
  let active = null;
  let predecessor = null;
  for (const record of records) {
    if (record.activationHeight > height) break;
    predecessor = active;
    active = record;
  }
  if (!active || active.operation === "revoke") return [];
  const pins = [active.certificate.sha256];
  if (active.operation === "renew" && predecessor?.certificate &&
      height <= active.overlapUntilHeight) pins.push(predecessor.certificate.sha256);
  return pins;
}
