// Browser-only local-test wallet. No secret is sent to the NIR bridge or a server.
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import wordListText from "../../blockchain/bip39-english.txt";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const words = wordListText.trim().split("\n");
const positions = new Map(words.map((word, index) => [word, index]));
const spkiPrefix = fromHex("308207b2300b0609608648016503040312038207a100");
const addressDomain = encoder.encode("NIR/ADDRESS/v1\0");
const derivationSalt = encoder.encode("NIR/ML-DSA-65/WALLET/V1");
const format = "nir-browser-phrase-v1";
const networkId = "nir-local-rehearsal";

if (words.length !== 2048 || positions.size !== 2048 ||
    hex(sha256(encoder.encode(wordListText))) !==
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda") {
  throw new Error("NIR word list is invalid");
}

function bytes(...parts) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function fromHex(hex) {
  return Uint8Array.from(hex.match(/.{2}/g), (part) => Number.parseInt(part, 16));
}

function hex(value) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid wallet data");
  const binary = atob(value);
  if (binary.length !== length) throw new Error("Invalid wallet data");
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (base64(decoded) !== value) throw new Error("Invalid wallet data");
  return decoded;
}

function canonicalPhrase(phrase) {
  if (typeof phrase !== "string" || phrase.length > 512) throw new Error("Нужны 24 слова восстановления");
  const entries = phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/u);
  if (entries.length !== 24 || entries.some((word) => !positions.has(word))) {
    throw new Error("Нужны 24 правильных английских слова");
  }
  return entries;
}

export async function phraseFromEntropy(entropy) {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 32) throw new Error("Invalid entropy");
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", entropy))[0];
  const bits = Array.from(entropy, (byte) => byte.toString(2).padStart(8, "0")).join("") +
    checksum.toString(2).padStart(8, "0");
  return Array.from({ length: 24 }, (_, index) => words[Number.parseInt(bits.slice(index * 11, index * 11 + 11), 2)]).join(" ");
}

export async function normalizePhrase(phrase) {
  const entries = canonicalPhrase(phrase);
  const bits = entries.map((word) => positions.get(word).toString(2).padStart(11, "0")).join("");
  const entropy = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2));
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", entropy))[0];
  if (expected !== Number.parseInt(bits.slice(256), 2)) throw new Error("Контрольная сумма фразы неверна");
  return entries.join(" ");
}

export async function createPhrase() {
  return phraseFromEntropy(crypto.getRandomValues(new Uint8Array(32)));
}

export async function accountFromPhrase(phrase, index = 0) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) throw new Error("Invalid account index");
  const canonical = await normalizePhrase(phrase);
  const password = await crypto.subtle.importKey("raw", encoder.encode(canonical.normalize("NFKD")), "PBKDF2", false, ["deriveBits"]);
  const master = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512",
    salt: encoder.encode("mnemonic"), iterations: 2048 }, password, 512));
  const hkdfKey = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
  master.fill(0);
  const accountIndex = new Uint8Array(4);
  new DataView(accountIndex.buffer).setUint32(0, index, false);
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-512",
    salt: derivationSalt, info: accountIndex }, hkdfKey, 256));
  const pair = ml_dsa65.keygen(seed);
  seed.fill(0);
  pair.secretKey.fill(0);
  const publicKey = bytes(spkiPrefix, pair.publicKey);
  const address = `nir1${hex(sha3_256(bytes(addressDomain, publicKey)))}`;
  return { address, publicKey: base64(publicKey), index };
}

function validPassword(password) {
  return typeof password === "string" && [...password].length >= 12 &&
    encoder.encode(password).length <= 1024 && password.normalize("NFKC") === password &&
    new Set(password).size >= 4 && !/[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(password);
}

function metadata(address) { return { address, format, networkId, version: 1 }; }

async function passwordKey(password, salt) {
  const keyBytes = await scryptAsync(encoder.encode(password), salt, { N: 32768, r: 8, p: 1, dkLen: 32 });
  try { return await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]); }
  finally { keyBytes.fill(0); }
}

export async function encryptPhrase(phrase, password) {
  if (!validPassword(password)) throw new Error("Пароль: минимум 12 разных символов");
  const canonical = await normalizePhrase(phrase);
  const { address } = await accountFromPhrase(canonical);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt);
  const associatedData = encoder.encode(JSON.stringify(metadata(address)));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: associatedData, tagLength: 128 }, key, encoder.encode(canonical)));
  return { ...metadata(address), cipher: { name: "aes-256-gcm", iv: base64(iv),
    ciphertext: base64(ciphertext) }, kdf: { name: "scrypt", N: 32768, r: 8, p: 1,
    salt: base64(salt) } };
}

export async function decryptPhrase(record, password) {
  try {
    if (!validPassword(password) || !record ||
        Object.keys(record).sort().join() !== ["address", "cipher", "format", "kdf", "networkId", "version"].join() ||
        record.format !== format || record.version !== 1 || record.networkId !== networkId ||
        !/^nir1[0-9a-f]{64}$/.test(record.address) ||
        Object.keys(record.cipher).sort().join() !== ["ciphertext", "iv", "name"].join() ||
        Object.keys(record.kdf).sort().join() !== ["N", "name", "p", "r", "salt"].join() ||
        record.cipher.name !== "aes-256-gcm" || record.kdf.name !== "scrypt" ||
        record.kdf.N !== 32768 || record.kdf.r !== 8 || record.kdf.p !== 1 ||
        record.cipher.ciphertext.length > 1024) throw new Error("Invalid wallet data");
    const salt = decodeBase64(record.kdf.salt, 32);
    const iv = decodeBase64(record.cipher.iv, 12);
    const encoded = record.cipher.ciphertext;
    if (typeof encoded !== "string" || encoded.length < 24 || encoded.length > 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid wallet data");
    const ciphertext = decodeBase64(encoded, atob(encoded).length);
    const key = await passwordKey(password, salt);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv,
      additionalData: encoder.encode(JSON.stringify(metadata(record.address))), tagLength: 128 }, key, ciphertext));
    try {
      const phrase = await normalizePhrase(decoder.decode(plaintext));
      const account = await accountFromPhrase(phrase);
      if (account.address !== record.address) throw new Error("Invalid wallet data");
      return phrase;
    } finally { plaintext.fill(0); }
  } catch { throw new Error("Неверный пароль или повреждены данные кошелька"); }
}
