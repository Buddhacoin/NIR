// Experimental local-test wallet profile. This is not a production key store.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { validPersonalWalletPassword } from "./vault.mjs";
import { walletFromMnemonic } from "./wallet-seed.mjs";

const FORMAT = "nir-encrypted-phrase-v1";
const KDF = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1 });
const NETWORK_ID = "nir-local-rehearsal";

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalBase64(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("invalid phrase vault encoding");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) {
    throw new Error("invalid phrase vault encoding");
  }
  return bytes;
}

function metadata(address) {
  return { address, format: FORMAT, networkId: NETWORK_ID, version: 1 };
}

function keyFor(password, salt) {
  return scryptSync(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p,
    maxmem: 64 * 1024 * 1024 });
}

export function encryptRecoveryPhrase(phrase, password) {
  if (!validPersonalWalletPassword(password)) {
    throw new Error("wallet password does not meet creation requirements");
  }
  const wallet = walletFromMnemonic(phrase);
  const address = wallet.address;
  wallet.privateKey = "";
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = keyFor(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(metadata(address)), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(phrase, "utf8"), cipher.final()]);
    return { ...metadata(address), cipher: { ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"), name: "aes-256-gcm", tag: cipher.getAuthTag().toString("base64") },
    kdf: { ...KDF, salt: salt.toString("base64") } };
  } finally { key.fill(0); }
}

export function decryptRecoveryPhrase(record, password) {
  let key;
  let plaintext;
  try {
    if (!validPersonalWalletPassword(password) ||
        !exactKeys(record, ["address", "cipher", "format", "kdf", "networkId", "version"]) ||
        !exactKeys(record.cipher, ["ciphertext", "iv", "name", "tag"]) ||
        !exactKeys(record.kdf, ["N", "name", "p", "r", "salt"]) ||
        record.format !== FORMAT || record.version !== 1 || record.networkId !== NETWORK_ID ||
        !/^nir1[0-9a-f]{64}$/.test(record.address) ||
        record.cipher.name !== "aes-256-gcm" || record.kdf.name !== KDF.name ||
        record.kdf.N !== KDF.N || record.kdf.r !== KDF.r || record.kdf.p !== KDF.p) {
      throw new Error("invalid phrase vault");
    }
    const salt = canonicalBase64(record.kdf.salt, 32);
    const iv = canonicalBase64(record.cipher.iv, 12);
    const tag = canonicalBase64(record.cipher.tag, 16);
    if (typeof record.cipher.ciphertext !== "string" ||
        record.cipher.ciphertext.length > 684) throw new Error("invalid phrase vault ciphertext");
    const ciphertext = Buffer.from(record.cipher.ciphertext, "base64");
    if (ciphertext.length < 1 || ciphertext.length > 512 ||
        ciphertext.toString("base64") !== record.cipher.ciphertext) {
      throw new Error("invalid phrase vault ciphertext");
    }
    key = keyFor(password, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(metadata(record.address)), "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const phrase = plaintext.toString("utf8");
    const wallet = walletFromMnemonic(phrase);
    const derivedAddress = wallet.address;
    wallet.privateKey = "";
    if (derivedAddress !== record.address) throw new Error("phrase vault address changed");
    return { address: derivedAddress, phrase };
  } catch {
    throw new Error("phrase vault password, contents, or integrity check is invalid");
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}
