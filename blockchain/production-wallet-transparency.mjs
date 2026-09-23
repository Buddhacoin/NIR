import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validateReleaseAuthoritySet } from "./offline-release-governance.mjs";
import { verifyProductionWalletExport } from "./production-wallet-export.mjs";

const STORE_FORMAT = "nir-wallet-release-transparency-store-v1";
const RECORD_FORMAT = "nir-wallet-release-transparency-record-v1";
const CHECKPOINT_FORMAT = "nir-wallet-release-transparency-checkpoint-v1";
const PROOF_FORMAT = "nir-wallet-release-inclusion-proof-v1";
const CONSISTENCY_FORMAT = "nir-wallet-release-consistency-proof-v1";
const PRIMARY = "LOG.primary.json"; const BACKUP = "LOG.backup.json"; const LOCK = ".writer.lock";
const ZERO = "0".repeat(64); const HASH = /^[0-9a-f]{64}$/; const PREFIXED = /^sha3-256:[0-9a-f]{64}$/;
const MAX_RECORDS = 4096; const MAX_STORE_BYTES = 16 * 1024 * 1024; const MAX_PROOF_NODES = 64;
const MAX_CHECKPOINT_LIFETIME_MS = 7 * 86_400_000;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function leaf(recordHash) { return hashObject({ recordHash }, "WALLET_RELEASE_MERKLE_LEAF_V1"); }
function node(left, right) { return hashObject({ left, right }, "WALLET_RELEASE_MERKLE_NODE_V1"); }
function split(count) { let value = 1; while ((value << 1) < count) value <<= 1; return value; }
function merkleRoot(leaves) {
  if (leaves.length === 0) return ZERO;
  if (leaves.length === 1) return leaves[0];
  const cut = split(leaves.length);
  return node(merkleRoot(leaves.slice(0, cut)), merkleRoot(leaves.slice(cut)));
}
function inclusionNodes(leaves, index) {
  if (leaves.length === 1) return [];
  const cut = split(leaves.length);
  return index < cut
    ? [...inclusionNodes(leaves.slice(0, cut), index), merkleRoot(leaves.slice(cut))]
    : [...inclusionNodes(leaves.slice(cut), index - cut), merkleRoot(leaves.slice(0, cut))];
}
function rebuildInclusion(hash, index, count, nodes, cursor = { value: 0 }) {
  if (count === 1) return hash;
  const cut = split(count); let result;
  if (index < cut) {
    result = rebuildInclusion(hash, index, cut, nodes, cursor);
    if (cursor.value >= nodes.length) throw new Error("wallet release inclusion proof is truncated");
    result = node(result, nodes[cursor.value++]);
  } else {
    result = rebuildInclusion(hash, index - cut, count - cut, nodes, cursor);
    if (cursor.value >= nodes.length) throw new Error("wallet release inclusion proof is truncated");
    result = node(nodes[cursor.value++], result);
  }
  return result;
}
function consistencyNodes(leaves, oldCount, complete = true) {
  const count = leaves.length;
  if (oldCount === count) return complete ? [] : [merkleRoot(leaves)];
  const cut = split(count);
  if (oldCount <= cut) return [
    ...consistencyNodes(leaves.slice(0, cut), oldCount, complete),
    merkleRoot(leaves.slice(cut)),
  ];
  return [
    ...consistencyNodes(leaves.slice(cut), oldCount - cut, false),
    merkleRoot(leaves.slice(0, cut)),
  ];
}

