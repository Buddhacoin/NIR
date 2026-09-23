import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  openSync, readSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, hashObject } from "./crypto.mjs";
import { validateDeveloperTestnetProductionPreflightReport } from "./developer-testnet-production-preflight.mjs";
import {
  installNodeArtifact, installWalletArtifact, readNodeProductionProvenance,
  readWalletProductionProvenance, verifyNodeProductionArtifactInstallation,
  verifyReleaseArtifact, verifyWalletProductionArtifactInstallation,
} from "./release-artifact.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";

const TARGET_FORMAT = "nir-production-release-target-v1";
const PACKAGE_FORMAT = "nir-production-release-package-v1";
const HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PREFLIGHT_AGE_MS = 86_400_000;
const MAX_FUTURE_SKEW_MS = 300_000;
const MAX_PUBLIC_JSON_BYTES = 600 * 1024 * 1024;
const PROVENANCE_FORMAT = "nir-production-install-provenance-v1";

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertUnambiguousJson(text) {
  let offset = 0; let nodes = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "")) offset += 1; };
  const string = () => {
    const start = offset;
    if (text[offset++] !== '"') throw new Error("JSON string is invalid");
    while (offset < text.length) {
      if (text[offset] === '"') { offset += 1; return JSON.parse(text.slice(start, offset)); }
      if (text[offset] === "\\") offset += 2;
      else offset += 1;
    }
    throw new Error("JSON string is unterminated");
  };
  const value = (depth = 0) => {
    whitespace(); nodes += 1;
    if (depth > 64 || nodes > 1_000_000) throw new Error("JSON structure exceeds production bounds");
    if (text[offset] === "{") {
      offset += 1; whitespace(); const keys = new Set();
      if (text[offset] === "}") { offset += 1; return; }
      while (true) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error("JSON contains a duplicate object key");
        keys.add(key); whitespace();
        if (text[offset++] !== ":") throw new Error("JSON object is invalid");
        value(depth + 1); whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset++] !== ",") throw new Error("JSON object is invalid");
      }
    }
    if (text[offset] === "[") {
      offset += 1; whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (true) {
        value(depth + 1); whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset++] !== ",") throw new Error("JSON array is invalid");
      }
    }
    if (text[offset] === '"') { string(); return; }
    const match = text.slice(offset).match(/^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/);
    if (!match) throw new Error("JSON value is invalid");
    offset += match[0].length;
  };
  value(); whitespace();
  if (offset !== text.length) throw new Error("JSON has trailing non-whitespace data");
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
      !/^(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})$/.test(value.releaseVersion) ||
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

export function installProductionReleasePackage(value, targetPath, { kind, _beforeActivation,
  previousInstallation = null, previousSignedRelease = null,
  expectedPreviousPackageHash = null, ...options } = {}) {
  const packageValue = verifyProductionReleasePackage(value, options);
  if (!new Set(["node", "wallet"]).has(kind) || packageValue.artifact.kind !== kind) {
    throw new Error("production package kind is invalid");
  }
  const updateInputs = [previousInstallation, previousSignedRelease, expectedPreviousPackageHash];
  if (!updateInputs.every((entry) => entry === null) &&
      !updateInputs.every((entry) => entry !== null)) {
    throw new Error("production update requires current installation, signed release and expected hash");
  }
  if (previousInstallation !== null) {
    const previous = verifyProductionInstallation(previousInstallation, {
      expectedPackageHash: expectedPreviousPackageHash, kind,
      signedRelease: previousSignedRelease, trustedAddress: options.trustedAddress,
    });
    if (previous.productionTarget.networkId !== packageValue.productionTarget.networkId ||
        previous.productionTarget.genesisHash !== packageValue.productionTarget.genesisHash ||
        compareStableVersions(packageValue.productionTarget.releaseVersion,
          previous.productionTarget.releaseVersion) <= 0) {
      throw new Error("production update is a rollback, downgrade, or mixed network");
    }
  }
  const productionProvenance = productionProvenanceFrom(packageValue);
  const installOptions = { ...options, _beforeActivation, productionProvenance };
  const provenance = kind === "wallet"
    ? installWalletArtifact(packageValue.artifact, targetPath, installOptions)
    : installNodeArtifact(packageValue.artifact, targetPath, installOptions);
  return { packageHash: packageValue.packageHash, productionProvenance, provenance };
}

function compareStableVersions(left, right) {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function productionProvenanceFrom(packageValue) {
  return {
    artifactHash: packageValue.artifact.artifactHash,
    format: PROVENANCE_FORMAT,
    kind: packageValue.artifact.kind,
    packageHash: packageValue.packageHash,
    productionReport: packageValue.productionReport,
    productionTarget: packageValue.productionTarget,
    version: 1,
  };
}

function validateProductionProvenance(value, kind) {
  exact(value, ["artifactHash", "format", "kind", "packageHash", "productionReport",
    "productionTarget", "version"], "production installation provenance");
  if (value.format !== PROVENANCE_FORMAT || value.version !== 1 || value.kind !== kind ||
      !/^[0-9a-f]{64}$/.test(value.artifactHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(value.packageHash ?? "")) {
    throw new Error("production installation provenance is invalid");
  }
  return structuredClone(value);
}

export function verifyProductionInstallation(targetPath, {
  expectedPackageHash, includeArtifact = false, kind, signedRelease, trustedAddress,
} = {}) {
  if (!new Set(["node", "wallet"]).has(kind) ||
      !/^[0-9a-f]{64}$/.test(expectedPackageHash ?? "")) {
    throw new Error("production startup requires an exact expected package hash and kind");
  }
  const raw = kind === "node"
    ? readNodeProductionProvenance(targetPath) : readWalletProductionProvenance(targetPath);
  const productionProvenance = validateProductionProvenance(raw, kind);
  if (productionProvenance.packageHash !== expectedPackageHash) {
    throw new Error("production installation package hash is not the trusted startup package");
  }
  const installed = kind === "node"
    ? verifyNodeProductionArtifactInstallation(targetPath, {
      productionProvenance, signedRelease, trustedAddress,
    })
    : verifyWalletProductionArtifactInstallation(targetPath, {
      productionProvenance, signedRelease, trustedAddress,
    });
  const packageValue = verifyProductionReleasePackage({
    artifact: installed.artifact,
    format: PACKAGE_FORMAT,
    packageHash: productionProvenance.packageHash,
    productionReport: productionProvenance.productionReport,
    productionTarget: productionProvenance.productionTarget,
    version: 1,
  }, {
    now: productionProvenance.productionReport.observedAt, signedRelease, trustedAddress,
  });
  if (packageValue.artifact.artifactHash !== productionProvenance.artifactHash) {
    throw new Error("production installation artifact does not match its provenance");
  }
  return { ...(includeArtifact ? { artifact: packageValue.artifact,
    productionReport: packageValue.productionReport } : {}),
    artifactHash: packageValue.artifact.artifactHash, files: installed.files,
    kind, packageHash: packageValue.packageHash,
    productionReportHash: packageValue.productionReport.reportHash,
    productionTarget: packageValue.productionTarget, verified: true };
}

export function serializeProductionReleasePackage(value, options = {}) {
  return `${canonicalJson(verifyProductionReleasePackage(value, options))}\n`;
}

export function readBoundedPublicJson(pathValue, { maximumBytes = MAX_PUBLIC_JSON_BYTES,
  requireCanonical = false, _afterOpen } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    throw new Error("no-follow nonblocking file support is required");
  }
  const path = resolve(pathValue);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
    const text = contents.toString("utf8");
    assertUnambiguousJson(text);
    const value = JSON.parse(text);
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
