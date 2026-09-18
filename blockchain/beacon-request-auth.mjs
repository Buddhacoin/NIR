import { randomBytes } from "node:crypto";

import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { addressFromPublicKey, signObject, verifyObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const FORMAT = "nir-beacon-share-request-v1";
const DOMAIN = "BEACON_SHARE_REQUEST_V1";

function exact(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) {
    throw new Error(`${label} schema is invalid`);
  }
}

export function validateBeaconRequesterPolicy(value, { beaconAddress, networkId }) {
  exact(value, ["beaconAddress", "format", "networkId", "requesters", "reservedAddresses",
    "reservedOperatorIds"],
    "beacon requester policy");
  if (value.format !== "nir-beacon-requester-policy-v1" ||
      value.beaconAddress !== beaconAddress || value.networkId !== networkId ||
      !Array.isArray(value.requesters) || value.requesters.length < 1 ||
      value.requesters.length > 128 || !Array.isArray(value.reservedAddresses) ||
      value.reservedAddresses.length < 1 || value.reservedAddresses.length > 1_024 ||
      !Array.isArray(value.reservedOperatorIds) || value.reservedOperatorIds.length < 1 ||
      value.reservedOperatorIds.length > 1_024 ||
      value.reservedOperatorIds.some((operator) => !OPERATOR.test(operator)) ||
      new Set(value.reservedOperatorIds).size !== value.reservedOperatorIds.length ||
      !value.reservedAddresses.includes(beaconAddress) ||
      value.reservedAddresses.some((address) => !ADDRESS.test(address)) ||
      new Set(value.reservedAddresses).size !== value.reservedAddresses.length) {
    throw new Error("beacon requester policy is invalid");
  }
  const reserved = new Set(value.reservedAddresses);
  const reservedOperators = new Set(value.reservedOperatorIds);
  const addresses = new Set();
  const operators = new Set();
  const keys = new Set();
  const requesters = new Map();
  for (const requester of value.requesters) {
    exact(requester, ["address", "algorithm", "operatorId", "publicKey"], "beacon requester");
    if (requester.algorithm !== SIGNATURE_ALGORITHM || !OPERATOR.test(requester.operatorId ?? "") ||
        addressFromPublicKey(requester.publicKey ?? "") !== requester.address ||
        reserved.has(requester.address) || reservedOperators.has(requester.operatorId) ||
        addresses.has(requester.address) ||
        operators.has(requester.operatorId) || keys.has(requester.publicKey)) {
      throw new Error("beacon requester identities are invalid, duplicated, or reserved");
    }
    addresses.add(requester.address); operators.add(requester.operatorId); keys.add(requester.publicKey);
    requesters.set(requester.address, structuredClone(requester));
  }
  return requesters;
}

function payload(value) {
  exact(value, ["beaconAddress", "candidateId", "expiresAt", "issuedAt", "networkId", "nonce",
    "purpose", "requester", "round"], "beacon share request payload");
  if (!ADDRESS.test(value.beaconAddress ?? "") || !ADDRESS.test(value.requester ?? "") ||
      !HASH.test(value.candidateId ?? "") || !HASH.test(value.nonce ?? "") ||
      !["fallback", "progress"].includes(value.purpose) ||
      !Number.isSafeInteger(value.round) || value.round < 1 ||
      !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > 60_000 || typeof value.networkId !== "string") {
    throw new Error("beacon share request payload is invalid");
  }
  return { ...value };
}

export function createBeaconShareRequest(fields, wallet, {
  clock = () => Date.now(), lifetimeMs = 30_000, nonce = randomBytes(32).toString("hex"),
} = {}) {
  const issuedAt = clock();
  const unsigned = payload({ ...fields, expiresAt: issuedAt + lifetimeMs, issuedAt, nonce,
    requester: wallet.address });
  return { format: FORMAT, payload: unsigned, signature: signObject(unsigned, wallet, DOMAIN) };
}

export function verifyBeaconShareRequest(envelope, {
  beaconAddress, clock = () => Date.now(), minimumTime = 0, networkId, requesters,
}) {
  exact(envelope, ["format", "payload", "signature"], "beacon share request");
  if (envelope.format !== FORMAT || !(requesters instanceof Map)) {
    throw new Error("beacon share request format is invalid");
  }
  const unsigned = payload(envelope.payload);
  const wallNow = clock();
  if (!Number.isSafeInteger(wallNow) || wallNow < 0 || !Number.isSafeInteger(minimumTime) ||
      minimumTime < 0) throw new Error("beacon request clock is invalid");
  const now = Math.max(wallNow, minimumTime);
  if (unsigned.networkId !== networkId || unsigned.beaconAddress !== beaconAddress ||
      unsigned.issuedAt > wallNow + 5_000 || unsigned.expiresAt <= now ||
      unsigned.issuedAt < now - 60_000) {
    throw new Error("beacon share request context or validity window is invalid");
  }
  const requester = requesters.get(unsigned.requester);
  if (!requester) throw new Error("beacon share requester is unauthorized");
  if (typeof envelope.signature !== "string" || envelope.signature.length > 16_384 ||
      !verifyObject(unsigned, envelope.signature, requester.publicKey, DOMAIN)) {
    throw new Error("beacon share request signature is invalid");
  }
  return { ...unsigned, replayKey: `${unsigned.requester}:${unsigned.nonce}`, verifiedAt: now };
}
