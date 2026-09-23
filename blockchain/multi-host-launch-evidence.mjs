import { randomBytes } from "node:crypto";

import {
  addressFromPublicKey,
  canonicalJson,
  hashObject,
  publicWallet,
  signObject,
  verifyObject,
} from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";

const PLAN_FORMAT = "nir-multi-host-launch-plan-v1";
const RECEIPT_FORMAT = "nir-multi-host-launch-host-receipt-v1";
const RESPONSE_FORMAT = "nir-multi-host-launch-service-response-v1";
const PACKAGE_FORMAT = "nir-multi-host-launch-evidence-v1";
const HASH = /^[0-9a-f]{64}$/;
const RELEASE_HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 60_000;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function validTime(value) { return Number.isSafeInteger(value) && value >= 0; }

function validateEndpoint(value, { allowInsecureLocalhost = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("launch endpoint is invalid"); }
  const localhost = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(allowInsecureLocalhost && localhost &&
        url.protocol === "http:")) || Buffer.byteLength(url.origin) > 256) {
    throw new Error("launch endpoint is invalid");
  }
  return url.origin;
}

function validateContext(value) {
  exact(value, ["drillPlanHash", "finalizedHeight", "finalizedTipHash", "genesisHash",
    "networkId", "peerRegistryHash", "recoveryStateCommitment", "releaseCheckpointHash",
    "stateRoot", "validatorSetHash"], "launch context");
  if (typeof value.networkId !== "string" || value.networkId.length < 1 ||
      Buffer.byteLength(value.networkId) > 128 || !HASH.test(value.genesisHash ?? "") ||
      !RELEASE_HASH.test(value.releaseCheckpointHash ?? "") ||
      !Number.isSafeInteger(value.finalizedHeight) || value.finalizedHeight < 1 ||
      !HASH.test(value.finalizedTipHash ?? "") || !HASH.test(value.stateRoot ?? "") ||
      !HASH.test(value.validatorSetHash ?? "") || !HASH.test(value.peerRegistryHash ?? "") ||
      !HASH.test(value.recoveryStateCommitment ?? "") || !HASH.test(value.drillPlanHash ?? "")) {
    throw new Error("launch context is invalid");
  }
  return structuredClone(value);
}

function validateIdentity(value, options) {
  exact(value, ["address", "algorithm", "endpoint", "operatorId", "publicKey", "role"],
    "launch identity");
  if (!["validator", "beacon", "archive"].includes(value.role) ||
      !NAME.test(value.operatorId ?? "") || value.algorithm !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(value.publicKey ?? "") !== value.address) {
    throw new Error("launch identity is invalid");
  }
  return { ...structuredClone(value), endpoint: validateEndpoint(value.endpoint, options) };
}

function planPayload(value, options = {}) {
  exact(value, ["context", "expiresAt", "format", "issuedAt", "outage", "runNonce",
    "topology", "version"], "launch plan");
  if (value.format !== PLAN_FORMAT || value.version !== 1 || !validTime(value.issuedAt) ||
      !validTime(value.expiresAt) || value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > MAX_AGE_MS || !NONCE.test(value.runNonce ?? "") ||
      !Array.isArray(value.topology) || value.topology.length < 10 || value.topology.length > 128) {
    throw new Error("launch plan header is invalid");
  }
  const context = validateContext(value.context);
  const topology = value.topology.map((identity) => validateIdentity(identity, options))
    .sort((a, b) => compare(`${a.role}:${a.operatorId}`, `${b.role}:${b.operatorId}`));
  const ids = new Set(topology.map(({ operatorId }) => operatorId));
  const keys = new Set(topology.map(({ address }) => address));
  const endpoints = new Set(topology.map(({ endpoint }) => endpoint));
  const validators = topology.filter(({ role }) => role === "validator");
  const beacons = topology.filter(({ role }) => role === "beacon");
  const archives = topology.filter(({ role }) => role === "archive");
  if (ids.size !== topology.length || keys.size !== topology.length ||
      endpoints.size !== topology.length || validators.length !== 4 || beacons.length < 4 ||
      archives.length < 2) throw new Error("launch topology lacks unique required operators");
  exact(value.outage, ["height", "operatorId", "stateRoot", "tipHash"], "outage context");
  if (!validators.some(({ operatorId }) => operatorId === value.outage.operatorId) ||
      !Number.isSafeInteger(value.outage.height) || value.outage.height < 1 ||
      value.outage.height >= context.finalizedHeight || !HASH.test(value.outage.tipHash ?? "") ||
      !HASH.test(value.outage.stateRoot ?? "")) throw new Error("outage context is invalid");
  return { context, expiresAt: value.expiresAt, format: PLAN_FORMAT, issuedAt: value.issuedAt,
    outage: structuredClone(value.outage), runNonce: value.runNonce, topology, version: 1 };
}

