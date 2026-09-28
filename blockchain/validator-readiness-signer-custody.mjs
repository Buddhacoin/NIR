import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  sign,
  scryptSync,
} from "node:crypto";

import { addressFromPublicKey, canonicalJson } from "./crypto.mjs";
import { consensusEnvelopeBytes } from "./consensus-codec.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
} from "./validator-admission-readiness-auth.mjs";
import {
  VALIDATOR_READINESS_CONSENSUS_PROCESS_READY_SIGNATURE_DOMAIN,
  VALIDATOR_READINESS_TRANSPORT_PROCESS_READY_SIGNATURE_DOMAIN,
} from "./validator-readiness-process-protocol.mjs";
import { encryptedVaultPublicCommitment } from "./vault.mjs";

const SIGNER_ROLES = new Set(["consensus", "transport"]);
const MAX_PASSWORD_BYTES = 1_024;
const KDF = Object.freeze({ N: 32768, p: 1, r: 8 });
const PEM_HEADER = Buffer.from("-----BEGIN PRIVATE KEY-----\n", "ascii");
const PEM_FOOTER = Buffer.from("\n-----END PRIVATE KEY-----\n", "ascii");
const DOMAINS = Object.freeze({
  consensus: Object.freeze({
    operation: VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
    ready: VALIDATOR_READINESS_CONSENSUS_PROCESS_READY_SIGNATURE_DOMAIN,
  }),
  transport: Object.freeze({
    operation: VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
    ready: VALIDATOR_READINESS_TRANSPORT_PROCESS_READY_SIGNATURE_DOMAIN,
  }),
});

function role(value) {
  if (!SIGNER_ROLES.has(value)) throw new Error("validator readiness signer custody role is invalid");
  return value;
}

function vaultCommitment(value, actual) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== ["address", "algorithm", "publicKey", "vaultHash"]
        .sort().join("\0") || canonicalJson(value) !== canonicalJson(actual)) {
    throw new Error("validator readiness signer custody vault commitment is invalid");
  }
  return actual;
}

function password(value) {
  if (!Buffer.isBuffer(value) || value.length < 12 || value.length > MAX_PASSWORD_BYTES) {
    throw new Error("validator readiness signer custody password is invalid");
  }
  for (const byte of value) {
    if (byte <= 0x1f || byte === 0x7f) {
      throw new Error("validator readiness signer custody password is invalid");
    }
  }
  return value;
}

function base64Value(byte) {
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x61 + 26;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30 + 52;
  if (byte === 0x2b) return 62;
  if (byte === 0x2f) return 63;
  return -1;
}

function canonicalPrivateKeyBase64(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 16_384 ||
      bytes.length % 4 !== 0) {
    throw new Error("decrypted signer key is invalid");
  }
  let padding = 0;
  if (bytes.at(-1) === 0x3d) padding += 1;
  if (bytes.at(-2) === 0x3d) padding += 1;
  for (let index = 0; index < bytes.length - padding; index += 1) {
    if (base64Value(bytes[index]) < 0) {
      throw new Error("decrypted signer key is invalid");
    }
  }
  for (let index = bytes.length - padding; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x3d) throw new Error("decrypted signer key is invalid");
  }
  if (padding > 2 || (padding === 1 &&
      (base64Value(bytes.at(-2)) & 0x03) !== 0) ||
      (padding === 2 && (base64Value(bytes.at(-3)) & 0x0f) !== 0)) {
    throw new Error("decrypted signer key is invalid");
  }
}

function aborted(signal) {
  if (signal === null || signal === undefined) return false;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    throw new Error("validator readiness signer custody abort signal is invalid");
  }
  return signal.aborted;
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason
    : new Error("validator readiness signer custody operation was aborted");
}

function fixedSign(value, keyObject, domain, options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some((key) => key !== "signal")) {
    throw new Error("validator readiness signer custody signing options are invalid");
  }
  const signal = options.signal ?? null;
  if (aborted(signal)) throw abortError(signal);
  const payload = consensusEnvelopeBytes(domain, value);
  let signature;
  try {
    signature = sign(null, payload, keyObject);
    if (aborted(signal)) throw abortError(signal);
    return signature.toString("base64");
  } finally {
    payload.fill(0);
    signature?.fill(0);
  }
}

function publicCapability(commitment, keyObject, signerRole) {
  const result = Object.create(null);
  Object.defineProperties(result, {
    address: { enumerable: true, value: commitment.address },
    algorithm: { enumerable: true, value: commitment.algorithm },
    publicKey: { enumerable: true, value: commitment.publicKey },
    signValidatorReadinessReadyInput: { value: (value, options = {}) =>
      fixedSign(value, keyObject, DOMAINS[signerRole].ready, options) },
    [signerRole === "transport" ? "signReadinessTransportInput"
      : "signReadinessConsensusInput"]: { value: (value, options = {}) =>
      fixedSign(value, keyObject, DOMAINS[signerRole].operation, options) },
  });
  return Object.freeze(result);
}

export function createValidatorReadinessSignerCustody({
  encryptedVault, expectedVaultCommitment, passwordBuffer, role: roleValue,
} = {}) {
  const controlled = [];
  try {
    const signerRole = role(roleValue);
    const secret = password(passwordBuffer);
    const commitment = vaultCommitment(expectedVaultCommitment,
      encryptedVaultPublicCommitment(encryptedVault));
    const salt = Buffer.from(encryptedVault.kdf.salt, "base64"); controlled.push(salt);
    const iv = Buffer.from(encryptedVault.cipher.iv, "base64"); controlled.push(iv);
    const tag = Buffer.from(encryptedVault.cipher.tag, "base64"); controlled.push(tag);
    const ciphertext = Buffer.from(encryptedVault.cipher.ciphertext, "base64");
    controlled.push(ciphertext);
    const metadata = { address: encryptedVault.address, algorithm: encryptedVault.algorithm,
      format: encryptedVault.format, label: encryptedVault.label,
      publicKey: encryptedVault.publicKey, version: encryptedVault.version };
    const aad = Buffer.from(canonicalJson(metadata), "utf8"); controlled.push(aad);
    const key = scryptSync(secret, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
    controlled.push(key);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    const decrypted = decipher.update(ciphertext); controlled.push(decrypted);
    const final = decipher.final(); controlled.push(final);
    const plaintext = Buffer.concat([decrypted, final]);
    controlled.push(plaintext); canonicalPrivateKeyBase64(plaintext);
    const pem = Buffer.concat([PEM_HEADER, plaintext, PEM_FOOTER]); controlled.push(pem);
    const keyObject = createPrivateKey({ key: pem, format: "pem" });
    if (keyObject.asymmetricKeyType !== commitment.algorithm) {
      throw new Error("decrypted signer key algorithm is invalid");
    }
    const derived = createPublicKey(keyObject).export({ type: "spki", format: "der" });
    controlled.push(derived);
    const expected = Buffer.from(commitment.publicKey, "base64"); controlled.push(expected);
    if (!derived.equals(expected) || addressFromPublicKey(commitment.publicKey) !== commitment.address) {
      throw new Error("decrypted signer identity is invalid");
    }
    return publicCapability(commitment, keyObject, signerRole);
  } catch {
    throw new Error("validator readiness signer custody initialization failed");
  } finally {
    for (const value of controlled) value.fill(0);
    if (Buffer.isBuffer(passwordBuffer)) passwordBuffer.fill(0);
  }
}
