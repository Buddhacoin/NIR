import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validateReleaseAuthoritySet } from "./offline-release-governance.mjs";

const FORMAT = "nir-production-runtime-policy-v1";
const ENVELOPE_FORMAT = "nir-production-runtime-policy-envelope-v1";
const APPROVAL_FORMAT = "nir-production-runtime-policy-approval-v1";
const HASH = /^[0-9a-f]{64}$/;
const PREFIXED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const VERSION = /^v(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})$/;
const COMMANDS = new Set(["bridge", "extension", "ui"]);
const MAX_RUNTIME_BYTES = 256 * 1024 * 1024;
const MAX_POLICY_LIFETIME_MS = 30 * 86_400_000;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function digestDescriptor(descriptor, size) {
  const digest = createHash("sha3-256");
  const buffer = Buffer.allocUnsafe(64 * 1024); let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count < 1) throw new Error("production runtime executable changed during read");
    digest.update(buffer.subarray(0, count)); offset += count;
  }
  return digest.digest("hex");
}

export function inspectProductionRuntime(executablePath = process.execPath) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure runtime inspection is unavailable");
  }
  const executableRealpath = realpathSync(executablePath);
  if (executableRealpath !== realpathSync(process.execPath)) {
    throw new Error("production runtime inspection must execute under the reviewed binary");
  }
  if (!isAbsolute(executableRealpath) || executableRealpath.includes("\0")) {
    throw new Error("production runtime realpath is invalid");
  }
  let descriptor;
  try {
    descriptor = openSync(executableRealpath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor); const linked = lstatSync(executableRealpath);
    if (!before.isFile() || before.nlink < 1 || before.size < 1 || before.size > MAX_RUNTIME_BYTES ||
        linked.isSymbolicLink() || !same(before, linked)) throw new Error("production runtime executable is unsafe");
    const executableSha3_256 = digestDescriptor(descriptor, before.size);
    const after = fstatSync(descriptor); const finalLinked = lstatSync(executableRealpath);
    if (!same(before, after) || !same(before, finalLinked) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("production runtime executable changed during inspection");
    }
    return { arch: process.arch, build: `node-abi-${process.versions.modules}`,
      executableRealpath, executableSha3_256, platform: process.platform,
      version: process.version };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function runtime(value) {
  exact(value, ["arch", "build", "executableRealpath", "executableSha3_256", "platform",
    "version"], "production runtime descriptor");
  if (!isAbsolute(value.executableRealpath ?? "") || value.executableRealpath.includes("\0") ||
      !HASH.test(value.executableSha3_256 ?? "") || !VERSION.test(value.version ?? "") ||
      !/^node-abi-[1-9][0-9]{0,5}$/.test(value.build ?? "") ||
      !/^[a-z0-9_-]{2,32}$/.test(value.platform ?? "") ||
      !/^[A-Za-z0-9_-]{2,32}$/.test(value.arch ?? "")) {
    throw new Error("production runtime descriptor is invalid");
  }
  return structuredClone(value);
}

function binding(value) {
  exact(value, ["genesisHash", "networkId", "releaseManifestHash", "releaseVersion",
    "sourceRevision", "toolPackageHash", "walletPackageHash"], "runtime release binding");
  if (!/^(?:sha3-256:)?[0-9a-f]{64}$/.test(value.genesisHash ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 2 || value.networkId.length > 128 ||
      !HASH.test(value.releaseManifestHash ?? "") || !HASH.test(value.toolPackageHash ?? "") ||
      !HASH.test(value.walletPackageHash ?? "") ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sourceRevision ?? "") ||
      !/^(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})$/.test(value.releaseVersion ?? "")) {
    throw new Error("runtime release binding is invalid");
  }
  return structuredClone(value);
}

