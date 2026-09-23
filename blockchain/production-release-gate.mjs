import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  openSync, readSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import { validateDeveloperTestnetProductionPreflightReport } from "./developer-testnet-production-preflight.mjs";
import { verifyReleaseArtifact } from "./release-artifact.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";

const TARGET_FORMAT = "nir-production-release-target-v1";
const PACKAGE_FORMAT = "nir-production-release-package-v1";
const HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PREFLIGHT_AGE_MS = 86_400_000;
const MAX_FUTURE_SKEW_MS = 300_000;
const MAX_PUBLIC_JSON_BYTES = 600 * 1024 * 1024;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function validateProductionReleaseTarget(value) {
  exact(value, ["finalizedTip", "format", "genesisHash", "maxFutureSkewMs",
    "maxPreflightAgeMs", "networkId", "releaseManifestHash", "releaseVersion",
    "sourceRevision", "version"], "production release target");
  if (value.format !== TARGET_FORMAT || value.version !== 1 ||
      typeof value.networkId !== "string" || value.networkId.length < 1 ||
      value.networkId.length > 128 || /[\x00-\x1f\x7f]/.test(value.networkId) ||
      !HASH.test(value.genesisHash ?? "") || !HASH.test(value.finalizedTip ?? "") ||
      !/^[0-9a-f]{64}$/.test(value.releaseManifestHash ?? "") ||
      !REVISION.test(value.sourceRevision ?? "") ||
      typeof value.releaseVersion !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value.releaseVersion) ||
      !Number.isSafeInteger(value.maxPreflightAgeMs) || value.maxPreflightAgeMs < 1 ||
      value.maxPreflightAgeMs > MAX_PREFLIGHT_AGE_MS ||
      !Number.isSafeInteger(value.maxFutureSkewMs) || value.maxFutureSkewMs < 0 ||
      value.maxFutureSkewMs > MAX_FUTURE_SKEW_MS) {
    throw new Error("production release target is invalid");
  }
  return structuredClone(value);
}

export function verifyProductionReleaseGate({ productionReport: reportValue,
  productionTarget: targetValue, signedRelease, trustedAddress, now }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("production release time is invalid");
  const target = validateProductionReleaseTarget(targetValue);
  const { manifest, signer } = verifySignedRelease(signedRelease, { trustedAddress });
  if (target.releaseManifestHash !== manifest.manifestHash ||
      target.sourceRevision !== manifest.sourceRevision ||
      target.releaseVersion !== manifest.releaseVersion) {
    throw new Error("production target does not match the trusted source release");
  }
  const report = validateDeveloperTestnetProductionPreflightReport(reportValue);
  if (report.summary.status !== "PASS" || report.readiness !== "EXTERNAL-EVIDENCE-PASS") {
    throw new Error("production preflight did not pass external evidence verification");
  }
  if (report.observedAt > now + target.maxFutureSkewMs ||
      report.observedAt < now - target.maxPreflightAgeMs) {
    throw new Error("production preflight is stale or from the future");
  }
  const context = report.evidence.expectedContext;
  const statement = report.evidence.attestationInput?.package?.statement;
  if (report.networkId !== target.networkId || context?.genesisHash !== target.genesisHash ||
      context?.finalizedTip !== target.finalizedTip ||
      context?.releaseManifestHash !== target.releaseManifestHash ||
      statement?.networkId !== target.networkId || statement?.genesisHash !== target.genesisHash ||
      statement?.validatorTip !== target.finalizedTip ||
      statement?.releaseManifestHash !== target.releaseManifestHash ||
      !Number.isSafeInteger(statement?.expiresAt) || statement.expiresAt < now) {
    throw new Error("production preflight context does not match the release target");
  }
  return { manifest, report, signer, target };
}

export function createProductionReleasePackage(artifactValue, options = {}) {
  const gate = verifyProductionReleaseGate(options);
  const artifact = verifyReleaseArtifact(artifactValue, { sourceManifest: gate.manifest });
  const payload = { artifact, format: PACKAGE_FORMAT, productionReport: gate.report,
    productionTarget: gate.target, version: 1 };
  return { ...payload, packageHash: hashObject(payload, "PRODUCTION_RELEASE_PACKAGE_V1") };
}

export function verifyProductionReleasePackage(value, options = {}) {
  exact(value, ["artifact", "format", "packageHash", "productionReport", "productionTarget",
    "version"], "production release package");
  if (value.format !== PACKAGE_FORMAT || value.version !== 1 ||
      !/^[0-9a-f]{64}$/.test(value.packageHash ?? "")) {
    throw new Error("production release package is invalid");
  }
  const gate = verifyProductionReleaseGate({ ...options, productionReport: value.productionReport,
    productionTarget: value.productionTarget });
  const artifact = verifyReleaseArtifact(value.artifact, { sourceManifest: gate.manifest });
  const payload = { artifact, format: PACKAGE_FORMAT, productionReport: gate.report,
    productionTarget: gate.target, version: 1 };
  if (value.packageHash !== hashObject(payload, "PRODUCTION_RELEASE_PACKAGE_V1")) {
    throw new Error("production release package hash is invalid");
  }
  return { ...payload, packageHash: value.packageHash };
}

