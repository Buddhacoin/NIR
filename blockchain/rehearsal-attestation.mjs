import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import {
  addressFromPublicKey, canonicalJson, hashObject, publicWallet, signObject, verifyObject,
} from "./crypto.mjs";
import { validateRealBeaconArchiveReport } from "./testnet-drill-real-services.mjs";

const SET_FORMAT = "nir-rehearsal-attestor-set-v1";
const ATTESTATION_FORMAT = "nir-rehearsal-attestation-v1";
const PACKAGE_FORMAT = "nir-rehearsal-attestation-package-v1";
const INPUT_FORMAT = "nir-production-preflight-rehearsal-input-v1";
const STORE_RECORD_FORMAT = "nir-rehearsal-attestation-store-record-v1";
const STORE_HEAD_FORMAT = "nir-rehearsal-attestation-store-head-v1";
const STORE_TRANSCRIPT_FORMAT = "nir-rehearsal-attestation-store-transcript-v1";
const HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RECORD = /^([0-9]{12})-([0-9a-f]{64})\.json$/;
const PRIMARY = "HEAD.json";
const BACKUP = "HEAD.backup.json";
const LOCK = ".writer.lock";
const MAX_OPERATORS = 64;
const MAX_RECORDS = 4096;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}
function digest(value) {
  return createHash("sha3-256").update(canonicalJson(value)).digest("hex");
}
function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function setPayload(value) {
  exact(value, ["format", "operators", "threshold", "version"], "rehearsal attestor set");
  if (value.format !== SET_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.threshold) || value.threshold < 2 ||
      !Array.isArray(value.operators) || value.operators.length < value.threshold ||
      value.operators.length > MAX_OPERATORS) throw new Error("rehearsal attestor policy is invalid");
  const addresses = new Set(); const keys = new Set(); const ids = new Set();
  const operators = value.operators.map((operator, index) => {
    exact(operator, ["address", "algorithm", "operatorId", "publicKey"], "rehearsal attestor");
    if (operator.algorithm !== SIGNATURE_ALGORITHM || !OPERATOR.test(operator.operatorId ?? "") ||
        addressFromPublicKey(operator.publicKey ?? "") !== operator.address ||
        addresses.has(operator.address) || keys.has(operator.publicKey) || ids.has(operator.operatorId) ||
        index > 0 && value.operators[index - 1].operatorId >= operator.operatorId) {
      throw new Error("rehearsal attestors are invalid, duplicated, or unordered");
    }
    addresses.add(operator.address); keys.add(operator.publicKey); ids.add(operator.operatorId);
    return structuredClone(operator);
  });
  return { format: SET_FORMAT, operators, threshold: value.threshold, version: 1 };
}

export function createRehearsalAttestorSet({ operators, threshold }) {
  const payload = setPayload({ format: SET_FORMAT,
    operators: [...operators].sort((a, b) => a.operatorId.localeCompare(b.operatorId)),
    threshold, version: 1 });
  return { ...payload, setId: `sha3-256:${hashObject(payload, "REHEARSAL_ATTESTOR_SET_V1")}` };
}

export function validateRehearsalAttestorSet(value) {
  exact(value, ["format", "operators", "setId", "threshold", "version"],
    "rehearsal attestor set envelope");
  const { setId, ...unsigned } = value; const payload = setPayload(unsigned);
  if (setId !== `sha3-256:${hashObject(payload, "REHEARSAL_ATTESTOR_SET_V1")}`) {
    throw new Error("rehearsal attestor set id is invalid");
  }
  return { ...payload, setId };
}

function statementPayload(value) {
  exact(value, ["drillPlanHash", "expiresAt", "format", "genesisHash", "networkId", "observedAt",
    "releaseCheckpointHash", "releaseManifestHash", "reportHash", "runNonce", "setId",
    "validatorTip", "version"], "rehearsal attestation statement");
  if (value.format !== ATTESTATION_FORMAT || value.version !== 1 ||
      typeof value.networkId !== "string" || value.networkId.length < 3 || value.networkId.length > 128 ||
      !HASH.test(value.drillPlanHash ?? "") || !HASH.test(value.genesisHash ?? "") ||
      !HASH.test(value.releaseCheckpointHash ?? "") ||
      !HASH.test(value.releaseManifestHash ?? "") || !HASH.test(value.reportHash ?? "") ||
      !HASH.test(value.setId ?? "") || !HASH.test(value.validatorTip ?? "") ||
      !NONCE.test(value.runNonce ?? "") || !Number.isSafeInteger(value.observedAt) ||
      !Number.isSafeInteger(value.expiresAt) || value.observedAt < 0 ||
      value.expiresAt <= value.observedAt || value.expiresAt - value.observedAt > 86_400_000) {
    throw new Error("rehearsal attestation statement is invalid");
  }
  return structuredClone(value);
}

