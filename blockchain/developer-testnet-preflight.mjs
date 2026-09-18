import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { addressFromPublicKey, canonicalJson, hashObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { compileGenesis } from "./genesis-ceremony.mjs";
import { validateOfflineReleaseBundle } from "./offline-release-bundle.mjs";
import {
  validateReleaseTransparencyAnchor, validateReleaseTransparencyCheckpoint,
} from "./offline-release-governance.mjs";
import { selectReleaseWitnessView, validateReleaseWitnessSet } from "./offline-release-witness.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";

const INPUT_FORMAT = "nir-developer-testnet-preflight-v1";
const REPORT_FORMAT = "nir-developer-testnet-preflight-report-v1";
const MAX_JSON_BYTES = 192 * 1024 * 1024;
const MAX_SCAN_FILES = 20_000;
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const NETWORK = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_NAME = /(?:^|[._-])(?:private(?:key)?|secret|seed|mnemonic|password)(?:$|[._-])/i;
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|DEVNET-KEYS\.json|[^/]+\.(?:key|pem|p12|pfx|jks|keystore)|[^/]*\.nirvault(?:\.json)?)(?:$|\/)/i;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function requireSecureFs() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new Error("secure preflight filesystem support is unavailable");
  }
}

function openRoot(path) {
  requireSecureFs();
  const resolved = resolve(path);
  const before = lstatSync(resolved);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o022) !== 0) {
    throw new Error("preflight root is unsafe");
  }
  const descriptor = openSync(resolved,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !same(before, opened)) {
    closeSync(descriptor); throw new Error("preflight root changed during open");
  }
  return { descriptor, metadata: opened, path: resolved };
}

function assertRoot(root) {
  const opened = fstatSync(root.descriptor);
  const linked = lstatSync(root.path);
  if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      !same(opened, root.metadata) || !same(linked, root.metadata) ||
      opened.mode !== root.metadata.mode || opened.uid !== root.metadata.uid ||
      opened.mtimeMs !== root.metadata.mtimeMs || opened.ctimeMs !== root.metadata.ctimeMs ||
      linked.mtimeMs !== root.metadata.mtimeMs || linked.ctimeMs !== root.metadata.ctimeMs) {
    throw new Error("preflight root changed during verification");
  }
}

function relativeName(value, label) {
  if (typeof value !== "string" || !SAFE_NAME.test(value) || value === "." || value === "..") {
    throw new Error(`${label} path is unsafe`);
  }
  return value;
}

function readBounded(root, nameValue, maximum = MAX_JSON_BYTES, options = {}) {
  const name = relativeName(nameValue, "preflight artifact");
  const path = join(root.path, name);
  let descriptor;
  try {
    assertRoot(root);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum ||
        !same(before, lstatSync(path))) throw new Error("preflight artifact is unsafe");
    options._afterFileOpen?.({ descriptor, name, path });
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (length === 0) throw new Error("preflight artifact changed during read");
      offset += length;
    }
    const after = fstatSync(descriptor);
    assertRoot(root);
    if (!same(before, after) || !same(before, lstatSync(path)) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("preflight artifact changed during read");
    }
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function readJson(root, name, maximum, options) {
  const bytes = readBounded(root, name, maximum, options);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("preflight artifact JSON is invalid"); }
  return value;
}

