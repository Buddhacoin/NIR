import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validateDeveloperTestnetPreflightReport } from "./developer-testnet-preflight.mjs";

const TOPOLOGY_FORMAT = "nir-testnet-drill-topology-v1";
const PLAN_FORMAT = "nir-testnet-partition-drill-plan-v1";
const EVIDENCE_FORMAT = "nir-testnet-partition-drill-evidence-v1";
const VALIDATION_FORMAT = "nir-testnet-partition-drill-validation-v1";
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const PREFIXED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCENARIO_DURATION_MS = 24 * 60 * 60 * 1000;
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function identity(value, role) {
  exact(value, ["address", "algorithm", "operatorId", "publicKey"], `${role} identity`);
  if (!ADDRESS.test(value.address ?? "") || !OPERATOR.test(value.operatorId ?? "") ||
      value.algorithm !== SIGNATURE_ALGORITHM || typeof value.publicKey !== "string" ||
      value.publicKey.length > 8_000 || addressFromPublicKey(value.publicKey) !== value.address) {
    throw new Error(`${role} identity is invalid`);
  }
  return { address: value.address, algorithm: value.algorithm,
    operatorId: value.operatorId, publicKey: value.publicKey };
}

function validateTopology(value) {
  exact(value, ["archives", "beacons", "certificateRotation", "format", "networkId",
    "releaseCheckpointHash", "validators", "version"], "drill topology");
  if (value.format !== TOPOLOGY_FORMAT || value.version !== 1 ||
      typeof value.networkId !== "string" || value.networkId.length < 3 ||
      value.networkId.length > 64 || !PREFIXED_HASH.test(value.releaseCheckpointHash ?? "") ||
      !Array.isArray(value.validators) || value.validators.length !== 4 ||
      !Array.isArray(value.beacons) || value.beacons.length < 4 || value.beacons.length > 64 ||
      !Array.isArray(value.archives) || value.archives.length < 2 || value.archives.length > 64) {
    throw new Error("drill topology header or bounds are invalid");
  }
  const normalized = {
    validators: value.validators.map((entry) => identity(entry, "validator"))
      .sort((left, right) => compare(left.operatorId, right.operatorId)),
    beacons: value.beacons.map((entry) => identity(entry, "beacon"))
      .sort((left, right) => compare(left.operatorId, right.operatorId)),
    archives: value.archives.map((entry) => identity(entry, "archive"))
      .sort((left, right) => compare(left.operatorId, right.operatorId)),
  };
  const all = [...normalized.validators, ...normalized.beacons, ...normalized.archives];
  if (new Set(all.map(({ address }) => address)).size !== all.length ||
      new Set(all.map(({ operatorId }) => operatorId)).size !== all.length) {
    throw new Error("drill topology reuses an address or operator across roles");
  }
  exact(value.certificateRotation, ["newPin", "oldPin", "overlapEndHeight",
    "overlapStartHeight", "validator"], "certificate rotation");
  const rotation = value.certificateRotation;
  if (!ADDRESS.test(rotation.validator ?? "") ||
      !normalized.validators.some(({ address }) => address === rotation.validator) ||
      !HASH.test(rotation.oldPin ?? "") || !HASH.test(rotation.newPin ?? "") ||
      rotation.oldPin === rotation.newPin || !Number.isSafeInteger(rotation.overlapStartHeight) ||
      !Number.isSafeInteger(rotation.overlapEndHeight) || rotation.overlapStartHeight < 1 ||
      rotation.overlapEndHeight < rotation.overlapStartHeight ||
      rotation.overlapEndHeight - rotation.overlapStartHeight > 10_000) {
    throw new Error("certificate rotation overlap is invalid");
  }
  return {
    archives: normalized.archives, beacons: normalized.beacons,
    certificateRotation: structuredClone(rotation), format: TOPOLOGY_FORMAT,
    networkId: value.networkId, releaseCheckpointHash: value.releaseCheckpointHash,
    validators: normalized.validators, version: 1,
  };
}

function requirements(pairs) {
  return pairs.map(([id, operatorId]) => ({ id, operatorId }))
    .sort((left, right) => compare(left.id, right.id));
}

function scenario(id, type, participants, partitions, observations, requiredQuorumHashes,
  quorumEligible, expected) {
  return { expected, id, participants: [...participants].sort(),
    partitions: partitions.map((part) => [...part].sort()),
    quorumEligible: [...quorumEligible].sort(), requiredObservations: requirements(observations),
    requiredQuorumHashes, type };
}

