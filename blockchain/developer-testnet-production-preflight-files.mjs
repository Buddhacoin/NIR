import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

import { canonicalJson } from "./crypto.mjs";
import { runDeveloperTestnetPreflightWithContext } from "./developer-testnet-preflight.mjs";
import { evaluateDeveloperTestnetProductionPreflight } from "./developer-testnet-production-preflight.mjs";
import { exportRehearsalAttestationStoreTranscript } from "./rehearsal-attestation.mjs";

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function readPublicJson(path, maximumBytes, kind, options) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure production preflight reads are unavailable");
  }
  const before = lstatSync(path); let descriptor;
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 ||
        before.size > maximumBytes || (before.mode & 0o022) !== 0) {
      throw new Error("production preflight artifact is unsafe");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !same(opened, before)) {
      throw new Error("production preflight artifact changed during open");
    }
    options._afterFileOpen?.({ descriptor, kind, path });
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (bytes.length !== opened.size || !same(opened, after) || !same(opened, linked) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs) throw new Error("production preflight artifact changed during read");
    const text = bytes.toString("utf8"); const canonical = text.endsWith("\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("production preflight artifact is not canonical JSON");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function runDeveloperTestnetProductionPreflightFromFiles({
  attestationInputPath, attestationStorePath, developerRoot, drillPlanPath,
  maxFutureSkewMs = 0, now, operatorSetPath,
}, options = {}) {
  const { context, report } = runDeveloperTestnetPreflightWithContext(developerRoot,
    options.developerOptions ?? {});
  const attempt = (operation) => { try { return operation(); } catch { return null; } };
  const drillPlan = attempt(() => readPublicJson(drillPlanPath, 4 * 1024 * 1024,
    "drill-plan", options));
  const attestationInput = attempt(() => readPublicJson(attestationInputPath, 8 * 1024 * 1024,
    "attestation-input", options));
  const operatorSet = attempt(() => readPublicJson(operatorSetPath, 512 * 1024,
    "operator-set", options));
  const attestationStoreTranscript = attempt(() =>
    exportRehearsalAttestationStoreTranscript(attestationStorePath));
  return evaluateDeveloperTestnetProductionPreflight({ attestationInput,
    attestationStoreTranscript, developerReport: report, drillPlan, expectedContext: context,
    maxFutureSkewMs, now, operatorSet });
}