export function createRehearsalStatement(report, {
  drillPlanHash, expiresAt, observedAt, runNonce, setId,
}) {
  if (!Number.isSafeInteger(report?.completedAt) || report.completedAt < 0 || observedAt < report.completedAt) {
    throw new Error("operator observation cannot precede the rehearsal report");
  }
  const validation = validateRealBeaconArchiveReport(report, { now: report.completedAt });
  const statement = statementPayload({ drillPlanHash, expiresAt, format: ATTESTATION_FORMAT,
    genesisHash: hashObject(report.validator.report.genesis, "GENESIS"),
    networkId: validation.networkId, observedAt,
    releaseCheckpointHash: validation.releaseCheckpointHash,
    releaseManifestHash: report.releaseEvidence.signedRelease.manifest.manifestHash,
    reportHash: `sha3-256:${digest(report)}`, runNonce, setId,
    validatorTip: validation.validatorTip, version: 1 });
  return statement;
}

function attestationPayload(statement, operator) {
  return { address: operator.address, operatorId: operator.operatorId, statement };
}

export function signRehearsalStatement(statementValue, { operatorId, wallet }, setValue) {
  const statement = statementPayload(statementValue); const set = validateRehearsalAttestorSet(setValue);
  const operator = set.operators.find((candidate) => candidate.operatorId === operatorId);
  if (!operator || operator.address !== wallet?.address || operator.publicKey !== wallet?.publicKey ||
      statement.setId !== set.setId) throw new Error("rehearsal signer is not an authorized attestor");
  const payload = attestationPayload(statement, operator);
  const signed = { ...payload,
    signature: signObject(payload, wallet, "REHEARSAL_REPORT_ATTESTATION_V1") };
  return { ...signed, attestationHash: `sha3-256:${digest(signed)}` };
}

export function verifyRehearsalAttestation(value, { maxFutureSkewMs = 0, now, operatorSet }) {
  exact(value, ["address", "attestationHash", "operatorId", "signature", "statement"],
    "rehearsal attestation");
  const set = validateRehearsalAttestorSet(operatorSet); const statement = statementPayload(value.statement);
  const operator = set.operators.find((candidate) => candidate.operatorId === value.operatorId);
  const { attestationHash, signature, ...payload } = value;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxFutureSkewMs) ||
      maxFutureSkewMs < 0 || maxFutureSkewMs > 300_000 || statement.setId !== set.setId ||
      !operator || operator.address !== value.address || statement.observedAt > now + maxFutureSkewMs ||
      statement.expiresAt < now || attestationHash !== `sha3-256:${digest({ ...payload, signature })}` ||
      !verifyObject(payload, signature, operator.publicKey, "REHEARSAL_REPORT_ATTESTATION_V1")) {
    throw new Error("rehearsal attestation is unauthorized, stale, future, or invalid");
  }
  return structuredClone(value);
}

function commonStatement(attestation) { return attestation.statement; }