function planPayload(preflightValue, topologyValue) {
  const preflight = validateDeveloperTestnetPreflightReport(preflightValue);
  if (preflight.summary.status !== "PASS") throw new Error("drill planning requires a PASS preflight");
  const topology = validateTopology(topologyValue);
  const release = preflight.checks.find(({ id }) => id === "release")?.details;
  if (preflight.networkId !== topology.networkId ||
      release?.checkpointHash !== topology.releaseCheckpointHash) {
    throw new Error("preflight and topology network or release checkpoint differ");
  }
  const validators = topology.validators;
  const validatorAddresses = validators.map(({ address }) => address);
  const [outage, ...active] = validators;
  const left = validators.slice(0, 2); const right = validators.slice(2);
  const majority = validators.slice(0, 3); const minority = validators[3];
  const beaconOut = topology.beacons.slice(0, Math.ceil(topology.beacons.length / 3));
  const rotationOperator = validators.find(
    ({ address }) => address === topology.certificateRotation.validator).operatorId;
  const scenarios = [
    scenario("01-validator-outage", "validator-outage", validatorAddresses,
      [[outage.address], active.map(({ address }) => address)],
      [...active.map(({ operatorId }) => [`finality:${operatorId}`, operatorId]),
        [`outage-observed:${outage.operatorId}`, outage.operatorId],
        [`catchup:${outage.operatorId}`, outage.operatorId]], 1, active.map(({ address }) => address),
      "finality-continues-and-restarted-validator-catches-up"),
    scenario("02-two-two-split", "two-two-partition", validatorAddresses,
      [left.map(({ address }) => address), right.map(({ address }) => address)],
      validators.map(({ operatorId }) => [`no-finality:${operatorId}`, operatorId]), 0, [],
      "neither-partition-finalizes"),
    scenario("03-three-one-recovery", "three-one-partition", validatorAddresses,
      [majority.map(({ address }) => address), [minority.address]],
      [...majority.flatMap(({ operatorId }) => [[`partition-observed:${operatorId}`, operatorId],
        [`finality:${operatorId}`, operatorId]]),
        [`partition-observed:${minority.operatorId}`, minority.operatorId],
        [`catchup:${minority.operatorId}`, minority.operatorId]], 1,
      majority.map(({ address }) => address), "one-majority-finality-and-minority-catchup"),
    scenario("04-delayed-replayed-messages", "message-adversary", validatorAddresses,
      [validatorAddresses], validators.flatMap(({ operatorId }) => [
        [`delay-observed:${operatorId}`, operatorId], [`duplicate-observed:${operatorId}`, operatorId],
        [`reorder-observed:${operatorId}`, operatorId], [`replay-rejected:${operatorId}`, operatorId],
        [`converged:${operatorId}`, operatorId],
      ]), 1, validatorAddresses, "delays-duplicates-reordering-converge-and-replay-is-rejected"),
    scenario("05-beacon-outage", "beacon-outage", topology.beacons.map(({ address }) => address),
      [beaconOut.map(({ address }) => address), topology.beacons.slice(beaconOut.length)
        .map(({ address }) => address)], topology.beacons.flatMap(({ operatorId }) => [
        [`outage-observed:${operatorId}`, operatorId], [`recovered:${operatorId}`, operatorId],
      ]), 0, [], "quorum-loss-is-safe-and-randomness-recovers"),
    scenario("06-archive-corruption", "archive-corruption",
      topology.archives.map(({ address }) => address),
      topology.archives.map(({ address }) => [address]), [
        [`corrupt-rejected:${topology.archives[0].operatorId}`, topology.archives[0].operatorId],
        [`alternate-restored:${topology.archives[1].operatorId}`, topology.archives[1].operatorId],
      ], 0, [], "corrupt-source-is-rejected-and-independent-source-restores"),
    scenario("07-certificate-overlap", "certificate-rotation-overlap", validatorAddresses,
      [validatorAddresses], [
        [`old-pin-accepted-in-overlap:${rotationOperator}`, rotationOperator],
        [`new-pin-accepted-in-overlap:${rotationOperator}`, rotationOperator],
        [`old-pin-rejected-after-overlap:${rotationOperator}`, rotationOperator],
        ...validators.map(({ operatorId }) => [`post-rotation-finality:${operatorId}`, operatorId]),
      ], 1, validatorAddresses, "bounded-overlap-switches-to-new-pin-and-rejects-old-pin"),
  ];
  const topologyPayload = { ...topology };
  return {
    format: PLAN_FORMAT, networkId: topology.networkId,
    preflightReportHash: preflight.reportHash,
    releaseCheckpointHash: topology.releaseCheckpointHash,
    scenarios, topology, topologyHash: hashObject(topologyPayload, "TESTNET_DRILL_TOPOLOGY_V1"),
    version: 1,
  };
}