export function verifyWalletReleaseConsistencyProof(value) {
  exact(value, ["format", "newCount", "newRoot", "nodes", "oldCount", "oldRoot", "version"],
    "wallet release consistency proof");
  if (value.format !== CONSISTENCY_FORMAT || value.version !== 1 ||
      !Number.isSafeInteger(value.oldCount) || !Number.isSafeInteger(value.newCount) ||
      value.oldCount < 1 || value.newCount < value.oldCount || value.newCount > MAX_RECORDS ||
      !HASH.test(value.oldRoot ?? "") || !HASH.test(value.newRoot ?? "") ||
      !Array.isArray(value.nodes) || value.nodes.length > MAX_PROOF_NODES ||
      value.nodes.some((item) => !HASH.test(item ?? ""))) throw new Error("wallet release consistency proof is invalid");
  if (value.oldCount === value.newCount) {
    if (value.nodes.length !== 0 || value.oldRoot !== value.newRoot) throw new Error("wallet release roots conflict");
    return structuredClone(value);
  }
  let fn = value.oldCount - 1; let sn = value.newCount - 1; let index = 0; let first; let second;
  if ((value.oldCount & (value.oldCount - 1)) === 0) first = second = value.oldRoot;
  else { first = second = value.nodes[index++]; }
  while ((fn & 1) === 1) { fn >>= 1; sn >>= 1; }
  for (; index < value.nodes.length; index += 1) {
    const hash = value.nodes[index];
    if (sn === 0) throw new Error("wallet release consistency proof has extra nodes");
    if ((fn & 1) === 1 || fn === sn) {
      first = node(hash, first); second = node(hash, second);
      while (fn !== 0 && (fn & 1) === 0) { fn >>= 1; sn >>= 1; }
    } else second = node(second, hash);
    fn >>= 1; sn >>= 1;
  }
  if (sn !== 0 || first !== value.oldRoot || second !== value.newRoot) {
    throw new Error("wallet release consistency proof does not connect the checkpoints");
  }
  return structuredClone(value);
}

