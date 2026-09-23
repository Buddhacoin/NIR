import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountHistoryIndex } from "./account-history-index.mjs";
import { createSignedHistoryArchive, verifySignedHistoryArchive } from "./archive-sync.mjs";
import { restoreHistoryArchiveFromSources } from "./archive-service.mjs";
import { createBeaconShareRequest } from "./beacon-request-auth.mjs";
import { initializeBlockStore } from "./block-store.mjs";
import { NirChain } from "./chain.mjs";
import { SAFETY_POLICY_V1_COMMITMENT } from "./constants.mjs";
import {
  addressFromPublicKey, canonicalJson, generateWallet, publicWallet, verifyObject,
} from "./crypto.mjs";
import { requestJson } from "./http-client.mjs";
import { validateOfflineReleaseBundle } from "./offline-release-bundle.mjs";
import {
  validateReleaseTransparencyAnchor, validateReleaseTransparencyCheckpoint,
} from "./offline-release-governance.mjs";
import {
  selectReleaseWitnessView, validateReleaseWitnessSet,
} from "./offline-release-witness.mjs";
import { createFallbackBeacon } from "./operators.mjs";
import {
  createPeerRegistry, EMPTY_PEER_REGISTRY_HASH, peerRegistryHash,
} from "./peer-registry.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";
import {
  runRealValidatorRecoveryRehearsal, validateRealValidatorRecoveryReport,
} from "./testnet-drill-real-runtime.mjs";
import { encryptWallet } from "./vault.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(HERE, "..");
const BEACON_CLI = join(HERE, "beacon-service.mjs");
const ARCHIVE_CLI = join(HERE, "archive-cli.mjs");
const LOOPBACK = "127.0.0.1";
const FORMAT = "nir-real-beacon-archive-rehearsal-v2";
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DISK_BYTES = 96 * 1024 * 1024;

