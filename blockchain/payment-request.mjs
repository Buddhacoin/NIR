import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { addressFromPublicKey, signObject, verifyObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const IDENTIFIER = /^[0-9a-f]{64}$/;
const NETWORK = /^[a-zA-Z0-9._:-]{3,128}$/;
const AMOUNT = /^[1-9][0-9]{0,30}$/;
const EXACT_FIELDS = [
  "algorithm", "amount", "expiresAt", "memo", "networkId", "publicKey",
  "recipient", "requestId", "signature", "type", "version",
];

function validateMemo(memo) {
  if (typeof memo !== "string" || Buffer.byteLength(memo, "utf8") > 160 ||
      /[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(memo)) {
    throw new Error("payment request memo is invalid");
  }
}

function validateUnsigned(request) {
  if (!request || request.type !== "payment-request" || request.version !== 1 ||
      request.algorithm !== SIGNATURE_ALGORITHM || !AMOUNT.test(request.amount ?? "") ||
      !NETWORK.test(request.networkId ?? "") || !IDENTIFIER.test(request.requestId ?? "") ||
      !ADDRESS.test(request.recipient ?? "") || typeof request.publicKey !== "string" ||
      request.publicKey.length < 100 || request.publicKey.length > 8_192 ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= 0) {
    throw new Error("payment request is invalid");
  }
  validateMemo(request.memo);
  if (addressFromPublicKey(request.publicKey) !== request.recipient) {
    throw new Error("payment request recipient does not match its public key");
  }
}

export function createPaymentRequest({ wallet, networkId, amount, memo = "", expiresAt, requestId }) {
  const request = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    expiresAt,
    memo,
    networkId,
    publicKey: wallet?.publicKey,
    recipient: wallet?.address,
    requestId,
    type: "payment-request",
    version: 1,
  };
  validateUnsigned(request);
  return { ...request, signature: signObject(request, wallet, "PAYMENT_REQUEST") };
}

export function verifyPaymentRequest(request, { networkId, now = Date.now() } = {}) {
  if (!request || Object.keys(request).sort().join("\0") !== [...EXACT_FIELDS].sort().join("\0") ||
      typeof request.signature !== "string" || request.signature.length < 100 ||
      request.signature.length > 8_192) {
    throw new Error("payment request shape is invalid");
  }
  const { signature, ...unsigned } = request;
  validateUnsigned(unsigned);
  if (networkId !== undefined && unsigned.networkId !== networkId) {
    throw new Error("payment request belongs to another network");
  }
  if (!Number.isSafeInteger(now) || now < 0 || unsigned.expiresAt <= now) {
    throw new Error("payment request has expired");
  }
  if (!verifyObject(unsigned, signature, unsigned.publicKey, "PAYMENT_REQUEST")) {
    throw new Error("payment request signature is invalid");
  }
  return structuredClone(request);
}
