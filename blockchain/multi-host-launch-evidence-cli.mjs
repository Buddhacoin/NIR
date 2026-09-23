#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseConsensusJson } from "./consensus-json.mjs";

import {
  collectMultiHostLaunchEvidence,
  serializeMultiHostLaunchEvidence,
  verifyMultiHostLaunchEvidencePackage,
} from "./multi-host-launch-evidence.mjs";

function readJson(path, maximum = 2 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum) {
      throw new Error("input is not a bounded single-link file");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) throw new Error("input changed during read");
    return parseConsensusJson(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function writeExclusive(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, serializeMultiHostLaunchEvidence(value));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "collect") {
    const [planPath, receiptsPath, outputPath, nowText] = args;
    if (!planPath || !receiptsPath || !outputPath) throw new Error("usage: collect PLAN RECEIPTS OUTPUT [NOW_MS]");
    const now = nowText === undefined ? Date.now() : Number(nowText);
    const value = await collectMultiHostLaunchEvidence(readJson(planPath), readJson(receiptsPath), { now });
    writeExclusive(outputPath, value);
    console.log(JSON.stringify({ packageHash: value.packageHash, status: "COLLECTED" }));
  } else if (command === "verify") {
    const [packagePath, planHash, runNonce, nowText, localFlag] = args;
    if (!packagePath || !planHash || !runNonce || !nowText) {
      throw new Error("usage: verify PACKAGE EXPECTED_PLAN_HASH EXPECTED_RUN_NONCE NOW_MS");
    }
    console.log(JSON.stringify(verifyMultiHostLaunchEvidencePackage(readJson(packagePath), {
      allowInsecureLocalhost: localFlag === "--allow-insecure-localhost",
      expectedPlanHash: planHash, expectedRunNonce: runNonce, now: Number(nowText),
    })));
  } else throw new Error("usage: multi-host-launch-evidence <collect|verify> ...");
} catch (error) {
  console.error(`Multi-host launch evidence failed: ${error.message}`);
  process.exitCode = 1;
}