function validateInput(value) {
  exact(value, ["archiveOperators", "artifacts", "bondedValidators", "format", "host",
    "networkId", "operatorRoots", "policy", "release", "version"], "preflight input");
  exact(value.artifacts, ["backupDrill", "genesis", "genesisEnvelope", "genesisPlan",
    "releaseAnchor", "releaseBundle", "releaseCheckpoint", "signedRelease", "witnessReceipts",
    "witnessSet"], "preflight artifacts");
  for (const [label, name] of Object.entries(value.artifacts)) relativeName(name, label);
  exact(value.release, ["anchorHash", "bundleHash", "checkpointHash", "sourceManifestHash",
    "trustedSignerAddress", "witnessSetId"],
    "preflight release expectation");
  exact(value.policy, ["maxClockOffsetMs", "maxDrillAgeMs", "maxFutureSkewMs",
    "maxWitnessAgeMs", "minDiskFreeBytes", "minFileDescriptors"], "preflight policy");
  exact(value.host, ["clockOffsetMs", "diskFreeBytes", "fileDescriptorLimit", "ingressProfiles",
    "observedAt", "ports", "tlsEndpoints"], "preflight host observation");
  if (value.format !== INPUT_FORMAT || value.version !== 1 || !NETWORK.test(value.networkId ?? "") ||
      !HASH.test(value.release.anchorHash ?? "") || !HASH.test(value.release.bundleHash ?? "") ||
      !HASH.test(value.release.checkpointHash ?? "") || !HASH.test(value.release.witnessSetId ?? "") ||
      !/^[0-9a-f]{64}$/.test(
        value.release.sourceManifestHash ?? "") ||
      !ADDRESS.test(value.release.trustedSignerAddress ?? "")) throw new Error("preflight header is invalid");
  for (const key of Object.keys(value.policy)) {
    if (!Number.isSafeInteger(value.policy[key]) || value.policy[key] < 0) {
      throw new Error("preflight policy value is invalid");
    }
  }
  if (!Number.isSafeInteger(value.host.observedAt) || value.host.observedAt < 0 ||
      !Number.isSafeInteger(value.host.clockOffsetMs) ||
      !Number.isSafeInteger(value.host.diskFreeBytes) || value.host.diskFreeBytes < 0 ||
      !Number.isSafeInteger(value.host.fileDescriptorLimit) || value.host.fileDescriptorLimit < 0 ||
      !Array.isArray(value.host.ports) || !Array.isArray(value.host.tlsEndpoints) ||
      !Array.isArray(value.host.ingressProfiles) ||
      !Array.isArray(value.archiveOperators) || !Array.isArray(value.bondedValidators) ||
      !Array.isArray(value.operatorRoots)) throw new Error("preflight collections are invalid");
  value.operatorRoots.forEach((name) => relativeName(name, "operator root"));
  return structuredClone(value);
}

function publicOperator(value, label) {
  exact(value, ["address", "algorithm", "operatorId", "publicKey"], label);
  if (!ADDRESS.test(value.address ?? "") || value.algorithm !== SIGNATURE_ALGORITHM ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.operatorId ?? "") ||
      typeof value.publicKey !== "string" || value.publicKey.length > 8_000 ||
      addressFromPublicKey(value.publicKey) !== value.address) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function httpsEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("TLS endpoint is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "" && url.pathname !== "/")) throw new Error("TLS endpoint is invalid");
  return { endpoint: url.origin, host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 443) };
}

function archiveOperator(value) {
  exact(value, ["address", "algorithm", "endpoint", "operatorId", "publicKey"], "archive operator");
  const { endpoint, ...identity } = value;
  return { ...publicOperator(identity, "archive operator"), endpoint: httpsEndpoint(endpoint).endpoint };
}