export function createTestnetPartitionDrillPlan(preflight, topology) {
  const payload = planPayload(preflight, topology);
  return { ...payload, planHash: hashObject(payload, "TESTNET_PARTITION_DRILL_PLAN_V1") };
}

export function validateTestnetPartitionDrillPlan(value) {
  exact(value, ["format", "networkId", "planHash", "preflightReportHash", "releaseCheckpointHash",
    "scenarios", "topology", "topologyHash", "version"], "drill plan");
  const topology = validateTopology(value.topology);
  if (value.format !== PLAN_FORMAT || value.version !== 1 || value.networkId !== topology.networkId ||
      value.releaseCheckpointHash !== topology.releaseCheckpointHash || !HASH.test(value.planHash ?? "") ||
      !HASH.test(value.preflightReportHash ?? "") || !HASH.test(value.topologyHash ?? "") ||
      !Array.isArray(value.scenarios) || value.scenarios.length !== 7) {
    throw new Error("drill plan header is invalid");
  }
  const topologyHash = hashObject(topology, "TESTNET_DRILL_TOPOLOGY_V1");
  if (topologyHash !== value.topologyHash) throw new Error("drill topology hash is invalid");
  // Regenerate against a minimal validated PASS-shaped report so scenario derivation has one source.
  const dummyPayload = {
    checks: [{ details: { ageMs: 0, sources: 2 }, id: "backup-restore-freshness", status: "PASS" },
      { details: { eligible: 4, minimumBondAtomic: "1000000000" }, id: "bonded-validator-eligibility", status: "PASS" },
      { details: { selectionHash: "0".repeat(64), witnesses: 3 }, id: "external-witness-quorum", status: "PASS" },
      { details: { genesisHash: "0".repeat(64), planCommitment: "0".repeat(64) }, id: "genesis", status: "PASS" },
      { details: { ingressProfiles: 4, ports: 14 }, id: "host-readiness", status: "PASS" },
      { details: { scannedFiles: 1 }, id: "public-artifact-scan", status: "PASS" },
      { details: { bundleHash: "sha3-256:" + "0".repeat(64), checkpointHash: topology.releaseCheckpointHash,
        sequence: 1 }, id: "release", status: "PASS" },
      { details: { identities: 1, operators: 1, tlsPins: 1 }, id: "role-and-key-separation", status: "PASS" }],
    format: "nir-developer-testnet-preflight-report-v1", networkId: topology.networkId,
    observedAt: 0, summary: { failed: 0, passed: 8, status: "PASS" }, version: 1,
  };
  const dummyPreflight = { ...dummyPayload,
    reportHash: hashObject(dummyPayload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1") };
  const scenarioPayload = planPayload(dummyPreflight, topology);
  if (canonicalJson(value.scenarios) !== canonicalJson(scenarioPayload.scenarios)) {
    throw new Error("drill scenarios are not the deterministic topology plan");
  }
  const { planHash, ...payload } = value;
  if (planHash !== hashObject(payload, "TESTNET_PARTITION_DRILL_PLAN_V1")) {
    throw new Error("drill plan hash is invalid");
  }
  return structuredClone(value);
}

function topologyIdentities(plan) {
  return [...plan.topology.validators, ...plan.topology.beacons, ...plan.topology.archives];
}

function observationPayload(plan, scenarioId, value) {
  return { evidenceHash: value.evidenceHash, networkId: plan.networkId,
    observationId: value.id, observedAt: value.observedAt, operatorId: value.operatorId,
    planHash: plan.planHash, result: value.result, scenarioId };
}

export function signTestnetDrillObservation(planValue, scenarioId, value, wallet) {
  const plan = validateTestnetPartitionDrillPlan(planValue);
  exact(value, ["evidenceHash", "id", "observedAt", "result"], "drill observation input");
  const scenarioValue = plan.scenarios.find(({ id }) => id === scenarioId);
  const required = scenarioValue?.requiredObservations.find(({ id }) => id === value?.id);
  const operator = topologyIdentities(plan).find(({ operatorId }) => operatorId === required?.operatorId);
  if (!operator || wallet?.address !== operator.address || wallet.publicKey !== operator.publicKey ||
      !HASH.test(value?.evidenceHash ?? "") || !Number.isSafeInteger(value?.observedAt) ||
      !["PASS", "FAIL"].includes(value?.result)) throw new Error("drill observation signer is invalid");
  const unsigned = { evidenceHash: value.evidenceHash, id: value.id,
    observedAt: value.observedAt, operatorId: operator.operatorId, result: value.result };
  return { ...unsigned, algorithm: SIGNATURE_ALGORITHM,
    signature: signObject(observationPayload(plan, scenarioId, unsigned), wallet,
      "TESTNET_DRILL_OBSERVATION_V1") };
}

function quorumPayload(plan, scenarioId, value) {
  return { blockHash: value.blockHash, height: value.height, networkId: plan.networkId,
    planHash: plan.planHash, scenarioId, stateRoot: value.stateRoot,
    validatorSetHash: value.validatorSetHash };
}

export function signTestnetDrillQuorumHash(planValue, scenarioId, value, wallets) {
  const plan = validateTestnetPartitionDrillPlan(planValue);
  exact(value, ["blockHash", "height", "stateRoot", "validatorSetHash"], "quorum hash input");
  const scenarioValue = plan.scenarios.find(({ id }) => id === scenarioId);
  if (!scenarioValue || !Array.isArray(wallets) || !HASH.test(value?.blockHash ?? "") ||
      !HASH.test(value?.stateRoot ?? "") || !HASH.test(value?.validatorSetHash ?? "") ||
      !Number.isSafeInteger(value?.height) || value.height < 1) throw new Error("quorum hash input is invalid");
  const payload = quorumPayload(plan, scenarioId, value);
  const signatures = wallets.map((wallet) => {
    const validator = plan.topology.validators.find(({ address }) => address === wallet?.address);
    if (!validator || validator.publicKey !== wallet.publicKey ||
        !scenarioValue.quorumEligible.includes(wallet.address)) throw new Error("quorum signer is ineligible");
    return { algorithm: SIGNATURE_ALGORITHM,
      signature: signObject(payload, wallet, "TESTNET_DRILL_QUORUM_HASH_V1"),
      validator: wallet.address };
  }).sort((left, right) => compare(left.validator, right.validator));
  return { ...value, signatures };
}

function evidencePayload(value) {
  exact(value, ["completedAt", "format", "networkId", "planHash", "releaseCheckpointHash",
    "scenarios", "startedAt", "version"], "drill evidence");
  if (value.format !== EVIDENCE_FORMAT || value.version !== 1 ||
      typeof value.networkId !== "string" || !HASH.test(value.planHash ?? "") ||
      !PREFIXED_HASH.test(value.releaseCheckpointHash ?? "") ||
      !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.completedAt) ||
      value.startedAt < 0 || value.completedAt < value.startedAt ||
      value.completedAt - value.startedAt > MAX_SCENARIO_DURATION_MS ||
      !Array.isArray(value.scenarios) || value.scenarios.length !== 7) {
    throw new Error("drill evidence header or bounds are invalid");
  }
  return structuredClone(value);
}

export function createTestnetPartitionDrillEvidence(fields) {
  const payload = evidencePayload({ ...fields, format: EVIDENCE_FORMAT, version: 1 });
  return { ...payload, evidenceHash: hashObject(payload, "TESTNET_PARTITION_DRILL_EVIDENCE_V1") };
}

function validateQuorumHash(value, plan, scenarioValue) {
  exact(value, ["blockHash", "height", "signatures", "stateRoot", "validatorSetHash"],
    "drill quorum hash");
  const validatorCount = plan.topology.validators.length;
  if (!HASH.test(value.blockHash ?? "") || !HASH.test(value.stateRoot ?? "") ||
      !HASH.test(value.validatorSetHash ?? "") || !Number.isSafeInteger(value.height) ||
      value.height < 1 || !Array.isArray(value.signatures) || value.signatures.length > validatorCount) {
    throw new Error("drill quorum hash is invalid or below validator quorum");
  }
  const payload = quorumPayload(plan, scenarioValue.id, value);
  const seen = new Set();
  for (const signature of value.signatures) {
    exact(signature, ["algorithm", "signature", "validator"], "drill quorum signature");
    const validator = plan.topology.validators.find(({ address }) => address === signature.validator);
    if (!validator || seen.has(signature.validator) || signature.algorithm !== SIGNATURE_ALGORITHM ||
        typeof signature.signature !== "string" || signature.signature.length > 16_384 ||
        !scenarioValue.quorumEligible.includes(signature.validator) ||
        !verifyObject(payload, signature.signature, validator.publicKey,
          "TESTNET_DRILL_QUORUM_HASH_V1")) {
      throw new Error("drill quorum signature is forged, duplicate, or ineligible");
    }
    seen.add(signature.validator);
  }
  if (seen.size < Math.floor((validatorCount * 2) / 3) + 1) {
    throw new Error("drill quorum hash is invalid or below validator quorum");
  }
  return structuredClone(value);
}

export function validateTestnetPartitionDrillEvidence(planValue, evidenceValue, {
  maxAgeMs = 24 * 60 * 60 * 1000, maxFutureSkewMs = 1_000, now,
} = {}) {
  const plan = validateTestnetPartitionDrillPlan(planValue);
  exact(evidenceValue, ["completedAt", "evidenceHash", "format", "networkId", "planHash",
    "releaseCheckpointHash", "scenarios", "startedAt", "version"], "drill evidence envelope");
  const { evidenceHash, ...unsigned } = evidenceValue;
  const evidence = evidencePayload(unsigned);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 ||
      maxAgeMs > MAX_EVIDENCE_AGE_MS || !Number.isSafeInteger(maxFutureSkewMs) ||
      maxFutureSkewMs < 0 || maxFutureSkewMs > 60_000 || evidence.networkId !== plan.networkId ||
      evidence.releaseCheckpointHash !== plan.releaseCheckpointHash || evidence.planHash !== plan.planHash ||
      evidence.completedAt < now - maxAgeMs || evidence.completedAt > now + maxFutureSkewMs ||
      evidenceHash !== hashObject(evidence, "TESTNET_PARTITION_DRILL_EVIDENCE_V1")) {
    throw new Error("drill evidence is stale, mutated, or bound to another plan");
  }
  const byId = new Map(evidence.scenarios.map((entry) => [entry?.id, entry]));
  if (byId.size !== evidence.scenarios.length) throw new Error("drill evidence repeats a scenario");
  const results = [];
  for (const planned of plan.scenarios) {
    const actual = byId.get(planned.id);
    exact(actual, ["id", "observations", "outcome", "quorumHashes"], "scenario evidence");
    if (!Array.isArray(actual.observations) ||
        actual.observations.length !== planned.requiredObservations.length ||
        !Array.isArray(actual.quorumHashes) || actual.quorumHashes.length > 32 ||
        !["PASS", "FAIL"].includes(actual.outcome)) throw new Error("scenario evidence is incomplete");
    const required = new Map(planned.requiredObservations.map((entry) => [entry.id, entry]));
    const observations = new Map();
    for (const observation of actual.observations) {
      exact(observation, ["algorithm", "evidenceHash", "id", "observedAt", "operatorId", "result",
        "signature"],
        "drill observation");
      const expected = required.get(observation.id);
      const operator = topologyIdentities(plan).find(
        ({ operatorId }) => operatorId === observation.operatorId);
      if (!expected || observations.has(observation.id) ||
          observation.operatorId !== expected.operatorId ||
          !operator || observation.algorithm !== SIGNATURE_ALGORITHM ||
          !["PASS", "FAIL"].includes(observation.result) ||
          !HASH.test(observation.evidenceHash ?? "") || !Number.isSafeInteger(observation.observedAt) ||
          observation.observedAt < evidence.startedAt || observation.observedAt > evidence.completedAt ||
          typeof observation.signature !== "string" || observation.signature.length > 16_384 ||
          !verifyObject(observationPayload(plan, planned.id, observation), observation.signature,
            operator.publicKey, "TESTNET_DRILL_OBSERVATION_V1")) {
        throw new Error("drill observation is missing, duplicated, stale, or from another operator");
      }
      observations.set(observation.id, observation);
    }
    const shouldPass = [...observations.values()].every(({ result }) => result === "PASS");
    if (actual.outcome !== (shouldPass ? "PASS" : "FAIL")) {
      throw new Error("scenario outcome contradicts its required observations");
    }
    const quorumHashes = actual.quorumHashes.map((value) =>
      validateQuorumHash(value, plan, planned));
    const heights = new Map();
    for (const quorum of quorumHashes) {
      const previous = heights.get(quorum.height);
      if (previous && previous !== quorum.blockHash) {
        throw new Error("scenario evidence contains conflicting quorum hashes");
      }
      heights.set(quorum.height, quorum.blockHash);
    }
    if (actual.outcome === "PASS" && quorumHashes.length < planned.requiredQuorumHashes ||
        planned.requiredQuorumHashes === 0 && quorumHashes.length !== 0) {
      throw new Error("scenario PASS lacks required quorum hashes or claims forbidden finality");
    }
    results.push({ id: planned.id, outcome: actual.outcome,
      observations: observations.size, quorumHashes: quorumHashes.length });
  }
  if (byId.size !== plan.scenarios.length) throw new Error("drill evidence contains an unknown scenario");
  const status = results.every(({ outcome }) => outcome === "PASS") ? "PASS" : "FAIL";
  const payload = { evidenceHash, format: VALIDATION_FORMAT, networkId: plan.networkId,
    planHash: plan.planHash, releaseCheckpointHash: plan.releaseCheckpointHash, results, status,
    version: 1 };
  return { ...payload, validationHash:
    hashObject(payload, "TESTNET_PARTITION_DRILL_VALIDATION_V1") };
}

