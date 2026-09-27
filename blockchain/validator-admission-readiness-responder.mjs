import { hashObject } from "./crypto.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
  verifyValidatorAdmissionReadinessCandidateResponse,
  verifyValidatorAdmissionReadinessCandidateTransportResponse,
  verifyValidatorAdmissionReadinessChallenge,
  verifyValidatorAdmissionReadinessContext,
} from "./validator-admission-readiness-auth.mjs";

function assertSigner(signer, identity, label) {
  if (!signer || signer.address !== identity.address || signer.algorithm !== identity.algorithm ||
      signer.publicKey !== identity.publicKey || typeof signer.sign !== "function") {
    throw new Error(`validator admission readiness ${label} signer is mismatched`);
  }
}

function aborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason
      : new Error("validator admission readiness response was aborted");
  }
}

function signWithAbort(signer, payload, domain, signal) {
  aborted(signal);
  let operation;
  try { operation = Promise.resolve(signer.sign(structuredClone(payload), domain, { signal })); }
  catch (error) { operation = Promise.reject(error); }
  if (signal === null) return operation;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason
      : new Error("validator admission readiness response was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

/**
 * Produces the dual-signed candidate response through two deliberately narrow signer interfaces.
 * Validation is complete before either signer is called. The transport signer is called first;
 * the consensus signer cannot be called after cancellation or a failed transport signature.
 */
export async function respondToValidatorAdmissionReadinessChallenge({
  challenge,
  consensusSigner,
  context,
  signal = null,
  transportSigner,
  validators,
} = {}) {
  if (signal !== null && (typeof signal !== "object" ||
      typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    throw new Error("validator admission readiness response abort signal is invalid");
  }
  const verifiedContext = verifyValidatorAdmissionReadinessContext(context);
  const verifiedChallenge = verifyValidatorAdmissionReadinessChallenge(challenge, {
    context: verifiedContext, validators,
  });
  assertSigner(transportSigner, verifiedContext.transport, "transport");
  assertSigner(consensusSigner, verifiedContext.candidate, "consensus");
  aborted(signal);

  const signed = { challengeHash: verifiedChallenge.challengeHash,
    contextHash: verifiedContext.contextHash,
    format: "nir-validator-admission-readiness-candidate-response-v1",
    observer: verifiedChallenge.observer,
    transportAddress: verifiedContext.transport.address, version: 1 };
  const responseHash = hashObject({ challenge: verifiedChallenge, context: verifiedContext,
    ...signed }, "VALIDATOR_READY_RESPONSE_HASH_V1");
  const transportSignature = await signWithAbort(transportSigner, { ...signed, responseHash },
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN, signal);
  aborted(signal);
  const transportResponse = verifyValidatorAdmissionReadinessCandidateTransportResponse({
    challenge: verifiedChallenge, context: verifiedContext, ...signed, responseHash,
    transportSignature,
  }, { validators });
  const consensusSignature = await signWithAbort(consensusSigner, { ...signed, responseHash,
    transportSignature: transportResponse.transportSignature },
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN, signal);
  aborted(signal);
  return verifyValidatorAdmissionReadinessCandidateResponse({ ...transportResponse,
    consensusSignature }, { validators });
}