function validateHost(input, plan) {
  const { host, policy } = input;
  if (Math.abs(host.clockOffsetMs) > policy.maxClockOffsetMs ||
      host.diskFreeBytes < policy.minDiskFreeBytes ||
      host.fileDescriptorLimit < policy.minFileDescriptors) {
    throw new Error("host capacity or clock policy failed");
  }
  const ports = new Map();
  for (const port of host.ports) {
    exact(port, ["available", "host", "port", "role"], "port observation");
    const key = `${port.host}:${port.port}`;
    if (port.available !== true || typeof port.host !== "string" || port.host.length < 1 ||
        port.host.length > 253 ||
        !Number.isSafeInteger(port.port) || port.port < 1024 || port.port > 65535 ||
        typeof port.role !== "string" || ports.has(key)) throw new Error("port readiness failed");
    ports.set(key, port.role);
  }
  const roles = new Set();
  for (const profile of host.ingressProfiles) {
    exact(profile, ["bodyIdleTimeoutMs", "maxBodyBytes", "maxConnections", "maxHeaderBytes",
      "maxUrlBytes", "requestTimeoutMs", "role"], "ingress profile");
    if (typeof profile.role !== "string" || roles.has(profile.role) ||
        [profile.bodyIdleTimeoutMs, profile.maxBodyBytes, profile.maxConnections,
          profile.maxHeaderBytes, profile.maxUrlBytes, profile.requestTimeoutMs]
          .some((value) => !Number.isSafeInteger(value)) ||
        profile.maxBodyBytes < 1 ||
        profile.maxBodyBytes > 2 * 1024 * 1024 || profile.maxHeaderBytes > 16 * 1024 ||
        profile.maxHeaderBytes < 1 || profile.maxConnections < 1 || profile.maxConnections > 128 ||
        profile.maxUrlBytes < 1 || profile.maxUrlBytes > 2_048 ||
        profile.bodyIdleTimeoutMs < 1 || profile.bodyIdleTimeoutMs > 5_000 ||
        profile.requestTimeoutMs < 1 || profile.requestTimeoutMs > 10_000) {
      throw new Error("ingress limits are absent or unsafe");
    }
    roles.add(profile.role);
  }
  for (const role of ["validator", "beacon", "evaluator", "archive"]) {
    if (!roles.has(role)) throw new Error("required ingress profile is missing");
  }
  const expected = [
    ...plan.validators.map(({ endpoint }) => ({ endpoint, role: "validator" })),
    ...plan.beaconAuthorities.map(({ endpoint }) => ({ endpoint, role: "beacon" })),
    ...plan.evaluators.map(({ endpoint }) => ({ endpoint, role: "evaluator" })),
    ...input.archiveOperators.map((operator) => ({
      endpoint: archiveOperator(operator).endpoint, role: "archive",
    })),
  ].sort((left, right) => left.endpoint.localeCompare(right.endpoint));
  const tls = new Map();
  for (const entry of host.tlsEndpoints) {
    exact(entry, ["endpoint", "role", "tlsCertificateSha256"], "TLS endpoint observation");
    const normalized = httpsEndpoint(entry.endpoint);
    if (!/^[0-9a-f]{64}$/.test(entry.tlsCertificateSha256 ?? "") ||
        typeof entry.role !== "string" || tls.has(normalized.endpoint)) {
      throw new Error("TLS pin inventory is invalid");
    }
    tls.set(normalized.endpoint, { ...normalized, role: entry.role });
  }
  if (tls.size !== expected.length || expected.some(({ endpoint, role }) => {
    const normalized = httpsEndpoint(endpoint); const observed = tls.get(normalized.endpoint);
    return !observed || observed.role !== role || ports.get(`${observed.host}:${observed.port}`) !== role;
  }) || ports.size !== expected.length) throw new Error("TLS pins or port observations are incomplete");
  for (const validator of plan.validators) {
    const observed = host.tlsEndpoints.find(({ endpoint }) =>
      httpsEndpoint(endpoint).endpoint === httpsEndpoint(validator.endpoint).endpoint);
    if (!/^[0-9a-f]{64}$/.test(validator.tlsCertificateSha256 ?? "") ||
        observed?.tlsCertificateSha256 !== validator.tlsCertificateSha256) {
      throw new Error("validator TLS pin does not match genesis");
    }
  }
  return { ingressProfiles: roles.size, ports: ports.size };
}

function secretScan(root, names) {
  let files = 0;
  for (const name of names) {
    if (++files > MAX_SCAN_FILES || SECRET_FILE.test(name)) {
      throw new Error("operator tree contains an unsafe or secret-bearing file");
    }
    const bytes = readBounded(root, name, MAX_SCAN_FILE_BYTES);
    const text = bytes.toString("utf8");
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text) ||
        /"(?:privateKey|secretKey|seed|mnemonic|password)"\s*:/i.test(text) ||
        SECRET_NAME.test(name)) {
      throw new Error("operator tree contains plaintext secret material");
    }
  }
  return { scannedFiles: files };
}

