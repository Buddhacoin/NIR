import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import {
  validateReleaseTransparencyAnchor, validateReleaseTransparencyCheckpoint,
} from "./offline-release-governance.mjs";

const SET_FORMAT = "nir-release-witness-set-v1";
const RECEIPT_FORMAT = "nir-release-witness-receipt-v1";
const EVIDENCE_FORMAT = "nir-release-witness-equivocation-v1";
const SELECTION_FORMAT = "nir-release-witness-selection-v1";
const HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const STORE_NAME = /^([0-9]{12})-([a-z0-9][a-z0-9._-]{0,63})-([0-9a-f]{64})\.json$/;
const MAX_WITNESSES = 64;
const MAX_STORE_RECEIPTS = 4096;
const MAX_FILE_BYTES = 64 * 1024;

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
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1 || decoded.length > maximum || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
}

function setPayload(value) {
  exact(value, ["format", "threshold", "version", "witnesses"], "release witness set");
  if (value.format !== SET_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.threshold) || value.threshold < 2 ||
      !Array.isArray(value.witnesses) || value.witnesses.length < value.threshold ||
      value.witnesses.length > MAX_WITNESSES) throw new Error("release witness set policy is invalid");
  const operators = new Set(); const addresses = new Set(); const keys = new Set();
  const witnesses = value.witnesses.map((witness, index) => {
    exact(witness, ["address", "algorithm", "operatorId", "publicKey"], "release witness");
    canonicalBase64(witness.publicKey, 8 * 1024, "release witness public key");
    if (!OPERATOR.test(witness.operatorId ?? "") || witness.algorithm !== SIGNATURE_ALGORITHM ||
        !ADDRESS.test(witness.address ?? "") || addressFromPublicKey(witness.publicKey) !== witness.address ||
        operators.has(witness.operatorId) || addresses.has(witness.address) || keys.has(witness.publicKey) ||
        (index > 0 && value.witnesses[index - 1].operatorId >= witness.operatorId)) {
      throw new Error("release witnesses are duplicate, unordered, or invalid");
    }
    operators.add(witness.operatorId); addresses.add(witness.address); keys.add(witness.publicKey);
    return structuredClone(witness);
  });
  return { format: SET_FORMAT, threshold: value.threshold, version: 1, witnesses };
}

export function createReleaseWitnessSet({ threshold, witnesses }) {
  const payload = setPayload({ format: SET_FORMAT, threshold, version: 1,
    witnesses: [...witnesses].sort((a, b) => a.operatorId.localeCompare(b.operatorId)) });
  return { ...payload, witnessSetId:
    `sha3-256:${hashObject(payload, "RELEASE_WITNESS_SET_V1")}` };
}

export function validateReleaseWitnessSet(value) {
  exact(value, ["format", "threshold", "version", "witnesses", "witnessSetId"],
    "release witness set envelope");
  const { witnessSetId, ...unsigned } = value;
  const payload = setPayload(unsigned);
  if (witnessSetId !== `sha3-256:${hashObject(payload, "RELEASE_WITNESS_SET_V1")}`) {
    throw new Error("release witness set id is invalid");
  }
  return { ...payload, witnessSetId };
}

function receiptPayload(value) {
  exact(value, ["address", "anchorHash", "checkpointHash", "entryHash", "format", "logId",
    "networkId", "observedAt", "operatorId", "sequence", "version", "witnessSetId"],
  "release witness receipt");
  if (value.format !== RECEIPT_FORMAT || value.version !== 1 || !OPERATOR.test(value.operatorId ?? "") ||
      !ADDRESS.test(value.address ?? "") || !HASH.test(value.anchorHash ?? "") ||
      !HASH.test(value.checkpointHash ?? "") || !HASH.test(value.entryHash ?? "") ||
      !HASH.test(value.witnessSetId ?? "") || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt < 0) {
    throw new Error("release witness receipt fields are invalid");
  }
  return structuredClone(value);
}

function signingPayload(payload) {
  return { anchorHash: payload.anchorHash, checkpointHash: payload.checkpointHash,
    entryHash: payload.entryHash, logId: payload.logId, networkId: payload.networkId,
    observedAt: payload.observedAt, operatorId: payload.operatorId, sequence: payload.sequence,
    witnessSetId: payload.witnessSetId };
}