export function serializeProductionReleasePackage(value, options = {}) {
  return `${canonicalJson(verifyProductionReleasePackage(value, options))}\n`;
}

export function readBoundedPublicJson(pathValue, { maximumBytes = MAX_PUBLIC_JSON_BYTES,
  requireCanonical = false, _afterOpen } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("no-follow file support is required");
  const path = resolve(pathValue);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size < 1 || opened.size > maximumBytes) {
      throw new Error("production release input is not a bounded regular file");
    }
    if (_afterOpen !== undefined) _afterOpen(path);
    const contents = Buffer.alloc(opened.size); let offset = 0;
    while (offset < contents.length) {
      const length = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (length === 0) throw new Error("production release input changed during read");
      offset += length;
    }
    const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (!sameIdentity(opened, after) || !sameIdentity(opened, linked) || linked.isSymbolicLink() ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs || opened.mode !== after.mode) {
      throw new Error("production release input changed during read");
    }
    const text = contents.toString("utf8"); const value = JSON.parse(text);
    if (requireCanonical && text !== `${canonicalJson(value)}\n`) {
      throw new Error("production release input is not canonical JSON");
    }
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function writeProductionPackageExclusive(pathValue, packageValue, options = {}) {
  const contents = Buffer.from(serializeProductionReleasePackage(packageValue, options));
  const target = resolve(pathValue); const parent = dirname(target);
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error("no-follow directory support is required");
  }
  const parentDescriptor = openSync(parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const parentIdentity = fstatSync(parentDescriptor);
  if (!parentIdentity.isDirectory()) { closeSync(parentDescriptor); throw new Error("output parent is invalid"); }
  const temporary = join(parent, `.${basename(target)}.nir-production-${randomBytes(16).toString("hex")}`);
  let temporaryIdentity = null; let linkedIdentity = null;
  try {
    const descriptor = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, contents); fchmodSync(descriptor, 0o644); fsyncSync(descriptor);
      temporaryIdentity = fstatSync(descriptor);
    }
    finally { closeSync(descriptor); }
    if (typeof options._beforeLink === "function") options._beforeLink({ parent, target, temporary });
    const currentParent = lstatSync(parent);
    const currentTemporary = lstatSync(temporary);
    if (!sameIdentity(parentIdentity, currentParent) || currentParent.isSymbolicLink() ||
        !currentTemporary.isFile() || currentTemporary.isSymbolicLink() ||
        !sameIdentity(temporaryIdentity, currentTemporary)) {
      throw new Error("output parent changed during production package write");
    }
    linkSync(temporary, target);
    linkedIdentity = lstatSync(target);
    if (typeof options._afterLink === "function") options._afterLink({ parent, target, temporary });
    const afterParent = lstatSync(parent); const afterTemporary = lstatSync(temporary);
    const afterTarget = lstatSync(target);
    if (!sameIdentity(parentIdentity, afterParent) || afterParent.isSymbolicLink() ||
        !sameIdentity(temporaryIdentity, afterTemporary) || afterTemporary.isSymbolicLink() ||
        !sameIdentity(temporaryIdentity, linkedIdentity) || !sameIdentity(linkedIdentity, afterTarget) ||
        afterTarget.isSymbolicLink()) {
      throw new Error("output activation changed during production package write");
    }
    fsyncSync(parentDescriptor);
    if (typeof options._beforeTempCleanup === "function") {
      options._beforeTempCleanup({ parent, target, temporary });
    }
    const cleanupParent = lstatSync(parent); const cleanupTemporary = lstatSync(temporary);
    if (!sameIdentity(parentIdentity, cleanupParent) || cleanupParent.isSymbolicLink() ||
        !cleanupTemporary.isFile() || cleanupTemporary.isSymbolicLink() ||
        !sameIdentity(temporaryIdentity, cleanupTemporary)) {
      throw new Error("production package temporary changed before cleanup");
    }
    unlinkSync(temporary); temporaryIdentity = null;
    fsyncSync(parentDescriptor);
    const finalParent = lstatSync(parent); const finalTarget = lstatSync(target);
    if (!sameIdentity(parentIdentity, finalParent) || finalParent.isSymbolicLink() ||
        !sameIdentity(linkedIdentity, finalTarget) || finalTarget.isSymbolicLink()) {
      throw new Error("production package output changed after activation");
    }
  } catch (error) {
    if (linkedIdentity !== null) {
      try {
        const current = lstatSync(target);
        if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, linkedIdentity)) {
          unlinkSync(target); fsyncSync(parentDescriptor);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.targetCleanupError = cleanupError.message;
      }
    }
    if (temporaryIdentity !== null) {
      try {
        const current = lstatSync(temporary);
        if (current.isFile() && !current.isSymbolicLink() &&
            sameIdentity(current, temporaryIdentity)) {
          unlinkSync(temporary); fsyncSync(parentDescriptor);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") error.temporaryCleanupError = cleanupError.message;
      }
    }
    throw error;
  } finally {
    closeSync(parentDescriptor);
  }
}