export function createMultiHostLaunchPlan(fields, options = {}) {
  const payload = planPayload({ ...fields, format: PLAN_FORMAT, version: 1 }, options);
  return { ...payload, planHash: hashObject(payload, "MULTI_HOST_LAUNCH_PLAN_V1") };
}

export function validateMultiHostLaunchPlan(value, options = {}) {
  exact(value, ["context", "expiresAt", "format", "issuedAt", "outage", "planHash",
    "runNonce", "topology", "version"], "launch plan envelope");
  const { planHash, ...unsigned } = value;
  const payload = planPayload(unsigned, options);
  if (planHash !== hashObject(payload, "MULTI_HOST_LAUNCH_PLAN_V1")) {
    throw new Error("launch plan hash is invalid");
  }
  return { ...payload, planHash };
}

function currentObservation(value, context) {
  exact(value, ["height", "peerRegistryHash", "recoveryStateCommitment", "stateRoot",
    "tipHash", "validatorSetHash"], "validator current observation");
  if (value.height !== context.finalizedHeight || value.tipHash !== context.finalizedTipHash ||
      value.stateRoot !== context.stateRoot || value.validatorSetHash !== context.validatorSetHash ||
      value.peerRegistryHash !== context.peerRegistryHash ||
      value.recoveryStateCommitment !== context.recoveryStateCommitment) {
    throw new Error("validator current observation is mixed or stale");
  }
  return structuredClone(value);
}

function validateObservation(value, identity, plan) {
  if (identity.role === "validator") {
    exact(value, ["current", "outageFinality", "recovery"], "validator observation");
    const current = currentObservation(value.current, plan.context);
    let outageFinality = value.outageFinality;
    if (identity.operatorId === plan.outage.operatorId) {
      if (outageFinality !== null) throw new Error("outage validator cannot attest outage finality");
      exact(value.recovery, ["caughtUp", "fromHeight", "newInstanceId", "oldInstanceId",
        "toHeight"], "validator recovery observation");
      if (value.recovery.caughtUp !== true || value.recovery.fromHeight > plan.outage.height ||
          value.recovery.toHeight !== plan.context.finalizedHeight ||
          !NONCE.test(value.recovery.oldInstanceId ?? "") ||
          !NONCE.test(value.recovery.newInstanceId ?? "") ||
          value.recovery.oldInstanceId === value.recovery.newInstanceId) {
        throw new Error("validator restart and catch-up observation is invalid");
      }
    } else {
      if (value.recovery !== null) throw new Error("survivor cannot claim target recovery");
      exact(outageFinality, ["height", "outageOperatorId", "stateRoot", "tipHash"],
        "outage finality observation");
      if (outageFinality.outageOperatorId !== plan.outage.operatorId ||
          outageFinality.height !== plan.outage.height ||
          outageFinality.tipHash !== plan.outage.tipHash ||
          outageFinality.stateRoot !== plan.outage.stateRoot) {
        throw new Error("outage finality observation is invalid");
      }
      outageFinality = structuredClone(outageFinality);
    }
    return { current, outageFinality, recovery: structuredClone(value.recovery) };
  }
  if (identity.role === "beacon") {
    exact(value, ["candidateId", "generation", "round", "shareHash", "status",
      "validatorTipHash"], "beacon observation");
    if (value.status !== "PASS" || !HASH.test(value.candidateId ?? "") ||
        !Number.isSafeInteger(value.generation) || value.generation < 0 ||
        !Number.isSafeInteger(value.round) || value.round < 0 || !HASH.test(value.shareHash ?? "") ||
        value.validatorTipHash !== plan.context.finalizedTipHash) {
      throw new Error("beacon observation is invalid");
    }
    return structuredClone(value);
  }
  exact(value, ["inventoryRoot", "restoreReceiptHash", "restoredHeight", "stateRoot", "status",
    "tipHash"], "archive observation");
  if (value.status !== "PASS" || !HASH.test(value.inventoryRoot ?? "") ||
      !HASH.test(value.restoreReceiptHash ?? "") ||
      value.restoredHeight !== plan.context.finalizedHeight ||
      value.tipHash !== plan.context.finalizedTipHash || value.stateRoot !== plan.context.stateRoot) {
    throw new Error("archive restore observation is invalid");
  }
  return structuredClone(value);
}