export function serializeTestnetPartitionDrill(value) { return `${canonicalJson(value)}\n`; }

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function openRoot(pathValue) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new Error("secure drill filesystem support is unavailable");
  }
  const path = resolve(pathValue); const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o022) !== 0) {
    throw new Error("drill artifact root is unsafe");
  }
  const descriptor = openSync(path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || !same(before, opened)) {
    closeSync(descriptor); throw new Error("drill artifact root changed during open");
  }
  return { descriptor, metadata: opened, path };
}

function assertRoot(root) {
  const opened = fstatSync(root.descriptor); const linked = lstatSync(root.path);
  if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      !same(opened, root.metadata) || !same(linked, root.metadata) ||
      opened.mode !== root.metadata.mode || opened.uid !== root.metadata.uid ||
      opened.mtimeMs !== root.metadata.mtimeMs || opened.ctimeMs !== root.metadata.ctimeMs ||
      linked.mtimeMs !== root.metadata.mtimeMs || linked.ctimeMs !== root.metadata.ctimeMs) {
    throw new Error("drill artifact root changed during read");
  }
}

function readJson(root, name, options) {
  const path = join(root.path, name); let descriptor;
  try {
    assertRoot(root);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_JSON_BYTES || !same(before, lstatSync(path))) {
      throw new Error("drill artifact is unsafe");
    }
    options?._afterFileOpen?.({ descriptor, name, path });
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (length === 0) throw new Error("drill artifact changed during read");
      offset += length;
    }
    const after = fstatSync(descriptor); assertRoot(root);
    if (!same(before, after) || !same(before, lstatSync(path)) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("drill artifact changed during read");
    }
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("drill artifact JSON is invalid"); }
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function runTestnetPartitionDrillCommand(rootPath, command, options = {}) {
  const expected = command === "plan" ? ["preflight-report.json", "topology.json"] :
    command === "verify" ? ["drill-evidence.json", "drill-plan.json"] : null;
  if (!expected) throw new Error("drill command is invalid");
  const root = openRoot(rootPath);
  try {
    assertRoot(root);
    const names = readdirSync(root.path).sort();
    if (canonicalJson(names) !== canonicalJson(expected)) {
      throw new Error("drill artifact root has missing or unexpected files");
    }
    const result = command === "plan"
      ? createTestnetPartitionDrillPlan(readJson(root, expected[0], options),
        readJson(root, expected[1], options))
      : validateTestnetPartitionDrillEvidence(readJson(root, "drill-plan.json", options),
        readJson(root, "drill-evidence.json", options), options);
    assertRoot(root);
    return result;
  } finally { closeSync(root.descriptor); }
}