function validatePublicInventory(root, input) {
  const allowed = ["preflight.json", ...Object.values(input.artifacts), ...input.operatorRoots];
  if (new Set(allowed).size !== allowed.length) {
    throw new Error("public artifact filenames are duplicated");
  }
  assertRoot(root);
  const present = readdirSync(root.path).sort();
  const expected = [...allowed].sort();
  if (present.length !== expected.length || present.some((name, index) => name !== expected[index])) {
    throw new Error("public artifact root contains missing or unexpected entries");
  }
  for (const name of expected) {
    const metadata = lstatSync(join(root.path, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || SECRET_FILE.test(name)) {
      throw new Error("public artifact root contains an unsafe file");
    }
  }
  assertRoot(root);
  return secretScan(root, input.operatorRoots);
}

function parseBond(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,30})$/.test(value)) {
    throw new Error("validator bond is invalid");
  }
  return BigInt(value);
}

export function runDeveloperTestnetPreflight(rootPath, options = {}) {
  const root = openRoot(rootPath);
  try {
    const input = validateInput(readJson(root, "preflight.json", 256 * 1024, options));
    const artifacts = new Map();
    const artifact = (key) => {
      if (!artifacts.has(key)) artifacts.set(key,
        readJson(root, input.artifacts[key], undefined, options));
      return artifacts.get(key);
    };
    const checks = [];
    const check = (id, operation) => {
      try { checks.push({ details: operation(), id, status: "PASS" }); }
      catch { checks.push({ details: { reason: `${id}-verification-failed` },
        id, status: "FAIL" }); }
    };
    let bundle; let anchor; let checkpoint; let witnessSet; let plan; let compiled;
    check("release", () => {
      bundle = validateOfflineReleaseBundle(artifact("releaseBundle"));
      anchor = validateReleaseTransparencyAnchor(artifact("releaseAnchor"));
      checkpoint = validateReleaseTransparencyCheckpoint(artifact("releaseCheckpoint"), anchor);
      if (bundle.bundleHash !== input.release.bundleHash || bundle.manifest.networkId !== input.networkId ||
          anchor.networkId !== input.networkId || checkpoint.networkId !== input.networkId ||
          anchor.anchorHash !== input.release.anchorHash ||
          checkpoint.checkpointHash !== input.release.checkpointHash ||
          checkpoint.lastBundleHash !== bundle.bundleHash) throw new Error("release or network binding failed");
      return { bundleHash: bundle.bundleHash, checkpointHash: checkpoint.checkpointHash,
        sequence: checkpoint.sequence };
    });
    check("external-witness-quorum", () => {
      if (!anchor || !checkpoint) throw new Error("release checkpoint is unavailable");
      witnessSet = validateReleaseWitnessSet(artifact("witnessSet"));
      if (witnessSet.witnessSetId !== input.release.witnessSetId) {
        throw new Error("witness policy is not the expected external trust root");
      }
      const receipts = artifact("witnessReceipts");
      const selection = selectReleaseWitnessView(receipts, {
        anchor, maxAgeMs: input.policy.maxWitnessAgeMs,
        maxFutureSkewMs: input.policy.maxFutureSkewMs, now: input.host.observedAt,
        sequence: checkpoint.sequence, witnessSet,
      });
      if (selection.checkpointHash !== checkpoint.checkpointHash ||
          selection.entryHash !== checkpoint.entryHash) throw new Error("witness quorum selected another checkpoint");
      return { selectionHash: selection.selectionHash, witnesses: selection.witnesses.length };
    });
    check("genesis", () => {
      const signedRelease = artifact("signedRelease");
      const verifiedRelease = verifySignedRelease(signedRelease,
        { trustedAddress: input.release.trustedSignerAddress });
      if (verifiedRelease.manifest.manifestHash !== input.release.sourceManifestHash) {
        throw new Error("genesis source release does not match expectation");
      }
      plan = artifact("genesisPlan");
      compiled = compileGenesis(plan, artifact("genesisEnvelope"), {
        signedRelease, trustedAddress: input.release.trustedSignerAddress,
      });
      if (compiled.genesis.networkId !== input.networkId ||
          canonicalJson(compiled.genesis) !== canonicalJson(artifact("genesis"))) {
        throw new Error("compiled genesis or network does not match");
      }
      return { genesisHash: compiled.genesisHash, planCommitment: compiled.planCommitment };
    });
    check("role-and-key-separation", () => {
      if (!plan) throw new Error("verified genesis plan is unavailable");
      const identities = [];
      for (const role of ["validators", "beaconAuthorities", "evaluators"]) {
        for (const identity of plan[role]) identities.push({ ...identity, role });
      }
      for (const validator of plan.validators) identities.push({ ...validator.transport,
        operatorId: validator.operatorId, role: "transport" });
      for (const archive of input.archiveOperators) identities.push({
        ...archiveOperator(archive), role: "archive",
      });
      if (input.archiveOperators.length < 2 || input.archiveOperators.length > 128) {
        throw new Error("archive operator set is not independently bounded");
      }
      const addresses = new Set(); const keys = new Set(); const operators = new Map();
      for (const identity of identities) {
        const ownerRole = identity.role === "transport" ? "validators" : identity.role;
        const priorRole = operators.get(identity.operatorId);
        if (addresses.has(identity.address) || keys.has(identity.publicKey) ||
            priorRole !== undefined && !(identity.role === "transport" && priorRole === "validators")) {
          throw new Error("role identities or keys are duplicated");
        }
        addresses.add(identity.address); keys.add(identity.publicKey);
        if (priorRole === undefined) operators.set(identity.operatorId, ownerRole);
      }
      return { identities: identities.length, operators: operators.size,
        tlsPins: plan.validators.filter(({ tlsCertificateSha256 }) => tlsCertificateSha256).length };
    });
    check("bonded-validator-eligibility", () => {
      if (!plan) throw new Error("verified validator set is unavailable");
      const bonds = new Map(input.bondedValidators.map((entry) => {
        exact(entry, ["address", "bondAtomic"], "validator eligibility");
        if (!ADDRESS.test(entry.address ?? "")) throw new Error("validator eligibility is invalid");
        return [entry.address, parseBond(entry.bondAtomic)];
      }));
      if (bonds.size !== input.bondedValidators.length || bonds.size !== plan.validators.length ||
          plan.validators.some(({ address }) => (bonds.get(address) ?? 0n) < MIN_VALIDATOR_BOND)) {
        throw new Error("validator set is not fully bonded and eligible");
      }
      return { eligible: bonds.size, minimumBondAtomic: MIN_VALIDATOR_BOND.toString() };
    });
    check("backup-restore-freshness", () => {
      const drill = artifact("backupDrill");
      exact(drill, ["checkpointHash", "completedAt", "downloadedFrom", "format", "height",
        "inventoryRoot", "networkId", "privateKeysIncluded", "sources", "stateRoot", "tipHash",
        "workspace"], "backup drill");
      if (drill.format !== "nir-backup-restore-drill-v1" || drill.networkId !== input.networkId ||
          drill.privateKeysIncluded !== false || !Number.isSafeInteger(drill.completedAt) ||
          drill.completedAt > input.host.observedAt + input.policy.maxFutureSkewMs ||
          drill.completedAt < input.host.observedAt - input.policy.maxDrillAgeMs ||
          !Number.isSafeInteger(drill.height) || drill.height < 0 ||
          !/^[0-9a-f]{64}$/.test(drill.checkpointHash ?? "") ||
          !/^[0-9a-f]{64}$/.test(drill.inventoryRoot ?? "") ||
          !/^[0-9a-f]{64}$/.test(drill.stateRoot ?? "") ||
          !/^[0-9a-f]{64}$/.test(drill.tipHash ?? "") ||
          !Array.isArray(drill.sources) || drill.sources.length < 2 ||
          new Set(drill.sources).size !== drill.sources.length ||
          drill.sources.some((source, index) => typeof source !== "string" ||
            index > 0 && drill.sources[index - 1] >= source) ||
          !drill.sources.includes(drill.downloadedFrom) || typeof drill.workspace !== "string") {
        throw new Error("backup drill is stale or invalid");
      }
      return { ageMs: input.host.observedAt - drill.completedAt, sources: drill.sources.length };
    });
    check("host-readiness", () => {
      if (!plan) throw new Error("verified role endpoints are unavailable");
      return validateHost(input, plan);
    });
    check("public-artifact-scan", () => validatePublicInventory(root, input));
    checks.sort((left, right) => left.id.localeCompare(right.id));
    const failed = checks.filter(({ status }) => status === "FAIL").length;
    const payload = {
      checks, format: REPORT_FORMAT, networkId: input.networkId, observedAt: input.host.observedAt,
      summary: { failed, passed: checks.length - failed, status: failed === 0 ? "PASS" : "FAIL" },
      version: 1,
    };
    return { ...payload, reportHash: hashObject(payload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1") };
  } finally { closeSync(root.descriptor); }
}

export function serializeDeveloperTestnetPreflightReport(report) {
  return `${canonicalJson(validateDeveloperTestnetPreflightReport(report))}\n`;
}

const DETAIL_FIELDS = Object.freeze({
  "backup-restore-freshness": ["ageMs", "sources"],
  "bonded-validator-eligibility": ["eligible", "minimumBondAtomic"],
  "external-witness-quorum": ["selectionHash", "witnesses"],
  genesis: ["genesisHash", "planCommitment"],
  "host-readiness": ["ingressProfiles", "ports"],
  "public-artifact-scan": ["scannedFiles"],
  release: ["bundleHash", "checkpointHash", "sequence"],
  "role-and-key-separation": ["identities", "operators", "tlsPins"],
});

export function validateDeveloperTestnetPreflightReport(value) {
  exact(value, ["checks", "format", "networkId", "observedAt", "reportHash", "summary", "version"],
    "preflight report");
  exact(value.summary, ["failed", "passed", "status"], "preflight report summary");
  if (value.format !== REPORT_FORMAT || value.version !== 1 || !NETWORK.test(value.networkId ?? "") ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || !Array.isArray(value.checks) ||
      value.checks.length !== Object.keys(DETAIL_FIELDS).length) throw new Error("preflight report is invalid");
  const ids = Object.keys(DETAIL_FIELDS).sort();
  let failed = 0;
  value.checks.forEach((entry, index) => {
    exact(entry, ["details", "id", "status"], "preflight report check");
    if (entry.id !== ids[index] || !["PASS", "FAIL"].includes(entry.status)) {
      throw new Error("preflight report check ordering or status is invalid");
    }
    const fields = entry.status === "PASS" ? DETAIL_FIELDS[entry.id] : ["reason"];
    exact(entry.details, fields, "preflight report check details");
    if (entry.status === "FAIL") {
      failed += 1;
      if (entry.details.reason !== `${entry.id}-verification-failed`) {
        throw new Error("preflight report failure reason is invalid");
      }
    }
  });
  if (value.summary.failed !== failed || value.summary.passed !== value.checks.length - failed ||
      value.summary.status !== (failed === 0 ? "PASS" : "FAIL")) {
    throw new Error("preflight report summary is invalid");
  }
  const { reportHash, ...payload } = value;
  if (reportHash !== hashObject(payload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1")) {
    throw new Error("preflight report hash is invalid");
  }
  return structuredClone(value);
}
