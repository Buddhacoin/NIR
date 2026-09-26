import { consensusValueBytes } from "./consensus-codec.mjs";
import { MAX_VALIDATORS } from "./constants.mjs";
import {
  createValidatorAdmissionReadinessCertificate,
  verifyValidatorAdmissionReadinessContext,
  verifyValidatorAdmissionReadinessReceipt,
} from "./validator-admission-readiness-auth.mjs";

export const VALIDATOR_READINESS_COLLECTOR_MAX_CONCURRENCY = 16;
export const VALIDATOR_READINESS_COLLECTOR_MAX_REQUEST_TIMEOUT_MS = 60_000;
export const VALIDATOR_READINESS_COLLECTOR_MAX_CONTEXT_BYTES = 256 * 1024;
export const VALIDATOR_READINESS_COLLECTOR_MAX_PEER_BYTES = 64 * 1024;
export const VALIDATOR_READINESS_COLLECTOR_MAX_RECEIPT_BYTES = 256 * 1024;
// A maximum-set exact quorum contains four ML-DSA-65 signatures per self-contained receipt.
export const VALIDATOR_READINESS_COLLECTOR_MAX_CERTIFICATE_BYTES = 8 * 1024 * 1024;

const ADDRESS = /^nir1[0-9a-f]{64}$/;

function boundedClone(value, maximumBytes, label) {
  let bytes;
  try { bytes = consensusValueBytes(value); }
  catch { throw new Error(`${label} is not canonical public data`); }
  if (bytes.length > maximumBytes) throw new Error(`${label} is too large`);
  return structuredClone(value);
}

function normalizeObservers(validators, peers) {
  if (!Array.isArray(validators) || validators.length < 4 ||
      validators.length > MAX_VALIDATORS || !Array.isArray(peers) ||
      peers.length !== validators.length) {
    throw new Error("validator readiness collector membership is invalid");
  }
  const validatorByAddress = new Map();
  for (const validator of validators) {
    const normalized = boundedClone(validator, VALIDATOR_READINESS_COLLECTOR_MAX_PEER_BYTES,
      "validator readiness collector validator");
    if (!ADDRESS.test(normalized?.address ?? "") || validatorByAddress.has(normalized.address)) {
      throw new Error("validator readiness collector membership is invalid");
    }
    validatorByAddress.set(normalized.address, normalized);
  }
  const peerByAddress = new Map();
  for (const peer of peers) {
    const normalized = boundedClone(peer, VALIDATOR_READINESS_COLLECTOR_MAX_PEER_BYTES,
      "validator readiness collector peer");
    if (!ADDRESS.test(normalized?.validatorAddress ?? "") ||
        !validatorByAddress.has(normalized.validatorAddress) ||
        peerByAddress.has(normalized.validatorAddress)) {
      throw new Error("validator readiness collector peer set is invalid");
    }
    peerByAddress.set(normalized.validatorAddress, normalized);
  }
  return [...validatorByAddress].sort(([left], [right]) => left.localeCompare(right))
    .map(([address, validator]) => ({ address, peer: peerByAddress.get(address), validator }));
}

function assertCollectorOptions({ collectReceipt, concurrency, requestTimeoutMs, signal,
  verifyReceipt }) {
  if (typeof collectReceipt !== "function" || typeof verifyReceipt !== "function" ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 ||
      concurrency > VALIDATOR_READINESS_COLLECTOR_MAX_CONCURRENCY ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      requestTimeoutMs > VALIDATOR_READINESS_COLLECTOR_MAX_REQUEST_TIMEOUT_MS ||
      (signal !== null && (typeof signal !== "object" ||
       typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean"))) {
    throw new Error("validator readiness collector options are invalid");
  }
}

function requestWithDeadline(collectReceipt, input, collectionSignal, requestTimeoutMs) {
  const requestController = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      collectionSignal.removeEventListener("abort", onCollectionAbort);
      callback(value);
    };
    const onCollectionAbort = () => {
      requestController.abort();
      finish(reject, new Error("validator readiness collection was aborted"));
    };
    timer = setTimeout(() => {
      requestController.abort();
      finish(reject, new Error("validator readiness observer request timed out"));
    }, requestTimeoutMs);
    if (collectionSignal.aborted) onCollectionAbort();
    else collectionSignal.addEventListener("abort", onCollectionAbort, { once: true });
    if (!settled) {
      Promise.resolve().then(() => collectReceipt({ ...input, signal: requestController.signal }))
        .then((value) => finish(resolve, value), (error) => finish(reject, error));
    }
  });
}

