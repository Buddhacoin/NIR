import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const PATH = "/v1/public/validator-admission-finality";

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

export function validatorAdmissionProofRequest({ chainIdentityGenesisHash, checkpointHash,
  fromHeight, transactionId }) {
  if (!Number.isSafeInteger(fromHeight) || fromHeight < 0 ||
      !HASH.test(chainIdentityGenesisHash ?? "") || !HASH.test(checkpointHash ?? "") ||
      !HASH.test(transactionId ?? "")) {
    throw new Error("validator admission proof request is invalid");
  }
  return { chainIdentityGenesisHash, checkpointHash, fromHeight, transactionId };
}

function responseFields({ clientNonce, networkId, request, result, signer }) {
  return { clientNonce, format: "nir-validator-admission-proof-response-auth-v1",
    method: "GET", networkId, path: PATH,
    requestHash: hashObject(request, "NIR_ADMISSION_PROOF_REQUEST_V1"),
    resultHash: hashObject(result, "NIR_ADMISSION_PROOF_RESULT_V1"), signer, version: 1 };
}

export function createValidatorAdmissionProofResponseAuth({ clientNonce, networkId, request,
  result, wallet }) {
  const normalized = validatorAdmissionProofRequest(request);
  if (!HASH.test(clientNonce ?? "")) throw new Error("validator admission proof nonce is invalid");
  const fields = responseFields({ clientNonce, networkId, request: normalized,
    result, signer: wallet.address });
  return { ...fields, signature: signObject(fields, wallet, "NIR_ADMISSION_PROOF_RESPONSE_V1") };
}

export function verifyValidatorAdmissionProofResponseAuth(auth, { clientNonce, networkId,
  request, result, validator }) {
  exact(auth, ["clientNonce", "format", "method", "networkId", "path", "requestHash",
    "resultHash", "signature", "signer", "version"], "validator admission proof response auth");
  const normalized = validatorAdmissionProofRequest(request);
  const fields = responseFields({ clientNonce, networkId, request: normalized,
    result, signer: validator.address });
  const { signature: _signature, ...authenticatedFields } = auth;
  if (!HASH.test(clientNonce ?? "") || !ADDRESS.test(validator?.address ?? "") ||
      canonicalJson(authenticatedFields) !== canonicalJson(fields) ||
      auth.signer !== validator.address ||
      !verifyObject(fields, auth.signature, validator.publicKey,
        "NIR_ADMISSION_PROOF_RESPONSE_V1")) {
    throw new Error("validator admission proof response signature is invalid");
  }
  return structuredClone(result);
}

export const VALIDATOR_ADMISSION_PROOF_PATH = PATH;