export function assembleRehearsalAttestationPackage(values, options) {
  const set = validateRehearsalAttestorSet(options.operatorSet);
  if (!Array.isArray(values) || values.length > MAX_OPERATORS) {
    throw new Error("rehearsal attestation collection is invalid");
  }
  const attestations = values.map((value) => verifyRehearsalAttestation(value, options));
  const byOperator = new Map(); let statement = null;
  for (const attestation of attestations) {
    const prior = byOperator.get(attestation.operatorId);
    if (prior) {
      if (canonicalJson(prior.statement) !== canonicalJson(attestation.statement)) {
        throw new Error("rehearsal attestor equivocation detected");
      }
      throw new Error("duplicate rehearsal attestor");
    }
    if (statement === null) statement = commonStatement(attestation);
    else if (canonicalJson(statement) !== canonicalJson(commonStatement(attestation))) {
      throw new Error("rehearsal attestations mix runs, releases, genesis, or tips");
    }
    byOperator.set(attestation.operatorId, attestation);
  }
  if (byOperator.size < set.threshold) throw new Error("rehearsal attestation quorum is insufficient");
  const payload = { attestations: [...byOperator.values()].sort((a, b) =>
    a.operatorId.localeCompare(b.operatorId)), format: PACKAGE_FORMAT, operatorSet: set,
  statement, version: 1 };
  return { ...payload, packageHash: `sha3-256:${digest(payload)}` };
}

export function verifyRehearsalAttestationPackage(value, options = {}) {
  exact(value, ["attestations", "format", "operatorSet", "packageHash", "statement", "version"],
    "rehearsal attestation package");
  if (value.format !== PACKAGE_FORMAT || value.version !== 1) {
    throw new Error("rehearsal attestation package header is invalid");
  }
  if (options.operatorSet !== undefined && canonicalJson(validateRehearsalAttestorSet(options.operatorSet)) !==
      canonicalJson(validateRehearsalAttestorSet(value.operatorSet))) {
    throw new Error("rehearsal attestation package uses an untrusted operator set");
  }
  const rebuilt = assembleRehearsalAttestationPackage(value.attestations, {
    ...options, operatorSet: value.operatorSet,
  });
  if (canonicalJson(rebuilt.statement) !== canonicalJson(value.statement) ||
      rebuilt.packageHash !== value.packageHash || canonicalJson(rebuilt) !== canonicalJson(value)) {
    throw new Error("rehearsal attestation package is invalid or non-canonical");
  }
  return rebuilt;
}

export function createProductionPreflightRehearsalInput(packageValue, options = {}) {
  const packageEnvelope = verifyRehearsalAttestationPackage(packageValue, options);
  const payload = { authority: "external-operator-attestations", format: INPUT_FORMAT,
    package: packageEnvelope, physicalIndependenceClaimed: false, version: 1 };
  return { ...payload, inputHash: `sha3-256:${digest(payload)}` };
}

export function verifyProductionPreflightRehearsalInput(value, options = {}) {
  exact(value, ["authority", "format", "inputHash", "package", "physicalIndependenceClaimed",
    "version"], "production preflight rehearsal input");
  const { inputHash, ...payload } = value;
  if (value.format !== INPUT_FORMAT || value.version !== 1 ||
      value.authority !== "external-operator-attestations" || value.physicalIndependenceClaimed !== false ||
      inputHash !== `sha3-256:${digest(payload)}`) throw new Error("production preflight input is invalid");
  verifyRehearsalAttestationPackage(value.package, options);
  return structuredClone(value);
}

