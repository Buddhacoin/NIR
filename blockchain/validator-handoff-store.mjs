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

import { advanceValidatorTrust, verifyValidatorHandoff } from "./validator-handoff.mjs";

const PRIMARY = "VALIDATOR-HANDOFFS.json";
const BACKUP = "VALIDATOR-HANDOFFS.backup.json";
const MAX_HANDOFF_STORE_BYTES = 16 * 1024 * 1024;

function serialized(value) {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents) > MAX_HANDOFF_STORE_BYTES) {
    throw new Error("validator handoff store is too large");
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

function readCandidate(path, trustAnchor) {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() ||
        statSync(path).size > MAX_HANDOFF_STORE_BYTES) return null;
    const handoffs = JSON.parse(readFileSync(path, "utf8"));
    const verified = advanceValidatorTrust({ ...trustAnchor, handoffs });
    return { contents: serialized(handoffs), handoffs, verified };
  } catch {
    return null;
  }
}

export function loadValidatorHandoffs(directory, trustAnchor) {
  const root = resolve(directory);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error("validator handoff directory cannot be a symbolic link");
  }
  const paths = [join(root, PRIMARY), join(root, BACKUP)];
  const candidates = paths.map((path) => readCandidate(path, trustAnchor));
  const valid = candidates.filter(Boolean).sort((left, right) =>
    right.handoffs.length - left.handoffs.length);
  if (valid.length === 0) {
    if (paths.some(existsSync)) throw new Error("all validator handoff store copies are invalid");
    return { handoffs: [], recoveredCopies: 0, trustedValidators: trustAnchor.trustedValidators };
  }
  if (valid.length === 2) {
    const shorter = valid[1].handoffs;
    const longerPrefix = valid[0].handoffs.slice(0, shorter.length);
    if (JSON.stringify(shorter) !== JSON.stringify(longerPrefix)) {
      throw new Error("validator handoff store copies conflict");
    }
  }
  const selected = valid[0];
  let recoveredCopies = 0;
  for (let index = 0; index < paths.length; index += 1) {
    if (!candidates[index] || candidates[index].contents !== selected.contents) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeAtomic(paths[index], selected.contents);
      recoveredCopies += 1;
    }
  }
  return {
    handoffs: structuredClone(selected.handoffs),
    lastHandoff: structuredClone(selected.verified.lastHandoff),
    recoveredCopies,
    trustedValidators: structuredClone(selected.verified.trustedValidators),
  };
}

export function installValidatorHandoff(directory, handoff, trustAnchor) {
  const root = resolve(directory);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error("validator handoff directory cannot be a symbolic link");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const current = loadValidatorHandoffs(root, trustAnchor);
  const lastHeight = current.lastHandoff?.activationHeight ?? 0;
  const verified = verifyValidatorHandoff(handoff, {
    expectedNetworkId: trustAnchor.expectedNetworkId,
    minimumActivationHeight: lastHeight + 1,
    trustedValidators: current.trustedValidators,
  });
  const handoffs = [...current.handoffs, structuredClone(handoff)];
  const contents = serialized(handoffs);
  writeAtomic(join(root, BACKUP), contents);
  writeAtomic(join(root, PRIMARY), contents);
  return { ...verified, handoffs: handoffs.length };
}
