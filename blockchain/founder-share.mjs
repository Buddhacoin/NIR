// The founder's share (docs/founder-share.md): a 2-of-3 address made from
// three 24-word phrases. The phrases are shown once and never stored; NIR
// Wallet keeps only the public descriptor, which is also what the main
// network's genesis plan takes as its `founder` entry. Spending needs any
// two of the three phrases.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createMultisigTransfer, multisigAddress } from "./chain.mjs";
import { FOUNDER_BPS, FOUNDER_IMMEDIATE_BPS, TREASURY_VESTING_MS } from "./constants.mjs";
import { mnemonicFromEntropy, walletFromMnemonic } from "./wallet-seed.mjs";

const FILE = "founder-share.json";
const THRESHOLD = 2;
const MEMBERS = 3;

function memberWallet(phrase) {
  return walletFromMnemonic(String(phrase ?? "").trim().toLowerCase().split(/\s+/).join(" "), 0);
}

// The genesis plan's founder entry for these member keys.
export function founderDescriptor(memberPublicKeys) {
  if (!Array.isArray(memberPublicKeys) || memberPublicKeys.length !== MEMBERS ||
      new Set(memberPublicKeys).size !== MEMBERS) {
    throw new Error("the founder address needs three different keys");
  }
  const keys = [...memberPublicKeys].sort();
  return {
    address: multisigAddress(keys, THRESHOLD),
    algorithm: "ml-dsa-65-multisig",
    memberPublicKeys: keys,
    threshold: THRESHOLD,
    vestingPolicy: {
      allocationBps: Number(FOUNDER_BPS),
      durationMs: TREASURY_VESTING_MS,
      immediateBps: Number(FOUNDER_IMMEDIATE_BPS),
      model: "genesis-release-plus-linear",
    },
  };
}

export function verifyFounderDescriptor(value) {
  const expected = founderDescriptor(value?.memberPublicKeys);
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error("the founder descriptor is invalid");
  return expected;
}

// Three fresh phrases and the address they make together.
export function createFounderShare({ entropy = () => randomBytes(32) } = {}) {
  const phrases = Array.from({ length: MEMBERS }, () => mnemonicFromEntropy(entropy()));
  return { descriptor: founderDescriptor(phrases.map((phrase) => memberWallet(phrase).publicKey)), phrases };
}

// The member wallets behind the given phrases; each must be one of the
// descriptor's keys, and two different ones are needed.
export function founderSigners(descriptor, phrases) {
  const checked = verifyFounderDescriptor(descriptor);
  const wallets = [];
  for (const phrase of phrases ?? []) {
    let wallet;
    try { wallet = memberWallet(phrase); } catch { throw new Error("a founder phrase is not a valid 24-word phrase"); }
    if (!checked.memberPublicKeys.includes(wallet.publicKey)) {
      throw new Error("a phrase does not belong to this founder address");
    }
    if (wallets.some((known) => known.publicKey === wallet.publicKey)) {
      throw new Error("the same founder phrase was entered twice");
    }
    wallets.push(wallet);
  }
  if (wallets.length < THRESHOLD) throw new Error("two different founder phrases are needed");
  return wallets.slice(0, THRESHOLD);
}

export function createFounderTransfer({ descriptor, phrases, recipient, amount, nonce, networkId,
  chainIdentityGenesisHash, fee }) {
  const checked = verifyFounderDescriptor(descriptor);
  return createMultisigTransfer({
    amount, chainIdentityGenesisHash, ...(fee === undefined ? {} : { fee }),
    memberPublicKeys: checked.memberPublicKeys, networkId, nonce, recipient,
    signerWallets: founderSigners(checked, phrases), threshold: THRESHOLD,
  });
}

export function readFounderDescriptor(storageRoot) {
  const path = join(storageRoot, FILE);
  try {
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return verifyFounderDescriptor(JSON.parse(readFileSync(path, "utf8")));
}

// Saved only once: a second founder address would split the share.
export function saveFounderDescriptor(storageRoot, descriptor) {
  const checked = verifyFounderDescriptor(descriptor);
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(storageRoot, FILE), `${JSON.stringify(checked, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("a founder address already exists");
    throw error;
  }
  return checked;
}