function receiptPayload(value, plan, identity) {
  exact(value, ["endpoint", "expiresAt", "format", "observation", "observedAt", "operatorId",
    "planHash", "role", "runNonce", "version"], "launch host receipt");
  if (value.format !== RECEIPT_FORMAT || value.version !== 1 || value.planHash !== plan.planHash ||
      value.runNonce !== plan.runNonce || value.role !== identity.role ||
      value.operatorId !== identity.operatorId || value.endpoint !== identity.endpoint ||
      !validTime(value.observedAt) || !validTime(value.expiresAt) ||
      value.observedAt < plan.issuedAt || value.expiresAt > plan.expiresAt ||
      value.expiresAt <= value.observedAt) throw new Error("launch host receipt context is invalid");
  return { ...structuredClone(value), observation: validateObservation(value.observation, identity, plan) };
}

export function signMultiHostLaunchReceipt(planValue, { expiresAt, observation, observedAt,
  operatorId, wallet }, options = {}) {
  const plan = validateMultiHostLaunchPlan(planValue, options);
  const identity = plan.topology.find((entry) => entry.operatorId === operatorId);
  if (!identity || wallet?.address !== identity.address || wallet.publicKey !== identity.publicKey) {
    throw new Error("launch host receipt signer is invalid");
  }
  const payload = receiptPayload({ endpoint: identity.endpoint, expiresAt,
    format: RECEIPT_FORMAT, observation, observedAt, operatorId, planHash: plan.planHash,
    role: identity.role, runNonce: plan.runNonce, version: 1 }, plan, identity);
  const receiptHash = hashObject(payload, "MULTI_HOST_LAUNCH_HOST_RECEIPT_V1");
  return { ...payload, receiptHash,
    signature: signObject({ receiptHash }, wallet, "MULTI_HOST_LAUNCH_HOST_RECEIPT_V1"),
    signer: publicWallet(wallet) };
}

export function verifyMultiHostLaunchReceipt(value, planValue, options = {}) {
  const plan = validateMultiHostLaunchPlan(planValue, options);
  exact(value, ["endpoint", "expiresAt", "format", "observation", "observedAt", "operatorId",
    "planHash", "receiptHash", "role", "runNonce", "signature", "signer", "version"],
  "launch host receipt envelope");
  const identity = plan.topology.find(({ operatorId }) => operatorId === value.operatorId);
  if (!identity) throw new Error("launch host receipt operator is unknown");
  const { receiptHash, signature, signer, ...unsigned } = value;
  exact(signer, ["address", "algorithm", "publicKey"], "launch host receipt signer");
  const payload = receiptPayload(unsigned, plan, identity);
  if (signer?.address !== identity.address || signer?.publicKey !== identity.publicKey ||
      signer?.algorithm !== SIGNATURE_ALGORITHM || receiptHash !==
      hashObject(payload, "MULTI_HOST_LAUNCH_HOST_RECEIPT_V1") ||
      !verifyObject({ receiptHash }, signature, identity.publicKey,
        "MULTI_HOST_LAUNCH_HOST_RECEIPT_V1")) {
    throw new Error("launch host receipt signature is invalid");
  }
  return { ...payload, receiptHash, signature, signer: structuredClone(signer) };
}

