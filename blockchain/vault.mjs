import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

import {
  addressFromPublicKey,
  canonicalJson,
  hashObject,
  signObject,
  verifyObject,
} from "./crypto.mjs";
import { multisigAddress } from "./chain.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const KDF = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1 });
const PASSWORD_MINIMUM = 16;
const PASSWORD_MAXIMUM_BYTES = 1_024;
const DISPLAY_CONTROL = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

function validPassword(password, { creation = false } = {}) {
  const minimum = creation ? PASSWORD_MINIMUM : 12;
  if (typeof password !== "string" || [...password].length < minimum ||
      Buffer.byteLength(password) > PASSWORD_MAXIMUM_BYTES || DISPLAY_CONTROL.test(password)) return false;
  if (!creation) return true;
  return password.normalize("NFKC") === password && new Set(password).size >= 6 &&
    !/^(.)\1+$/u.test(password);
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function decodeBase64(value, field, minimum, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum * 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < minimum || decoded.length > maximum || decoded.toString("base64") !== value) {
    throw new Error(`${field} length is invalid`);
  }
  return decoded;
}

function validateMetadata(vault) {
  if (!exactKeys(vault, ["address", "algorithm", "format", "label", "publicKey", "version"]) ||
      vault?.format !== "nir-encrypted-vault" || vault.version !== 1 ||
      vault.algorithm !== SIGNATURE_ALGORITHM || typeof vault.label !== "string" ||
      vault.label.length < 1 || Buffer.byteLength(vault.label) > 256 ||
      vault.label.normalize("NFC") !== vault.label || DISPLAY_CONTROL.test(vault.label) ||
      !/^nir1[0-9a-f]{64}$/.test(vault.address ?? "")) {
    throw new Error("unsupported vault metadata");
  }
  decodeBase64(vault.publicKey, "vault public key", 1, 4_000);
  if (addressFromPublicKey(vault.publicKey) !== vault.address) {
    throw new Error("vault address does not match its public key");
  }
}

function validateSerializedVault(vault) {
  if (!exactKeys(vault, ["address", "algorithm", "cipher", "format", "kdf", "label", "publicKey", "version"])) {
    throw new Error("unsupported vault schema");
  }
  validateMetadata(vaultMetadata(vault, vault.label));
}

function vaultMetadata(wallet, label) {
  return {
    address: wallet.address,
    algorithm: wallet.algorithm,
    format: "nir-encrypted-vault",
    label,
    publicKey: wallet.publicKey,
    version: 1,
  };
}

export function encryptWallet(wallet, password, { label = "NIR vault" } = {}) {
  if (!validPassword(password, { creation: true })) {
    throw new Error("vault password must be canonical, non-trivial, and contain at least 16 characters");
  }
  validateMetadata(vaultMetadata(wallet, label));
  decodeBase64(wallet.privateKey, "wallet private key", 1, 8_192);
  const challenge = { address: wallet.address, purpose: "vault-key-check" };
  const keyCheck = signObject(challenge, wallet, "VAULT_CHECK");
  if (!verifyObject(challenge, keyCheck, wallet.publicKey, "VAULT_CHECK")) {
    throw new Error("wallet key pair does not match");
  }
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  const metadata = vaultMetadata(wallet, label);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(canonicalJson(metadata)));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(wallet.privateKey, "utf8")),
      cipher.final(),
    ]);
    const vault = {
      ...metadata,
      cipher: {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        name: "aes-256-gcm",
        tag: cipher.getAuthTag().toString("base64"),
      },
      kdf: { ...KDF, salt: salt.toString("base64") },
    };
    validateSerializedVault(vault);
    return vault;
  } finally {
    key.fill(0);
  }
}

export function decryptWallet(vault, password) {
  let parsed;
  let structurallyValid = validPassword(password);
  try {
    if (
      !exactKeys(vault?.kdf, ["N", "name", "p", "r", "salt"]) ||
      !exactKeys(vault?.cipher, ["ciphertext", "iv", "name", "tag"]) ||
      vault?.format !== "nir-encrypted-vault" || vault.version !== 1 ||
      vault.kdf?.name !== "scrypt" || vault.cipher?.name !== "aes-256-gcm" ||
      vault.kdf.N !== KDF.N || vault.kdf.r !== KDF.r || vault.kdf.p !== KDF.p
    ) throw new Error("unsupported vault format");
    validateSerializedVault(vault);
    const salt = decodeBase64(vault.kdf.salt, "vault salt", 32, 32);
    const iv = decodeBase64(vault.cipher.iv, "vault IV", 12, 12);
    const tag = decodeBase64(vault.cipher.tag, "vault authentication tag", 16, 16);
    const ciphertext = decodeBase64(vault.cipher.ciphertext, "vault ciphertext", 1, 16_384);
    const metadata = vaultMetadata(vault, vault.label);
    parsed = { ciphertext, iv, metadata, salt, tag };
  } catch {
    structurallyValid = false;
  }
  const salt = parsed?.salt ?? Buffer.alloc(32);
  const key = scryptSync(structurallyValid ? password : "invalid-vault-password-padding", salt, 32, {
      N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024,
  });
  let plaintext;
  try {
    if (!structurallyValid || !parsed) throw new Error("invalid vault");
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
    decipher.setAAD(Buffer.from(canonicalJson(parsed.metadata)));
    decipher.setAuthTag(parsed.tag);
    plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
    const privateKey = plaintext.toString("utf8");
    decodeBase64(privateKey, "decrypted private key", 1, 8_192);
    const wallet = {
      address: vault.address,
      algorithm: vault.algorithm,
      privateKey,
      publicKey: vault.publicKey,
    };
    const challenge = { address: wallet.address, purpose: "vault-key-check" };
    const signature = signObject(challenge, wallet, "VAULT_CHECK");
    if (!verifyObject(challenge, signature, wallet.publicKey, "VAULT_CHECK")) {
      throw new Error("vault key pair does not match");
    }
    return wallet;
  } catch {
    throw new Error("vault password, contents, or integrity check is invalid");
  } finally {
    key.fill(0);
    plaintext?.fill(0);
    parsed?.ciphertext.fill(0);
  }
}

export function createMultisigRecoveryManifest({ vaults, threshold, label = "NIR recovery plan" }) {
  if (!Array.isArray(vaults) || vaults.length < 2 || vaults.length > 16 ||
      !Number.isSafeInteger(threshold) || threshold < 2 || threshold > vaults.length ||
      new Set(vaults.map(({ address }) => address)).size !== vaults.length) {
    throw new Error("recovery vaults must be distinct");
  }
  const memberPublicKeys = vaults.map(({ publicKey }) => publicKey);
  return {
    address: multisigAddress(memberPublicKeys, threshold),
    algorithm: "ml-dsa-65-multisig",
    label,
    members: vaults.map((vault) => ({
      address: vault.address,
      vaultHash: hashObject(vault, "ENCRYPTED_VAULT_BACKUP"),
    })).sort((a, b) => a.address.localeCompare(b.address)),
    threshold,
    version: 1,
  };
}
