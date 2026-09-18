#!/usr/bin/env node
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  createOfflineReleaseBundle, parseOfflineReleaseBundle, serializeOfflineReleaseApproval,
  parseOfflineReleaseApproval, serializeOfflineReleaseBundle, signOfflineReleaseBundle,
  verifyOfflineReleaseGitTree,
} from "./offline-release-bundle.mjs";
import { decryptWallet } from "./vault.mjs";

function readSecret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n");
      error ? reject(error) : resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") {
          value += character;
          if (Buffer.byteLength(value) > 1_024) return finish(new Error("secret input is too long"));
        }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

function privateGeneration(target) {
  const metadata = lstatSync(target);
  if (!metadata.isSymbolicLink() || metadata.nlink !== 1) return target;
  const link = readlinkSync(target);
  const escaped = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\.${escaped}\\.nir-private-[0-9a-f]{32}$`).test(link)) {
    throw new Error("release vault activation is invalid");
  }
  return join(dirname(target), link);
}

function readBounded(path, maximum, label, { privateFile = false } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("secure no-follow reads are unavailable");
  const target = resolve(path);
  const source = privateFile ? privateGeneration(target) : target;
  let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum ||
        (privateFile && (before.mode & 0o077) !== 0)) throw new Error(`${label} is unsafe`);
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const linked = lstatSync(source);
    if (contents.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed during read`);
    }
    return contents.toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, maximum, label, options) {
  try { return JSON.parse(readBounded(path, maximum, label, options)); }
  catch (error) {
    if (/unsafe|changed|no-follow|activation/.test(error.message)) throw error;
    throw new Error(`${label} is not valid JSON`);
  }
}

function writeExclusive(path, contents) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error("secure no-follow output creation is unavailable");
  }
  const target = resolve(path);
  const parent = dirname(target);
  const parentDescriptor = openSync(parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let descriptor;
  try {
    descriptor = openSync(target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, 0o644);
    fsyncSync(descriptor);
    fsyncSync(parentDescriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parentDescriptor);
  }
}

function verifyGitProvenance(rootValue, paths, sourceRevision) {
  const root = resolve(rootValue);
  const actual = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8", maxBuffer: 1024 * 1024,
  }).trim();
  if (actual !== sourceRevision) throw new Error("source revision does not match Git HEAD");
  const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (status !== "") throw new Error("tracked source tree is not clean");
  const tracked = new Set(execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean));
  if (!Array.isArray(paths) || paths.some((path) => !tracked.has(path))) {
    throw new Error("release allowlist contains an untracked source");
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "create" && (args.length === 7 || args.length === 8)) {
    const [root, pathsFile, releaseVersion, networkId, protocolText, sourceRevision, output,
      previous = "none"] = args;
    const paths = readJson(pathsFile, 2 * 1024 * 1024, "release path allowlist");
    verifyGitProvenance(root, paths, sourceRevision);
    const bundle = createOfflineReleaseBundle(root, paths, {
      networkId, previousBundleHash: previous === "none" ? null : previous,
      protocolVersion: Number(protocolText), releaseVersion, sourceRevision,
    });
    verifyOfflineReleaseGitTree(root, bundle, sourceRevision);
    writeExclusive(output, serializeOfflineReleaseBundle(bundle));
    console.log(`Offline release bundle ${bundle.bundleHash} created for ${bundle.manifest.files.length} files.`);
  } else if (command === "sign" && args.length === 3) {
    const [bundlePath, vaultPath, output] = args;
    const bundle = parseOfflineReleaseBundle(readBounded(bundlePath, 192 * 1024 * 1024, "release bundle"));
    const password = await readSecret("Release vault password: ");
    const vault = readJson(vaultPath, 64 * 1024, "release vault", { privateFile: true });
    const wallet = decryptWallet(vault, password);
    try {
      const approval = signOfflineReleaseBundle(bundle, wallet);
      writeExclusive(output, serializeOfflineReleaseApproval(bundle, approval));
      console.log(`Offline release bundle approved by ${wallet.address}.`);
    } finally {
      wallet.privateKey = "";
    }
  } else if (command === "verify" && args.length === 8) {
    const [bundlePath, approvalPath, trustedAddress, releaseVersion, networkId,
      protocolText, previous, expectedHash] = args;
    const bundle = parseOfflineReleaseBundle(readBounded(bundlePath, 192 * 1024 * 1024, "release bundle"));
    if (bundle.bundleHash !== expectedHash) throw new Error("release bundle hash is not the expected hash");
    parseOfflineReleaseApproval(readBounded(approvalPath, 32 * 1024, "release approval"), bundle, {
      networkId, previousBundleHash: previous === "none" ? null : previous,
      protocolVersion: Number(protocolText), releaseVersion, trustedAddress,
    });
    console.log(`Offline release bundle ${bundle.bundleHash} verified.`);
  } else {
    throw new Error("usage: offline-release create <root> <paths.json> <version> <network> <protocol> <revision> <new-bundle> [previous-bundle-hash|none] | offline-release sign <bundle> <release-vault> <new-approval> | offline-release verify <bundle> <approval> <trusted-address> <version> <network> <protocol> <previous-hash|none> <expected-bundle-hash>");
  }
} catch (error) {
  console.error(`Offline release operation failed: ${error.message}`);
  process.exitCode = 1;
}