function responsePayload(value, plan, receipt) {
  exact(value, ["challengeNonce", "endpoint", "format", "operatorId", "planHash", "receiptHash",
    "respondedAt", "role", "runNonce", "version"], "launch service response");
  if (value.format !== RESPONSE_FORMAT || value.version !== 1 || value.planHash !== plan.planHash ||
      value.runNonce !== plan.runNonce || value.receiptHash !== receipt.receiptHash ||
      value.operatorId !== receipt.operatorId || value.role !== receipt.role ||
      value.endpoint !== receipt.endpoint || !NONCE.test(value.challengeNonce ?? "") ||
      !validTime(value.respondedAt) || value.respondedAt < receipt.observedAt ||
      value.respondedAt > receipt.expiresAt) throw new Error("launch service response is invalid");
  return structuredClone(value);
}

export function signMultiHostLaunchServiceResponse(planValue, receiptValue, {
  challengeNonce, respondedAt, wallet,
}, options = {}) {
  const plan = validateMultiHostLaunchPlan(planValue, options);
  const receipt = verifyMultiHostLaunchReceipt(receiptValue, plan, options);
  if (wallet?.address !== receipt.signer.address || wallet.publicKey !== receipt.signer.publicKey) {
    throw new Error("launch service response signer is invalid");
  }
  const payload = responsePayload({ challengeNonce, endpoint: receipt.endpoint,
    format: RESPONSE_FORMAT, operatorId: receipt.operatorId, planHash: plan.planHash,
    receiptHash: receipt.receiptHash, respondedAt, role: receipt.role, runNonce: plan.runNonce,
    version: 1 }, plan, receipt);
  const responseHash = hashObject(payload, "MULTI_HOST_LAUNCH_SERVICE_RESPONSE_V1");
  return { ...payload, responseHash,
    signature: signObject({ responseHash }, wallet, "MULTI_HOST_LAUNCH_SERVICE_RESPONSE_V1") };
}

export function verifyMultiHostLaunchServiceResponse(value, planValue, receiptValue,
  { challengeNonce, ...options } = {}) {
  const plan = validateMultiHostLaunchPlan(planValue, options);
  const receipt = verifyMultiHostLaunchReceipt(receiptValue, plan, options);
  exact(value, ["challengeNonce", "endpoint", "format", "operatorId", "planHash", "receiptHash",
    "respondedAt", "responseHash", "role", "runNonce", "signature", "version"],
  "launch service response envelope");
  const { responseHash, signature, ...unsigned } = value;
  const payload = responsePayload(unsigned, plan, receipt);
  if (payload.challengeNonce !== challengeNonce || responseHash !==
      hashObject(payload, "MULTI_HOST_LAUNCH_SERVICE_RESPONSE_V1") ||
      !verifyObject({ responseHash }, signature, receipt.signer.publicKey,
        "MULTI_HOST_LAUNCH_SERVICE_RESPONSE_V1")) {
    throw new Error("launch service response signature or challenge is invalid");
  }
  return { ...payload, responseHash, signature };
}

