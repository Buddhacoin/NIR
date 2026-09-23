#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import process from "node:process";

import { parseConsensusJson } from "./consensus-json.mjs";
import { createLaunchEvidenceSidecar } from "./launch-evidence-sidecar.mjs";
import { readRestrictedPasswordFd } from "./operator-secret-input.mjs";
import { decryptWallet } from "./vault.mjs";

function readJson(path, maximum, { privateFile = false } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure launch evidence input reads are unavailable");
  }
  const before = lstatSync(path); let descriptor;
  try {
    const uid = process.getuid?.();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 ||
        before.size > maximum || privateFile && ((before.mode & 0o777) !== 0o600 ||
        uid !== undefined && before.uid !== uid) || !privateFile && (before.mode & 0o022) !== 0) {
      throw new Error("launch evidence input file is unsafe");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor); const bytes = readFileSync(descriptor); const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size ||
        opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev ||
        opened.ino !== after.ino || opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error("launch evidence input changed during read");
    }
    return parseConsensusJson(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function passwordFromEnvironment() {
  const text = process.env.NIR_LAUNCH_EVIDENCE_PASSWORD_FD;
  delete process.env.NIR_LAUNCH_EVIDENCE_PASSWORD_FD;
  const descriptor = Number(text);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
    throw new Error("launch evidence password descriptor is invalid");
  }
  try { return readRestrictedPasswordFd(descriptor, "launch evidence vault"); }
  finally { closeSync(descriptor); }
}

function port(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("launch evidence port is invalid");
  }
  return parsed;
}

function listen(server, value) {
  return new Promise((resolve, reject) => {
    const fail = (error) => { server.off("listening", succeed); reject(error); };
    const succeed = () => { server.off("error", fail); resolve(); };
    server.once("error", fail); server.once("listening", succeed);
    server.listen(value, "127.0.0.1");
  });
}

async function main() {
  const args = process.argv.slice(2);
  const localOnly = args.at(-1) === "--allow-insecure-localhost";
  if (localOnly) args.pop();
  if (args.length !== 4) {
    throw new Error("usage: launch-evidence:sidecar PLAN RECEIPT VAULT PORT [--allow-insecure-localhost]");
  }
  const [planPath, receiptPath, vaultPath, portText] = args;
  let password;
  try {
    password = passwordFromEnvironment();
    const wallet = decryptWallet(readJson(vaultPath, 16 * 1024 * 1024, { privateFile: true }),
      password.toString("utf8"));
    const server = createLaunchEvidenceSidecar({ plan: readJson(planPath, 2 * 1024 * 1024),
      receipt: readJson(receiptPath, 2 * 1024 * 1024), wallet }, { allowInsecureLocalhost: localOnly });
    await listen(server, port(portText));
    process.stdout.write(`NIR launch-evidence sidecar listening on 127.0.0.1:${portText}\n`);
    const shutdown = () => server.close(() => process.exit(0));
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  } finally { password?.fill(0); }
}

main().catch(() => {
  process.stderr.write("launch evidence sidecar failed to start\n"); process.exitCode = 1;
});
