// One recovery phrase, many accounts (docs/wallet.md). The 24 words are kept
// on this Mac only encrypted under the wallet password, so the user can view
// them again in Settings; account n is derived from them with
// walletFromMnemonic(phrase, n) and stored as its own vault. Restoring the
// words on another Mac brings the same accounts back in the same order.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { canonicalJson } from "./crypto.mjs";
import { validPersonalWalletPassword } from "./vault.mjs";
import { privateMode } from "./wallet-files-windows.mjs";
import { createPhraseWalletFile, verifyWalletFile } from "./wallet-files.mjs";
import { listLocalTestWallets } from "./wallet-onboarding.mjs";
import { entropyFromMnemonic, mnemonicFromEntropy, walletFromMnemonic } from "./wallet-seed.mjs";

const KDF = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1 });
const MAX_ACCOUNTS = 100;

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || !privateMode(stat.mode)) throw new Error("wallet storage directory is not private");
}

function root(storageRoot) {
  if (typeof storageRoot !== "string" || !isAbsolute(storageRoot)) {
    throw new Error("wallet storage root must be absolute");
  }
  return resolve(storageRoot);
}

const seedPath = (storageRoot) => join(root(storageRoot), "Seed", "seed.nirseed.json");

function addressAt(phrase, index) {
  const wallet = walletFromMnemonic(phrase, index);
  wallet.privateKey = "";
  return wallet.address;
}

// The file names the first account's address; it is bound into the
// encryption, so a phrase can never be swapped under another wallet's file.
function encryptPhrase(phrase, password) {
  const metadata = { account0: addressAt(phrase, 0), format: "nir-encrypted-seed", version: 1 };
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(canonicalJson(metadata)));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(phrase, "utf8")), cipher.final()]);
    return { ...metadata, cipher: { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"),
      name: "aes-256-gcm", tag: cipher.getAuthTag().toString("base64") }, kdf: { ...KDF, salt: salt.toString("base64") } };
  } finally {
    key.fill(0);
  }
}

function decryptPhrase(file, password) {
  if (file?.format !== "nir-encrypted-seed" || file.version !== 1 || file.cipher?.name !== "aes-256-gcm" ||
      file.kdf?.name !== KDF.name || file.kdf.N !== KDF.N || file.kdf.r !== KDF.r || file.kdf.p !== KDF.p) {
    throw new Error("seed file is not supported");
  }
  const key = scryptSync(password, Buffer.from(file.kdf.salt, "base64"), 32,
    { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  let phrase;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
    decipher.setAAD(Buffer.from(canonicalJson({ account0: file.account0, format: file.format, version: file.version })));
    decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
    phrase = Buffer.concat([decipher.update(Buffer.from(file.cipher.ciphertext, "base64")), decipher.final()])
      .toString("utf8");
  } catch {
    throw new Error("wallet password is incorrect");
  } finally {
    key.fill(0);
  }
  if (addressAt(phrase, 0) !== file.account0) throw new Error("seed file does not match its first account");
  return phrase;
}

function writeSeed(storageRoot, phrase, password) {
  privateDirectory(join(root(storageRoot), "Seed"));
  const path = seedPath(storageRoot);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(encryptPhrase(phrase, password))}\n`, { mode: 0o600, flag: "w" });
  renameSync(`${path}.tmp`, path);
}

function readSeed(storageRoot) {
  return JSON.parse(readFileSync(seedPath(storageRoot), "utf8"));
}

export function hasLocalSeed(storageRoot) {
  return existsSync(seedPath(storageRoot));
}

// Account n's vault, unless this Mac already has it.
function storeAccount(storageRoot, phrase, password, index) {
  const address = addressAt(phrase, index);
  if (listLocalTestWallets(root(storageRoot)).some((wallet) => wallet.address === address)) {
    return { accountIndex: index, address, existed: true };
  }
  const directory = join(root(storageRoot), "Wallets");
  privateDirectory(directory);
  const walletPath = join(directory, `${randomUUID()}.nirvault.json`);
  createPhraseWalletFile({ accountIndex: index, password, path: walletPath, phrase,
    label: `NIR account ${index + 1}` });
  if (verifyWalletFile({ path: walletPath, password }).address !== address) {
    throw new Error("phrase account address changed");
  }
  return { accountIndex: index, address, existed: false, walletPath };
}

export function createLocalSeedWallet({ storageRoot, password }) {
  if (!validPersonalWalletPassword(password)) throw new Error("wallet password does not meet creation requirements");
  if (hasLocalSeed(storageRoot)) throw new Error("this Mac already has a recovery phrase");
  const phrase = mnemonicFromEntropy();
  writeSeed(storageRoot, phrase, password);
  return { ...storeAccount(storageRoot, phrase, password, 0), phrase };
}

// The next account from the same words: the lowest index this Mac lacks.
export function addLocalSeedAccount({ storageRoot, password }) {
  const phrase = decryptPhrase(readSeed(storageRoot), password);
  const existing = new Set(listLocalTestWallets(root(storageRoot)).map(({ address }) => address));
  for (let index = 0; index < MAX_ACCOUNTS; index++) {
    if (!existing.has(addressAt(phrase, index))) return storeAccount(storageRoot, phrase, password, index);
  }
  throw new Error("this recovery phrase already has the maximum number of accounts");
}

// A new wallet password protects the 24 words too, so a new account asks
// for the same password as every signature.
export function changeLocalSeedPassword({ storageRoot, oldPassword, newPassword }) {
  if (!validPersonalWalletPassword(newPassword)) throw new Error("wallet password does not meet creation requirements");
  writeSeed(storageRoot, decryptPhrase(readSeed(storageRoot), oldPassword), newPassword);
}

export function revealLocalSeedPhrase({ storageRoot, password }) {
  return decryptPhrase(readSeed(storageRoot), password);
}

// The words written down earlier: the first account comes back at once and
// "Add account" brings back the next ones in the same order.
export function restoreLocalSeedWallet({ storageRoot, phrase, password }) {
  if (!validPersonalWalletPassword(password)) throw new Error("wallet password does not meet creation requirements");
  // Validates the words and their checksum before anything is written.
  const entropy = entropyFromMnemonic(phrase);
  const canonical = mnemonicFromEntropy(entropy);
  entropy.fill(0);
  if (hasLocalSeed(storageRoot) && readSeed(storageRoot).account0 !== addressAt(canonical, 0)) {
    throw new Error("this Mac already has a different recovery phrase");
  }
  writeSeed(storageRoot, canonical, password);
  return storeAccount(storageRoot, canonical, password, 0);
}