function validateEvidenceSets(plan, receipts, responses, challengeNonce, collectedAt, options = {}) {
  if (!Array.isArray(receipts) || !Array.isArray(responses) ||
      receipts.length !== plan.topology.length || responses.length !== receipts.length) {
    throw new Error("launch evidence is incomplete; declared-only input cannot pass");
  }
  const receiptMap = new Map();
  for (const value of receipts) {
    const receipt = verifyMultiHostLaunchReceipt(value, plan, options);
    if (receipt.expiresAt < collectedAt) throw new Error("launch host receipt expired before collection");
    if (receiptMap.has(receipt.operatorId)) throw new Error("launch evidence repeats an operator");
    receiptMap.set(receipt.operatorId, receipt);
  }
  const responseMap = new Map();
  for (const value of responses) {
    const receipt = receiptMap.get(value?.operatorId);
    if (!receipt || responseMap.has(value.operatorId)) {
      throw new Error("launch evidence repeats or invents a service response");
    }
    responseMap.set(value.operatorId, verifyMultiHostLaunchServiceResponse(value, plan, receipt,
      { ...options, challengeNonce }));
  }
  if (responseMap.size !== plan.topology.length) {
    throw new Error("launch evidence lacks independently fetched service responses");
  }
  if ([...responseMap.values()].some(({ respondedAt }) =>
    respondedAt < collectedAt - MAX_FUTURE_MS || respondedAt > collectedAt + MAX_FUTURE_MS)) {
    throw new Error("launch service response is stale or future-dated");
  }
  const validators = [...receiptMap.values()].filter(({ role }) => role === "validator");
  const survivors = validators.filter(({ operatorId }) => operatorId !== plan.outage.operatorId &&
    operatorId && true);
  if (survivors.length !== 3 || survivors.some(({ observation }) => !observation.outageFinality)) {
    throw new Error("launch evidence lacks 3/4 outage finality");
  }
  const target = validators.find(({ operatorId }) => operatorId === plan.outage.operatorId);
  if (!target?.observation.recovery?.caughtUp) {
    throw new Error("launch evidence lacks outage restart and catch-up");
  }
  const beacons = [...receiptMap.values()].filter(({ role }) => role === "beacon");
  const beaconKey = (value) => [value.candidateId, value.generation, value.round,
    value.validatorTipHash].join(":");
  const groups = new Map();
  for (const { observation } of beacons) {
    const list = groups.get(beaconKey(observation)) ?? [];
    list.push(observation); groups.set(beaconKey(observation), list);
  }
  if (groups.size !== 1) throw new Error("launch evidence mixes beacon run contexts");
  const beaconQuorum = Math.floor((beacons.length * 2) / 3) + 1;
  const selected = [...groups.values()].find((group) => group.length >= beaconQuorum &&
    new Set(group.map(({ shareHash }) => shareHash)).size === group.length);
  if (!selected) throw new Error("launch evidence lacks a unique beacon quorum");
  const archives = [...receiptMap.values()].filter(({ role }) => role === "archive");
  const archiveGroups = new Map();
  for (const receipt of archives) {
    const key = [receipt.observation.restoredHeight, receipt.observation.tipHash,
      receipt.observation.stateRoot, receipt.observation.inventoryRoot].join(":");
    const list = archiveGroups.get(key) ?? []; list.push(receipt); archiveGroups.set(key, list);
  }
  if (archiveGroups.size !== 1) throw new Error("launch evidence mixes archive restore contexts");
  const archivePair = [...archiveGroups.values()].find((group) => group.length >= 2 &&
    new Set(group.map(({ observation }) => observation.restoreReceiptHash)).size === group.length);
  if (!archivePair) throw new Error("launch evidence lacks two independent archive restores");
  return { receiptMap, responseMap, beaconQuorum, beaconResponders: selected.length,
    archiveResponders: archivePair.length, validatorResponders: validators.length };
}

function packagePayload(value, options = {}) {
  exact(value, ["challengeNonce", "collectedAt", "format", "hostReceipts", "plan",
    "serviceResponses", "version"], "launch evidence package");
  const plan = validateMultiHostLaunchPlan(value.plan, options);
  if (value.format !== PACKAGE_FORMAT || value.version !== 1 ||
      !NONCE.test(value.challengeNonce ?? "") || !validTime(value.collectedAt) ||
      value.collectedAt < plan.issuedAt || value.collectedAt > plan.expiresAt ||
      Buffer.byteLength(canonicalJson(value)) > MAX_BYTES) {
    throw new Error("launch evidence package header is invalid");
  }
  const hostReceipts = structuredClone(value.hostReceipts).sort((a, b) =>
    compare(`${a?.role}:${a?.operatorId}`, `${b?.role}:${b?.operatorId}`));
  const serviceResponses = structuredClone(value.serviceResponses).sort((a, b) =>
    compare(`${a?.role}:${a?.operatorId}`, `${b?.role}:${b?.operatorId}`));
  return { challengeNonce: value.challengeNonce, collectedAt: value.collectedAt,
    format: PACKAGE_FORMAT, hostReceipts, plan, serviceResponses, version: 1 };
}

