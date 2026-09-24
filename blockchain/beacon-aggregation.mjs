import { canonicalJson } from "./crypto.mjs";
import { createFallbackBeacon, createProgressBeacon } from "./operators.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const PURPOSES = new Set(["fallback", "progress"]);
const MAX_SHARES = 128;

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function canonicalBase64(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 16 * 1024) return false;
  try { return Buffer.from(value, "base64").toString("base64") === value; }
  catch { return false; }
}

function validateShare(value, { candidateId, generation, networkId, round }) {
  exact(value, ["authority", "candidateId", "generation", "networkId", "round", "signature", "value"],
    "beacon share");
  if (!ADDRESS.test(value.authority ?? "") || value.candidateId !== candidateId ||
      value.networkId !== networkId || value.generation !== generation || value.round !== round ||
      !HASH.test(value.value ?? "") || !canonicalBase64(value.signature)) {
    throw new Error("beacon share context or encoding is invalid");
  }
  return structuredClone(value);
}

export function aggregateBeaconShares({ candidateId, networkId, purpose = "fallback", round, shares }) {
  if (!PURPOSES.has(purpose) || typeof networkId !== "string" || networkId.length < 1 ||
      Buffer.byteLength(networkId) > 128 || !HASH.test(candidateId ?? "") ||
      !Number.isSafeInteger(round) || round < 1 || !Array.isArray(shares) || shares.length < 3 ||
      shares.length > MAX_SHARES) throw new Error("beacon aggregation input is invalid");
  const generation = shares[0]?.generation;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("beacon share generation is invalid");
  }
  const validated = shares.map((share) => validateShare(share,
    { candidateId, generation, networkId, round }));
  const authorities = new Set(validated.map(({ authority }) => authority));
  if (authorities.size !== validated.length) throw new Error("beacon share authority is duplicated");
  const createBeacon = purpose === "progress" ? createProgressBeacon : createFallbackBeacon;
  return createBeacon({ shares: validated, networkId, candidateId, generation, round });
}

export function serializeAggregatedBeacon(value) { return `${canonicalJson(value)}\n`; }
