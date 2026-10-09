// Experimental, valueless-testnet wallet recovery. Do not use for real funds
// before an independent review of this derivation and the surrounding UI.
// BIP-39 English word list and mnemonic checksum, followed by a NIR-specific
// account derivation. The account key uses RFC 9881's ML-DSA-65 seed encoding.
import { createHash, createPrivateKey, createPublicKey, hkdfSync, pbkdf2Sync,
  randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { addressFromPublicKey } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const wordListBytes = readFileSync(new URL("./bip39-english.txt", import.meta.url));
if (createHash("sha256").update(wordListBytes).digest("hex") !==
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda") {
  throw new Error("NIR recovery word list hash changed");
}
const WORDS = Object.freeze(wordListBytes.toString("utf8").trim().split("\n"));
if (WORDS.length !== 2048 || new Set(WORDS).size !== 2048) {
  throw new Error("NIR recovery word list is invalid");
}
const WORD_INDEX = new Map(WORDS.map((word, index) => [word, index]));
const ML_DSA_65_PKCS8_SEED_PREFIX = Buffer.from(
  "3034020100300b060960864801650304031204228020", "hex");
const DERIVATION_SALT = Buffer.from("NIR/ML-DSA-65/WALLET/V1", "utf8");

function normalizedWords(phrase) {
  if (typeof phrase !== "string" || phrase.length > 512) {
    throw new Error("recovery phrase is required and must be bounded");
  }
  const words = phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/u);
  if (words.length !== 24 || words.some((word) => !WORD_INDEX.has(word))) {
    throw new Error("recovery phrase must contain 24 valid English words");
  }
  return words;
}

export function mnemonicFromEntropy(entropy = randomBytes(32)) {
  if (!Buffer.isBuffer(entropy) || entropy.length !== 32) {
    throw new Error("NIR recovery entropy must be 32 bytes");
  }
  const checksum = createHash("sha256").update(entropy).digest()[0];
  const bits = [...entropy].map((byte) => byte.toString(2).padStart(8, "0")).join("") +
    checksum.toString(2).padStart(8, "0");
  return Array.from({ length: 24 }, (_, position) =>
    WORDS[Number.parseInt(bits.slice(position * 11, position * 11 + 11), 2)]).join(" ");
}

export function entropyFromMnemonic(phrase) {
  const words = normalizedWords(phrase);
  const bits = words.map((word) => WORD_INDEX.get(word).toString(2).padStart(11, "0")).join("");
  const entropy = Buffer.from(Array.from({ length: 32 }, (_, position) =>
    Number.parseInt(bits.slice(position * 8, position * 8 + 8), 2)));
  const checksum = createHash("sha256").update(entropy).digest()[0];
  if (Number.parseInt(bits.slice(256), 2) !== checksum) {
    entropy.fill(0);
    throw new Error("recovery phrase checksum is invalid");
  }
  return entropy;
}

export function walletFromMnemonic(phrase, accountIndex = 0) {
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > 0x7fffffff) {
    throw new Error("account index is invalid");
  }
  const entropy = entropyFromMnemonic(phrase);
  const canonical = mnemonicFromEntropy(entropy);
  entropy.fill(0);
  // BIP-39 PBKDF2 with an empty optional passphrase. The local app password
  // encrypts its vault; it is not part of the recoverable account identity.
  const master = pbkdf2Sync(canonical.normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
  const index = Buffer.alloc(4);
  index.writeUInt32BE(accountIndex);
  const keySeed = Buffer.from(hkdfSync("sha512", master, DERIVATION_SALT, index, 32));
  master.fill(0);
  index.fill(0);
  const seedDer = Buffer.concat([ML_DSA_65_PKCS8_SEED_PREFIX, keySeed]);
  try {
    const privateKey = createPrivateKey({
      key: seedDer,
      format: "der", type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== SIGNATURE_ALGORITHM) {
      throw new Error("NIR wallet derivation did not produce ML-DSA-65");
    }
    const publicKeyBase64 = createPublicKey(privateKey).export({
      format: "der", type: "spki",
    }).toString("base64");
    return {
      address: addressFromPublicKey(publicKeyBase64),
      algorithm: SIGNATURE_ALGORITHM,
      publicKey: publicKeyBase64,
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    };
  } finally {
    seedDer.fill(0);
    keySeed.fill(0);
  }
}
