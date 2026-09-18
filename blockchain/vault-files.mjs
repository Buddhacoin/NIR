import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { generateWallet } from "./crypto.mjs";
import {
  createMultisigRecoveryManifest,
  decryptWallet,
  encryptWallet,
} from "./vault.mjs";

const VAULT_FILENAMES = ["guardian-1.nirvault.json", "guardian-2.nirvault.json", "guardian-3.nirvault.json"];
const READY_FILENAME = "RECOVERY-READY";
const NETWORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generationPattern(target) {
  return new RegExp(`^\\.${escapeRegex(basename(target))}\\.nir-recovery-[0-9a-f]{32}$`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function openDirectory(path, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error(`${label} requires secure no-follow directory support`);
  }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !sameIdentity(before, opened)) {
    closeSync(descriptor);
    throw new Error(`${label} changed during open`);
  }
  return { descriptor, metadata: opened };
}

function assertDirectoryIdentity(path, opened, label, requireStableMetadata = false) {
  const current = lstatSync(path);
  const descriptor = fstatSync(opened.descriptor);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      !sameIdentity(current, opened.metadata) || !sameIdentity(descriptor, opened.metadata) ||
      descriptor.mode !== opened.metadata.mode || descriptor.uid !== opened.metadata.uid ||
      (requireStableMetadata && (descriptor.mtimeMs !== opened.metadata.mtimeMs ||
        descriptor.ctimeMs !== opened.metadata.ctimeMs))) {
    throw new Error(`${label} changed during operation`);
  }
}