/**
 * Collects public, independently authenticated readiness receipts. The caller-supplied collector
 * performs transport outside this module; it receives only cloned public context, validator, and
 * peer data. The verifier is a narrow adapter to validator-admission-readiness-auth.mjs.
 */
export async function collectValidatorAdmissionReadinessCertificate({
  collectReceipt,
  concurrency = 4,
  context,
  peers,
  requestTimeoutMs = 5_000,
  signal = null,
  validators,
  verifyReceipt = verifyValidatorAdmissionReadinessReceipt,
} = {}) {
  assertCollectorOptions({ collectReceipt, concurrency, requestTimeoutMs, signal, verifyReceipt });
  if (signal?.aborted) throw new Error("validator readiness collection was aborted");
  const publicContext = verifyValidatorAdmissionReadinessContext(boundedClone(context,
    VALIDATOR_READINESS_COLLECTOR_MAX_CONTEXT_BYTES, "validator readiness collector context"));
  const observers = normalizeObservers(validators, peers);
  const publicValidators = observers.map(({ validator }) => structuredClone(validator));
  const quorum = Math.floor((observers.length * 2) / 3) + 1;
  const verifiedByAddress = new Map();
  const settled = new Set();
  const collectionController = new AbortController();
  let next = 0;
  let complete;
  let fail;
  let finished = false;
  const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });

  const finish = (callback, value) => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener?.("abort", abortCollection);
    callback(value);
    collectionController.abort();
  };
  const abortCollection = () => finish(fail,
    new Error("validator readiness collection was aborted"));
  signal?.addEventListener?.("abort", abortCollection, { once: true });
  if (signal?.aborted) abortCollection();

  const maybeFinish = () => {
    let valid = 0;
    for (const observer of observers) {
      if (verifiedByAddress.has(observer.address)) valid += 1;
      if (valid === quorum) {
        if ([...observers.slice(0, observers.indexOf(observer) + 1)]
          .every(({ address }) => settled.has(address))) finish(complete);
        return;
      }
    }
    if (settled.size === observers.length) {
      finish(fail, new Error("validator readiness collector quorum is not reached"));
    }
  };

  const worker = async () => {
    while (!finished && next < observers.length) {
      const observer = observers[next];
      next += 1;
      try {
        const received = await requestWithDeadline(collectReceipt, {
          context: structuredClone(publicContext),
          peer: structuredClone(observer.peer),
          validator: structuredClone(observer.validator),
        }, collectionController.signal, requestTimeoutMs);
        const bounded = boundedClone(received,
          VALIDATOR_READINESS_COLLECTOR_MAX_RECEIPT_BYTES,
          "validator readiness collector receipt");
        const verified = await verifyReceipt(bounded, {
          context: structuredClone(publicContext),
          validator: structuredClone(observer.validator),
          validators: structuredClone(publicValidators),
        });
        const normalized = boundedClone(verified,
          VALIDATOR_READINESS_COLLECTOR_MAX_RECEIPT_BYTES,
          "verified validator readiness receipt");
        const verifiedObserver = normalized?.observationAttestation?.validator;
        if (verifiedObserver !== observer.address || verifiedByAddress.has(verifiedObserver)) continue;
        verifiedByAddress.set(verifiedObserver, normalized);
      } catch {
        // One unavailable or invalid observer must not prevent an honest quorum from completing.
      } finally {
        settled.add(observer.address);
        maybeFinish();
      }
    }
  };
  for (let index = 0; index < Math.min(concurrency, observers.length); index += 1) {
    void worker().catch((error) => finish(fail, error));
  }
  await completion;

  const receipts = [...verifiedByAddress.values()]
    .sort((left, right) => left.observationAttestation.validator.localeCompare(
      right.observationAttestation.validator)).slice(0, quorum);
  const certificate = createValidatorAdmissionReadinessCertificate({
    context: publicContext, receipts, validators: publicValidators,
  });
  if (consensusValueBytes(certificate).length >
      VALIDATOR_READINESS_COLLECTOR_MAX_CERTIFICATE_BYTES) {
    throw new Error("validator readiness certificate is too large");
  }
  return certificate;
}
