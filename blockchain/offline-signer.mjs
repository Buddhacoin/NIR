import {
  chmodSync, closeSync, fchmodSync, lstatSync, openSync, readFileSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  createCreditDelegation, createCreditStake, createCreditTransfer,
  createCreditUnstakeClaim, createCreditUnstakeRequest, createDelegatedCreditTransfer,
  createTransfer,
} from "./chain.mjs";
import { addressFromPublicKey, canonicalJson, hashObject, verifyObject } from "./crypto.mjs";
import { createPaymentRequest, verifyPaymentRequest } from "./payment-request.mjs";
import { simulateWalletOperation } from "./transaction-simulation.mjs";
import { decryptWallet } from "./vault.mjs";
import { walletPublicInfo } from "./wallet-files.mjs";

const FORMAT = "nir-offline-signing-package-v1";
const SIGNED_FORMAT = "nir-offline-signed-package-v1";
const WATCH_FORMAT = "nir-watch-only-export-v1";
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const NETWORK = /^[a-zA-Z0-9._:-]{3,128}$/;
const MAX_PACKAGE_BYTES = 128 * 1024;
const PACKAGE_KEYS = new Set([
  "checkpoint", "createdAt", "expiresAt", "format", "intent", "networkId", "simulation",
  "simulationCommitment", "version",
]);

