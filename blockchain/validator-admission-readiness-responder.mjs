import {
  verifyValidatorAdmissionReadinessCandidateResponse,
  verifyValidatorAdmissionReadinessCandidateTransportResponse,
  validatorAdmissionReadinessConsensusSigningInput,
  validatorAdmissionReadinessTransportSigningInput,
} from "./validator-admission-readiness-auth.mjs";

function assertSigner(signer, identity, label) {
  const narrow = label === "transport" ? "signReadinessTransport" : "signReadinessConsensus";
  if (!signer || signer.address !== identity.address || signer.algorithm !== identity.algorithm ||
      signer.publicKey !== identity.publicKey || typeof signer[narrow] !== "function") {
    throw new Error(`validator admission readiness ${label} signer is mismatched`);
  }
}

function aborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason
      : new Error("validator admission readiness response was aborted");
  }
}

function signWithAbort(operation, signal) {
  aborted(signal);
  let result;
  try { result = Promise.resolve(operation()); }
  catch (error) { result = Promise.reject(error); }
  if (signal === null) return result;
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
    result.then((value) => finish(resolve, value), (error) => finish(reject, error));
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
  const prepared = validatorAdmissionReadinessTransportSigningInput({ challenge, context,
    validators });
  const verifiedContext = prepared.context;
  const verifiedChallenge = prepared.challenge;
  assertSigner(transportSigner, verifiedContext.transport, "transport");
  assertSigner(consensusSigner, verifiedContext.candidate, "consensus");
  aborted(signal);

  const transportSignature = await signWithAbort(() => transportSigner.signReadinessTransport({
    challenge: verifiedChallenge, signal, signingInput: structuredClone(prepared.signingInput),
  }), signal);
  aborted(signal);
  const transportResponse = verifyValidatorAdmissionReadinessCandidateTransportResponse({
    challenge: verifiedChallenge, context: verifiedContext, ...prepared.signingInput,
    transportSignature,
  }, { validators });
  const consensus = validatorAdmissionReadinessConsensusSigningInput({ transportResponse,
    validators });
  const consensusSignature = await signWithAbort(() => consensusSigner.signReadinessConsensus({
    signal, signingInput: structuredClone(consensus.signingInput), transportResponse,
  }), signal);
  aborted(signal);
  return verifyValidatorAdmissionReadinessCandidateResponse({ ...transportResponse,
    consensusSignature }, { validators });
}