export function createMultiHostLaunchEvidencePackage(fields, options = {}) {
  const payload = packagePayload({ ...fields, format: PACKAGE_FORMAT, version: 1 }, options);
  validateEvidenceSets(payload.plan, payload.hostReceipts, payload.serviceResponses,
    payload.challengeNonce, payload.collectedAt, options);
  return { ...payload, packageHash: hashObject(payload, "MULTI_HOST_LAUNCH_EVIDENCE_V1") };
}

export function verifyMultiHostLaunchEvidencePackage(value, {
  expectedPlanHash, expectedRunNonce, maxFutureSkewMs = 1_000, now, ...options
} = {}) {
  exact(value, ["challengeNonce", "collectedAt", "format", "hostReceipts", "packageHash",
    "plan", "serviceResponses", "version"], "launch evidence package envelope");
  const { packageHash, ...unsigned } = value;
  const payload = packagePayload(unsigned, options);
  if (!validTime(now) || !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 ||
      maxFutureSkewMs > MAX_FUTURE_MS || payload.plan.runNonce !== expectedRunNonce ||
      payload.plan.planHash !== expectedPlanHash || !HASH.test(expectedPlanHash ?? "") ||
      now < payload.collectedAt - maxFutureSkewMs || now > payload.plan.expiresAt ||
      packageHash !== hashObject(payload, "MULTI_HOST_LAUNCH_EVIDENCE_V1")) {
    throw new Error("launch evidence package is stale, replayed, or mutated");
  }
  const summary = validateEvidenceSets(payload.plan, payload.hostReceipts,
    payload.serviceResponses, payload.challengeNonce, payload.collectedAt, options);
  return { archiveResponders: summary.archiveResponders,
    beaconQuorum: summary.beaconQuorum, beaconResponders: summary.beaconResponders,
    finalizedHeight: payload.plan.context.finalizedHeight, format: "nir-multi-host-launch-validation-v1",
    networkId: payload.plan.context.networkId, packageHash, physicalIndependenceClaimed: false,
    recoveryStateCommitment: payload.plan.context.recoveryStateCommitment, status: "PASS",
    validatorResponders: summary.validatorResponders, version: 1 };
}

async function boundedJson(response) {
  if (!response.ok) throw new Error(`launch evidence service returned HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    throw new Error("launch evidence service response is oversized");
  }
  if (!response.body) throw new Error("launch evidence service response has no body");
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) {
        await reader.cancel(); throw new Error("launch evidence service response is oversized");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return parseConsensusJson(new TextDecoder().decode(bytes)); }
  catch { throw new Error("launch evidence service response is invalid JSON"); }
}

export async function collectMultiHostLaunchEvidence(planValue, receiptValues, {
  allowInsecureLocalhost = false, challengeNonce = randomBytes(16).toString("hex"),
  fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 10_000,
} = {}) {
  const options = { allowInsecureLocalhost };
  const plan = validateMultiHostLaunchPlan(planValue, options);
  if (typeof fetchImpl !== "function" || !NONCE.test(challengeNonce) || !validTime(now) ||
      now > plan.expiresAt || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 ||
      timeoutMs > 60_000) throw new Error("launch evidence collector policy is invalid");
  const receipts = receiptValues.map((value) => verifyMultiHostLaunchReceipt(value, plan, options));
  if (receipts.length !== plan.topology.length) {
    throw new Error("launch evidence collector requires every signed host receipt");
  }
  const responses = await Promise.all(receipts.map(async (receipt) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${receipt.endpoint}/v1/launch-evidence`, {
        body: canonicalJson({ challengeNonce, planHash: plan.planHash,
          receiptHash: receipt.receiptHash, runNonce: plan.runNonce }),
        headers: { "content-type": "application/json" }, method: "POST", redirect: "error",
        signal: controller.signal,
      });
      return await boundedJson(response);
    } finally { clearTimeout(timer); }
  }));
  return createMultiHostLaunchEvidencePackage({ challengeNonce, collectedAt: now,
    hostReceipts: receipts, plan, serviceResponses: responses }, options);
}

export function serializeMultiHostLaunchEvidence(value) { return `${canonicalJson(value)}\n`; }
