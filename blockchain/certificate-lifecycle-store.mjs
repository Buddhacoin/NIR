import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseConsensusJson } from "./consensus-json.mjs";
import {
  certificateRecordHash,
  MAX_CERTIFICATE_RECORDS,
  verifyCertificateHistory,
  verifyCertificateRecord,
} from "./certificate-lifecycle.mjs";

const PRIMARY = "NETWORK-CERTIFICATES.json";
const BACKUP = "NETWORK-CERTIFICATES.backup.json";
export const MAX_CERTIFICATE_STORE_BYTES = 4 * 1024 * 1024;

function serialized(history) {
  const contents = `${JSON.stringify(history)}\n`;
  if (Buffer.byteLength(contents) > MAX_CERTIFICATE_STORE_BYTES) {
    throw new Error("certificate lifecycle store is too large");
  }
  return contents;
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function atomicWrite(path, contents) {
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

function readCopy(path, context) {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() ||
        statSync(path).size > MAX_CERTIFICATE_STORE_BYTES) return null;
    const history = parseConsensusJson(readFileSync(path, "utf8"));
    if (!Array.isArray(history) || history.length > MAX_CERTIFICATE_RECORDS) return null;
    const verified = verifyCertificateHistory(history, context);
    return { contents: serialized(verified), history: verified };
  } catch {
    return null;
  }
}

export function loadCertificateHistory(directory, context) {
  const root = resolve(directory);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error("certificate lifecycle directory cannot be a symbolic link");
  }
  const paths = [join(root, PRIMARY), join(root, BACKUP)];
  const copies = paths.map((path) => readCopy(path, context));
  const valid = copies.filter(Boolean).sort((left, right) =>
    right.history.length - left.history.length);
  if (valid.length === 0) {
    if (paths.some(existsSync)) throw new Error("all certificate lifecycle copies are invalid");
    return { history: [], recoveredCopies: 0 };
  }
  if (valid.length === 2) {
    const shorter = valid[1].history;
    const prefix = valid[0].history.slice(0, shorter.length);
    if (serialized(shorter) !== serialized(prefix)) {
      throw new Error("certificate lifecycle store copies conflict");
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let recoveredCopies = 0;
  for (let index = 0; index < paths.length; index += 1) {
    if (!copies[index] || copies[index].contents !== valid[0].contents) {
      atomicWrite(paths[index], valid[0].contents);
      recoveredCopies += 1;
    }
  }
  return { history: structuredClone(valid[0].history), recoveredCopies };
}

export function installCertificateRecord(directory, record, context) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const current = loadCertificateHistory(root, context);
  if (current.history.some((entry) => entry.recordHash === record?.recordHash)) {
    return { ...current, status: "known" };
  }
  const verified = verifyCertificateRecord(record, { ...context, history: current.history });
  const history = [...current.history, verified];
  const contents = serialized(history);
  atomicWrite(join(root, BACKUP), contents);
  atomicWrite(join(root, PRIMARY), contents);
  return { history, recoveredCopies: 0, status: "installed" };
}

export function certificateStorePaths(directory) {
  const root = resolve(directory);
  return { backup: join(root, BACKUP), primary: join(root, PRIMARY) };
}
