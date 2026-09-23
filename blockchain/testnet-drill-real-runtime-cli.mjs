#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

import { canonicalJson } from "./crypto.mjs";
import { runRealBeaconArchiveRehearsal } from "./testnet-drill-real-services.mjs";
import { runRealValidatorRecoveryRehearsal } from "./testnet-drill-real-runtime.mjs";

function readReleaseEvidence(path) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure no-follow release evidence reads are unavailable");
  }
  const before = lstatSync(path); let descriptor;
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 2 || before.size > 8 * 1024 * 1024) {
      throw new Error("release evidence file is unsafe or too large");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor); const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || contents.length !== opened.size ||
        opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== after.dev ||
        opened.ino !== after.ino || opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs) throw new Error("release evidence changed during read");
    const text = contents.toString("utf8"); const canonical = text.endsWith("\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("release evidence is not canonical JSON");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

try {
  const [command, releaseEvidencePath, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || command !== undefined && command !== "services" ||
      command === "services" && releaseEvidencePath === undefined) {
    throw new Error("usage: testnet-drill-real-runtime [services RELEASE_EVIDENCE_JSON]");
  }
  const result = command === "services"
    ? await runRealBeaconArchiveRehearsal({ releaseEvidence: readReleaseEvidence(releaseEvidencePath) })
    : await runRealValidatorRecoveryRehearsal();
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  const cleanup = error.cleanupReport ? ` cleanup=${JSON.stringify(error.cleanupReport)}` : "";
  const runtime = error.code === "ERR_RUNTIME_UNAVAILABLE"
    ? ` inventory=${JSON.stringify(error.runtimeInventory)}` : "";
  process.stderr.write(`real validator recovery rehearsal failed:${error.code ?? "ERR_REHEARSAL"}${runtime}${cleanup}\n`);
  process.exitCode = 1;
}
