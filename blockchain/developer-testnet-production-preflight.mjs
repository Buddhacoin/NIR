import { createHash } from "node:crypto";

import { canonicalJson } from "./crypto.mjs";
import { validateDeveloperTestnetPreflightReport } from "./developer-testnet-preflight.mjs";
import {
  validateRehearsalAttestorSet, verifyProductionPreflightRehearsalInput,
  verifyRehearsalAttestationStoreTranscript,
} from "./rehearsal-attestation.mjs";
import { validateTestnetPartitionDrillPlan } from "./testnet-partition-drill.mjs";

const FORMAT = "nir-developer-testnet-production-preflight-report-v1";
const HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/;
const DETAILS = Object.freeze({
  "developer-preflight": ["reportHash"],
  "drill-plan": ["planHash"],
  "durable-attestation-head": ["count", "recordHash", "transcriptHash"],
  "external-operator-attestation": ["operators", "packageHash", "runNonce"],
  "production-context-binding": ["genesisHash", "releaseCheckpointHash", "tipHash"],
});

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}
function digest(value) { return createHash("sha3-256").update(canonicalJson(value)).digest("hex"); }
function passedDetails(report, id) {
  const check = report.checks.find((entry) => entry.id === id);
  return check?.status === "PASS" ? check.details : null;
}

export function evaluateDeveloperTestnetProductionPreflight({
  attestationInput: inputValue, attestationStoreTranscript: transcriptValue,
  developerReport: developerValue,
  drillPlan: planValue, expectedContext, maxFutureSkewMs = 0, now,
  operatorSet: operatorSetValue,
}) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxFutureSkewMs) ||
      maxFutureSkewMs < 0 || maxFutureSkewMs > 300_000) throw new Error("production preflight time is invalid");
  let trustedContext = null;
  try {
    exact(expectedContext, ["finalizedTip", "genesisHash", "releaseManifestHash"],
      "production preflight expected context");
    if (![expectedContext.finalizedTip, expectedContext.genesisHash,
      expectedContext.releaseManifestHash].every((value) => HASH.test(value ?? ""))) {
      throw new Error("production preflight expected context is invalid");
    }
    trustedContext = structuredClone(expectedContext);
  } catch {}
  const checks = []; const check = (id, operation) => {
    try { checks.push({ details: operation(), id, status: "PASS" }); }
    catch { checks.push({ details: { reason: `${id}-verification-failed` }, id, status: "FAIL" }); }
  };
  let developerReport; let plan; let operatorSet; let input;
  check("developer-preflight", () => {
    developerReport = validateDeveloperTestnetPreflightReport(developerValue);
    if (developerReport.summary.status !== "PASS") throw new Error("developer preflight did not pass");
    return { reportHash: developerReport.reportHash };
  });
  check("drill-plan", () => {
    plan = validateTestnetPartitionDrillPlan(planValue);
    if (!developerReport || plan.preflightReportHash !== developerReport.reportHash) {
      throw new Error("drill plan is for another developer preflight");
    }
    return { planHash: plan.planHash };
  });
  check("external-operator-attestation", () => {
    operatorSet = validateRehearsalAttestorSet(operatorSetValue);
    input = verifyProductionPreflightRehearsalInput(inputValue, { maxFutureSkewMs, now, operatorSet });
    return { operators: input.package.attestations.length, packageHash: input.package.packageHash,
      runNonce: input.package.statement.runNonce };
  });
  check("durable-attestation-head", () => {
    const transcript = verifyRehearsalAttestationStoreTranscript(transcriptValue);
    const headEnvelope = transcript.records.at(-1); const head = headEnvelope.record;
    if (!input || head.packageHash !== input.package.packageHash ||
        head.runNonce !== input.package.statement.runNonce) {
      throw new Error("attestation package is not the durable accepted head");
    }
    return { count: transcript.records.length, recordHash: headEnvelope.recordHash,
      transcriptHash: transcript.transcriptHash };
  });
  check("production-context-binding", () => {
    const genesis = developerReport && passedDetails(developerReport, "genesis");
    const release = developerReport && passedDetails(developerReport, "release");
    const statement = input?.package?.statement;
    if (!developerReport || !plan || !statement || !genesis || !release ||
        statement.networkId !== developerReport.networkId || statement.networkId !== plan.networkId ||
        !trustedContext || statement.genesisHash !== genesis.genesisHash ||
        statement.genesisHash !== trustedContext.genesisHash ||
        statement.releaseCheckpointHash !== release.checkpointHash ||
        statement.releaseCheckpointHash !== plan.releaseCheckpointHash ||
        statement.releaseManifestHash !== trustedContext.releaseManifestHash ||
        statement.validatorTip !== trustedContext.finalizedTip || statement.drillPlanHash !== plan.planHash) {
      throw new Error("production contexts do not match");
    }
    return { genesisHash: genesis.genesisHash, releaseCheckpointHash: release.checkpointHash,
      tipHash: trustedContext.finalizedTip };
  });
  checks.sort((left, right) => left.id.localeCompare(right.id));
  const failed = checks.filter(({ status }) => status === "FAIL").length;
  const evidence = { attestationInput: inputValue === undefined ? null : structuredClone(inputValue),
    attestationStoreTranscript: transcriptValue === undefined ? null : structuredClone(transcriptValue),
    developerReport: developerValue === undefined ? null : structuredClone(developerValue),
    drillPlan: planValue === undefined ? null : structuredClone(planValue),
    expectedContext: expectedContext === undefined ? null : structuredClone(expectedContext), maxFutureSkewMs,
    operatorSet: operatorSetValue === undefined ? null : structuredClone(operatorSetValue) };
  const payload = { checks, developerReportHash: developerReport?.reportHash ?? developerValue?.reportHash ?? null,
    evidence, format: FORMAT, networkId: developerReport?.networkId ?? developerValue?.networkId ?? "invalid",
    observedAt: now, readiness: failed === 0 ? "EXTERNAL-EVIDENCE-PASS" : "FAIL",
    summary: { failed, passed: checks.length - failed, status: failed === 0 ? "PASS" : "FAIL" }, version: 1 };
  return { ...payload, reportHash: `sha3-256:${digest(payload)}` };
}

