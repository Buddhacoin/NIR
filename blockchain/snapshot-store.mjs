import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseConsensusJson } from "./consensus-json.mjs";

import {
  MAX_SNAPSHOT_BYTES,
  restoreStateSnapshotWithHandoffs,
  verifyStateSnapshotWithHandoffs,
} from "./state-snapshot.mjs";

const PRIMARY = "STATE-SNAPSHOT.json";
const BACKUP = "STATE-SNAPSHOT.backup.json";

function serialized(value) {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents) > MAX_SNAPSHOT_BYTES) {
    throw new Error("serialized state snapshot is too large");
  }
  return contents;
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readCandidate(path, genesisConfig, trustAnchor) {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() ||
        statSync(path).size > MAX_SNAPSHOT_BYTES) return null;
    const snapshot = parseConsensusJson(readFileSync(path, "utf8"));
    const verified = verifyStateSnapshotWithHandoffs(snapshot, trustAnchor);
    const chain = restoreStateSnapshotWithHandoffs(genesisConfig, snapshot, trustAnchor);
    return { chain, contents: serialized(snapshot), snapshot, verified };
  } catch {
    return null;
  }
}

export function installStateSnapshot(directory, genesisConfig, snapshot, trustAnchor) {
  const root = resolve(directory);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error("state snapshot directory cannot be a symbolic link");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const verified = verifyStateSnapshotWithHandoffs(snapshot, trustAnchor);
  restoreStateSnapshotWithHandoffs(genesisConfig, snapshot, trustAnchor);
  const paths = [join(root, PRIMARY), join(root, BACKUP)];
  const existing = paths.map((path) => readCandidate(path, genesisConfig, trustAnchor))
    .filter(Boolean).sort((left, right) => right.verified.height - left.verified.height)[0];
  if (existing && existing.verified.height > verified.height) {
    throw new Error("state snapshot rollback is not allowed");
  }
  if (existing && existing.verified.height === verified.height &&
      existing.verified.snapshotHash !== verified.snapshotHash) {
    throw new Error("installed state snapshot conflicts at the same height");
  }
  const contents = serialized(snapshot);
  writeAtomic(paths[1], contents);
  writeAtomic(paths[0], contents);
  return { ...verified, directory: root };
}

export function loadInstalledStateSnapshot(directory, genesisConfig, trustAnchor) {
  const root = resolve(directory);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error("state snapshot directory cannot be a symbolic link");
  }
  const paths = [join(root, PRIMARY), join(root, BACKUP)];
  const candidates = paths.map((path) => readCandidate(path, genesisConfig, trustAnchor));
  const valid = candidates.filter(Boolean).sort((left, right) =>
    right.verified.height - left.verified.height);
  if (valid.length === 0) {
    if (paths.some(existsSync)) throw new Error("all installed state snapshot copies are invalid");
    return null;
  }
  if (valid.length === 2 && valid[0].verified.height === valid[1].verified.height &&
      valid[0].verified.snapshotHash !== valid[1].verified.snapshotHash) {
    throw new Error("installed state snapshot copies conflict");
  }
  const selected = valid[0];
  let recoveredCopies = 0;
  for (let index = 0; index < paths.length; index += 1) {
    if (!candidates[index] || candidates[index].contents !== selected.contents) {
      writeAtomic(paths[index], selected.contents);
      recoveredCopies += 1;
    }
  }
  return {
    chain: selected.chain,
    recoveredCopies,
    snapshot: structuredClone(selected.snapshot),
    verified: structuredClone(selected.verified),
  };
}
