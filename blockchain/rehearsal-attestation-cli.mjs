#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { readRestrictedPasswordFd } from "./operator-secret-input.mjs";
import {
  acceptRehearsalAttestationQuorum, createRehearsalStatement, serializeRehearsalAttestation,
  signRehearsalStatement, verifyProductionPreflightRehearsalInput,
} from "./rehearsal-attestation.mjs";
import { decryptWallet } from "./vault.mjs";

function readJson(path, maximum, privateFile = false) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure no-follow attestation input reads are unavailable");
  }
  const before = lstatSync(path); let descriptor;
  try {
    const uid = process.getuid?.();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 ||
        before.size > maximum || privateFile && (before.mode & 0o777) !== 0o600 ||
        !privateFile && (before.mode & 0o022) !== 0 || uid !== undefined && privateFile && before.uid !== uid) {
      throw new Error("attestation input file is unsafe");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor); const bytes = readFileSync(descriptor); const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size ||
        opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev ||
        opened.ino !== after.ino || opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error("attestation input changed during read");
    }
    const text = bytes.toString("utf8"); const canonicalText = text.endsWith("\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonicalText);
    if (canonicalJson(value) !== canonicalText) throw new Error("attestation input is not canonical JSON");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function integer(value, label) {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

try {
  const [command, ...args] = process.argv.slice(2); let output;
  if (command === "statement" && args.length === 5) {
    const [reportPath, setPath, runNonce, observedAt, expiresAt] = args;
    const set = readJson(setPath, 512 * 1024);
    output = createRehearsalStatement(readJson(reportPath, 8 * 1024 * 1024), {
      expiresAt: integer(expiresAt, "expiry"), observedAt: integer(observedAt, "observation time"),
      runNonce, setId: set.setId,
    });
  } else if (command === "sign" && args.length === 4) {
    const [statementPath, setPath, vaultPath, operatorId] = args;
    const descriptor = integer(process.env.NIR_REHEARSAL_PASSWORD_FD, "password descriptor");
    if (descriptor < 3 || descriptor > 255) throw new Error("password descriptor is invalid");
    delete process.env.NIR_REHEARSAL_PASSWORD_FD; let password;
    try {
      password = readRestrictedPasswordFd(descriptor, "rehearsal attestor vault");
      const wallet = decryptWallet(readJson(vaultPath, 16 * 1024 * 1024, true), password.toString("utf8"));
      output = signRehearsalStatement(readJson(statementPath, 64 * 1024), { operatorId, wallet },
        readJson(setPath, 512 * 1024));
    } finally { password?.fill(0); closeSync(descriptor); }
  } else if (command === "accept" && (args.length === 4 || args.length === 5)) {
    const [storePath, setPath, attestationsPath, now, skew = "0"] = args;
    output = acceptRehearsalAttestationQuorum(storePath,
      readJson(attestationsPath, 2 * 1024 * 1024), { maxFutureSkewMs: integer(skew, "future skew"),
        now: integer(now, "current time"), operatorSet: readJson(setPath, 512 * 1024) });
  } else if (command === "verify" && (args.length === 3 || args.length === 4)) {
    const [inputPath, setPath, now, skew = "0"] = args;
    output = verifyProductionPreflightRehearsalInput(readJson(inputPath, 4 * 1024 * 1024), {
      maxFutureSkewMs: integer(skew, "future skew"), now: integer(now, "current time"),
      operatorSet: readJson(setPath, 512 * 1024),
    });
  } else {
    throw new Error("usage: rehearsal-attestation <statement REPORT SET NONCE OBSERVED EXPIRES|sign STATEMENT SET VAULT OPERATOR|accept STORE SET ATTESTATIONS NOW [SKEW]|verify INPUT SET NOW [SKEW]>");
  }
  process.stdout.write(serializeRehearsalAttestation(output));
} catch {
  process.stderr.write("rehearsal attestation command failed\n"); process.exitCode = 1;
}