function recordPayload(value) {
  exact(value, ["authoritySetId", "bundleHash", "format", "genesisHash", "networkId",
    "previousRecordHash", "releaseManifestHash", "releaseVersion", "sequence", "sourceRevision",
    "toolPackageHash", "version", "walletPackageHash"], "wallet release record");
  if (value.format !== RECORD_FORMAT || value.version !== 1 || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 || !HASH.test(value.previousRecordHash ?? "") ||
      !PREFIXED.test(value.bundleHash ?? "") || !PREFIXED.test(value.authoritySetId ?? "") ||
      !HASH.test(value.releaseManifestHash ?? "") || !HASH.test(value.walletPackageHash ?? "") ||
      !HASH.test(value.toolPackageHash ?? "") || typeof value.networkId !== "string" ||
      !/^(?:sha3-256:)?[0-9a-f]{64}$/.test(value.genesisHash ?? "") ||
      !/^(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})$/.test(value.releaseVersion ?? "") ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sourceRevision ?? "")) {
    throw new Error("wallet release record is invalid");
  }
  return structuredClone(value);
}
function validateStore(value) {
  exact(value, ["checksum", "count", "format", "headHash", "merkleRoot", "records", "version"],
    "wallet release transparency store");
  if (value.format !== STORE_FORMAT || value.version !== 1 || !Array.isArray(value.records) ||
      value.records.length > MAX_RECORDS || value.count !== value.records.length ||
      !HASH.test(value.headHash ?? "") || !HASH.test(value.merkleRoot ?? "")) throw new Error("wallet release store is invalid");
  let previous = ZERO; let context = null; const packages = new Set(); const bundles = new Set();
  const records = value.records.map((envelope, index) => {
    exact(envelope, ["record", "recordHash"], "wallet release record envelope");
    const record = recordPayload(envelope.record); const recordHash = hashObject(record, "WALLET_RELEASE_RECORD_V1");
    if (recordHash !== envelope.recordHash || record.sequence !== index + 1 ||
        record.previousRecordHash !== previous || packages.has(record.walletPackageHash) ||
        bundles.has(record.bundleHash)) throw new Error("wallet release log is reordered, duplicate, or forked");
    if (context && (record.networkId !== context.networkId || record.genesisHash !== context.genesisHash ||
        record.authoritySetId !== context.authoritySetId)) throw new Error("wallet release log context changed");
    context ??= record; packages.add(record.walletPackageHash); bundles.add(record.bundleHash); previous = recordHash;
    return { record, recordHash };
  });
  const leaves = records.map(({ recordHash }) => leaf(recordHash));
  const payload = { count: records.length, format: STORE_FORMAT, headHash: previous,
    merkleRoot: merkleRoot(leaves), records, version: 1 };
  if (value.headHash !== payload.headHash || value.merkleRoot !== payload.merkleRoot ||
      value.checksum !== hashObject(payload, "WALLET_RELEASE_STORE_V1")) throw new Error("wallet release store commitment is invalid");
  return { ...payload, checksum: value.checksum };
}
function emptyStore() {
  const payload = { count: 0, format: STORE_FORMAT, headHash: ZERO, merkleRoot: ZERO, records: [], version: 1 };
  return { ...payload, checksum: hashObject(payload, "WALLET_RELEASE_STORE_V1") };
}
function requireFs() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY) ||
      constants.O_NOFOLLOW === 0 || constants.O_DIRECTORY === 0) throw new Error("secure wallet release filesystem is unavailable");
}
function openRoot(pathValue, create = false) {
  requireFs(); const path = resolve(pathValue);
  if (create) try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const linked = lstatSync(path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || (linked.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && linked.uid !== process.getuid())) {
    throw new Error("wallet release root is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !same(linked, opened)) { closeSync(descriptor); throw new Error("wallet release root changed"); }
  return { descriptor, metadata: opened, path };
}
function assertRoot(root) {
  const linked = lstatSync(root.path); const opened = fstatSync(root.descriptor);
  if (!linked.isDirectory() || linked.isSymbolicLink() || !same(linked, root.metadata) ||
      !same(opened, root.metadata) || linked.uid !== root.metadata.uid ||
      linked.mode !== root.metadata.mode) throw new Error("wallet release root changed");
}
function readCopy(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_STORE_BYTES ||
        (before.mode & 0o077) !== 0) throw new Error("wallet release copy is unsafe");
    const contents = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (!same(before, after) || !same(before, linked) || contents.length !== before.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("wallet release copy changed");
    const value = JSON.parse(contents); if (contents.toString() !== `${canonicalJson(value)}\n`) throw new Error("wallet release copy is not canonical");
    return validateStore(value);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function loadCopies(root) {
  const valid = []; let present = 0;
  for (const name of [PRIMARY, BACKUP]) try {
    const path = join(root.path, name); lstatSync(path); present += 1; valid.push(readCopy(path));
  } catch (error) { if (error.code !== "ENOENT" && present === 0) present += 1; }
  if (present === 0) return { copiesValid: 0, store: emptyStore() };
  if (valid.length === 0) throw new Error("both wallet release copies are invalid");
  valid.sort((a, b) => b.count - a.count); const selected = valid[0];
  for (const candidate of valid.slice(1)) if (candidate.count === selected.count && candidate.headHash !== selected.headHash ||
      candidate.records.some((entry, index) => entry.recordHash !== selected.records[index]?.recordHash)) {
    throw new Error("wallet release copies diverged");
  }
  return { copiesValid: valid.length, store: selected };
}
function lock(root) {
  assertRoot(root); const path = join(root.path, LOCK); let descriptor;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${process.pid}\n`); fchmodSync(descriptor, 0o600); fsyncSync(descriptor);
    const identity = fstatSync(descriptor); closeSync(descriptor); descriptor = undefined; assertRoot(root);
    return { identity, path };
  } catch (error) { if (descriptor !== undefined) closeSync(descriptor); throw error; }
}
function unlock(root, held) {
  const linked = lstatSync(held.path); if (!same(linked, held.identity) || linked.isSymbolicLink()) throw new Error("wallet release lock changed");
  unlinkSync(held.path); fsyncSync(root.descriptor);
}
function writeCopy(root, name, store, hook) {
  assertRoot(root); const target = join(root.path, name); const temporary = join(root.path, `.${name}.${randomBytes(16).toString("hex")}.tmp`);
  let identity = null;
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, `${canonicalJson(store)}\n`); fchmodSync(descriptor, 0o600); fsyncSync(descriptor); identity = fstatSync(descriptor); }
    finally { closeSync(descriptor); }
    if (hook) hook({ name, target, temporary }); assertRoot(root); const linked = lstatSync(temporary);
    if (!same(identity, linked) || linked.isSymbolicLink()) throw new Error("wallet release temporary changed");
    renameSync(temporary, target); identity = null; fsyncSync(root.descriptor); assertRoot(root); readCopy(target);
  } finally { if (identity) try { const linked = lstatSync(temporary); if (same(identity, linked) && !linked.isSymbolicLink()) unlinkSync(temporary); } catch {} }
}

export function loadWalletReleaseTransparencyStore(pathValue) {
  const root = openRoot(pathValue); try { const loaded = loadCopies(root); assertRoot(root); return loaded; }
  finally { closeSync(root.descriptor); }
}

export function appendWalletReleaseTransparency(pathValue, exportValue, options = {}) {
  const verified = verifyProductionWalletExport(exportValue, options);
  const root = openRoot(pathValue, true); const held = lock(root);
  try {
    const current = loadCopies(root).store;
    if (current.count >= MAX_RECORDS) throw new Error("wallet release log capacity is exhausted");
    const binding = verified.binding;
    const record = recordPayload({ authoritySetId: verified.authoritySet.setId,
      bundleHash: verified.bundle.bundleHash, format: RECORD_FORMAT, genesisHash: binding.genesisHash,
      networkId: binding.networkId, previousRecordHash: current.headHash,
      releaseManifestHash: binding.releaseManifestHash, releaseVersion: binding.releaseVersion,
      sequence: current.count + 1, sourceRevision: binding.sourceRevision,
      toolPackageHash: binding.tool.packageHash, version: 1,
      walletPackageHash: binding.wallet.packageHash });
    const recordHash = hashObject(record, "WALLET_RELEASE_RECORD_V1");
    const records = [...current.records, { record, recordHash }];
    const payload = { count: records.length, format: STORE_FORMAT, headHash: recordHash,
      merkleRoot: merkleRoot(records.map((entry) => leaf(entry.recordHash))), records, version: 1 };
    const store = { ...payload, checksum: hashObject(payload, "WALLET_RELEASE_STORE_V1") };
    writeCopy(root, PRIMARY, store, options._beforePrimaryRename);
    writeCopy(root, BACKUP, store, options._beforeBackupRename);
    return { record, recordHash, store };
  } finally { try { unlock(root, held); } finally { closeSync(root.descriptor); } }
}

function checkpointPayload(value) {
  exact(value, ["authoritySetId", "count", "expiresAt", "format", "genesisHash", "headHash", "issuedAt",
    "latestBundleHash", "latestReleaseManifestHash", "latestToolPackageHash",
    "latestWalletPackageHash", "merkleRoot", "networkId", "version"], "wallet release checkpoint");
  if (value.format !== CHECKPOINT_FORMAT || value.version !== 1 || !Number.isSafeInteger(value.count) ||
      value.count < 1 || value.count > MAX_RECORDS || !Number.isSafeInteger(value.issuedAt) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > MAX_CHECKPOINT_LIFETIME_MS ||
      !HASH.test(value.headHash ?? "") || !HASH.test(value.merkleRoot ?? "") ||
      !/^(?:sha3-256:)?[0-9a-f]{64}$/.test(value.genesisHash ?? "") ||
      !PREFIXED.test(value.authoritySetId ?? "") || !PREFIXED.test(value.latestBundleHash ?? "") ||
      !HASH.test(value.latestReleaseManifestHash ?? "") ||
      !HASH.test(value.latestToolPackageHash ?? "") || !HASH.test(value.latestWalletPackageHash ?? "")) {
    throw new Error("wallet release checkpoint is invalid");
  }
  return structuredClone(value);
}
export function createWalletReleaseCheckpoint(storeValue, { issuedAt, expiresAt }) {
  const store = validateStore(storeValue); const latest = store.records.at(-1)?.record;
  if (!latest) throw new Error("empty wallet release log cannot be checkpointed");
  return checkpointPayload({ authoritySetId: latest.authoritySetId, count: store.count, expiresAt,
    format: CHECKPOINT_FORMAT, genesisHash: latest.genesisHash, headHash: store.headHash, issuedAt,
    latestBundleHash: latest.bundleHash, latestToolPackageHash: latest.toolPackageHash,
    latestReleaseManifestHash: latest.releaseManifestHash,
    latestWalletPackageHash: latest.walletPackageHash, merkleRoot: store.merkleRoot,
    networkId: latest.networkId, version: 1 });
}
export function signWalletReleaseCheckpoint(checkpointValue, authoritySetValue, { operatorId, wallet }) {
  const checkpoint = checkpointPayload(checkpointValue); const set = validateReleaseAuthoritySet(authoritySetValue);
  const authority = set.authorities.find((entry) => entry.operatorId === operatorId);
  if (!authority || authority.address !== wallet.address || checkpoint.authoritySetId !== set.setId) throw new Error("checkpoint signer is not an authority");
  return { address: authority.address, algorithm: SIGNATURE_ALGORITHM, operatorId,
    signature: signObject(checkpoint, wallet, "WALLET_RELEASE_CHECKPOINT_V1") };
}
export function assembleWalletReleaseCheckpoint(checkpointValue, authoritySetValue, signatureValues) {
  const checkpoint = checkpointPayload(checkpointValue); const set = validateReleaseAuthoritySet(authoritySetValue);
  if (checkpoint.authoritySetId !== set.setId || !Array.isArray(signatureValues) || signatureValues.length < set.threshold || signatureValues.length > set.authorities.length) throw new Error("checkpoint authority quorum is missing");
  const seen = new Set(); const signatures = signatureValues.map((value) => {
    exact(value, ["address", "algorithm", "operatorId", "signature"], "checkpoint signature");
    const authority = set.authorities.find((entry) => entry.operatorId === value.operatorId);
    if (!authority || value.algorithm !== SIGNATURE_ALGORITHM || value.address !== authority.address ||
        seen.has(value.operatorId) || !verifyObject(checkpoint, value.signature, authority.publicKey,
          "WALLET_RELEASE_CHECKPOINT_V1")) throw new Error("checkpoint signature is unknown, duplicate, or invalid");
    seen.add(value.operatorId); return structuredClone(value);
  }).sort((a, b) => a.operatorId < b.operatorId ? -1 : 1);
  const payload = { checkpoint, signatures };
  return { ...payload, checkpointHash: hashObject(payload, "WALLET_RELEASE_SIGNED_CHECKPOINT_V1") };
}
export function verifyWalletReleaseCheckpoint(value, authoritySetValue, { expectedCheckpointHash, now }) {
  exact(value, ["checkpoint", "checkpointHash", "signatures"], "signed wallet release checkpoint");
  const expected = assembleWalletReleaseCheckpoint(value.checkpoint, authoritySetValue, value.signatures);
  if (value.checkpointHash !== expected.checkpointHash || value.checkpointHash !== expectedCheckpointHash ||
      !Number.isSafeInteger(now) || now < expected.checkpoint.issuedAt || now > expected.checkpoint.expiresAt) {
    throw new Error("wallet release checkpoint is untrusted, stale, or from the future");
  }
  return expected;
}
export function createWalletReleaseInclusionProof(storeValue, sequence) {
  const store = validateStore(storeValue);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > store.count) throw new Error("wallet release proof sequence is invalid");
  const record = store.records[sequence - 1]; const nodes = inclusionNodes(store.records.map((entry) => leaf(entry.recordHash)), sequence - 1);
  return { count: store.count, format: PROOF_FORMAT, nodes, record, sequence, version: 1 };
}
export function verifyWalletReleaseInclusionProof(value, checkpointValue) {
  exact(value, ["count", "format", "nodes", "record", "sequence", "version"], "wallet release inclusion proof");
  const checkpoint = checkpointValue.checkpoint ?? checkpointValue;
  if (value.format !== PROOF_FORMAT || value.version !== 1 || value.count !== checkpoint.count ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > value.count ||
      !Array.isArray(value.nodes) || value.nodes.length > MAX_PROOF_NODES || value.nodes.some((item) => !HASH.test(item ?? ""))) throw new Error("wallet release inclusion proof is invalid");
  exact(value.record, ["record", "recordHash"], "wallet release proof record");
  const record = recordPayload(value.record.record);
  if (record.sequence !== value.sequence || value.record.recordHash !== hashObject(record, "WALLET_RELEASE_RECORD_V1")) throw new Error("wallet release proof record is invalid");
  const cursor = { value: 0 }; const root = rebuildInclusion(leaf(value.record.recordHash), value.sequence - 1, value.count, value.nodes, cursor);
  if (cursor.value !== value.nodes.length || root !== checkpoint.merkleRoot) throw new Error("wallet release inclusion proof does not match checkpoint");
  return { record, recordHash: value.record.recordHash };
}
export function createWalletReleaseConsistencyProof(storeValue, oldCount) {
  const store = validateStore(storeValue);
  if (!Number.isSafeInteger(oldCount) || oldCount < 1 || oldCount > store.count) throw new Error("wallet release consistency range is invalid");
  const leaves = store.records.map((entry) => leaf(entry.recordHash));
  return { format: CONSISTENCY_FORMAT, newCount: store.count, newRoot: store.merkleRoot,
    nodes: consistencyNodes(leaves, oldCount), oldCount, oldRoot: merkleRoot(leaves.slice(0, oldCount)), version: 1 };
}
export function exportWalletReleaseGossipCheckpoint(signedCheckpoint) {
  exact(signedCheckpoint, ["checkpoint", "checkpointHash", "signatures"], "signed wallet release checkpoint");
  return { authoritySetId: signedCheckpoint.checkpoint.authoritySetId,
    checkpointHash: signedCheckpoint.checkpointHash, count: signedCheckpoint.checkpoint.count,
    expiresAt: signedCheckpoint.checkpoint.expiresAt, genesisHash: signedCheckpoint.checkpoint.genesisHash,
    headHash: signedCheckpoint.checkpoint.headHash,
    latestReleaseManifestHash: signedCheckpoint.checkpoint.latestReleaseManifestHash,
    merkleRoot: signedCheckpoint.checkpoint.merkleRoot, networkId: signedCheckpoint.checkpoint.networkId };
}

function gossipPayload(value) {
  exact(value, ["authoritySetId", "checkpointHash", "count", "expiresAt", "genesisHash",
    "headHash", "latestReleaseManifestHash", "merkleRoot", "networkId"],
  "wallet release gossip checkpoint");
  if (!PREFIXED.test(value.authoritySetId ?? "") || !HASH.test(value.checkpointHash ?? "") ||
      !Number.isSafeInteger(value.count) || value.count < 1 || value.count > MAX_RECORDS ||
      !Number.isSafeInteger(value.expiresAt) || !HASH.test(value.headHash ?? "") ||
      !HASH.test(value.merkleRoot ?? "") || !HASH.test(value.latestReleaseManifestHash ?? "") ||
      !/^(?:sha3-256:)?[0-9a-f]{64}$/.test(value.genesisHash ?? "") ||
      typeof value.networkId !== "string") throw new Error("wallet release gossip checkpoint is invalid");
  return structuredClone(value);
}

export function compareWalletReleaseGossipCheckpoints(leftValue, rightValue, consistencyProof = null) {
  const left = gossipPayload(leftValue); const right = gossipPayload(rightValue);
  if (left.networkId !== right.networkId || left.genesisHash !== right.genesisHash ||
      left.authoritySetId !== right.authoritySetId) throw new Error("wallet release gossip contexts are mixed");
  if (left.count === right.count) {
    if (left.merkleRoot !== right.merkleRoot || left.headHash !== right.headHash ||
        left.latestReleaseManifestHash !== right.latestReleaseManifestHash) {
      throw new Error("wallet release split-view checkpoint detected");
    }
    return { relation: "equal", trustedCount: left.count };
  }
  const [older, newer] = left.count < right.count ? [left, right] : [right, left];
  const proof = verifyWalletReleaseConsistencyProof(consistencyProof);
  if (proof.oldCount !== older.count || proof.newCount !== newer.count ||
      proof.oldRoot !== older.merkleRoot || proof.newRoot !== newer.merkleRoot) {
    throw new Error("wallet release gossip checkpoint lacks a matching consistency proof");
  }
  return { relation: "consistent-extension", trustedCount: newer.count };
}

export function verifyWalletReleaseTransparencyEvidence(verifiedExport, evidence, {
  expectedCheckpointHash, now,
}) {
  exact(evidence, ["checkpoint", "inclusionProof"], "wallet release transparency evidence");
  if (!verifiedExport?.authoritySet || !verifiedExport?.binding || !verifiedExport?.bundle) {
    throw new Error("verified wallet export context is required");
  }
  const checkpoint = verifyWalletReleaseCheckpoint(evidence.checkpoint,
    verifiedExport.authoritySet, { expectedCheckpointHash, now });
  const included = verifyWalletReleaseInclusionProof(evidence.inclusionProof, checkpoint);
  const binding = verifiedExport.binding; const record = included.record;
  if (record.bundleHash !== verifiedExport.bundle.bundleHash ||
      record.authoritySetId !== verifiedExport.authoritySet.setId ||
      record.networkId !== binding.networkId || record.genesisHash !== binding.genesisHash ||
      record.releaseManifestHash !== binding.releaseManifestHash ||
      record.releaseVersion !== binding.releaseVersion || record.sourceRevision !== binding.sourceRevision ||
      record.walletPackageHash !== binding.wallet.packageHash ||
      record.toolPackageHash !== binding.tool.packageHash) {
    throw new Error("wallet release transparency record does not match the portable export");
  }
  return { checkpoint, record, verified: true };
}

export const WALLET_RELEASE_TRANSPARENCY_LIMITS = Object.freeze({ maxProofNodes: MAX_PROOF_NODES,
  maxRecords: MAX_RECORDS });