export function validateDeveloperTestnetProductionPreflightReport(value) {
  exact(value, ["checks", "developerReportHash", "evidence", "format", "networkId", "observedAt", "readiness",
    "reportHash", "summary", "version"], "production preflight report");
  exact(value.summary, ["failed", "passed", "status"], "production preflight summary");
  if (value.format !== FORMAT || value.version !== 1 || !HASH.test(value.developerReportHash ?? "") ||
      !HASH.test(value.reportHash ?? "") || typeof value.networkId !== "string" ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || !Array.isArray(value.checks) ||
      value.checks.length !== Object.keys(DETAILS).length) throw new Error("production preflight report is invalid");
  const ids = Object.keys(DETAILS).sort(); let failed = 0;
  value.checks.forEach((entry, index) => {
    exact(entry, ["details", "id", "status"], "production preflight check");
    if (entry.id !== ids[index] || !["PASS", "FAIL"].includes(entry.status)) {
      throw new Error("production preflight checks are invalid");
    }
    exact(entry.details, entry.status === "PASS" ? DETAILS[entry.id] : ["reason"],
      "production preflight check details");
    if (entry.status === "FAIL") {
      failed += 1;
      if (entry.details.reason !== `${entry.id}-verification-failed`) {
        throw new Error("production preflight failure reason is invalid");
      }
    } else for (const [key, detail] of Object.entries(entry.details)) {
      if (key === "count" || key === "operators") {
        if (!Number.isSafeInteger(detail) || detail < 1) throw new Error("production count is invalid");
      } else if (!HASH.test(detail ?? "")) throw new Error("production binding hash is invalid");
    }
  });
  const status = failed === 0 ? "PASS" : "FAIL";
  if (value.summary.failed !== failed || value.summary.passed !== value.checks.length - failed ||
      value.summary.status !== status ||
      value.readiness !== (failed === 0 ? "EXTERNAL-EVIDENCE-PASS" : "FAIL")) {
    throw new Error("production preflight summary is invalid");
  }
  const { reportHash, ...payload } = value;
  if (reportHash !== `sha3-256:${digest(payload)}`) throw new Error("production preflight report hash is invalid");
  exact(value.evidence, ["attestationInput", "attestationStoreTranscript", "developerReport",
    "drillPlan", "expectedContext", "maxFutureSkewMs", "operatorSet"],
  "production preflight evidence");
  const rebuilt = evaluateDeveloperTestnetProductionPreflight({ ...value.evidence, now: value.observedAt });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    throw new Error("production preflight report does not reproduce from its evidence");
  }
  return structuredClone(value);
}

export function serializeDeveloperTestnetProductionPreflightReport(value) {
  return `${canonicalJson(validateDeveloperTestnetProductionPreflightReport(value))}\n`;
}