function digest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}
function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}
function writeJson(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function initializeBoundDevnet(directory, {
  beaconWallets, firstValidatorPort, networkId,
}) {
  if (!Array.isArray(beaconWallets) || beaconWallets.length !== 4) {
    throw new Error("rehearsal beacon authority set is invalid");
  }
  const root = resolve(directory); const coordinatorDirectory = join(root, "coordinator");
  mkdirSync(join(coordinatorDirectory, "blocks"), { recursive: true, mode: 0o700 });
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorTransports = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet(); const coordinator = generateWallet();
  const validatorUrls = validators.map((_, index) =>
    `http://127.0.0.1:${firstValidatorPort + index}`);
  const peerRegistry = createPeerRegistry({ activationHeight: 0, epoch: 0, networkId,
    peers: validators.map((validator, index) => ({ tlsCertificateSha256: null,
      transport: publicWallet(validatorTransports[index]), url: validatorUrls[index],
      validatorAddress: validator.address })), previousRegistryHash: EMPTY_PEER_REGISTRY_HASH }, validators);
  const genesis = { beaconAuthorities: members(beaconWallets, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluators: members(evaluators, "evaluator"), genesisTimestamp: 0, networkId, peerRegistry,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT], treasuryAddress: treasury.address,
    validators: members(validators, "validator") };
  writeJson(join(coordinatorDirectory, "genesis.json"), genesis);
  writeJson(join(coordinatorDirectory, "TREASURY-DEV-KEY.json"), treasury);
  writeJson(join(coordinatorDirectory, "COORDINATOR-KEY.json"), coordinator);
  initializeBlockStore(coordinatorDirectory, new NirChain(genesis));
  const validatorDirectories = validators.map((wallet, index) => {
    const target = join(root, "validators", `validator-${index}`);
    for (const name of ["blocks", "commits", "prepares", "timeouts", "mempool"]) {
      mkdirSync(join(target, name), { recursive: true, mode: 0o700 });
    }
    writeJson(join(target, "genesis.json"), genesis);
    writeJson(join(target, "VALIDATOR-KEY.json"), wallet);
    writeJson(join(target, "AUTHORIZED-COORDINATOR.json"), publicWallet(coordinator));
    initializeBlockStore(target, new NirChain(genesis));
    writeJson(join(target, "PEERS.json"), validatorUrls);
    writeJson(join(target, "PEER-REGISTRY.json"), peerRegistry);
    writeJson(join(target, "PEER-REGISTRIES.json"), [peerRegistry]);
    writeJson(join(target, "TRANSPORT-KEY.json"), validatorTransports[index]);
    return target;
  });
  writeJson(join(root, "network.json"), { coordinatorDirectory, networkId,
    peerRegistryHash: peerRegistryHash(peerRegistry), validatorDirectories, validatorUrls });
  return { coordinatorDirectory, directory: root, networkId, validatorDirectories, validatorUrls };
}

function validateReleaseEvidence(value, networkId, observedNow) {
  exact(value, ["anchor", "bundle", "checkpoint", "maxAgeMs", "maxFutureSkewMs",
    "signedRelease", "trustedAddress", "witnessReceipts", "witnessSet"], "release evidence");
  if (!Number.isSafeInteger(observedNow) || observedNow < 0 ||
      !Number.isSafeInteger(value.maxAgeMs) || value.maxAgeMs < 1 || value.maxAgeMs > 86_400_000 ||
      !Number.isSafeInteger(value.maxFutureSkewMs) || value.maxFutureSkewMs < 0 ||
      value.maxFutureSkewMs > 300_000) {
    throw new Error("release evidence time policy is invalid");
  }
  const signed = verifySignedRelease(value.signedRelease, { trustedAddress: value.trustedAddress });
  const bundle = validateOfflineReleaseBundle(value.bundle);
  const anchor = validateReleaseTransparencyAnchor(value.anchor);
  const checkpoint = validateReleaseTransparencyCheckpoint(value.checkpoint, anchor);
  const witnessSet = validateReleaseWitnessSet(value.witnessSet);
  const selection = selectReleaseWitnessView(value.witnessReceipts, { anchor,
    maxAgeMs: value.maxAgeMs, maxFutureSkewMs: value.maxFutureSkewMs, now: observedNow,
    sequence: checkpoint.sequence, witnessSet });
  if (anchor.networkId !== networkId || checkpoint.networkId !== networkId ||
      bundle.manifest.networkId !== networkId || checkpoint.lastBundleHash !== bundle.bundleHash ||
      selection.checkpointHash !== checkpoint.checkpointHash || selection.entryHash !== checkpoint.entryHash ||
      bundle.manifest.releaseVersion !== signed.manifest.releaseVersion ||
      bundle.manifest.sourceRevision !== signed.manifest.sourceRevision) {
    throw new Error("release evidence is not one exact witnessed release view");
  }
  return { anchor, bundle, checkpoint, manifest: signed.manifest, selection,
    signer: signed.signer, witnessSet };
}

async function reservePorts(count) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer(); reservations.push(server);
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject); server.listen(0, LOOPBACK, resolvePromise);
      });
    }
    return reservations;
  } catch (error) {
    await Promise.all(reservations.filter(({ listening }) => listening).map((server) =>
      new Promise((resolvePromise) => server.close(resolvePromise))));
    throw error;
  }
}

class ServiceProcess {
  constructor(child, kind, port, maxOutputBytes) {
    this.child = child; this.kind = kind; this.port = port; this.exited = false; this.outputBytes = 0;
    const consume = (chunk) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > maxOutputBytes) {
        this.failure = new Error(`${kind} service output limit exceeded`);
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    child.once("error", () => { this.failure = new Error(`${kind} service failed to spawn`); });
    child.once("exit", (code, signal) => { this.exit = { code, signal }; this.exited = true; });
  }
}

