import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync,
  readlinkSync } from "node:fs";

import { addressFromPublicKey, hashObject } from "./crypto.mjs";

const NETWORK_ID = "nir-local-rehearsal";
const MAX_BACKUP_BYTES = 64 * 1024;

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function backupSnapshot(path, expectedAddress, exported = false) {
  const target = resolve(path);
  const activation = lstatSync(target);
  let source = target;
  let link;
  if (activation.isSymbolicLink()) {
    if (exported || activation.nlink !== 1) throw new Error("exported backup must be a regular file");
    link = readlinkSync(target);
    const escaped = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^\\.${escaped}\\.nir-private-[0-9a-f]{32}$`).test(link)) {
      throw new Error("wallet backup activation is unsafe");
    }
    source = join(dirname(target), link);
  }
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_BACKUP_BYTES ||
        (!exported && ((before.mode & 0o077) !== 0 ||
          before.uid !== lstatSync(dirname(source)).uid))) {
      throw new Error("recovery backup is not a bounded private file");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("recovery backup changed while read");
    }
    const linked = lstatSync(source);
    const current = lstatSync(target);
    if (!linked.isFile() || linked.isSymbolicLink() ||
        linked.dev !== before.dev || linked.ino !== before.ino ||
        activation.dev !== current.dev || activation.ino !== current.ino ||
        (link !== undefined && (!current.isSymbolicLink() || readlinkSync(target) !== link))) {
      throw new Error("recovery backup activation changed while read");
    }
    const backup = JSON.parse(bytes.toString("utf8"));
    if (!exactKeys(backup, ["address", "format", "generation", "networkId", "protection",
      "vault", "vaultHash", "version"]) ||
        backup.format !== "nir-wallet-recovery-backup-v2" || backup.version !== 2 ||
        backup.protection !== "independent-recovery-code" ||
        backup.networkId !== NETWORK_ID || backup.address !== expectedAddress ||
        !Number.isSafeInteger(backup.generation) || backup.generation < 1 ||
        hashObject(backup.vault, "WALLET_RECOVERY_VAULT") !== backup.vaultHash ||
        addressFromPublicKey(backup.vault?.publicKey) !== expectedAddress) {
      throw new Error("recovery backup network, address, or integrity mismatch");
    }
    return { fingerprint: createHash("sha256").update(bytes).digest("hex"),
      unsafePermissions: exported && (before.mode & 0o077) !== 0 };
  } finally { closeSync(fd); }
}

export function recoveryBackupFingerprint(path, expectedAddress) {
  return backupSnapshot(path, expectedAddress).fingerprint;
}

export function verifyRecoveryExportReceipt(receipt, sourcePath, fingerprint, expectedAddress) {
  if (receipt?.backupExported !== true || typeof receipt.backupPath !== "string" ||
      !receipt.backupPath.startsWith("/") || resolve(receipt.backupPath) === resolve(sourcePath)) {
    throw new Error("encrypted backup export was not verified");
  }
  const source = backupSnapshot(sourcePath, expectedAddress);
  const destination = backupSnapshot(receipt.backupPath, expectedAddress, true);
  if (source.fingerprint !== fingerprint || destination.fingerprint !== fingerprint) {
    throw new Error("encrypted backup changed during export");
  }
  return { verified: true, unsafePermissions: destination.unsafePermissions };
}
