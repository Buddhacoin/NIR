import { canonicalJson } from "./crypto.mjs";
import { requestValidatorJson } from "./http-client.mjs";
import {
  verifyValidatorAdmissionReadinessContext,
  verifyValidatorAdmissionReadinessReceipt,
} from "./validator-admission-readiness-auth.mjs";
export {
  VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH,
  VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH,
} from "./validator-admission-readiness-observer-routes.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH,
  VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH,
} from "./validator-admission-readiness-observer-routes.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function allowed(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error(`${label} has unknown fields`);
  }
}

function verifiedOrigin(peer) {
  exact(peer, ["url", "validatorAddress"], "validator readiness observer peer");
  if (!ADDRESS.test(peer.validatorAddress ?? "") || typeof peer.url !== "string") {
    throw new Error("validator readiness observer peer is invalid");
  }
  const origin = new URL(peer.url);
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" ||
      origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
      origin.origin !== peer.url) {
    throw new Error("validator readiness observer peer must be a canonical HTTPS origin");
  }
  return origin;
}

function common({ certificateContext, certificateHistory, height, peer, request, signal,
  timeoutMs, validator = null }) {
  const origin = verifiedOrigin(peer);
  if (!certificateContext || Object.getPrototypeOf(certificateContext) !== Object.prototype ||
      !Array.isArray(certificateContext.validators) || !Array.isArray(certificateHistory) ||
      !Number.isSafeInteger(height) || height < 1 || typeof request !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      (signal !== null && (typeof signal !== "object" ||
        typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean"))) {
    throw new Error("validator readiness observer request options are invalid");
  }
  const member = certificateContext.validators.find(({ address }) =>
    address === peer.validatorAddress);
  if (!member || validator !== null && canonicalJson(member) !== canonicalJson(validator)) {
    throw new Error("validator readiness observer peer membership is invalid");
  }
  return origin;
}

function contextForCertificateState(value, certificateContext) {
  if (!certificateContext || Object.getPrototypeOf(certificateContext) !== Object.prototype ||
      !Array.isArray(certificateContext.validators)) {
    throw new Error("validator readiness certificate context is invalid");
  }
  const context = verifyValidatorAdmissionReadinessContext(value);
  if (context.networkId !== certificateContext.networkId ||
      context.checkpoint.validatorSetId !== validatorSetId(certificateContext.validators)) {
    throw new Error("validator readiness context certificate state is mismatched");
  }
  return context;
}

function composeSignals(outer, inner) {
  for (const signal of [outer, inner]) {
    if (signal !== null && (typeof signal !== "object" ||
        typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) {
      throw new Error("validator readiness observer abort signal is invalid");
    }
  }
  if (outer === null) return { cleanup() {}, signal: inner };
  if (inner === null || inner === outer) return { cleanup() {}, signal: outer };
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer.addEventListener("abort", abort, { once: true });
  inner.addEventListener("abort", abort, { once: true });
  if (outer.aborted || inner.aborted) controller.abort();
  return { cleanup() {
    outer.removeEventListener("abort", abort); inner.removeEventListener("abort", abort);
  }, signal: controller.signal };
}

async function boundedRequest(request, url, options) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) throw new Error("validator readiness observer request was aborted");
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  try {
    const operation = Promise.resolve().then(() => request(url, {
      ...options, signal: controller.signal,
    }));
    const cancellation = new Promise((_, reject) => controller.signal.addEventListener("abort",
      () => reject(new Error(timedOut ? "validator readiness observer request timed out"
        : "validator readiness observer request was aborted")), { once: true }));
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function requestOptions({ certificateContext, certificateHistory, height, peer, signal,
  timeoutMs }, method, body) {
  return { body, certificateContext, certificateHistory, height,
    maxResponseBytes: MAX_RESPONSE_BYTES, method, signal, timeoutMs,
    validatorAddress: peer.validatorAddress };
}

export async function fetchValidatorAdmissionReadinessContext(options = {}) {
  allowed(options, ["candidateAddress", "certificateContext", "certificateHistory", "height",
    "peer", "request", "signal", "timeoutMs"], "validator readiness context request");
  const { candidateAddress, certificateContext, certificateHistory, height, peer,
    request = requestValidatorJson, signal = null, timeoutMs = 3_000 } = options;
  const normalized = { ...options, request, signal, timeoutMs };
  const origin = common(normalized);
  if (!ADDRESS.test(candidateAddress ?? "")) {
    throw new Error("validator readiness candidate address is invalid");
  }
  const url = new URL(VALIDATOR_ADMISSION_READINESS_OBSERVER_CONTEXT_PATH, origin);
  url.searchParams.set("address", candidateAddress);
  const response = await boundedRequest(request, url, requestOptions({ certificateContext,
    certificateHistory, height, peer, signal, timeoutMs }, "GET", undefined));
  if (response?.ok !== true || response.status !== 200) {
    throw new Error("validator readiness context response status is invalid");
  }
  const context = contextForCertificateState(response.body, certificateContext);
  if (context.candidate.address !== candidateAddress || context.checkpoint.height !== height) {
    throw new Error("validator readiness context response does not match the request");
  }
  return context;
}

export async function requestValidatorAdmissionReadinessReceipt(options = {}) {
  allowed(options, ["certificateContext", "certificateHistory", "context", "peer", "request",
    "signal", "timeoutMs", "validator"], "validator readiness receipt request");
  const { certificateContext, certificateHistory, peer, request, signal, validator,
    timeoutMs } = { request: requestValidatorJson, signal: null, timeoutMs: 3_000, ...options };
  const context = contextForCertificateState(options.context, certificateContext);
  const height = context.checkpoint.height;
  const normalized = { ...options, height, request, signal, timeoutMs };
  const origin = common(normalized);
  const url = new URL(VALIDATOR_ADMISSION_READINESS_OBSERVER_RECEIPT_PATH, origin);
  const body = canonicalClone({ context });
  const response = await boundedRequest(request, url, requestOptions({ certificateContext,
    certificateHistory, height, peer, signal, timeoutMs }, "POST", body));
  if (response?.ok !== true || response.status !== 200) {
    throw new Error("validator readiness receipt response status is invalid");
  }
  const receipt = verifyValidatorAdmissionReadinessReceipt(response.body,
    { context, validators: certificateContext.validators });
  if (receipt.observationAttestation.validator !== peer.validatorAddress) {
    throw new Error("validator readiness receipt observer is mismatched");
  }
  return receipt;
}

export function createValidatorAdmissionReadinessObserverClient({ certificateContext,
  certificateHistory, request = requestValidatorJson, signal = null,
  timeoutMs = 3_000 } = {}) {
  return Object.freeze({
    fetchContext: async (input = {}) => {
      allowed(input, ["candidateAddress", "height", "peer", "signal"],
        "validator readiness client context request");
      const { candidateAddress, height, peer, signal: requestSignal = null } = input;
      const composed = composeSignals(signal, requestSignal);
      try {
        return await fetchValidatorAdmissionReadinessContext({ candidateAddress,
          certificateContext, certificateHistory, height, peer, request,
          signal: composed.signal, timeoutMs });
      } finally { composed.cleanup(); }
    },
    requestReceipt: async (input = {}) => {
      allowed(input, ["context", "peer", "signal", "validator"],
        "validator readiness client receipt request");
      const { context, peer, signal: requestSignal = null, validator } = input;
      if (!validator || Object.getPrototypeOf(validator) !== Object.prototype) {
        throw new Error("validator readiness client receipt validator is required");
      }
      const composed = composeSignals(signal, requestSignal);
      try {
        return await requestValidatorAdmissionReadinessReceipt({ certificateContext,
          certificateHistory, context, peer, request, signal: composed.signal,
          timeoutMs, validator });
      } finally { composed.cleanup(); }
    },
  });
}