function startBeacon({ networkId, password, policyPath, port, vaultPath }, limits) {
  const child = spawn(process.execPath,
    [BEACON_CLI, vaultPath, networkId, policyPath, String(port), LOOPBACK], {
      cwd: REPOSITORY, detached: true, env: { NIR_BEACON_PASSWORD_FD: "3" }, shell: false,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
  child.stdio[3].end(`${password}\n`);
  return new ServiceProcess(child, "beacon", port, limits.maxOutputBytes);
}

function startArchive(path, port, limits) {
  const child = spawn(process.execPath,
    [ARCHIVE_CLI, "serve", path, String(port), LOOPBACK], {
      cwd: REPOSITORY, detached: true, env: {}, shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return new ServiceProcess(child, "archive", port, limits.maxOutputBytes);
}

async function waitHealth(record, predicate, limits) {
  const end = Date.now() + limits.startupTimeoutMs; let lastError;
  while (Date.now() < end) {
    if (record.failure) throw record.failure;
    if (record.exited) throw new Error(`${record.kind} service exited during startup`);
    try {
      const response = await requestJson(`http://${LOOPBACK}:${record.port}/health`, {
        maxResponseBytes: 16 * 1024, timeoutMs: Math.min(250, limits.requestTimeoutMs),
      });
      if (response.ok && predicate(response.body)) return response.body;
      lastError = new Error(`${record.kind} health binding is invalid`);
    } catch (error) { lastError = error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw lastError ?? new Error(`${record.kind} startup timed out`);
}

async function stopGroup(record, limits) {
  if (record.exited) return { forced: false, stopped: true };
  try { process.kill(-record.child.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") return { forced: false, stopped: false }; }
  const stopped = await deadline(new Promise((resolvePromise) =>
    record.child.once("exit", () => resolvePromise(true))), limits.shutdownTimeoutMs,
  `${record.kind} shutdown`).catch(() => record.exited);
  if (stopped || record.exited) return { forced: false, stopped: true };
  try { process.kill(-record.child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") return { forced: true, stopped: false }; }
  const killed = await deadline(new Promise((resolvePromise) =>
    record.child.once("exit", () => resolvePromise(true))), limits.shutdownTimeoutMs,
  `${record.kind} forced shutdown`).catch(() => record.exited);
  return { forced: true, stopped: killed || record.exited };
}

async function cleanup(records, root, reservations, limits) {
  for (const server of reservations) if (server.listening) {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
  const outcomes = await Promise.all(records.map((record) => stopGroup(record, limits)));
  const report = { attempted: records.length,
    failures: outcomes.filter(({ stopped }) => !stopped).length,
    forced: outcomes.filter(({ forced }) => forced).length, rootRemoved: false, status: "FAIL" };
  try { rmSync(root, { force: true, recursive: true }); report.rootRemoved = true; } catch {}
  report.status = report.failures === 0 && report.rootRemoved ? "PASS" : "FAIL";
  return report;
}

function diskBytes(root) {
  let total = 0; const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop(); const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error("service rehearsal contains a symlink");
    if (metadata.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name));
    else if (metadata.isFile()) total += metadata.size;
    else throw new Error("service rehearsal contains a special file");
    if (total > MAX_DISK_BYTES) throw new Error("service rehearsal disk limit exceeded");
  }
  return total;
}

async function beaconShare(url, fields, requester, options = {}) {
  const envelope = createBeaconShareRequest(fields, requester, options);
  const response = await requestJson(`${url}/v1/share`, {
    body: envelope, maxResponseBytes: 32 * 1024, method: "POST", timeoutMs: 2_000,
  });
  return { envelope, response };
}

function verifyBeaconShares(authorities, shares, context) {
  if (!Array.isArray(authorities) || authorities.length < 4 || authorities.length > 64 ||
      !Array.isArray(shares) || shares.length > authorities.length) {
    throw new Error("beacon quorum input is invalid");
  }
  const trusted = new Map(authorities.map((authority) => [authority.address, authority]));
  if (trusted.size !== authorities.length || authorities.some((authority) =>
    authority.address !== addressFromPublicKey(authority.publicKey ?? ""))) {
    throw new Error("beacon authorities are duplicated or invalid");
  }
  const seen = new Set();
  for (const share of shares) {
    exact(share, ["authority", "candidateId", "networkId", "round", "signature", "value"],
      "beacon share");
    const authority = trusted.get(share?.authority);
    const payload = { authority: share?.authority, candidateId: context.candidateId,
      networkId: context.networkId, round: context.round, value: share?.value };
    if (!authority || seen.has(share.authority) || share.candidateId !== context.candidateId ||
        share.networkId !== context.networkId || share.round !== context.round ||
        !verifyObject(payload, share.signature, authority.publicKey, "FALLBACK_RANDOMNESS_SHARE")) {
      throw new Error("beacon share signature or context is invalid");
    }
    seen.add(share.authority);
  }
  const quorum = Math.floor((authorities.length * 2) / 3) + 1;
  if (seen.size < quorum) throw new Error("real beacon quorum not reached");
  return createFallbackBeacon({ shares, ...context });
}

function chainFromValidatorReport(report) {
  const chain = new NirChain(report.genesis);
  for (const block of report.blocks) chain.appendBlock(block);
  return chain;
}

function servicePayload(fields) { return { ...fields, format: FORMAT, version: 2 }; }

export function validateRealBeaconArchiveReport(value, { now = Date.now() } = {}) {
  exact(value, ["archive", "beacon", "completedAt", "format", "networkId", "releaseEvidence",
    "startedAt", "transcriptHash", "validator", "version"], "real service rehearsal report");
  if (value.format !== FORMAT || value.version !== 2 ||
      !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.completedAt) ||
      value.completedAt < value.startedAt || value.completedAt - value.startedAt > 90_000) {
    throw new Error("real service rehearsal report header is invalid");
  }
  const unsigned = structuredClone(value); delete unsigned.transcriptHash;
  if (value.transcriptHash !== digest(unsigned)) throw new Error("real service transcript was mutated");
  exact(value.validator, ["report", "validation"], "validator rehearsal binding");
  const validator = validateRealValidatorRecoveryReport(value.validator.report);
  const release = validateReleaseEvidence(value.releaseEvidence, value.networkId, now);
  if (canonicalJson(validator) !== canonicalJson(value.validator.validation) ||
      validator.transcriptHash !== value.validator.validation.transcriptHash ||
      validator.tipHash !== value.validator.validation.tipHash ||
      validator.tipHash !== value.beacon.validatorTip || value.networkId !== value.validator.report.networkId ||
      release.checkpoint.checkpointHash !== value.beacon.releaseCheckpointHash ||
      release.manifest.manifestHash !== value.beacon.releaseManifestHash) {
    throw new Error("service transcript is not bound to the validator or release checkpoint");
  }
  const chain = chainFromValidatorReport(value.validator.report);
  exact(value.beacon, ["aggregate", "authorities", "candidateId", "firstShares",
    "outageCandidateId", "outageQuorumRejected", "recoveryShares", "releaseCheckpointHash",
    "releaseManifestHash", "replayRejected", "replayStatus", "restartReplayRejected", "restartStableShare",
    "validatorTip"], "real beacon evidence");
  if (canonicalJson(value.beacon.authorities) !==
      canonicalJson(value.validator.report.genesis.beaconAuthorities)) {
    throw new Error("beacon authorities are not the on-chain genesis registry");
  }
  const expectedCandidate = digest({ networkId: value.networkId, purpose: "initial",
    releaseCheckpointHash: release.checkpoint.checkpointHash,
    releaseManifestHash: release.manifest.manifestHash, validatorTip: chain.tipHash });
  const expectedOutage = digest({ networkId: value.networkId, purpose: "outage-recovery",
    releaseCheckpointHash: release.checkpoint.checkpointHash,
    releaseManifestHash: release.manifest.manifestHash, validatorTip: chain.tipHash });
  if (value.beacon.candidateId !== expectedCandidate || value.beacon.outageCandidateId !== expectedOutage ||
      !value.beacon.outageQuorumRejected || !value.beacon.replayRejected ||
      !value.beacon.restartReplayRejected || value.beacon.replayStatus !== 409 ||
      canonicalJson(value.beacon.restartStableShare) !== canonicalJson(value.beacon.firstShares[2]) ||
      value.beacon.releaseCheckpointHash !== release.checkpoint.checkpointHash ||
      value.beacon.releaseManifestHash !== release.manifest.manifestHash) {
    throw new Error("beacon restart or fail-closed evidence is invalid");
  }
  verifyBeaconShares(value.beacon.authorities, value.beacon.firstShares, {
    candidateId: expectedCandidate, networkId: value.networkId, round: 1,
  });
  const aggregate = verifyBeaconShares(value.beacon.authorities, value.beacon.recoveryShares, {
    candidateId: expectedOutage, networkId: value.networkId, round: 2,
  });
  if (canonicalJson(aggregate) !== canonicalJson(value.beacon.aggregate)) {
    throw new Error("beacon recovery aggregate is invalid");
  }
  exact(value.archive, ["artifacts", "operators", "outageQuorumRejected", "recovery"],
    "real archive evidence");
  if (!value.archive.outageQuorumRejected || !Array.isArray(value.archive.artifacts) ||
      value.archive.artifacts.length !== 2 || !Array.isArray(value.archive.operators) ||
      value.archive.operators.length !== 2) throw new Error("archive quorum evidence is incomplete");
  const verifiedArchives = value.archive.artifacts.map((artifact) =>
    verifySignedHistoryArchive(artifact, chain, { trustedOperators: value.archive.operators }));
  exact(value.archive.recovery, ["height", "matchingSources", "operators", "records", "tipHash"],
    "archive recovery result");
  const artifactSigners = new Set(verifiedArchives.map(({ signer }) => signer.address));
  if (artifactSigners.size !== 2 || value.archive.operators.some(({ address }) =>
      !artifactSigners.has(address)) ||
      verifiedArchives[0].contentRoot !== verifiedArchives[1].contentRoot ||
      value.archive.recovery.matchingSources !== 2 || value.archive.recovery.height !== chain.height ||
      value.archive.recovery.tipHash !== chain.tipHash ||
      new Set(value.archive.recovery.operators).size !== 2 ||
      value.archive.recovery.operators.some((address) =>
        !value.archive.operators.some((operator) => operator.address === address))) {
    throw new Error("archive recovery is not backed by matching independent artifacts");
  }
  return { archiveRecovery: true, beaconQuorumRecovery: true, format: FORMAT,
    harnessStatus: "PASS", networkId: value.networkId, scenarioStatus: "PASS",
    releaseCheckpointHash: release.checkpoint.checkpointHash,
    transcriptHash: value.transcriptHash, validatorTip: chain.tipHash, version: 2 };
}

export async function runRealBeaconArchiveRehearsal({ releaseEvidence, ...options } = {}) {
  const networkId = "nir-real-recovery-devnet";
  const verifiedRelease = validateReleaseEvidence(releaseEvidence, networkId, Date.now());
  const limits = { maxOutputBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 750,
    startupTimeoutMs: options.startupTimeoutMs ?? 8_000 };
  for (const [name, value] of Object.entries(limits)) {
    const maximum = name === "maxOutputBytes" ? 1024 * 1024 : 30_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`real service rehearsal ${name} is invalid`);
    }
  }
  const beaconWallets = Array.from({ length: 4 }, generateWallet);
  const validator = await runRealValidatorRecoveryRehearsal({ ...(options.validator ?? {}),
    _networkInitializer: (directory, initializerOptions) => initializeBoundDevnet(directory, {
      ...initializerOptions, beaconWallets,
    }) });
  const chain = chainFromValidatorReport(validator.report);
  const root = mkdtempSync(join(tmpdir(), "nir-real-services-"));
  const records = []; let reservations = [];
  let failure; let result;
  try {
    reservations = await reservePorts(6);
    const startedAt = Date.now();
    const requester = generateWallet();
    const authorities = structuredClone(validator.report.genesis.beaconAuthorities);
    const beaconConfigs = beaconWallets.map((wallet, index) => {
      const password = `beacon-rehearsal-${index}-Strong-42`;
      const vaultPath = join(root, `beacon-${index}.nirvault.json`);
      const policyPath = join(root, `beacon-${index}-requesters.json`);
      writeJson(vaultPath, encryptWallet(wallet, password, { label: `rehearsal-beacon-${index}` }));
      writeJson(policyPath, { beaconAddress: wallet.address, format: "nir-beacon-requester-policy-v1",
        networkId: chain.networkId,
        requesters: [{ ...publicWallet(requester), operatorId: "rehearsal-requester" }],
        reservedAddresses: authorities.map(({ address }) => address),
        reservedOperatorIds: beaconWallets.map((_, position) => `beacon-${position}`) });
      return { networkId: chain.networkId, password, policyPath,
        port: reservations[index].address().port, vaultPath };
    });
    for (let index = 0; index < beaconConfigs.length; index += 1) {
      await new Promise((resolvePromise) => reservations[index].close(resolvePromise));
      const record = startBeacon(beaconConfigs[index], limits); records.push(record);
      await waitHealth(record, (body) => body.address === beaconWallets[index].address &&
        body.networkId === chain.networkId, limits);
    }
    if (options._crashBeaconAfterStart !== undefined) {
      const target = records[options._crashBeaconAfterStart];
      if (!target || target.kind !== "beacon") throw new Error("beacon crash target is invalid");
      process.kill(-target.child.pid, "SIGKILL");
      await deadline(new Promise((resolvePromise) => target.child.once("exit", resolvePromise)),
        limits.shutdownTimeoutMs, "injected beacon crash");
      throw new Error("injected real beacon crash");
    }
    const candidateId = digest({ networkId: chain.networkId, purpose: "initial",
      releaseCheckpointHash: verifiedRelease.checkpoint.checkpointHash,
      releaseManifestHash: verifiedRelease.manifest.manifestHash, validatorTip: chain.tipHash });
    const firstRequests = []; const firstShares = [];
    for (let index = 0; index < 4; index += 1) {
      const exchange = await beaconShare(`http://${LOOPBACK}:${beaconConfigs[index].port}`, {
        beaconAddress: beaconWallets[index].address, candidateId, networkId: chain.networkId,
        purpose: "fallback", round: 1,
      }, requester);
      if (!exchange.response.ok) throw new Error("real beacon rejected a valid share request");
      firstRequests.push(exchange.envelope); firstShares.push(exchange.response.body);
    }
    verifyBeaconShares(authorities, firstShares, { candidateId, networkId: chain.networkId, round: 1 });
    const replay = await requestJson(`http://${LOOPBACK}:${beaconConfigs[0].port}/v1/share`, {
      body: firstRequests[0], method: "POST", timeoutMs: limits.requestTimeoutMs,
    });
    if (replay.status !== 409) throw new Error("real beacon accepted a replayed request");
    for (const index of [2, 3]) if (!(await stopGroup(records[index], limits)).stopped) {
      throw new Error("beacon outage failed");
    }
    const outageCandidateId = digest({ networkId: chain.networkId, purpose: "outage-recovery",
      releaseCheckpointHash: verifiedRelease.checkpoint.checkpointHash,
      releaseManifestHash: verifiedRelease.manifest.manifestHash, validatorTip: chain.tipHash });
    const recoveryShares = [];
    for (let index = 0; index < 2; index += 1) {
      const exchange = await beaconShare(`http://${LOOPBACK}:${beaconConfigs[index].port}`, {
        beaconAddress: beaconWallets[index].address, candidateId: outageCandidateId,
        networkId: chain.networkId, purpose: "fallback", round: 2,
      }, requester);
      if (!exchange.response.ok) throw new Error("live beacon rejected recovery context");
      recoveryShares.push(exchange.response.body);
    }
    let outageQuorumRejected = false;
    try { verifyBeaconShares(authorities, recoveryShares, {
      candidateId: outageCandidateId, networkId: chain.networkId, round: 2,
    }); } catch (error) { if (/quorum/.test(error.message)) outageQuorumRejected = true; else throw error; }
    if (!outageQuorumRejected) throw new Error("beacon quorum did not fail closed during outage");
    const restartedBeacon = startBeacon(beaconConfigs[2], limits); records.push(restartedBeacon);
    await waitHealth(restartedBeacon, (body) => body.address === beaconWallets[2].address, limits);
    const restartReplay = await requestJson(`http://${LOOPBACK}:${beaconConfigs[2].port}/v1/share`, {
      body: firstRequests[2], method: "POST", timeoutMs: limits.requestTimeoutMs,
    });
    if (restartReplay.status !== 409) throw new Error("restarted beacon forgot durable replay state");
    const stableExchange = await beaconShare(`http://${LOOPBACK}:${beaconConfigs[2].port}`, {
      beaconAddress: beaconWallets[2].address, candidateId, networkId: chain.networkId,
      purpose: "fallback", round: 1,
    }, requester);
    if (!stableExchange.response.ok ||
        canonicalJson(stableExchange.response.body) !== canonicalJson(firstShares[2])) {
      throw new Error("restarted beacon changed an issued share");
    }
    const recoveredExchange = await beaconShare(`http://${LOOPBACK}:${beaconConfigs[2].port}`, {
      beaconAddress: beaconWallets[2].address, candidateId: outageCandidateId,
      networkId: chain.networkId, purpose: "fallback", round: 2,
    }, requester);
    if (!recoveredExchange.response.ok) throw new Error("restarted beacon failed recovery share");
    recoveryShares.push(recoveredExchange.response.body);
    const aggregate = verifyBeaconShares(authorities, recoveryShares, {
      candidateId: outageCandidateId, networkId: chain.networkId, round: 2,
    });

    const historyDirectory = join(root, "history"); mkdirSync(historyDirectory, { mode: 0o700 });
    new AccountHistoryIndex(historyDirectory, chain);
    const archiveWallets = [generateWallet(), generateWallet()];
    const archiveOperators = archiveWallets.map(publicWallet);
    const artifacts = archiveWallets.map((wallet) =>
      createSignedHistoryArchive(historyDirectory, chain, wallet));
    const archivePaths = artifacts.map((artifact, index) => {
      const path = join(root, `archive-${index}.json`); writeJson(path, artifact); return path;
    });
    const archiveRecords = [];
    for (let index = 0; index < 2; index += 1) {
      const reservationIndex = index + 4;
      const port = reservations[reservationIndex].address().port;
      await new Promise((resolvePromise) => reservations[reservationIndex].close(resolvePromise));
      const record = startArchive(archivePaths[index], port, limits);
      records.push(record); archiveRecords.push(record);
      await waitHealth(record, (body) => body.archiveHash === artifacts[index].manifest.archiveHash &&
        body.networkId === chain.networkId, limits);
    }
    const sources = archiveRecords.map(({ port }) => `http://${LOOPBACK}:${port}`);
    if (!(await stopGroup(archiveRecords[1], limits)).stopped) throw new Error("archive outage failed");
    const failedRestore = join(root, "failed-restore"); mkdirSync(failedRestore, { mode: 0o700 });
    let archiveOutageRejected = false;
    try {
      await restoreHistoryArchiveFromSources(failedRestore, sources, chain, {
        allowInsecureLocalhost: true, minimumSources: 2, timeoutMs: 1_000,
        trustedOperators: archiveOperators,
      });
    } catch (error) { if (/enough independent matching sources/.test(error.message)) {
      archiveOutageRejected = true;
    } else throw error; }
    if (!archiveOutageRejected) throw new Error("archive restore did not fail closed without quorum");
    const restartedArchive = startArchive(archivePaths[1], archiveRecords[1].port, limits);
    records.push(restartedArchive); archiveRecords[1] = restartedArchive;
    await waitHealth(restartedArchive, (body) => body.archiveHash === artifacts[1].manifest.archiveHash,
      limits);
    const restoredDirectory = join(root, "restored"); mkdirSync(restoredDirectory, { mode: 0o700 });
    const recovery = await restoreHistoryArchiveFromSources(restoredDirectory, sources, chain, {
      allowInsecureLocalhost: true, minimumSources: 2, timeoutMs: 2_000,
      trustedOperators: archiveOperators,
    });
    const fields = servicePayload({ archive: { artifacts, operators: archiveOperators,
      outageQuorumRejected: archiveOutageRejected, recovery },
    beacon: { aggregate, authorities, candidateId, firstShares, outageCandidateId,
      outageQuorumRejected, recoveryShares,
      releaseCheckpointHash: verifiedRelease.checkpoint.checkpointHash,
      releaseManifestHash: verifiedRelease.manifest.manifestHash, replayRejected: true,
      replayStatus: replay.status, restartReplayRejected: true,
      restartStableShare: stableExchange.response.body, validatorTip: chain.tipHash },
    completedAt: Date.now(), networkId: chain.networkId,
    releaseEvidence: structuredClone(releaseEvidence), startedAt,
    validator: { report: validator.report, validation: validator.validation } });
    const report = { ...fields, transcriptHash: digest(fields) };
    const validation = validateRealBeaconArchiveReport(report);
    result = { diskBytes: diskBytes(root), report, validation,
      validatorCleanup: validator.cleanup };
  } catch (error) { failure = error; }
  const cleanupReport = await cleanup(records, root, reservations, limits);
  if (failure || cleanupReport.status !== "PASS") {
    const error = failure ?? new Error("real service rehearsal cleanup failed closed");
    error.cleanupReport = cleanupReport; throw error;
  }
  return { ...result, cleanup: cleanupReport };
}