export function createReleaseWitnessReceipt({
  anchor: anchorValue, checkpoint: checkpointValue, witnessSet: setValue,
  operatorId, wallet, observedAt,
}) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const checkpoint = validateReleaseTransparencyCheckpoint(checkpointValue, anchor);
  const witnessSet = validateReleaseWitnessSet(setValue);
  const witness = witnessSet.witnesses.find((candidate) => candidate.operatorId === operatorId);
  if (!witness || witness.address !== wallet.address || witness.publicKey !== wallet.publicKey) {
    throw new Error("release witness signer is not in the trusted witness set");
  }
  const payload = receiptPayload({ address: witness.address, anchorHash: anchor.anchorHash,
    checkpointHash: checkpoint.checkpointHash, entryHash: checkpoint.entryHash,
    format: RECEIPT_FORMAT, logId: anchor.logId, networkId: anchor.networkId, observedAt,
    operatorId, sequence: checkpoint.sequence, version: 1, witnessSetId: witnessSet.witnessSetId });
  const signed = { ...payload, signature: signObject(signingPayload(payload), wallet,
    "RELEASE_WITNESS_RECEIPT_V1") };
  return { ...signed, receiptHash: `sha3-256:${hashObject(signed, "RELEASE_WITNESS_RECEIPT_HASH_V1")}` };
}

export function validateReleaseWitnessReceipt(value, {
  anchor: anchorValue, witnessSet: setValue, now, maxAgeMs, maxFutureSkewMs,
} = {}) {
  exact(value, ["address", "anchorHash", "checkpointHash", "entryHash", "format", "logId",
    "networkId", "observedAt", "operatorId", "receiptHash", "sequence", "signature", "version",
    "witnessSetId"], "release witness receipt envelope");
  canonicalBase64(value.signature, 16 * 1024, "release witness signature");
  const { receiptHash, signature, ...unsigned } = value;
  const payload = receiptPayload(unsigned);
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const witnessSet = validateReleaseWitnessSet(setValue);
  const witness = witnessSet.witnesses.find((candidate) => candidate.operatorId === payload.operatorId);
  const expectedHash = `sha3-256:${hashObject({ ...payload, signature },
    "RELEASE_WITNESS_RECEIPT_HASH_V1")}`;
  if (payload.anchorHash !== anchor.anchorHash || payload.logId !== anchor.logId ||
      payload.networkId !== anchor.networkId || payload.witnessSetId !== witnessSet.witnessSetId ||
      !witness || payload.address !== witness.address || receiptHash !== expectedHash ||
      !verifyObject(signingPayload(payload), signature, witness.publicKey, "RELEASE_WITNESS_RECEIPT_V1")) {
    throw new Error("release witness receipt has invalid identity, context, hash, or signature");
  }
  if (now !== undefined) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
        !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0) {
      throw new Error("release witness time policy is invalid");
    }
    if (payload.observedAt < now - maxAgeMs) throw new Error("release witness receipt is stale");
    if (payload.observedAt > now + maxFutureSkewMs) throw new Error("release witness receipt is from the future");
  }
  return { ...payload, receiptHash, signature };
}

function sameView(left, right) {
  return left.anchorHash === right.anchorHash && left.logId === right.logId &&
    left.networkId === right.networkId && left.sequence === right.sequence &&
    left.entryHash === right.entryHash && left.checkpointHash === right.checkpointHash;
}

export function createReleaseWitnessEquivocationEvidence(firstValue, secondValue, context) {
  const first = validateReleaseWitnessReceipt(firstValue, context);
  const second = validateReleaseWitnessReceipt(secondValue, context);
  if (first.operatorId !== second.operatorId || first.address !== second.address ||
      first.sequence !== second.sequence || first.anchorHash !== second.anchorHash ||
      first.logId !== second.logId || first.networkId !== second.networkId || sameView(first, second)) {
    throw new Error("receipts do not prove release witness equivocation");
  }
  const receipts = [first, second].sort((a, b) => a.receiptHash.localeCompare(b.receiptHash));
  const payload = { format: EVIDENCE_FORMAT, operatorId: first.operatorId, receipts,
    sequence: first.sequence, version: 1, witnessSetId: first.witnessSetId };
  return validateReleaseWitnessEquivocationEvidence({ ...payload, evidenceHash:
    `sha3-256:${hashObject(payload, "RELEASE_WITNESS_EQUIVOCATION_V1")}` }, context);
}

