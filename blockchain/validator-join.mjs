import { X509Certificate, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmdirSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { transactionId } from "./chain.mjs";
import { MIN_TRANSFER_FEE } from "./constants.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import {
  MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES, MAX_VALIDATOR_CANDIDATE_SYNC_INPUT_BYTES,
  synchronizeValidatorCandidateContext, validateValidatorCandidateContext,
  validateValidatorCandidateSyncInput,
} from "./validator-candidate-context.mjs";
import {
  createVerifiedWalletBackup, createWalletFile, signValidatorAdmissionWithWalletFiles,
  verifyWalletFile, walletPublicInfo,
} from "./wallet-files.mjs";
import {
  VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS,
  verifyValidatorAdmission,
} from "./validator-admission.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";

const FORMAT_V1 = "nir-validator-join-plan-v1";
const FORMAT = "nir-validator-join-plan-v2";
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ADMISSION_PACKAGE_BYTES = MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES + 1024 * 1024;
export const VALIDATOR_ADMISSION_SIGNING_LOCK_LEASE_MS = 300_000;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function privateDirectory(m) {
  return m.isDirectory() && !m.isSymbolicLink() && (m.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || m.uid === process.getuid());
}
function normalizeEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error("validator join endpoint is invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
      endpoint.hash || endpoint.pathname !== "/") throw new Error("validator join endpoint must be an HTTPS origin");
  return endpoint.origin;
}
function certificateFingerprint(pem, endpoint, now) {
  let certificate;
  try { certificate = new X509Certificate(pem); }
  catch { throw new Error("validator join TLS certificate is invalid"); }
  const from = Date.parse(certificate.validFrom); const to = Date.parse(certificate.validTo);
  if (!certificate.checkHost(new URL(endpoint).hostname)) throw new Error("validator join TLS certificate does not match endpoint");
  if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to) throw new Error("validator join TLS certificate is not currently valid");
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}
function pinDirectory(path) {
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new Error("secure directory operations unavailable");
  const canonical = realpathSync(resolve(path));
  const linked = lstatSync(canonical);
  const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const identity = fstatSync(descriptor);
  if (!privateDirectory(linked) || !privateDirectory(identity) || !sameIdentity(linked, identity)) {
    closeSync(descriptor); throw new Error("validator join directory is unsafe");
  }
  return { descriptor, identity, path: canonical, assert() {
    const held = fstatSync(descriptor); const current = lstatSync(canonical);
    if (!privateDirectory(held) || !privateDirectory(current) || !sameIdentity(held, identity) ||
        !sameIdentity(current, identity) || realpathSync(canonical) !== canonical) {
      throw new Error("validator join directory changed during operation");
    }
  } };
}
function readJson(path, label, privateFile = false, maximumBytes = MAX_JSON_BYTES) {
  const requested = resolve(path); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested)); let descriptor;
  try {
    parent.assert(); const linked = lstatSync(target);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !sameIdentity(before, linked) ||
        before.size < 2 || before.size > maximumBytes ||
        (privateFile && ((before.mode & 0o077) ||
          (typeof process.getuid === "function" && before.uid !== process.getuid())))) {
      throw new Error(`${label} is unsafe`);
    }
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor); const current = lstatSync(target);
    parent.assert();
    if (!sameIdentity(before, after) || !sameIdentity(before, current) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
      throw new Error(`${label} changed while reading`);
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); closeSync(parent.descriptor); }
}
function readText(path, label, privateFile) {
  const requested = resolve(path); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested)); let descriptor;
  try {
    parent.assert(); const linked = lstatSync(target);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !sameIdentity(before, linked) ||
        before.size < 2 || before.size > 256 * 1024 ||
        (privateFile && ((before.mode & 0o077) ||
          (typeof process.getuid === "function" && before.uid !== process.getuid())))) {
      throw new Error(`${label} is unsafe`);
    }
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor); const current = lstatSync(target);
    parent.assert();
    if (!sameIdentity(before, after) || !sameIdentity(before, current) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes.toString("utf8");
  } finally { if (descriptor !== undefined) closeSync(descriptor); closeSync(parent.descriptor); }
}
export function writeValidatorJoinArtifact(path, value) {
  const requested = resolve(path); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested));
  const temporary = join(parent.path, `.${basename(target)}.nir-validator-join-${randomBytes(16).toString("hex")}`);
  let descriptor; let identity = null;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    identity = fstatSync(descriptor); writeFileSync(descriptor, `${canonicalJson(value)}\n`); fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined; parent.assert();
    const linked = lstatSync(temporary);
    if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 || !sameIdentity(linked, identity) || (linked.mode & 0o777) !== 0o600) throw new Error("validator join artifact is unsafe");
    linkSync(temporary, target); unlinkSync(temporary); fsyncSync(parent.descriptor); parent.assert();
    if (!sameIdentity(lstatSync(target), identity)) throw new Error("validator join artifact activation changed");
    identity = null; return target;
  } catch (error) {
    if (identity) try { const current = lstatSync(temporary); if (sameIdentity(current, identity) && current.isFile() && !current.isSymbolicLink()) unlinkSync(temporary); } catch (cleanup) { if (cleanup?.code !== "ENOENT") error.cleanupError = cleanup.message; }
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); closeSync(parent.descriptor); }
}
function readPlan(directory) {
  const requested = resolve(directory); const root = pinDirectory(requested);
  try {
    root.assert();
    const plan = validateValidatorJoinPlan(readJson(join(root.path, "join-plan.json"), "validator join plan", true), root.path);
    root.assert();
    if (realpathSync(requested) !== root.path) throw new Error("validator join workspace activation changed");
    return plan;
  }
  finally { closeSync(root.descriptor); }
}
export function validatorJoinPublicPlan(directory) { return readPlan(directory); }
export function validateValidatorJoinConfig(value) {
  if (value?.format === "nir-validator-join-config-v1" && value?.version === 1) {
    exact(value, ["endpoint", "expectedChainIdentityGenesisHash", "expectedCheckpointPolicyId",
      "expectedTlsCertificateSha256", "format", "networkId", "operatorId", "tlsCertificate",
      "tlsPrivateKey", "version"], "validator join config");
    if (!NETWORK.test(value.networkId ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
        !HASH.test(value.expectedChainIdentityGenesisHash ?? "") ||
        !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") ||
        !HASH.test(value.expectedTlsCertificateSha256 ?? "") ||
        !isAbsolute(value.tlsCertificate ?? "") || !isAbsolute(value.tlsPrivateKey ?? "") ||
        value.tlsCertificate === value.tlsPrivateKey) throw new Error("validator join config is invalid");
    return { ...structuredClone(value), endpoint: normalizeEndpoint(value.endpoint) };
  }
  exact(value, ["candidateContextMaxWitnessAgeMs", "candidateContextMinimumCheckpointHeight",
    "candidateContextMinimumSequence", "endpoint", "expectedChainIdentityGenesisHash",
    "expectedCheckpointPolicyId", "expectedTlsCertificateSha256", "format", "networkId",
    "operatorId", "tlsCertificate", "tlsPrivateKey", "version"], "validator join config");
  if (value.format !== "nir-validator-join-config-v2" || value.version !== 2 || !NETWORK.test(value.networkId ?? "") ||
      !OPERATOR.test(value.operatorId ?? "") || !HASH.test(value.expectedChainIdentityGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") || !HASH.test(value.expectedTlsCertificateSha256 ?? "") ||
      !Number.isSafeInteger(value.candidateContextMinimumCheckpointHeight) ||
      value.candidateContextMinimumCheckpointHeight < 1 ||
      !Number.isSafeInteger(value.candidateContextMinimumSequence) ||
      value.candidateContextMinimumSequence < 0 ||
      !Number.isSafeInteger(value.candidateContextMaxWitnessAgeMs) ||
      value.candidateContextMaxWitnessAgeMs < 1 || value.candidateContextMaxWitnessAgeMs > 86_400_000 ||
      !isAbsolute(value.tlsCertificate ?? "") || !isAbsolute(value.tlsPrivateKey ?? "") || value.tlsCertificate === value.tlsPrivateKey) throw new Error("validator join config is invalid");
  return { ...structuredClone(value), endpoint: normalizeEndpoint(value.endpoint) };
}
export function loadValidatorJoinInputs(configPath) {
  const config = validateValidatorJoinConfig(readJson(configPath, "validator join config", true));
  return { config, tlsCertificatePem: readText(config.tlsCertificate, "validator TLS certificate", false),
    tlsPrivateKeyPem: readText(config.tlsPrivateKey, "validator TLS private key", true) };
}
export function loadValidatorCandidateSyncInput(path) {
  return validateValidatorCandidateSyncInput(readJson(path, "validator candidate sync input", false,
    MAX_VALIDATOR_CANDIDATE_SYNC_INPUT_BYTES));
}
export function validateValidatorJoinPlan(value, root) {
  if (value?.format === FORMAT_V1 && value?.version === 1) {
    exact(value, ["broadcast", "consensus", "endpoint", "expectedChainIdentityGenesisHash",
      "expectedCheckpointPolicyId", "format", "networkId", "operatorId", "paths", "status",
      "tlsCertificateSha256", "transport", "version"], "validator join plan");
    exact(value.paths, ["consensusVault", "transportVault"], "validator join paths");
    const paths = { consensusVault: join(root, "consensus.nirvault.json"),
      transportVault: join(root, "transport.nirvault.json") };
    if (value.broadcast !== false || value.status !== "awaiting-external-v31-candidate-service" ||
        !NETWORK.test(value.networkId ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
        !HASH.test(value.tlsCertificateSha256 ?? "") ||
        !HASH.test(value.expectedChainIdentityGenesisHash ?? "") ||
        !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") ||
        normalizeEndpoint(value.endpoint) !== value.endpoint ||
        canonicalJson(value.paths) !== canonicalJson(paths) ||
        canonicalJson(walletPublicInfo(paths.consensusVault)) !== canonicalJson(value.consensus) ||
        canonicalJson(walletPublicInfo(paths.transportVault)) !== canonicalJson(value.transport) ||
        value.consensus.address === value.transport.address) throw new Error("validator join plan is invalid");
    return structuredClone(value);
  }
  exact(value, ["broadcast", "candidateContextMaxWitnessAgeMs",
    "candidateContextMinimumCheckpointHeight", "candidateContextMinimumSequence", "consensus",
    "endpoint", "expectedChainIdentityGenesisHash", "expectedCheckpointPolicyId", "format",
    "networkId", "operatorId", "paths", "status", "tlsCertificateSha256", "transport", "version"],
  "validator join plan");
  exact(value.paths, ["consensusVault", "transportVault"], "validator join paths");
  const paths = { consensusVault: join(root, "consensus.nirvault.json"), transportVault: join(root, "transport.nirvault.json") };
  if (value.format !== FORMAT || value.version !== 2 || value.broadcast !== false || value.status !== "awaiting-external-v31-candidate-service" ||
      !NETWORK.test(value.networkId ?? "") || !OPERATOR.test(value.operatorId ?? "") || !HASH.test(value.tlsCertificateSha256 ?? "") ||
      !HASH.test(value.expectedChainIdentityGenesisHash ?? "") || !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") ||
      !Number.isSafeInteger(value.candidateContextMinimumCheckpointHeight) ||
      value.candidateContextMinimumCheckpointHeight < 1 ||
      !Number.isSafeInteger(value.candidateContextMinimumSequence) || value.candidateContextMinimumSequence < 0 ||
      !Number.isSafeInteger(value.candidateContextMaxWitnessAgeMs) ||
      value.candidateContextMaxWitnessAgeMs < 1 || value.candidateContextMaxWitnessAgeMs > 86_400_000 ||
      normalizeEndpoint(value.endpoint) !== value.endpoint || canonicalJson(value.paths) !== canonicalJson(paths) ||
      canonicalJson(walletPublicInfo(paths.consensusVault)) !== canonicalJson(value.consensus) ||
      canonicalJson(walletPublicInfo(paths.transportVault)) !== canonicalJson(value.transport) || value.consensus.address === value.transport.address) throw new Error("validator join plan is invalid");
  return structuredClone(value);
}
function removeStaging(staging, identity, error) {
  let pinned = null;
  try {
    pinned = pinDirectory(staging);
    if (!sameIdentity(pinned.identity, identity)) throw new Error("validator join cleanup identity changed");
    for (const name of readdirSync(staging)) {
      try {
        pinned.assert();
        const path = join(staging, name); const item = lstatSync(path);
        if ((item.isFile() || item.isSymbolicLink()) && item.nlink === 1) unlinkSync(path);
        else throw new Error("validator join staging contains an unsafe entry");
        pinned.assert();
      } catch (cleanup) { if (cleanup?.code !== "ENOENT") error.cleanupError = cleanup.message; }
    }
    pinned.assert();
    rmdirSync(staging);
  } catch (cleanup) { if (cleanup?.code !== "ENOENT") error.cleanupError = cleanup.message; }
  finally { if (pinned !== null) closeSync(pinned.descriptor); }
}
export function createValidatorJoinWorkspace({ directory, config: input, tlsCertificatePem, tlsPrivateKeyPem, consensusPassword, transportPassword, now = Date.now() }) {
  const config = validateValidatorJoinConfig(input);
  if (consensusPassword === transportPassword) throw new Error("validator identities require distinct passwords");
  const fingerprint = certificateFingerprint(tlsCertificatePem, config.endpoint, now);
  if (fingerprint !== config.expectedTlsCertificateSha256) throw new Error("validator join TLS fingerprint does not match config");
  let certificateKey; let suppliedKey;
  try { certificateKey = new X509Certificate(tlsCertificatePem).publicKey.export({ format: "der", type: "spki" }); suppliedKey = createPublicKey(createPrivateKey(tlsPrivateKeyPem)).export({ format: "der", type: "spki" }); }
  catch { throw new Error("validator join TLS private key is invalid"); }
  if (!certificateKey.equals(suppliedKey)) throw new Error("validator join TLS certificate and private key do not match");
  const requested = resolve(directory); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested));
  const staging = join(parent.path, `.${basename(target)}.nir-validator-join-${randomBytes(16).toString("hex")}`); let stagingIdentity = null;
  let activationIdentity = null;
  try {
    mkdirSync(staging, { mode: 0o700 }); chmodSync(staging, 0o700); stagingIdentity = lstatSync(staging);
    createWalletFile({ path: join(staging, "consensus.nirvault.json"), password: consensusPassword, label: "NIR validator consensus identity" });
    createWalletFile({ path: join(staging, "transport.nirvault.json"), password: transportPassword, label: "NIR validator transport identity" });
    const consensus = walletPublicInfo(join(staging, "consensus.nirvault.json")); const transport = walletPublicInfo(join(staging, "transport.nirvault.json"));
    const plan = { broadcast: false,
      ...(config.version === 2 ? {
        candidateContextMaxWitnessAgeMs: config.candidateContextMaxWitnessAgeMs,
        candidateContextMinimumCheckpointHeight: config.candidateContextMinimumCheckpointHeight,
        candidateContextMinimumSequence: config.candidateContextMinimumSequence,
      } : {}), consensus, endpoint: config.endpoint,
      expectedChainIdentityGenesisHash: config.expectedChainIdentityGenesisHash,
      expectedCheckpointPolicyId: config.expectedCheckpointPolicyId,
      format: config.version === 2 ? FORMAT : FORMAT_V1,
      networkId: config.networkId, operatorId: config.operatorId,
      paths: { consensusVault: join(staging, "consensus.nirvault.json"),
        transportVault: join(staging, "transport.nirvault.json") },
      status: "awaiting-external-v31-candidate-service", tlsCertificateSha256: fingerprint,
      transport, version: config.version };
    const fd = openSync(join(staging, "join-plan.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${canonicalJson(plan)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    verifyWalletFile({ path: join(staging, "consensus.nirvault.json"), password: consensusPassword }); verifyWalletFile({ path: join(staging, "transport.nirvault.json"), password: transportPassword });
    parent.assert(); if (!sameIdentity(lstatSync(staging), stagingIdentity)) throw new Error("validator join staging changed");
    symlinkSync(basename(staging), target, "dir"); activationIdentity = lstatSync(target);
    fsyncSync(parent.descriptor); parent.assert();
    if (!activationIdentity.isSymbolicLink() || readlinkSync(target) !== basename(staging) ||
        !sameIdentity(lstatSync(staging), stagingIdentity)) throw new Error("validator join workspace activation changed");
    const validated = validateValidatorJoinPlan(plan, staging);
    stagingIdentity = null; return validated;
  } catch (error) {
    if (activationIdentity) try { const current = lstatSync(target); if (current.isSymbolicLink() && sameIdentity(current, activationIdentity) && readlinkSync(target) === basename(staging)) unlinkSync(target); } catch (cleanup) { if (cleanup?.code !== "ENOENT") error.cleanupError = cleanup.message; }
    if (stagingIdentity) removeStaging(staging, stagingIdentity, error); throw error;
  }
  finally { closeSync(parent.descriptor); }
}
export function validatorJoinStatus(directory) {
  const plan = readPlan(directory);
  const context = latestValidatorCandidateContext(directory, plan);
  return { address: plan.consensus.address, broadcast: false, endpoint: plan.endpoint, networkId: plan.networkId,
    ...(context ? { candidateContext: { atomicBalance: context.account.atomicBalance,
      checkpointHeight: context.checkpoint.height, contextHash: context.contextHash,
      nextNonce: context.account.nextNonce, protocolVersion: context.protocolVersion,
      queuePosition: context.queuePosition, queueSize: context.queueSize,
      status: context.status } } : {}),
    status: context ? "proof-backed candidate context synchronized" :
      "awaiting external v31 candidate service / quorum observation",
    next: context ? ["keep encrypted identity backups separate and verified",
      "for a protocol-v32 absent-queue context, prepare and offline-sign one admission intent",
      "submission and finalized inclusion proof are not implemented",
      "obtain finalized admission and fresh endpoint readiness proofs before selection",
      "after quorum-observed admission wait for a non-skipping authorized rotation"] :
      ["create and verify encrypted backups",
        "synchronize a proof-backed read-only v31 candidate context",
        "do not fabricate admission, readiness, selection, or activation state"] };
}
function latestValidatorCandidateContext(directory, plan = readPlan(directory), { now = Date.now() } = {}) {
  const root = dirname(plan.paths.consensusVault);
  const contexts = readdirSync(root).filter((name) =>
    /^candidate-context-[0-9a-f]{64}\.json$/.test(name)).map((name) => {
    const stored = readJson(join(root, name), "validator candidate context", true,
      MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES);
    const historical = validateValidatorCandidateContext(stored, plan, { now: stored.syncedAt });
    try { return validateValidatorCandidateContext(historical, plan, { now }); }
    catch (error) {
      if (/time policy|stale|fresh/i.test(error?.message ?? "")) return null;
      throw error;
    }
  }).filter(Boolean).sort((a, b) => b.checkpoint.height - a.checkpoint.height ||
    (b.checkpointTrustPackage?.sequence ?? -1) -
      (a.checkpointTrustPackage?.sequence ?? -1) ||
    b.contextHash.localeCompare(a.contextHash));
  return contexts[0] ?? null;
}

function admissionPlanCommitment(plan) {
  return hashObject({
    candidateContextMaxWitnessAgeMs: plan.candidateContextMaxWitnessAgeMs,
    candidateContextMinimumCheckpointHeight: plan.candidateContextMinimumCheckpointHeight,
    candidateContextMinimumSequence: plan.candidateContextMinimumSequence,
    consensus: plan.consensus,
    endpoint: plan.endpoint,
    expectedChainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    expectedCheckpointPolicyId: plan.expectedCheckpointPolicyId,
    networkId: plan.networkId,
    operatorId: plan.operatorId,
    tlsCertificateSha256: plan.tlsCertificateSha256,
    transport: plan.transport,
  }, "VALIDATOR_ADMISSION_PLAN_V1");
}

export function validateValidatorAdmissionSigningPackage(value, plan, { now = Date.now() } = {}) {
  exact(value, ["amount", "candidateContext", "candidateContextHash",
    "chainIdentityGenesisHash", "consensus", "endpoint", "fee", "format", "networkId",
    "nonce", "operatorId", "packageHash", "planCommitment", "referenceHeight",
    "tlsCertificateSha256", "transport", "validUntilHeight", "version"],
  "validator admission signing package");
  if (Buffer.byteLength(canonicalJson(value)) > MAX_ADMISSION_PACKAGE_BYTES) {
    throw new Error("validator admission signing package is too large");
  }
  const { packageHash, ...payload } = value;
  const context = validateValidatorCandidateContext(value.candidateContext, plan, { now });
  const balance = BigInt(context.account?.atomicBalance ?? "-1");
  const expectedValidUntil = context.checkpoint.height +
    VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS;
  if (plan.format !== FORMAT || plan.version !== 2 ||
      value.format !== "nir-validator-admission-signing-package-v1" || value.version !== 1 ||
      value.networkId !== plan.networkId ||
      value.chainIdentityGenesisHash !== plan.expectedChainIdentityGenesisHash ||
      value.planCommitment !== admissionPlanCommitment(plan) ||
      value.candidateContextHash !== context.contextHash ||
      canonicalJson(value.consensus) !== canonicalJson(plan.consensus) ||
      canonicalJson(value.transport) !== canonicalJson(plan.transport) ||
      value.endpoint !== plan.endpoint || value.operatorId !== plan.operatorId ||
      value.tlsCertificateSha256 !== plan.tlsCertificateSha256 ||
      context.protocolVersion !== 32 || context.status !== "not-admitted" ||
      context.admission !== null || context.queuePosition !== null ||
      context.address !== plan.consensus.address ||
      value.amount !== MIN_VALIDATOR_BOND.toString() || value.fee !== MIN_TRANSFER_FEE.toString() ||
      balance < MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE || context.bondAndFeeCovered !== true ||
      value.nonce !== context.account.nextNonce || !Number.isSafeInteger(value.nonce) || value.nonce < 0 ||
      value.referenceHeight !== context.checkpoint.height ||
      value.validUntilHeight !== expectedValidUntil ||
      packageHash !== hashObject(payload, "VALIDATOR_ADMISSION_PACKAGE_V1")) {
    throw new Error("validator admission signing package context or policy is invalid");
  }
  return structuredClone(value);
}

function admissionIntentPath(plan, signingPackage) {
  return join(dirname(plan.paths.consensusVault),
    `admission-intent-${signingPackage.nonce}-${signingPackage.packageHash}.json`);
}

function admissionResolutionPath(plan, signingPackage) {
  return join(dirname(plan.paths.consensusVault),
    `admission-resolution-${signingPackage.nonce}-${signingPackage.packageHash}.json`);
}

function admissionNonceLockPath(plan, nonce) {
  return join(dirname(plan.paths.consensusVault), `admission-nonce-${nonce}.lock`);
}

function persistIdempotentPrivateArtifact(path, value, label, maximumBytes = MAX_ADMISSION_PACKAGE_BYTES) {
  try {
    writeValidatorJoinArtifact(path, value);
    return { created: true, path };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readJson(path, label, true, maximumBytes);
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error(`${label} conflicts with an existing unresolved same-nonce intent`);
    }
    return { created: false, path };
  }
}

export function prepareValidatorAdmissionSigningPackage({ directory, outputPath, now = Date.now(),
  _afterLockAcquire }) {
  const plan = readPlan(directory);
  if (plan.format !== FORMAT || plan.version !== 2) {
    throw new Error("validator admission preparation requires a v2 join workspace");
  }
  const context = latestValidatorCandidateContext(directory, plan, { now });
  if (context === null) throw new Error("a verified candidate context is required before admission preparation");
  validateValidatorCandidateContext(context, plan, { now });
  const payload = {
    amount: MIN_VALIDATOR_BOND.toString(), candidateContext: context,
    candidateContextHash: context.contextHash,
    chainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    consensus: plan.consensus, endpoint: plan.endpoint, fee: MIN_TRANSFER_FEE.toString(),
    format: "nir-validator-admission-signing-package-v1", networkId: plan.networkId,
    nonce: context.account.nextNonce, operatorId: plan.operatorId,
    planCommitment: admissionPlanCommitment(plan), referenceHeight: context.checkpoint.height,
    tlsCertificateSha256: plan.tlsCertificateSha256, transport: plan.transport,
    validUntilHeight: context.checkpoint.height + VALIDATOR_ADMISSION_TRANSACTION_LIFETIME_BLOCKS,
    version: 1,
  };
  const signingPackage = validateValidatorAdmissionSigningPackage({ ...payload,
    packageHash: hashObject(payload, "VALIDATOR_ADMISSION_PACKAGE_V1") }, plan, { now });
  const lockPath = admissionNonceLockPath(plan, signingPackage.nonce);
  const lock = acquireAdmissionNonceLock(lockPath, signingPackage.packageHash, now);
  try {
    if (_afterLockAcquire !== undefined) {
      if (typeof _afterLockAcquire !== "function") throw new Error("signing lock hook is invalid");
      _afterLockAcquire({ lockPath });
    }
    // The nonce reservation and durable intent must be one serialized operation. Re-reading
    // after lock acquisition prevents two concurrent prepares from both passing uniqueness.
    const lockedLatest = latestValidatorCandidateContext(directory, plan, { now });
    if (lockedLatest === null || lockedLatest.contextHash !== signingPackage.candidateContextHash) {
      throw new Error("validator admission package is not based on the latest verified context");
    }
    assertNoUnresolvedAdmissionIntent(plan, signingPackage, { now });
    assertHeldSigningLock(lockPath, lock, lock.owned);
    const intent = persistIdempotentPrivateArtifact(admissionIntentPath(plan, signingPackage),
      signingPackage, "validator admission intent");
    const output = persistIdempotentPrivateArtifact(outputPath, signingPackage,
      "validator admission signing package");
    return { broadcast: false, intentCreated: intent.created, outputCreated: output.created,
      packageHash: signingPackage.packageHash, path: output.path,
      status: "prepared for isolated offline signing" };
  } finally {
    releaseAdmissionNonceLock(lockPath, lock);
  }
}

function validatorAdmissionIntentPackages(plan) {
  const root = dirname(plan.paths.consensusVault);
  return readdirSync(root).filter((name) =>
    /^admission-intent-[0-9]+-[0-9a-f]{64}\.json$/.test(name)).map((name) => {
    const value = readJson(join(root, name), "validator admission intent", true,
      MAX_ADMISSION_PACKAGE_BYTES);
    return validateValidatorAdmissionSigningPackage(value, plan,
      { now: value.candidateContext?.syncedAt });
  });
}

function validateAdmissionResolution(value, signingPackage, plan) {
  exact(value, ["candidateContext", "chainIdentityGenesisHash", "format", "networkId", "nonce",
    "oldPackageHash", "resolutionHash", "version"], "validator admission resolution");
  const { resolutionHash, ...payload } = value;
  const context = validateValidatorCandidateContext(value.candidateContext, plan,
    { now: value.candidateContext?.syncedAt });
  const oldSequence = signingPackage.candidateContext.checkpointTrustPackage?.sequence;
  const newSequence = context.checkpointTrustPackage?.sequence;
  if (value.format !== "nir-validator-admission-resolution-v1" || value.version !== 1 ||
      value.oldPackageHash !== signingPackage.packageHash || value.nonce !== signingPackage.nonce ||
      value.networkId !== plan.networkId ||
      value.chainIdentityGenesisHash !== plan.expectedChainIdentityGenesisHash ||
      context.protocolVersion !== 32 || context.status !== "not-admitted" ||
      context.admission !== null || context.queuePosition !== null ||
      context.address !== plan.consensus.address || context.account.nextNonce !== signingPackage.nonce ||
      context.checkpoint.height <= signingPackage.validUntilHeight ||
      !Number.isSafeInteger(oldSequence) || !Number.isSafeInteger(newSequence) ||
      newSequence <= oldSequence ||
      resolutionHash !== hashObject(payload, "VALIDATOR_ADMISSION_RESOLUTION_V1")) {
    throw new Error("validator admission resolution is invalid or not monotonic");
  }
  return structuredClone(value);
}

function resolvedAdmissionIntent(plan, signingPackage) {
  try {
    return validateAdmissionResolution(readJson(admissionResolutionPath(plan, signingPackage),
      "validator admission resolution", true, MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES + 1024 * 1024),
    signingPackage, plan);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertNoOtherUnresolvedAdmissionIntent(plan, proposed) {
  for (const intent of validatorAdmissionIntentPackages(plan)) {
    if (intent.nonce !== proposed.nonce || intent.packageHash === proposed.packageHash) continue;
    if (resolvedAdmissionIntent(plan, intent) === null) {
      throw new Error("a different unresolved validator admission already uses this nonce");
    }
  }
}

function assertNoUnresolvedAdmissionIntent(plan, proposed, { now }) {
  assertNoOtherUnresolvedAdmissionIntent(plan, proposed);
  validateValidatorAdmissionSigningPackage(proposed, plan, { now });
}

function readExactAdmissionIntent(plan, signingPackage) {
  const intent = validateValidatorAdmissionSigningPackage(readJson(
    admissionIntentPath(plan, signingPackage), "validator admission intent", true,
    MAX_ADMISSION_PACKAGE_BYTES), plan, { now: signingPackage.candidateContext?.syncedAt });
  if (canonicalJson(intent) !== canonicalJson(signingPackage)) {
    throw new Error("validator admission intent does not exactly match the signing package");
  }
  return intent;
}

export function resolveExpiredValidatorAdmissionIntent({ directory, now = Date.now() }) {
  const plan = readPlan(directory);
  if (plan.format !== FORMAT || plan.version !== 2) {
    throw new Error("validator admission resolution requires a v2 join workspace");
  }
  const context = latestValidatorCandidateContext(directory, plan, { now });
  if (context === null) throw new Error("a newer verified candidate context is required");
  const unresolved = validatorAdmissionIntentPackages(plan).filter((intent) =>
    resolvedAdmissionIntent(plan, intent) === null);
  if (unresolved.length !== 1) {
    throw new Error("validator admission resolution requires exactly one unresolved intent");
  }
  const intent = unresolved[0];
  const payload = { candidateContext: context,
    chainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    format: "nir-validator-admission-resolution-v1", networkId: plan.networkId,
    nonce: intent.nonce, oldPackageHash: intent.packageHash, version: 1 };
  const resolution = validateAdmissionResolution({ ...payload,
    resolutionHash: hashObject(payload, "VALIDATOR_ADMISSION_RESOLUTION_V1") }, intent, plan);
  const stored = persistIdempotentPrivateArtifact(admissionResolutionPath(plan, intent), resolution,
    "validator admission resolution", MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES + 1024 * 1024);
  return { broadcast: false, oldPackageHash: intent.packageHash, path: stored.path,
    resolutionHash: resolution.resolutionHash, status: "expired unsubmitted intent resolved" };
}

function validateSigningLock(value, packageHash, now) {
  exact(value, ["format", "packageHash", "pid", "startedAt", "token", "version"],
    "validator admission signing lock");
  if (value.format !== "nir-validator-admission-signing-lock-v1" || value.version !== 1 ||
      (packageHash !== null && value.packageHash !== packageHash) ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 ||
      value.startedAt > now + 30_000 || !HASH.test(value.token ?? "")) {
    throw new Error("validator admission signing lock is invalid");
  }
  return structuredClone(value);
}

function processIsLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function quarantineOwnedSigningLock(path, identity, expected) {
  const parent = pinDirectory(dirname(path));
  const quarantine = join(parent.path,
    `.${basename(path)}.quarantine-${randomBytes(16).toString("hex")}`);
  try {
    parent.assert();
    const current = lstatSync(path);
    const record = readJson(path, "validator admission signing lock", true, 64 * 1024);
    if (!sameIdentity(current, identity) || canonicalJson(record) !== canonicalJson(expected)) {
      throw new Error("validator admission signing lock changed before recovery");
    }
    renameSync(path, quarantine);
    const moved = lstatSync(quarantine);
    const movedRecord = readJson(quarantine, "validator admission signing lock", true, 64 * 1024);
    if (!sameIdentity(moved, identity) || canonicalJson(movedRecord) !== canonicalJson(expected)) {
      try { linkSync(quarantine, path); } catch { /* fail closed with quarantine retained */ }
      throw new Error("validator admission signing lock changed during recovery");
    }
    fsyncSync(parent.descriptor); parent.assert();
    unlinkSync(quarantine); fsyncSync(parent.descriptor); parent.assert();
  } finally { closeSync(parent.descriptor); }
}

function assertOwnedSigningLock(path, identity, expected) {
  const before = lstatSync(path);
  const record = readJson(path, "validator admission signing lock", true, 64 * 1024);
  const after = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !sameIdentity(before, identity) ||
      !sameIdentity(after, identity) || canonicalJson(record) !== canonicalJson(expected)) {
    throw new Error("validator admission signing lock ownership is not stable");
  }
  return after;
}

function assertHeldSigningLock(path, lock, expected) {
  const held = fstatSync(lock.descriptor);
  if (!held.isFile() || !sameIdentity(held, lock.identity)) {
    throw new Error("validator admission signing lock descriptor changed");
  }
  return assertOwnedSigningLock(path, lock.identity, expected);
}

function acquireAdmissionNonceLock(path, packageHash, now) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owned = { format: "nir-validator-admission-signing-lock-v1", packageHash,
      pid: process.pid, startedAt: now, token: randomBytes(32).toString("hex"), version: 1 };
    try {
      writeValidatorJoinArtifact(path, owned);
      const identity = lstatSync(path);
      assertOwnedSigningLock(path, identity, owned);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const lock = { descriptor, identity, owned };
      try { assertHeldSigningLock(path, lock, owned); }
      catch (error) { closeSync(descriptor); throw error; }
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const before = lstatSync(path);
      const lock = validateSigningLock(readJson(path,
        "validator admission signing lock", true, 64 * 1024), null, now);
      if (now - lock.startedAt <= VALIDATOR_ADMISSION_SIGNING_LOCK_LEASE_MS &&
          processIsLive(lock.pid)) {
        throw new Error("validator admission signing is already in progress");
      }
      const current = validateSigningLock(readJson(path,
        "validator admission signing lock", true, 64 * 1024), null, now);
      if (canonicalJson(current) !== canonicalJson(lock) ||
          (now - current.startedAt <= VALIDATOR_ADMISSION_SIGNING_LOCK_LEASE_MS &&
           processIsLive(current.pid))) {
        throw new Error("validator admission signing lock changed or renewed during recovery");
      }
      quarantineOwnedSigningLock(path, before, lock);
    }
  }
  throw new Error("validator admission signing lock could not be acquired");
}

function releaseAdmissionNonceLock(path, lock) {
  try {
    assertHeldSigningLock(path, lock, lock.owned);
    quarantineOwnedSigningLock(path, lock.identity, lock.owned);
  } finally {
    closeSync(lock.descriptor);
  }
}

export function signValidatorAdmissionPackage({ directory, packagePath, outputPath,
  consensusPassword, transportPassword, now = Date.now(), _afterLockAcquire }) {
  const plan = readPlan(directory);
  if (plan.format !== FORMAT || plan.version !== 2) {
    throw new Error("validator admission signing requires a v2 join workspace");
  }
  const storedPackage = readJson(packagePath, "validator admission signing package", true,
    MAX_ADMISSION_PACKAGE_BYTES);
  const signingPackage = validateValidatorAdmissionSigningPackage(storedPackage, plan,
    { now: storedPackage.candidateContext?.syncedAt });
  const root = dirname(plan.paths.consensusVault);
  const journalPath = join(root, `admission-signature-${signingPackage.nonce}-${signingPackage.packageHash}.json`);
  const validateSigned = (signed) => {
    exact(signed, ["broadcast", "format", "packageHash", "transaction", "transactionId", "version"],
      "signed validator admission");
    const verified = verifyValidatorAdmission(signed.transaction, plan.networkId, {
      chainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
      currentHeight: signingPackage.referenceHeight + 1, protocolVersion: 32,
    });
    const { signature: _signature, transportSignature: _transportSignature,
      ...unsigned } = signed.transaction;
    const expectedUnsigned = {
      algorithm: plan.consensus.algorithm,
      amount: signingPackage.amount,
      chainIdentityGenesisHash: signingPackage.chainIdentityGenesisHash,
      endpoint: signingPackage.endpoint,
      fee: signingPackage.fee,
      networkId: signingPackage.networkId,
      nonce: signingPackage.nonce,
      operatorId: signingPackage.operatorId,
      publicKey: plan.consensus.publicKey,
      referenceHeight: signingPackage.referenceHeight,
      sender: plan.consensus.address,
      tlsCertificateSha256: signingPackage.tlsCertificateSha256,
      transportAlgorithm: plan.transport.algorithm,
      transportPublicKey: plan.transport.publicKey,
      type: "validator-admission",
      validUntilHeight: signingPackage.validUntilHeight,
    };
    if (signed.broadcast !== false || signed.format !== "nir-signed-validator-admission-v1" ||
        signed.version !== 1 || signed.packageHash !== signingPackage.packageHash ||
        signed.transactionId !== transactionId(signed.transaction) ||
        canonicalJson(unsigned) !== canonicalJson(expectedUnsigned) ||
        verified.payload.sender !== plan.consensus.address ||
        verified.transport.address !== plan.transport.address ||
        verified.payload.publicKey !== plan.consensus.publicKey ||
        verified.payload.transportPublicKey !== plan.transport.publicKey ||
        verified.payload.nonce !== signingPackage.nonce ||
        verified.payload.referenceHeight !== signingPackage.referenceHeight ||
        verified.payload.validUntilHeight !== signingPackage.validUntilHeight) {
      throw new Error("signed validator admission identity or package binding is invalid");
    }
    return structuredClone(signed);
  };
  const materialize = (signed, journalCreated) => {
    const output = persistIdempotentPrivateArtifact(outputPath, signed,
      "signed validator admission", 1024 * 1024);
    return { broadcast: false, journalCreated, outputCreated: output.created,
      packageHash: signingPackage.packageHash, path: output.path,
      status: "signed offline; unresolved and not submitted", transactionId: signed.transactionId };
  };
  // Signing is only allowed for an already reserved, byte-identical prepare intent.
  readExactAdmissionIntent(plan, signingPackage);
  assertNoOtherUnresolvedAdmissionIntent(plan, signingPackage);
  try {
    return materialize(validateSigned(readJson(journalPath, "signed validator admission", true,
      1024 * 1024)), false);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lockPath = admissionNonceLockPath(plan, signingPackage.nonce);
  const lock = acquireAdmissionNonceLock(lockPath, signingPackage.packageHash, now);
  try {
    // Another process may have completed while this caller waited for the nonce lock.
    try {
      return materialize(validateSigned(readJson(journalPath, "signed validator admission", true,
        1024 * 1024)), false);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    readExactAdmissionIntent(plan, signingPackage);
    const latest = latestValidatorCandidateContext(directory, plan, { now });
    if (latest === null || latest.contextHash !== signingPackage.candidateContextHash) {
      throw new Error("validator admission package is not based on the latest verified context");
    }
    // Re-read every same-nonce intent under the lock; pre-lock uniqueness is never authoritative.
    assertNoUnresolvedAdmissionIntent(plan, signingPackage, { now });
    if (_afterLockAcquire !== undefined) {
      if (typeof _afterLockAcquire !== "function") throw new Error("signing lock hook is invalid");
      _afterLockAcquire({ lockPath });
    }
    const transaction = signValidatorAdmissionWithWalletFiles({
      consensusPassword, consensusPath: plan.paths.consensusVault,
      intent: signingPackage, transportPassword, transportPath: plan.paths.transportVault,
    });
    const signed = validateSigned({ broadcast: false,
      format: "nir-signed-validator-admission-v1", packageHash: signingPackage.packageHash,
      transaction, transactionId: transactionId(transaction), version: 1 });
    assertHeldSigningLock(lockPath, lock, lock.owned);
    const journal = persistIdempotentPrivateArtifact(journalPath, signed,
      "signed validator admission", 1024 * 1024);
    return materialize(signed, journal.created);
  } finally {
    releaseAdmissionNonceLock(lockPath, lock);
  }
}
export async function syncValidatorJoinCandidateContext({ directory, syncInput, request }) {
  const plan = readPlan(directory);
  if (plan.format !== FORMAT || plan.version !== 2) {
    throw new Error("candidate context sync requires explicit migration to a v2 join plan with pinned floors");
  }
  const context = await synchronizeValidatorCandidateContext({ plan, syncInput, request });
  const path = join(dirname(plan.paths.consensusVault), `candidate-context-${context.contextHash}.json`);
  try { writeValidatorJoinArtifact(path, context); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = validateValidatorCandidateContext(readJson(path,
      "validator candidate context", true, MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES), plan);
    if (canonicalJson(existing) !== canonicalJson(context)) throw error;
  }
  return { context, path };
}
export function verifyValidatorJoinWorkspace({ directory, consensusPassword, transportPassword }) {
  const plan = readPlan(directory);
  const consensus = verifyWalletFile({ path: plan.paths.consensusVault, password: consensusPassword });
  const transport = verifyWalletFile({ path: plan.paths.transportVault, password: transportPassword });
  if (consensus.address !== plan.consensus.address || transport.address !== plan.transport.address ||
      consensus.address === transport.address) throw new Error("validator join identity verification failed");
  return { broadcast: false, consensusAddress: consensus.address, networkId: plan.networkId,
    status: "awaiting external v31 candidate service / quorum observation",
    transportAddress: transport.address, verified: true };
}
export function createValidatorJoinBackups({ directory, backupDirectory, consensusPassword, transportPassword, generation = 1 }) {
  const plan = readPlan(directory); const requested = resolve(backupDirectory);
  const parent = pinDirectory(dirname(requested)); const target = join(parent.path, basename(requested));
  const staging = join(parent.path, `.${basename(target)}.nir-validator-backup-${randomBytes(16).toString("hex")}`);
  let identity = null; let activationIdentity = null;
  try {
    mkdirSync(staging, { mode: 0o700 }); chmodSync(staging, 0o700); identity = lstatSync(staging);
    const consensus = createVerifiedWalletBackup({ sourcePath: plan.paths.consensusVault,
      targetPath: join(staging, "consensus.backup.json"), password: consensusPassword,
      networkId: plan.networkId, generation });
    const transport = createVerifiedWalletBackup({ sourcePath: plan.paths.transportVault,
      targetPath: join(staging, "transport.backup.json"), password: transportPassword,
      networkId: plan.networkId, generation });
    parent.assert(); if (!sameIdentity(lstatSync(staging), identity)) throw new Error("validator backup staging changed");
    symlinkSync(basename(staging), target, "dir"); activationIdentity = lstatSync(target);
    fsyncSync(parent.descriptor); parent.assert();
    if (!activationIdentity.isSymbolicLink() || readlinkSync(target) !== basename(staging) ||
        !sameIdentity(lstatSync(staging), identity)) throw new Error("validator backup activation changed");
    identity = null;
    return { consensus: { ...consensus, path: join(target, "consensus.backup.json") },
      transport: { ...transport, path: join(target, "transport.backup.json") } };
  } catch (error) {
    if (activationIdentity) try { const current = lstatSync(target); if (current.isSymbolicLink() && sameIdentity(current, activationIdentity) && readlinkSync(target) === basename(staging)) unlinkSync(target); } catch (cleanup) { if (cleanup?.code !== "ENOENT") error.cleanupError = cleanup.message; }
    if (identity) removeStaging(staging, identity, error); throw error;
  }
  finally { closeSync(parent.descriptor); }
}
