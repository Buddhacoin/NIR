#!/usr/bin/env node
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { readBoundedPublicJson } from "./production-release-gate.mjs";
import { assembleWalletReleaseAuthorityTransition, createWalletReleaseAuthorityTransition,
  signWalletReleaseAuthorityTransition } from "./production-wallet-authority-rotation.mjs";
import {
  appendWalletReleaseTransparency, assembleWalletReleaseCheckpoint,
  compareWalletReleaseGossipCheckpoints,
  createWalletReleaseCheckpoint, createWalletReleaseConsistencyProof,
  createWalletReleaseInclusionProof, exportWalletReleaseGossipCheckpoint,
  loadWalletReleaseTransparencyStore, scheduleWalletReleaseAuthorityTransition,
  signWalletReleaseCheckpoint,
  verifyWalletReleaseCheckpoint, verifyWalletReleaseConsistencyProof,
} from "./production-wallet-transparency.mjs";
import { decryptWallet } from "./vault.mjs";

function json(path, maximumBytes = 192 * 1024 * 1024) {
  return readBoundedPublicJson(path, { maximumBytes, requireCanonical: true });
}
function privateJson(path, maximumBytes) {
  const metadata = lstatSync(resolve(path));
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("release checkpoint vault must be a private regular file");
  }
  return json(path, maximumBytes);
}
function writeExclusive(pathValue, value) {
  const path = resolve(pathValue); const parent = dirname(path);
  const parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`); fchmodSync(descriptor, 0o644);
    fsyncSync(descriptor); fsyncSync(parentDescriptor);
  } finally { if (descriptor !== undefined) closeSync(descriptor); closeSync(parentDescriptor); }
}
function secret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt); let value = "";
    const done = (error) => { process.stdin.off("data", input); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n"); error ? reject(error) : resolveSecret(value); };
    const input = (chunk) => { for (const character of chunk.toString()) {
      if (character === "\u0003") return done(new Error("cancelled"));
      if (character === "\r" || character === "\n") return done();
      if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
      else if (character >= " ") { value += character; if (Buffer.byteLength(value) > 1024) return done(new Error("secret is too long")); }
    } };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", input);
  });
}

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === "append" && args.length === 8) {
    const [store, exportPath, releaseAddress, authoritySetId, networkId, genesisHash,
      walletPackageHash, toolPackageHash] = args;
    result = appendWalletReleaseTransparency(store, json(exportPath), {
      expectedAuthoritySetId: authoritySetId, expectedGenesisHash: genesisHash,
      expectedNetworkId: networkId, expectedToolPackageHash: toolPackageHash,
      expectedWalletPackageHash: walletPackageHash, trustedReleaseAddress: releaseAddress,
    });
    result = { recordHash: result.recordHash, sequence: result.record.sequence };
  } else if (command === "checkpoint" && args.length === 4) {
    const [store, issuedAt, expiresAt, output] = args;
    result = createWalletReleaseCheckpoint(loadWalletReleaseTransparencyStore(store).store,
      { expiresAt: Number(expiresAt), issuedAt: Number(issuedAt) }); writeExclusive(output, result);
  } else if (command === "sign" && args.length === 5) {
    const [checkpointPath, setPath, operatorId, vaultPath, output] = args;
    const password = await secret("Release checkpoint vault password: ");
    const wallet = decryptWallet(privateJson(vaultPath, 128 * 1024), password);
    try { result = signWalletReleaseCheckpoint(json(checkpointPath, 1024 * 1024),
      json(setPath, 1024 * 1024), { operatorId, wallet }); writeExclusive(output, result); }
    finally { wallet.privateKey = ""; }
  } else if (command === "assemble" && args.length >= 4) {
    const [checkpointPath, setPath, output, ...signatures] = args;
    result = assembleWalletReleaseCheckpoint(json(checkpointPath, 1024 * 1024),
      json(setPath, 1024 * 1024), signatures.map((path) => json(path, 64 * 1024)));
    writeExclusive(output, result);
  } else if (command === "transition-create" && args.length === 10) {
    const [oldSet, newSet, oldCheckpoint, delay, grace, createdAt, nonce, networkId,
      genesisHash, output] = args;
    result = createWalletReleaseAuthorityTransition({ activationDelay: Number(delay),
      createdAt: Number(createdAt), genesisHash, graceRecords: Number(grace), networkId,
      newSet: json(newSet, 1024 * 1024), oldCheckpoint: json(oldCheckpoint, 1024 * 1024),
      oldSet: json(oldSet, 1024 * 1024), transitionNonce: nonce }); writeExclusive(output, result);
  } else if (command === "transition-sign" && args.length === 6) {
    const [transitionPath, oldSetPath, role, operatorId, vaultPath, output] = args;
    const password = await secret("Authority transition vault password: ");
    const wallet = decryptWallet(privateJson(vaultPath, 128 * 1024), password);
    try { result = signWalletReleaseAuthorityTransition(json(transitionPath, 1024 * 1024),
      json(oldSetPath, 1024 * 1024), { operatorId, role, wallet }); writeExclusive(output, result); }
    finally { wallet.privateKey = ""; }
  } else if (command === "transition-assemble" && args.length === 5) {
    const [transitionPath, oldSetPath, oldSignaturesPath, newSignaturesPath, output] = args;
    result = assembleWalletReleaseAuthorityTransition(json(transitionPath, 1024 * 1024),
      json(oldSetPath, 1024 * 1024), json(oldSignaturesPath, 1024 * 1024),
      json(newSignaturesPath, 1024 * 1024)); writeExclusive(output, result);
  } else if (command === "transition-schedule" && args.length === 4) {
    const [store, envelopePath, expectedOldCheckpointHash, output] = args;
    result = scheduleWalletReleaseAuthorityTransition(store, json(envelopePath, 2 * 1024 * 1024),
      { expectedOldCheckpointHash }); writeExclusive(output, result.transition);
  } else if (command === "proof" && args.length === 3) {
    const [store, sequence, output] = args; result = createWalletReleaseInclusionProof(
      loadWalletReleaseTransparencyStore(store).store, Number(sequence)); writeExclusive(output, result);
  } else if (command === "consistency" && args.length === 3) {
    const [store, oldCount, output] = args; result = createWalletReleaseConsistencyProof(
      loadWalletReleaseTransparencyStore(store).store, Number(oldCount));
    verifyWalletReleaseConsistencyProof(result); writeExclusive(output, result);
  } else if (command === "gossip" && args.length === 5) {
    const [signedPath, setPath, expectedHash, now, output] = args;
    const signed = verifyWalletReleaseCheckpoint(json(signedPath, 1024 * 1024),
      json(setPath, 1024 * 1024), { expectedCheckpointHash: expectedHash, now: Number(now) });
    result = exportWalletReleaseGossipCheckpoint(signed); writeExclusive(output, result);
  } else if (command === "compare-gossip" && args.length === 3) {
    const [left, right, proof] = args; result = compareWalletReleaseGossipCheckpoints(
      json(left, 64 * 1024), json(right, 64 * 1024), proof === "none" ? null : json(proof, 64 * 1024));
  } else throw new Error("usage: wallet-transparency append STORE EXPORT RELEASE_ADDRESS AUTHORITY_SET_ID NETWORK GENESIS WALLET_PACKAGE_HASH TOOL_PACKAGE_HASH | checkpoint STORE ISSUED_AT EXPIRES_AT OUTPUT | sign CHECKPOINT SET OPERATOR_ID VAULT OUTPUT | assemble CHECKPOINT SET OUTPUT SIGNATURE... | transition-create OLD_SET NEW_SET OLD_CHECKPOINT DELAY GRACE CREATED_AT NONCE NETWORK GENESIS OUTPUT | transition-sign TRANSITION OLD_SET <old|new> OPERATOR VAULT OUTPUT | transition-assemble TRANSITION OLD_SET OLD_SIGNATURES_JSON NEW_SIGNATURES_JSON OUTPUT | transition-schedule STORE ENVELOPE OLD_CHECKPOINT_HASH OUTPUT | proof STORE SEQUENCE OUTPUT | consistency STORE OLD_COUNT OUTPUT | gossip SIGNED_CHECKPOINT SET EXPECTED_HASH NOW OUTPUT | compare-gossip LEFT RIGHT CONSISTENCY_PROOF|none");
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  process.stderr.write(`Wallet release transparency failed safely: ${error.message}\n`); process.exitCode = 1;
}