function readPrivateJson(path, label, maximum = 64 * 1024, expectedUid) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} requires no-follow support`);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 2 || opened.size > maximum ||
        (opened.mode & 0o777) !== 0o600 ||
        (expectedUid !== undefined && opened.uid !== expectedUid)) throw new Error(`${label} is unsafe`);
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (!sameIdentity(opened, after) || !sameIdentity(opened, linked) ||
        opened.size !== contents.length || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs || opened.mode !== after.mode) {
      throw new Error(`${label} changed during read`);
    }
    return JSON.parse(contents.toString("utf8"));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExclusiveJson(path, value, mode) {
  const descriptor = openSync(path, "wx", mode);
  try {
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertPasswords(passwords) {
  if (
    !Array.isArray(passwords) || passwords.length !== 3 ||
    passwords.some((password) => typeof password !== "string" || password.length < 16) ||
    new Set(passwords).size !== passwords.length
  ) throw new Error("three distinct passwords of at least 16 characters are required");
}

export function createVaultSet({
  directory, passwords, threshold = 2, label = "NIR founder vault", networkId, generation = 1,
  onBeforeActivate,
}) {
  assertPasswords(passwords);
  if (threshold !== 2 || !NETWORK_ID.test(networkId ?? "") ||
      !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("recovery set requires 2-of-3, an exact network, and a positive generation");
  }
  const target = resolve(directory);
  const parent = dirname(target);
  const parentOpened = openDirectory(parent, "recovery parent");
  const staging = join(parent,
    `.${basename(target)}.nir-recovery-${randomBytes(16).toString("hex")}`);
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);
  const stagingIdentity = lstatSync(staging);
  let activatedIdentity = null;
  const vaults = passwords.map((password, index) => {
    const wallet = generateWallet();
    try {
      return encryptWallet(wallet, password, { label: `${label} / guardian ${index + 1}` });
    } finally {
      wallet.privateKey = "";
    }
  });
  const manifest = {
    ...createMultisigRecoveryManifest({ vaults, threshold, label }),
    files: VAULT_FILENAMES.map((file, index) => ({ address: vaults[index].address, file })),
    generation,
    networkId,
  };
  try {
    vaults.forEach((vault, index) => writeExclusiveJson(join(staging, VAULT_FILENAMES[index]), vault, 0o600));
    writeExclusiveJson(join(staging, "recovery-manifest.json"), manifest, 0o600);
    writeExclusiveJson(join(staging, READY_FILENAME), {
      format: "nir-recovery-ready-v1", generation, networkId,
    }, 0o600);

    // Fail before publishing the set if any freshly written backup cannot decrypt.
    vaults.forEach((vault, index) => {
      const restored = decryptWallet(
        readPrivateJson(join(staging, VAULT_FILENAMES[index]), "fresh recovery vault"),
        passwords[index],
      );
      if (restored.address !== vault.address) throw new Error("fresh vault verification failed");
      restored.privateKey = "";
    });
    const stagingOpened = openDirectory(staging, "recovery generation");
    try {
      fsyncSync(stagingOpened.descriptor);
      assertDirectoryIdentity(parent, parentOpened, "recovery parent");
      assertDirectoryIdentity(staging, stagingOpened, "recovery generation", true);
    if (onBeforeActivate !== undefined) {
      if (typeof onBeforeActivate !== "function") throw new Error("recovery activation hook is invalid");
        onBeforeActivate({ generation: staging, target });
    }
      assertDirectoryIdentity(parent, parentOpened, "recovery parent");
      assertDirectoryIdentity(staging, stagingOpened, "recovery generation", true);
      const activatedLink = basename(staging);
      if (!generationPattern(target).test(activatedLink)) {
        throw new Error("recovery generation name is invalid");
      }
      // A relative symlink is the portable no-replace activation primitive.
      symlinkSync(activatedLink, target, "dir");
      activatedIdentity = lstatSync(target);
      if (!activatedIdentity.isSymbolicLink() || readlinkSync(target) !== activatedLink) {
        throw new Error("recovery activation is inconsistent");
      }
      fsyncSync(parentOpened.descriptor);
      const current = lstatSync(target);
      if (!current.isSymbolicLink() || !sameIdentity(current, activatedIdentity) ||
          readlinkSync(target) !== activatedLink) throw new Error("recovery activation changed");
    } finally {
      closeSync(stagingOpened.descriptor);
    }
    return manifest;
  } catch (error) {
    if (activatedIdentity !== null) {
      try {
        const current = lstatSync(target);
        if (current.isSymbolicLink() && sameIdentity(current, activatedIdentity) &&
            readlinkSync(target) === basename(staging)) unlinkSync(target);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.activationCleanupError = cleanupError.message;
      }
    }
    try {
      const current = lstatSync(staging);
      if (current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, stagingIdentity)) {
        rmSync(staging, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.generationCleanupError = cleanupError.message;
    }
    throw error;
  } finally {
    closeSync(parentOpened.descriptor);
  }
}

export function verifyVaultSet({ directory, passwords, networkId, minimumGeneration }) {
  assertPasswords(passwords);
  const target = resolve(directory);
  const activation = lstatSync(target);
  if (!activation.isSymbolicLink() || activation.nlink !== 1) {
    throw new Error("recovery activation is not a unique symbolic link");
  }
  const generationName = readlinkSync(target);
  if (!generationPattern(target).test(generationName)) {
    throw new Error("recovery activation target is invalid");
  }
  const generationPath = join(dirname(target), generationName);
  const root = openDirectory(generationPath, "recovery generation");
  if ((root.metadata.mode & 0o777) !== 0o700 ||
      root.metadata.uid !== lstatSync(dirname(target)).uid) {
    closeSync(root.descriptor);
    throw new Error("recovery generation owner or mode is unsafe");
  }
  try {
  const expectedEntries = [...VAULT_FILENAMES, "recovery-manifest.json", READY_FILENAME].sort();
  if (readdirSync(generationPath).sort().join("\0") !== expectedEntries.join("\0")) {
    throw new Error("recovery directory is incomplete or contains unknown files");
  }
  const ready = readPrivateJson(join(generationPath, READY_FILENAME),
    "recovery activation marker", 1_024, root.metadata.uid);
  if (Object.keys(ready ?? {}).sort().join("\0") !== ["format", "generation", "networkId"].sort().join("\0") ||
      ready.format !== "nir-recovery-ready-v1" || ready.networkId !== networkId ||
      !Number.isSafeInteger(ready.generation) || ready.generation < minimumGeneration) {
    throw new Error("recovery activation marker is invalid");
  }
  const manifest = readPrivateJson(join(generationPath, "recovery-manifest.json"),
    "recovery manifest", 64 * 1024, root.metadata.uid);
  const listedFiles = manifest.files?.map(({ file }) => file);
  if (
    Object.keys(manifest ?? {}).sort().join("\0") !==
      ["address", "algorithm", "files", "generation", "label", "members", "networkId", "threshold", "version"].sort().join("\0") ||
    !Array.isArray(listedFiles) || listedFiles.length !== VAULT_FILENAMES.length ||
    manifest.files.some((entry) => Object.keys(entry ?? {}).sort().join("\0") !== "address\0file" ||
      !/^nir1[0-9a-f]{64}$/.test(entry.address ?? "")) ||
    !VAULT_FILENAMES.every((file) => listedFiles.includes(file)) ||
    new Set(listedFiles).size !== listedFiles.length || manifest.threshold !== 2 ||
    manifest.algorithm !== "ml-dsa-65-multisig" || manifest.version !== 1 ||
    manifest.networkId !== networkId || !Number.isSafeInteger(manifest.generation) ||
    !Number.isSafeInteger(minimumGeneration) || manifest.generation < minimumGeneration
  ) throw new Error("recovery manifest contains an invalid vault file set");
  const vaults = manifest.files.map(({ file, address }) => {
    const vault = readPrivateJson(join(generationPath, file),
      "recovery vault file", 64 * 1024, root.metadata.uid);
    if (vault.address !== address) throw new Error("recovery vault address is invalid");
    return vault;
  });
  vaults.forEach((vault, index) => {
    const restored = decryptWallet(vault, passwords[index]);
    restored.privateKey = "";
  });
  const expected = createMultisigRecoveryManifest({
    vaults,
    threshold: manifest.threshold,
    label: manifest.label,
  });
  if (
    expected.address !== manifest.address ||
    JSON.stringify(expected.members) !== JSON.stringify(manifest.members)
  ) throw new Error("vault set does not match its recovery manifest");
  assertDirectoryIdentity(generationPath, root, "recovery generation", true);
  const currentActivation = lstatSync(target);
  if (!currentActivation.isSymbolicLink() || !sameIdentity(currentActivation, activation) ||
      readlinkSync(target) !== generationName) throw new Error("recovery activation changed during verification");
  return {
    address: manifest.address, generation: manifest.generation,
    networkId: manifest.networkId, threshold: manifest.threshold, verified: true,
  };
  } finally {
    closeSync(root.descriptor);
  }
}