function policyPayload(value) {
  exact(value, ["authoritySetId", "binding", "commands", "createdAt", "expiresAt", "format",
    "previousPolicyHash", "runtime", "sequence", "version"], "production runtime policy");
  if (value.format !== FORMAT || value.version !== 1 || !PREFIXED_HASH.test(value.authoritySetId ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      (value.previousPolicyHash !== null && !HASH.test(value.previousPolicyHash ?? "")) ||
      (value.sequence === 1) !== (value.previousPolicyHash === null) ||
      !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > MAX_POLICY_LIFETIME_MS ||
      !Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > COMMANDS.size ||
      value.commands.some((item, index) => !COMMANDS.has(item) ||
        (index > 0 && value.commands[index - 1] >= item))) {
    throw new Error("production runtime policy is invalid");
  }
  return { authoritySetId: value.authoritySetId, binding: binding(value.binding),
    commands: [...value.commands], createdAt: value.createdAt, expiresAt: value.expiresAt,
    format: FORMAT, previousPolicyHash: value.previousPolicyHash, runtime: runtime(value.runtime),
    sequence: value.sequence, version: 1 };
}

export function createProductionRuntimePolicy({ authoritySet, binding: releaseBinding, commands,
  createdAt, expiresAt, previousPolicyHash = null, runtime: runtimeDescriptor, sequence }) {
  const set = validateReleaseAuthoritySet(authoritySet);
  const payload = policyPayload({ authoritySetId: set.setId, binding: releaseBinding,
    commands: [...commands].sort(), createdAt, expiresAt, format: FORMAT, previousPolicyHash,
    runtime: runtimeDescriptor, sequence, version: 1 });
  return { ...payload, policyHash: hashObject(payload, "PRODUCTION_RUNTIME_POLICY_V1") };
}

export function validateProductionRuntimePolicy(value) {
  exact(value, ["authoritySetId", "binding", "commands", "createdAt", "expiresAt", "format",
    "policyHash", "previousPolicyHash", "runtime", "sequence", "version"],
  "production runtime policy envelope");
  const { policyHash, ...unsigned } = value; const payload = policyPayload(unsigned);
  if (!HASH.test(policyHash ?? "") || policyHash !== hashObject(payload,
    "PRODUCTION_RUNTIME_POLICY_V1")) throw new Error("production runtime policy hash is invalid");
  return { ...payload, policyHash };
}

export function signProductionRuntimePolicy(policyValue, authoritySetValue, { operatorId, wallet }) {
  const policy = validateProductionRuntimePolicy(policyValue);
  const set = validateReleaseAuthoritySet(authoritySetValue);
  const authority = set.authorities.find((item) => item.operatorId === operatorId);
  if (policy.authoritySetId !== set.setId || !authority || authority.address !== wallet.address ||
      authority.publicKey !== wallet.publicKey) throw new Error("runtime policy signer is not authorized");
  const signed = { policyHash: policy.policyHash, setId: set.setId };
  return { address: authority.address, algorithm: SIGNATURE_ALGORITHM, format: APPROVAL_FORMAT,
    operatorId, policyHash: policy.policyHash, setId: set.setId,
    signature: signObject(signed, wallet, "PRODUCTION_RUNTIME_POLICY_APPROVAL_V1"), version: 1 };
}

export function assembleProductionRuntimePolicy(policyValue, authoritySetValue, approvalValues) {
  const policy = validateProductionRuntimePolicy(policyValue);
  const authoritySet = validateReleaseAuthoritySet(authoritySetValue);
  if (policy.authoritySetId !== authoritySet.setId || !Array.isArray(approvalValues) ||
      approvalValues.length < authoritySet.threshold || approvalValues.length > authoritySet.authorities.length) {
    throw new Error("runtime policy approval quorum is missing");
  }
  const seen = new Set(); const signed = { policyHash: policy.policyHash, setId: authoritySet.setId };
  const approvals = approvalValues.map((approval) => {
    exact(approval, ["address", "algorithm", "format", "operatorId", "policyHash", "setId",
      "signature", "version"], "runtime policy approval");
    const authority = authoritySet.authorities.find((item) => item.operatorId === approval.operatorId);
    if (!authority || seen.has(approval.operatorId) || approval.format !== APPROVAL_FORMAT ||
        approval.version !== 1 || approval.address !== authority.address ||
        approval.algorithm !== SIGNATURE_ALGORITHM || approval.policyHash !== policy.policyHash ||
        approval.setId !== authoritySet.setId || !verifyObject(signed, approval.signature,
          authority.publicKey, "PRODUCTION_RUNTIME_POLICY_APPROVAL_V1")) {
      throw new Error("runtime policy approval is invalid, unknown, or duplicate");
    }
    seen.add(approval.operatorId); return structuredClone(approval);
  }).sort((left, right) => left.operatorId < right.operatorId ? -1 : 1);
  const payload = { approvals, authoritySet, format: ENVELOPE_FORMAT, policy, version: 1 };
  return { ...payload, envelopeHash: hashObject(payload, "PRODUCTION_RUNTIME_POLICY_ENVELOPE_V1") };
}

export function verifyProductionRuntimePolicy(value, { command, expectedBinding,
  expectedPolicyHash, expectedSequence, now, executablePath = process.execPath } = {}) {
  exact(value, ["approvals", "authoritySet", "envelopeHash", "format", "policy", "version"],
    "production runtime policy approval envelope");
  if (value.format !== ENVELOPE_FORMAT || value.version !== 1) throw new Error("runtime policy envelope is invalid");
  const expected = assembleProductionRuntimePolicy(value.policy, value.authoritySet, value.approvals);
  const observed = inspectProductionRuntime(executablePath); const policy = expected.policy;
  if (expected.envelopeHash !== value.envelopeHash || policy.policyHash !== expectedPolicyHash ||
      policy.sequence !== expectedSequence || !Number.isSafeInteger(now) || now < policy.createdAt ||
      now > policy.expiresAt || !COMMANDS.has(command) || !policy.commands.includes(command) ||
      canonicalJson(policy.runtime) !== canonicalJson(observed) ||
      canonicalJson(policy.binding) !== canonicalJson(binding(expectedBinding))) {
    throw new Error("production runtime policy is stale, rolled back, mixed, or does not match this runtime");
  }
  return expected;
}

export const PRODUCTION_RUNTIME_POLICY_LIMITS = Object.freeze({
  maxLifetimeMs: MAX_POLICY_LIFETIME_MS, maxRuntimeBytes: MAX_RUNTIME_BYTES,
});