function fail(message) { throw new Error(`offline signer: ${message}`); }

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid`);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) fail(`${label} has unknown or missing fields`);
}

function checkpoint(value, networkId) {
  exact(value, new Set(["height", "networkId", "stateRoot", "tipHash", "validatorSetId"]), "checkpoint");
  if (value.networkId !== networkId || !Number.isSafeInteger(value.height) || value.height < 0 ||
      !HASH.test(value.tipHash ?? "") || !HASH.test(value.stateRoot ?? "") || !HASH.test(value.validatorSetId ?? "")) {
    fail("checkpoint is invalid");
  }
  return structuredClone(value);
}

function simulationCommitment(simulation) {
  return hashObject(simulation, "OFFLINE_SIGNING_SIMULATION_V1");
}

function redactedSimulation(result) {
  return {
    authority: result.authority, deltas: result.deltas, intent: result.intent,
    intentHash: result.intentHash, networkId: result.networkId, proof: result.proof,
    request: result.request ?? null, risks: result.risks, stateHeight: result.stateHeight,
    title: result.title, type: result.type, verified: result.verified,
  };
}

/** Create a canonical package for an air-gapped signer. No secret is accepted or emitted. */
export function createOfflineSigningPackage({ intent, stateEvidence, checkpoint: value, expiresAt, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now || expiresAt > now + 15 * 60_000) fail("package expiry is invalid");
  const result = simulateWalletOperation({ intent, stateEvidence, now });
  const checked = checkpoint(value, result.networkId);
  if (checked.height !== result.stateHeight || checked.tipHash !== result.proof.tipHash ||
      checked.stateRoot !== result.proof.stateRoot || stateEvidence.networkId !== result.networkId ||
      stateEvidence.height !== checked.height || stateEvidence.tipHash !== checked.tipHash ||
      stateEvidence.stateRoot !== checked.stateRoot) {
    fail("checkpoint does not match independently verified simulation state");
  }
  const rendered = redactedSimulation(result);
  const packageValue = {
    checkpoint: checked, createdAt: now, expiresAt, format: FORMAT, intent: result.intent,
    networkId: result.networkId, simulation: { result: rendered, stateEvidence: structuredClone(stateEvidence) },
    simulationCommitment: simulationCommitment(rendered), version: 1,
  };
  validateOfflineSigningPackage(packageValue, { now });
  return packageValue;
}

/** Strictly re-decode a package and re-run its simulation. */
export function validateOfflineSigningPackage(value, { now = Date.now() } = {}) {
  exact(value, PACKAGE_KEYS, "signing package");
  if (value.format !== FORMAT || value.version !== 1 || !NETWORK.test(value.networkId ?? "") ||
      !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) ||
      value.createdAt < 0 || value.expiresAt <= value.createdAt || value.expiresAt <= now ||
      value.expiresAt > value.createdAt + 15 * 60_000 || !HASH.test(value.simulationCommitment ?? "")) {
    fail("signing package metadata is invalid or expired");
  }
  exact(value.simulation, new Set(["result", "stateEvidence"]), "simulation package");
  const checked = checkpoint(value.checkpoint, value.networkId);
  const evidence = value.simulation.stateEvidence;
  if (!evidence || evidence.networkId !== value.networkId || evidence.height !== checked.height ||
      evidence.tipHash !== checked.tipHash || evidence.stateRoot !== checked.stateRoot) {
    fail("simulation evidence does not match checkpoint");
  }
  const rerun = simulateWalletOperation({ intent: value.intent, stateEvidence: evidence, now });
  const rendered = redactedSimulation(rerun);
  if (canonicalJson(value.simulation.result) !== canonicalJson(rendered) ||
      value.simulationCommitment !== simulationCommitment(rendered)) {
    fail("simulation commitment or human-readable consequences do not match");
  }
  return { checkpoint: checked, package: structuredClone(value), simulation: rendered };
}

/** Canonical JSON rejects duplicate keys, whitespace ambiguity, and non-canonical ordering. */
export function parseCanonicalOfflineSigningPackage(text, options = {}) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_PACKAGE_BYTES || text.includes("\u0000")) {
    fail("package text is invalid");
  }
  const canonicalText = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
  let value;
  try { value = JSON.parse(canonicalText); } catch { fail("package text is not JSON"); }
  if (canonicalJson(value) !== canonicalText) fail("package text is not canonical");
  return validateOfflineSigningPackage(value, options);
}

export function readOfflineSigningPackage(path, options = {}) {
  const target = resolve(path);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PACKAGE_BYTES) {
    fail("package file is unsafe");
  }
  return parseCanonicalOfflineSigningPackage(readFileSync(target, "utf8"), options);
}

/** Decode a bounded, ordered QR fragment set without accepting missing or duplicated parts. */
export function parseOfflineSigningQrFragments(fragments, options = {}) {
  if (!Array.isArray(fragments) || fragments.length < 1 || fragments.length > 256) fail("QR fragments are invalid");
  const pieces = new Map();
  let total = null;
  for (const fragment of fragments) {
    if (typeof fragment !== "string" || fragment.length > 1_500) fail("QR fragment is invalid");
    const match = /^NIRQR1\/(\d{1,3})\/(\d{1,3})\/([A-Za-z0-9_-]{1,1200})$/.exec(fragment);
    if (!match) fail("QR fragment format is invalid");
    const index = Number(match[1]); const declaredTotal = Number(match[2]);
    if (declaredTotal < 1 || declaredTotal > 256 || index < 1 || index > declaredTotal ||
        (total !== null && total !== declaredTotal) || pieces.has(index)) fail("QR fragments are inconsistent");
    total = declaredTotal; pieces.set(index, match[3]);
  }
  if (pieces.size !== total) fail("QR fragments are incomplete");
  const encoded = [...Array(total)].map((_, index) => pieces.get(index + 1)).join("");
  let text;
  try { text = Buffer.from(encoded, "base64url").toString("utf8"); }
  catch { fail("QR fragments are not base64url"); }
  if (Buffer.byteLength(text, "utf8") > MAX_PACKAGE_BYTES || Buffer.from(text, "utf8").toString("base64url") !== encoded) {
    fail("QR fragments are not canonical");
  }
  return parseCanonicalOfflineSigningPackage(text, options);
}

export function readPrivateOfflineVault(path) {
  const target = resolve(path);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 ||
      (metadata.mode & 0o077) !== 0) fail("vault must be a private bounded regular file");
  try { return JSON.parse(readFileSync(target, "utf8")); }
  catch { fail("vault is not valid JSON"); }
}

function signedTransfer(intent, wallet) {
  if (intent.resource === "transfer-credit") {
    if (intent.feePayer !== undefined) fail("sponsored transfer-credit signing needs the fee payer's isolated signer");
    return intent.creditOwner === undefined
      ? createCreditTransfer({ wallet, networkId: intent.networkId, recipient: intent.recipient, amount: intent.amount, nonce: intent.nonce })
      : createDelegatedCreditTransfer({ wallet, creditOwner: intent.creditOwner, networkId: intent.networkId,
        recipient: intent.recipient, amount: intent.amount, nonce: intent.nonce });
  }
  if (intent.feePayer === undefined) return createTransfer({ wallet, networkId: intent.networkId,
    recipient: intent.recipient, amount: intent.amount, nonce: intent.nonce, fee: intent.fee });
  fail("sponsored transfer needs a coordinated isolated signer package with the fee payer public key");
}

function signedOperation(intent, wallet) {
  if (intent.type === "transfer") return signedTransfer(intent, wallet);
  if (intent.type === "credit-stake") return createCreditStake({ wallet, networkId: intent.networkId, amount: intent.amount, nonce: intent.nonce, fee: intent.fee });
  if (intent.type === "credit-delegation") return createCreditDelegation({ wallet, networkId: intent.networkId, delegate: intent.delegate, limit: intent.limit, nonce: intent.nonce, fee: intent.fee });
  if (intent.type === "credit-unstake-request") return createCreditUnstakeRequest({ wallet, networkId: intent.networkId, amount: intent.amount, nonce: intent.nonce });
  if (intent.type === "credit-unstake-claim") return createCreditUnstakeClaim({ wallet, networkId: intent.networkId, nonce: intent.nonce });
  if (intent.type === "payment-request") return createPaymentRequest({ wallet, networkId: intent.networkId,
    amount: intent.amount, memo: intent.memo, expiresAt: intent.expiresAt, requestId: intent.requestId });
  fail("operation type is not supported");
}

/** Sign locally only. This module has no network code and never broadcasts. */
export function signOfflinePackage({ vault, password, signingPackage, now = Date.now() } = {}) {
  const verified = validateOfflineSigningPackage(signingPackage, { now });
  const wallet = decryptWallet(vault, password);
  try {
    const signerAddress = verified.simulation.type === "payment-request"
      ? verified.package.intent.recipient : verified.package.intent.sender;
    if (wallet.address !== signerAddress) fail("vault does not hold the required signing authority");
    const operation = signedOperation(verified.package.intent, wallet);
    return {
      checkpoint: verified.checkpoint, createdAt: now, format: SIGNED_FORMAT,
      networkId: verified.package.networkId, package: verified.package,
      signingPackageHash: hashObject(verified.package, "OFFLINE_SIGNING_PACKAGE_V1"),
      transaction: operation, version: 1,
    };
  } finally {
    wallet.privateKey = "";
  }
}

export function verifyOfflineSignedPackage(value, { now = Date.now() } = {}) {
  exact(value, new Set(["checkpoint", "createdAt", "format", "networkId", "package", "signingPackageHash", "transaction", "version"]), "signed package");
  if (value.format !== SIGNED_FORMAT || value.version !== 1 || !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 || !HASH.test(value.signingPackageHash ?? "")) fail("signed package metadata is invalid");
  const verified = validateOfflineSigningPackage(value.package, { now });
  if (value.networkId !== verified.package.networkId || canonicalJson(value.checkpoint) !== canonicalJson(verified.checkpoint) ||
      value.signingPackageHash !== hashObject(verified.package, "OFFLINE_SIGNING_PACKAGE_V1")) {
    fail("signed package does not bind to the reviewed package");
  }
  const transaction = value.transaction;
  if (verified.simulation.type === "payment-request") {
    verifyPaymentRequest(transaction, { networkId: value.networkId, now });
    if (transaction.requestId !== verified.package.intent.requestId) fail("signed payment request does not match package");
  } else {
    const domains = { transfer: "TRANSFER", "credit-stake": "CREDIT_STAKE", "credit-delegation": "CREDIT_DELEGATION",
      "credit-unstake-request": "CREDIT_UNSTAKE_REQUEST", "credit-unstake-claim": "CREDIT_UNSTAKE_CLAIM" };
    if (!domains[transaction?.type] || transaction.type !== verified.simulation.type ||
        transaction.networkId !== value.networkId || transaction.sender !== verified.package.intent.sender ||
        transaction.nonce !== verified.package.intent.nonce || transaction.algorithm !== "ml-dsa-65" ||
        typeof transaction.publicKey !== "string" || addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        typeof transaction.signature !== "string") fail("signed operation is invalid");
    const { signature, ...unsigned } = transaction;
    if (!verifyObject(unsigned, signature, transaction.publicKey, domains[transaction.type])) fail("signed operation signature is invalid");
  }
  return { package: verified.package, simulation: verified.simulation, transaction: structuredClone(transaction), verified: true };
}

export function writePrivateCanonicalFile(path, value) {
  const target = resolve(path);
  const descriptor = openSync(target, "wx", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`, "utf8");
  } finally { closeSync(descriptor); }
  chmodSync(target, 0o600);
  return target;
}

/** Watch-only material deliberately contains public address/key and a checked checkpoint, never a vault or secret. */
export function exportWatchOnly({ vaultPath, checkpoint: value }) {
  const publicInfo = walletPublicInfo(vaultPath);
  const checked = checkpoint(value, value?.networkId);
  if (addressFromPublicKey(publicInfo.publicKey) !== publicInfo.address) fail("public wallet identity is invalid");
  return { address: publicInfo.address, algorithm: publicInfo.algorithm, checkpoint: checked,
    format: WATCH_FORMAT, networkId: checked.networkId, publicKey: publicInfo.publicKey, version: 1 };
}

export const OFFLINE_SIGNING_FORMAT = FORMAT;
export const OFFLINE_SIGNED_FORMAT = SIGNED_FORMAT;
