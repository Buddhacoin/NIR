import { randomBytes } from "node:crypto";

import { addressFromPublicKey, signObject, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { requestJson } from "./http-client.mjs";

export const VALIDATOR_LIVE_IDENTITY_PATH = "/v1/public/validator-live-identity";
const DOMAIN = "VALIDATOR_LIVE_IDENTITY_V1";
const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const isHash = (value) => typeof value === "string" && HASH.test(value);

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function fields({ address, chainIdentityGenesisHash, height, networkId, nonce,
  tipHash, tlsCertificateSha256 }) {
  if (typeof address !== "string" || !ADDRESS.test(address) ||
      !isHash(chainIdentityGenesisHash) ||
      !Number.isSafeInteger(height) || height < 0 ||
      typeof networkId !== "string" || networkId.length < 3 || networkId.length > 128 ||
      !isHash(nonce) || !isHash(tipHash) || !isHash(tlsCertificateSha256)) {
    throw new Error("validator live identity fields are invalid");
  }
  return { address, chainIdentityGenesisHash, format: "nir-validator-live-identity-v1",
    height, networkId, nonce, tipHash, tlsCertificateSha256, version: 1 };
}

export function createValidatorLiveIdentity({ chainIdentityGenesisHash, height, networkId, nonce,
  tipHash, tlsCertificateSha256, wallet }) {
  const payload = fields({ address: wallet?.address, chainIdentityGenesisHash, height,
    networkId, nonce, tipHash, tlsCertificateSha256 });
  return { ...payload, signature: signObject(payload, wallet, DOMAIN) };
}

export function verifyValidatorLiveIdentity(value, { chainIdentityGenesisHash, networkId, nonce,
  tlsCertificateSha256, validator }) {
  exact(value, ["address", "chainIdentityGenesisHash", "format", "height", "networkId",
    "nonce", "signature", "tipHash", "tlsCertificateSha256", "version"],
  "validator live identity");
  const { signature, ...unsigned } = value;
  const payload = fields(unsigned);
  if (value.format !== payload.format || value.version !== 1 ||
      validator?.algorithm !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(validator.publicKey) !== validator.address ||
      value.address !== validator.address || value.chainIdentityGenesisHash !== chainIdentityGenesisHash ||
      value.networkId !== networkId || value.nonce !== nonce ||
      value.tlsCertificateSha256 !== tlsCertificateSha256 ||
      typeof signature !== "string" || signature.length < 1 || signature.length > 7_000 ||
      !verifyObject(payload, signature, validator.publicKey, DOMAIN)) {
    throw new Error("validator live identity signature or binding is invalid");
  }
  return structuredClone(value);
}

/** A nonce-bound key-possession check, not a finalized checkpoint or certificate lifecycle proof. */
export async function probeValidatorLiveIdentity({ chainIdentityGenesisHash, networkId,
  tlsCertificateSha256, upstreamOrigin, validator }) {
  const nonce = randomBytes(32).toString("hex");
  if (!isHash(chainIdentityGenesisHash) || !isHash(tlsCertificateSha256)) {
    throw new Error("validator live identity probe inputs are invalid");
  }
  let upstream;
  try { upstream = new URL(upstreamOrigin); }
  catch { throw new Error("validator live identity upstream origin is invalid"); }
  if (upstream.protocol !== "https:" ||
      !["127.0.0.1", "[::1]"].includes(upstream.hostname) || !upstream.port ||
      upstream.username || upstream.password || upstream.pathname !== "/" ||
      upstream.search || upstream.hash || upstream.origin !== upstreamOrigin) {
    throw new Error("validator live identity requires exact loopback HTTPS origin");
  }
  const response = await requestJson(`${upstream.origin}${VALIDATOR_LIVE_IDENTITY_PATH}`, {
    body: { nonce }, method: "POST", maxResponseBytes: 16 * 1024, timeoutMs: 3_000,
    tlsCertificateSha256,
  });
  if (!response.ok || response.status !== 200) {
    throw new Error("validator live identity endpoint is unavailable");
  }
  return verifyValidatorLiveIdentity(response.body, { chainIdentityGenesisHash,
    networkId, nonce, tlsCertificateSha256, validator });
}