export function validateReleaseWitnessEquivocationEvidence(value, context) {
  exact(value, ["evidenceHash", "format", "operatorId", "receipts", "sequence", "version",
    "witnessSetId"], "release witness equivocation evidence");
  if (value.format !== EVIDENCE_FORMAT || value.version !== 1 || !HASH.test(value.evidenceHash ?? "") ||
      !OPERATOR.test(value.operatorId ?? "") || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || !HASH.test(value.witnessSetId ?? "") || !Array.isArray(value.receipts) ||
      value.receipts.length !== 2) throw new Error("release witness equivocation evidence is invalid");
  const receipts = value.receipts.map((receipt) => validateReleaseWitnessReceipt(receipt, context));
  if (receipts[0].receiptHash >= receipts[1].receiptHash ||
      receipts.some((receipt) => receipt.operatorId !== value.operatorId ||
        receipt.sequence !== value.sequence || receipt.witnessSetId !== value.witnessSetId) ||
      receipts[0].address !== receipts[1].address || receipts[0].anchorHash !== receipts[1].anchorHash ||
      receipts[0].logId !== receipts[1].logId || receipts[0].networkId !== receipts[1].networkId ||
      sameView(receipts[0], receipts[1])) {
    throw new Error("release witness evidence does not prove equivocation");
  }
  const { evidenceHash, ...payload } = value;
  if (evidenceHash !== `sha3-256:${hashObject(payload, "RELEASE_WITNESS_EQUIVOCATION_V1")}`) {
    throw new Error("release witness equivocation evidence hash is invalid");
  }
  return structuredClone(value);
}

