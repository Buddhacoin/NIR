import { X509Certificate, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "./crypto.mjs";
import {
  createVerifiedWalletBackup, createWalletFile, verifyWalletFile, walletPublicInfo,
} from "./wallet-files.mjs";

const FORMAT = "nir-validator-join-plan-v1";
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

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
function readJson(path, label, privateFile = false) {
  const requested = resolve(path); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested)); let descriptor;
  try {
    parent.assert(); const linked = lstatSync(target);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !sameIdentity(before, linked) ||
        before.size < 2 || before.size > MAX_JSON_BYTES ||
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
export function validateValidatorJoinConfig(value) {
  exact(value, ["endpoint", "expectedChainIdentityGenesisHash", "expectedCheckpointPolicyId", "expectedTlsCertificateSha256", "format", "networkId", "operatorId", "tlsCertificate", "tlsPrivateKey", "version"], "validator join config");
  if (value.format !== "nir-validator-join-config-v1" || value.version !== 1 || !NETWORK.test(value.networkId ?? "") ||
      !OPERATOR.test(value.operatorId ?? "") || !HASH.test(value.expectedChainIdentityGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") || !HASH.test(value.expectedTlsCertificateSha256 ?? "") ||
      !isAbsolute(value.tlsCertificate ?? "") || !isAbsolute(value.tlsPrivateKey ?? "") || value.tlsCertificate === value.tlsPrivateKey) throw new Error("validator join config is invalid");
  return { ...structuredClone(value), endpoint: normalizeEndpoint(value.endpoint) };
}
export function loadValidatorJoinInputs(configPath) {
  const config = validateValidatorJoinConfig(readJson(configPath, "validator join config", true));
  return { config, tlsCertificatePem: readText(config.tlsCertificate, "validator TLS certificate", false),
    tlsPrivateKeyPem: readText(config.tlsPrivateKey, "validator TLS private key", true) };
}
export function validateValidatorJoinPlan(value, root) {
  exact(value, ["broadcast", "consensus", "endpoint", "expectedChainIdentityGenesisHash", "expectedCheckpointPolicyId", "format", "networkId", "operatorId", "paths", "status", "tlsCertificateSha256", "transport", "version"], "validator join plan");
  exact(value.paths, ["consensusVault", "transportVault"], "validator join paths");
  const paths = { consensusVault: join(root, "consensus.nirvault.json"), transportVault: join(root, "transport.nirvault.json") };
  if (value.format !== FORMAT || value.version !== 1 || value.broadcast !== false || value.status !== "awaiting-external-v31-candidate-service" ||
      !NETWORK.test(value.networkId ?? "") || !OPERATOR.test(value.operatorId ?? "") || !HASH.test(value.tlsCertificateSha256 ?? "") ||
      !HASH.test(value.expectedChainIdentityGenesisHash ?? "") || !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") ||
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
    const plan = { broadcast: false, consensus, endpoint: config.endpoint, expectedChainIdentityGenesisHash: config.expectedChainIdentityGenesisHash, expectedCheckpointPolicyId: config.expectedCheckpointPolicyId, format: FORMAT, networkId: config.networkId, operatorId: config.operatorId, paths: { consensusVault: join(staging, "consensus.nirvault.json"), transportVault: join(staging, "transport.nirvault.json") }, status: "awaiting-external-v31-candidate-service", tlsCertificateSha256: fingerprint, transport, version: 1 };
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
  return { address: plan.consensus.address, broadcast: false, endpoint: plan.endpoint, networkId: plan.networkId,
    status: "awaiting external v31 candidate service / quorum observation",
    next: ["create and verify encrypted backups",
      "wait for the separately reviewed external v31 candidate service (not implemented)",
      "through that service obtain proof-backed balance, nonce, finalized inclusion, and endpoint observation",
      "after quorum-observed admission wait for a non-skipping authorized rotation"] };
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
