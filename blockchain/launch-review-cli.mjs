#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import process from "node:process";

import { parseConsensusJson } from "./consensus-json.mjs";
import { createLaunchReview, signLaunchReview, verifyLaunchReview } from "./launch-review.mjs";
import { readRestrictedPasswordFd } from "./operator-secret-input.mjs";
import { decryptWallet } from "./vault.mjs";

function readJson(path, maximum, privateFile = false) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure launch review input reads are unavailable");
  }
  const before = lstatSync(path); let descriptor;
  try {
    const uid = process.getuid?.();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 ||
        before.size > maximum || privateFile && ((before.mode & 0o777) !== 0o600 ||
        uid !== undefined && before.uid !== uid) || !privateFile && (before.mode & 0o022) !== 0) {
      throw new Error("launch review input file is unsafe");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor); const bytes = readFileSync(descriptor); const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size ||
        opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev ||
        opened.ino !== after.ino || opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error("launch review input changed during read");
    }
    return parseConsensusJson(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function password() {
  const descriptor = Number(process.env.NIR_LAUNCH_REVIEW_PASSWORD_FD);
  delete process.env.NIR_LAUNCH_REVIEW_PASSWORD_FD;
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
    throw new Error("launch review password descriptor is invalid");
  }
  try { return readRestrictedPasswordFd(descriptor, "launch review vault"); }
  finally { closeSync(descriptor); }
}

try {
  const [command, ...args] = process.argv.slice(2); let output;
  if (command === "create" && args.length === 1) {
    output = createLaunchReview(readJson(args[0], 2 * 1024 * 1024));
  } else if (command === "sign" && args.length === 3) {
    const [reviewPath, vaultPath, reviewerId] = args; let secret; let wallet;
    try {
      secret = password();
      wallet = decryptWallet(readJson(vaultPath, 16 * 1024 * 1024, true), secret.toString("utf8"));
      output = signLaunchReview(readJson(reviewPath, 2 * 1024 * 1024), wallet, reviewerId);
    } finally { secret?.fill(0); if (wallet) wallet.privateKey = ""; }
  } else if (command === "verify" && args.length === 3) {
    const [reviewPath, networkId, now] = args;
    output = verifyLaunchReview(readJson(reviewPath, 2 * 1024 * 1024), {
      expectedNetworkId: networkId, now: Number(now),
    });
  } else {
    throw new Error("usage: launch-review <create INPUT|sign REVIEW VAULT REVIEWER_ID|verify REVIEW NETWORK_ID NOW_MS>");
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch {
  process.stderr.write("launch review command failed\n"); process.exitCode = 1;
}