export function selectReleaseWitnessView(receiptValues, {
  anchor, witnessSet: setValue, sequence, now, maxAgeMs, maxFutureSkewMs = 0,
}) {
  const witnessSet = validateReleaseWitnessSet(setValue);
  if (!Array.isArray(receiptValues) || receiptValues.length > MAX_WITNESSES ||
      !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("release witness selection input is invalid");
  const receipts = receiptValues.map((receipt) => validateReleaseWitnessReceipt(receipt, {
    anchor, maxAgeMs, maxFutureSkewMs, now, witnessSet,
  }));
  const operators = new Map();
  for (const receipt of receipts) {
    if (receipt.sequence !== sequence) throw new Error("release witness receipt has the wrong sequence");
    if (operators.has(receipt.operatorId)) {
      const prior = operators.get(receipt.operatorId);
      if (!sameView(prior, receipt)) {
        const error = new Error("release witness equivocation detected");
        error.evidence = createReleaseWitnessEquivocationEvidence(prior, receipt, { anchor, witnessSet });
        throw error;
      }
      throw new Error("duplicate release witness identity");
    }
    operators.set(receipt.operatorId, receipt);
  }
  const groups = new Map();
  for (const receipt of receipts) {
    const key = `${receipt.entryHash}\0${receipt.checkpointHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(receipt);
  }
  const quorums = [...groups.values()].filter((group) => group.length >= witnessSet.threshold);
  if (quorums.length !== 1) throw new Error("release witness quorum has no unique exact view");
  const selected = quorums[0].sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  const payload = { anchorHash: selected[0].anchorHash, checkpointHash: selected[0].checkpointHash,
    entryHash: selected[0].entryHash, format: SELECTION_FORMAT, logId: selected[0].logId,
    networkId: selected[0].networkId, receiptHashes: selected.map((receipt) => receipt.receiptHash),
    sequence, version: 1, witnessSetId: witnessSet.witnessSetId,
    witnesses: selected.map((receipt) => receipt.operatorId) };
  return { ...payload, selectionHash:
    `sha3-256:${hashObject(payload, "RELEASE_WITNESS_SELECTION_V1")}` };
}

function requireSecureFs() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new Error("secure witness-store filesystem support is unavailable");
  }
}

function openStore(pathValue, create = false) {
  requireSecureFs(); const path = resolve(pathValue);
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) {
    throw new Error("release witness store is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(descriptor); throw new Error("release witness store changed during open");
  }
  return { descriptor, metadata: opened, path };
}

function assertStore(store, stable = false) {
  const current = fstatSync(store.descriptor); const linked = lstatSync(store.path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || current.dev !== store.metadata.dev ||
      current.ino !== store.metadata.ino || linked.dev !== store.metadata.dev ||
      linked.ino !== store.metadata.ino || current.mode !== store.metadata.mode ||
      current.uid !== store.metadata.uid || (stable && (current.mtimeMs !== store.metadata.mtimeMs ||
      current.ctimeMs !== store.metadata.ctimeMs))) throw new Error("release witness store changed");
}

function readCanonical(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_FILE_BYTES || (before.mode & 0o077) !== 0) {
      throw new Error("release witness store file is unsafe");
    }
    const contents = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (contents.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("release witness store file changed during read");
    }
    const text = contents.toString("utf8");
    const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("release witness store JSON is not canonical");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function storeName(receipt) {
  return `${String(receipt.sequence).padStart(12, "0")}-${receipt.operatorId}-${
    receipt.receiptHash.slice("sha3-256:".length)}.json`;
}

export function loadReleaseWitnessHeadStore(storePath, context, { _afterDirectoryOpen } = {}) {
  const store = openStore(storePath, true);
  const heads = new Map(); const receipts = []; const equivocations = [];
  try {
    if (_afterDirectoryOpen) _afterDirectoryOpen(store.path);
    const names = readdirSync(store.path).sort();
    if (names.length > MAX_STORE_RECEIPTS) throw new Error("release witness store is over its bounded limit");
    for (const name of names) {
      const match = STORE_NAME.exec(name);
      if (!match) throw new Error("release witness store contains an unknown file");
      const receipt = validateReleaseWitnessReceipt(readCanonical(join(store.path, name)), {
        anchor: context.anchor, witnessSet: context.witnessSet,
      });
      if (name !== storeName(receipt)) throw new Error("release witness store filename is invalid");
      const head = heads.get(receipt.operatorId);
      if (head && receipt.sequence < head.sequence) throw new Error("release witness head rolled back");
      if (head && receipt.sequence === head.sequence && !sameView(head, receipt)) {
        equivocations.push(createReleaseWitnessEquivocationEvidence(head, receipt, {
          anchor: context.anchor, witnessSet: context.witnessSet,
        }));
      }
      if (!head || receipt.sequence > head.sequence ||
          (receipt.sequence === head.sequence && receipt.observedAt > head.observedAt)) {
        heads.set(receipt.operatorId, receipt);
      }
      receipts.push(receipt);
    }
    assertStore(store, true);
    return { equivocations, heads, receipts };
  } finally { closeSync(store.descriptor); }
}

export function importReleaseWitnessReceipt(storePath, receiptValue, context) {
  const current = loadReleaseWitnessHeadStore(storePath, context);
  const receipt = validateReleaseWitnessReceipt(receiptValue, context);
  if (current.receipts.some((candidate) => candidate.receiptHash === receipt.receiptHash)) {
    throw new Error("release witness receipt was replayed");
  }
  if (current.receipts.length >= MAX_STORE_RECEIPTS) {
    throw new Error("release witness store is over its bounded limit");
  }
  const head = current.heads.get(receipt.operatorId);
  if (head && receipt.sequence < head.sequence) throw new Error("release witness receipt rolls its head back");
  const evidence = head && receipt.sequence === head.sequence && !sameView(head, receipt)
    ? createReleaseWitnessEquivocationEvidence(head, receipt, {
      anchor: context.anchor, witnessSet: context.witnessSet,
    }) : null;
  const store = openStore(storePath, true); let descriptor;
  try {
    assertStore(store);
    descriptor = openSync(join(store.path, storeName(receipt)), constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${canonicalJson(receipt)}\n`); fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor); fsyncSync(store.descriptor); assertStore(store);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor); closeSync(store.descriptor);
  }
  loadReleaseWitnessHeadStore(storePath, context);
  return { evidence, receipt, status: evidence ? "equivocation" : "imported" };
}

export function selectReleaseWitnessHeadStore(storePath, options) {
  const loaded = loadReleaseWitnessHeadStore(storePath, options);
  const tainted = new Set(loaded.equivocations.map((evidence) => evidence.operatorId));
  return selectReleaseWitnessView([...loaded.heads.values()].filter((receipt) =>
    !tainted.has(receipt.operatorId)), options);
}

export function serializeReleaseWitness(value) {
  return `${canonicalJson(value)}\n`;
}