function requireSecureFs() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new Error("secure rehearsal attestation store filesystem support is unavailable");
  }
}
function openStore(pathValue, create = false) {
  requireSecureFs(); const path = resolve(pathValue);
  if (create) try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const linked = lstatSync(path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || (linked.mode & 0o077) !== 0) {
    throw new Error("rehearsal attestation store root is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !same(linked, opened)) { closeSync(descriptor); throw new Error("store root changed"); }
  return { descriptor, metadata: opened, path };
}
function assertStore(store) {
  const opened = fstatSync(store.descriptor); const linked = lstatSync(store.path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || !same(opened, store.metadata) ||
      !same(linked, store.metadata) || opened.mode !== store.metadata.mode || opened.uid !== store.metadata.uid) {
    throw new Error("rehearsal attestation store root changed");
  }
}
function readCanonical(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_FILE_BYTES ||
        (before.mode & 0o077) !== 0) throw new Error("attestation store file is unsafe");
    const contents = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (contents.length !== before.size || !same(before, after) || !same(before, linked) ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("attestation store file changed during read");
    }
    const text = contents.toString("utf8"); const canonical = text.endsWith("\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("attestation store JSON is not canonical");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function recordPayload(value) {
  exact(value, ["acceptedAt", "format", "observedAt", "operatorIds", "packageHash", "previousRecordHash",
    "runNonce", "sequence", "version"], "attestation store record");
  if (value.format !== STORE_RECORD_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt < 0 ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || value.observedAt > value.acceptedAt ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !HASH.test(value.packageHash ?? "") ||
      !(value.previousRecordHash === null || NONCE.test(value.previousRecordHash ?? "")) ||
      !NONCE.test(value.runNonce ?? "") || !Array.isArray(value.operatorIds) ||
      value.operatorIds.length < 2 || value.operatorIds.length > MAX_OPERATORS ||
      value.operatorIds.some((id, index) => !OPERATOR.test(id) || index > 0 && value.operatorIds[index - 1] >= id)) {
    throw new Error("attestation store record is invalid");
  }
  return structuredClone(value);
}
function headValue(count, headHash) {
  const payload = { count, format: STORE_HEAD_FORMAT, headHash, version: 1 };
  return { ...payload, checksum: digest(payload) };
}
function validateHead(value) {
  exact(value, ["checksum", "count", "format", "headHash", "version"], "attestation store head");
  const { checksum, ...payload } = value;
  if (value.format !== STORE_HEAD_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.count) || value.count < 1 || !NONCE.test(value.headHash ?? "") ||
      checksum !== digest(payload)) throw new Error("attestation store head is invalid");
  return structuredClone(value);
}
function loadStore(store, hook) {
  hook?.(store.path); const names = readdirSync(store.path).sort();
  const recordNames = names.filter((name) => RECORD.test(name));
  const allowed = new Set([...recordNames, PRIMARY, BACKUP, LOCK]);
  if (names.some((name) => !allowed.has(name)) || recordNames.length > MAX_RECORDS) {
    throw new Error("attestation store contains unknown or excessive entries");
  }
  let prior = null; const records = [];
  for (const [index, name] of recordNames.entries()) {
    const match = RECORD.exec(name); const envelope = readCanonical(join(store.path, name));
    exact(envelope, ["record", "recordHash"], "attestation store record envelope");
    const record = recordPayload(envelope.record); const expected = digest(record);
    if (record.sequence !== index + 1 || Number(match[1]) !== record.sequence || match[2] !== expected ||
        envelope.recordHash !== expected || record.previousRecordHash !== prior) {
      throw new Error("attestation store chain is rolled back, forked, or corrupt");
    }
    prior = expected; records.push({ ...record, recordHash: expected });
  }
  if (records.length === 0) {
    if (names.includes(PRIMARY) || names.includes(BACKUP)) throw new Error("empty store has a stale head");
  } else {
    if (!names.includes(PRIMARY) || !names.includes(BACKUP)) throw new Error("attestation store head copy is missing");
    const primary = validateHead(readCanonical(join(store.path, PRIMARY)));
    const backup = validateHead(readCanonical(join(store.path, BACKUP)));
    const expected = headValue(records.length, prior);
    if (canonicalJson(primary) !== canonicalJson(backup) || canonicalJson(primary) !== canonicalJson(expected)) {
      throw new Error("attestation store head is rolled back or divergent");
    }
  }
  assertStore(store); return records;
}
function writeExclusive(store, name, value) {
  let descriptor;
  try {
    assertStore(store); descriptor = openSync(join(store.path, name), constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`); fchmodSync(descriptor, 0o600); fsyncSync(descriptor);
    fsyncSync(store.descriptor); assertStore(store);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function replaceOwned(store, name, value) {
  const temporary = `.${name}.${randomBytes(16).toString("hex")}.tmp`; let descriptor;
  try {
    descriptor = openSync(join(store.path, temporary), constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`); fsyncSync(descriptor); closeSync(descriptor);
    descriptor = undefined; assertStore(store); renameSync(join(store.path, temporary), join(store.path, name));
    fsyncSync(store.descriptor); assertStore(store);
  } finally { if (descriptor !== undefined) closeSync(descriptor); rmSync(join(store.path, temporary), { force: true }); }
}

export function loadRehearsalAttestationStore(path, options = {}) {
  const store = openStore(path, false);
  try { return loadStore(store, options._afterRootOpen); } finally { closeSync(store.descriptor); }
}

export function verifyRehearsalAttestationStoreTranscript(value) {
  exact(value, ["format", "head", "records", "transcriptHash", "version"],
    "rehearsal attestation store transcript");
  if (value.format !== STORE_TRANSCRIPT_FORMAT || value.version !== 1 ||
      !Array.isArray(value.records) || value.records.length < 1 || value.records.length > MAX_RECORDS) {
    throw new Error("rehearsal attestation store transcript is invalid");
  }
  let previous = null;
  const records = value.records.map((envelope, index) => {
    exact(envelope, ["record", "recordHash"], "attestation transcript record");
    const record = recordPayload(envelope.record); const recordHash = digest(record);
    if (envelope.recordHash !== recordHash || record.sequence !== index + 1 ||
        record.previousRecordHash !== previous) {
      throw new Error("attestation transcript chain is rolled back, reordered, or corrupt");
    }
    previous = recordHash; return { record, recordHash };
  });
  const head = validateHead(value.head); const expectedHead = headValue(records.length, previous);
  const { transcriptHash, ...payload } = value;
  if (canonicalJson(head) !== canonicalJson(expectedHead) || transcriptHash !== digest(payload)) {
    throw new Error("attestation transcript head or commitment is invalid");
  }
  return structuredClone(value);
}

export function exportRehearsalAttestationStoreTranscript(path) {
  const records = loadRehearsalAttestationStore(path);
  if (records.length < 1) throw new Error("cannot export an empty attestation store");
  const envelopes = records.map(({ recordHash, ...record }) => ({ record, recordHash }));
  const payload = { format: STORE_TRANSCRIPT_FORMAT,
    head: headValue(records.length, records.at(-1).recordHash), records: envelopes, version: 1 };
  return verifyRehearsalAttestationStoreTranscript({ ...payload, transcriptHash: digest(payload) });
}

export function acceptRehearsalAttestationQuorum(path, attestations, options) {
  const packageEnvelope = assembleRehearsalAttestationPackage(attestations, options);
  const store = openStore(path, true); let lockDescriptor;
  try {
    lockDescriptor = openSync(join(store.path, LOCK), constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fsyncSync(store.descriptor);
    const records = loadStore(store);
    const sameRun = records.find((record) => record.runNonce === packageEnvelope.statement.runNonce);
    if (sameRun) {
      if (sameRun.packageHash === packageEnvelope.packageHash) throw new Error("rehearsal run was replayed");
      throw new Error("rehearsal run nonce equivocation detected");
    }
    const latestByOperator = new Map();
    for (const record of records) for (const operatorId of record.operatorIds) latestByOperator.set(operatorId,
      Math.max(latestByOperator.get(operatorId) ?? 0, record.observedAt));
    for (const operatorId of packageEnvelope.attestations.map(({ operatorId }) => operatorId)) {
      if ((latestByOperator.get(operatorId) ?? 0) > packageEnvelope.statement.observedAt) {
        throw new Error("rehearsal attestor head would roll back");
      }
    }
    const record = recordPayload({ acceptedAt: options.now, format: STORE_RECORD_FORMAT,
      observedAt: packageEnvelope.statement.observedAt,
      operatorIds: packageEnvelope.attestations.map(({ operatorId }) => operatorId),
      packageHash: packageEnvelope.packageHash,
      previousRecordHash: records.at(-1)?.recordHash ?? null,
      runNonce: packageEnvelope.statement.runNonce, sequence: records.length + 1, version: 1 });
    const recordHash = digest(record);
    writeExclusive(store, `${String(record.sequence).padStart(12, "0")}-${recordHash}.json`,
      { record, recordHash });
    if (options._crashAfterRecord) throw new Error("injected attestation store crash");
    const head = headValue(record.sequence, recordHash);
    replaceOwned(store, PRIMARY, head); replaceOwned(store, BACKUP, head);
    loadStore(store);
    return { package: packageEnvelope,
      preflightInput: createProductionPreflightRehearsalInput(packageEnvelope, options), recordHash };
  } finally {
    try {
      if (lockDescriptor !== undefined) {
        closeSync(lockDescriptor); rmSync(join(store.path, LOCK), { force: true }); fsyncSync(store.descriptor);
      }
    } finally { closeSync(store.descriptor); }
  }
}

export function serializeRehearsalAttestation(value) { return `${canonicalJson(value)}\n`; }
