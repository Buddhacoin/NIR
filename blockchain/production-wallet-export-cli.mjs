#!/usr/bin/env node
import {
  closeSync, constants, fchmodSync, fsyncSync, openSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { parseOfflineReleaseBundle, serializeOfflineReleaseBundle } from "./offline-release-bundle.mjs";
import {
  assembleProductionWalletExport, createProductionWalletExportBundle,
  importProductionWalletExport, parseProductionWalletExport,
  serializeProductionWalletExport,
} from "./production-wallet-export.mjs";
import { readBoundedPublicJson } from "./production-release-gate.mjs";
import { verifyWalletReleaseTransparencyEvidence } from "./production-wallet-transparency.mjs";

function readJson(path, maximumBytes = 600 * 1024 * 1024, requireCanonical = false) {
  return readBoundedPublicJson(path, { maximumBytes, requireCanonical });
}
function writeExclusive(pathValue, contents) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error("secure no-follow output support is unavailable");
  }
  const path = resolve(pathValue); const parent = dirname(path);
  const parentDescriptor = openSync(parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let descriptor;
  try {
    descriptor = openSync(path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, contents); fchmodSync(descriptor, 0o644); fsyncSync(descriptor);
    fsyncSync(parentDescriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parentDescriptor);
  }
}

function transparencyEvidence(checkpointPath, inclusionPath, transitionPath, consistencyPath) {
  if ((transitionPath === undefined) !== (consistencyPath === undefined)) {
    throw new Error("wallet authority transition and consistency proof must be supplied together");
  }
  const evidence = {
    checkpoint: readJson(checkpointPath, 1024 * 1024, true),
    inclusionProof: readJson(inclusionPath, 1024 * 1024, true),
  };
  if (transitionPath !== undefined) {
    evidence.transition = readJson(transitionPath, 2 * 1024 * 1024, true);
    evidence.consistencyProof = readJson(consistencyPath, 1024 * 1024, true);
  }
  return evidence;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "build" && args.length === 6) {
    const [walletPath, toolPath, signedPath, trustedAddress, previous, output] = args;
    const bundle = createProductionWalletExportBundle({
      previousBundleHash: previous === "none" ? null : previous,
      signedRelease: readJson(signedPath, 16 * 1024 * 1024), toolPackage: readJson(toolPath),
      trustedAddress, walletPackage: readJson(walletPath),
    });
    writeExclusive(output, serializeOfflineReleaseBundle(bundle));
    process.stdout.write(`${canonicalJson({ bundleHash: bundle.bundleHash,
      manifestHash: bundle.manifestHash, status: "UNSIGNED" })}\n`);
  } else if (command === "assemble" && args.length >= 4) {
    const [bundlePath, setPath, output, ...approvalPaths] = args;
    const bundle = parseOfflineReleaseBundle(`${canonicalJson(readJson(bundlePath,
      192 * 1024 * 1024, true))}\n`);
    const assembled = assembleProductionWalletExport(bundle, readJson(setPath, 1024 * 1024),
      approvalPaths.map((path) => readJson(path, 64 * 1024, true)));
    writeExclusive(output, `${canonicalJson(assembled)}\n`);
    process.stdout.write(`${canonicalJson({ bundleHash: bundle.bundleHash, status: "ASSEMBLED" })}\n`);
  } else if (command === "verify" && (args.length === 11 || args.length === 13)) {
    const [path, trustedReleaseAddress, expectedAuthoritySetId, expectedNetworkId, expectedGenesisHash,
      expectedWalletPackageHash, expectedToolPackageHash, checkpointPath, proofPath,
      expectedCheckpointHash, nowText, transitionPath, consistencyPath] = args;
    const text = `${canonicalJson(readJson(path, 192 * 1024 * 1024, true))}\n`;
    const verified = parseProductionWalletExport(text, { expectedAuthoritySetId,
      expectedGenesisHash, expectedNetworkId,
      expectedToolPackageHash, expectedWalletPackageHash, trustedReleaseAddress });
    verifyWalletReleaseTransparencyEvidence(verified,
      transparencyEvidence(checkpointPath, proofPath, transitionPath, consistencyPath), {
      expectedCheckpointHash, now: Number(nowText),
    });
    process.stdout.write(`${canonicalJson({ bundleHash: verified.bundle.bundleHash,
      packageHash: verified.walletPackage.packageHash, status: "VERIFIED" })}\n`);
  } else if (command === "import" && new Set([12, 14, 15, 17]).has(args.length)) {
    const [path, trustedReleaseAddress, expectedAuthoritySetId, expectedNetworkId, expectedGenesisHash,
      expectedWalletPackageHash, expectedToolPackageHash, checkpointPath, proofPath,
      expectedCheckpointHash, nowText, target,
      ...optional] = args;
    const hasPrevious = optional.length === 3 || optional.length === 5;
    const hasTransition = optional.length === 2 || optional.length === 5;
    const [previousInstallation, previousSignedPath, expectedPreviousPackageHash] = hasPrevious
      ? optional.slice(0, 3) : [];
    const [transitionPath, consistencyPath] = hasTransition ? optional.slice(-2) : [];
    const envelope = readJson(path, 192 * 1024 * 1024, true);
    const verificationOptions = { expectedAuthoritySetId,
      expectedGenesisHash,
      expectedNetworkId, expectedToolPackageHash, expectedWalletPackageHash,
      trustedReleaseAddress };
    const verified = parseProductionWalletExport(`${canonicalJson(envelope)}\n`, verificationOptions);
    const evidence = transparencyEvidence(checkpointPath, proofPath, transitionPath, consistencyPath);
    verifyWalletReleaseTransparencyEvidence(verified, evidence, {
      expectedCheckpointHash, now: Number(nowText),
    });
    const result = importProductionWalletExport(envelope, target, { ...verificationOptions,
      expectedCheckpointHash, now: Number(nowText), transparencyEvidence: evidence,
      expectedPreviousPackageHash: expectedPreviousPackageHash ?? null,
      previousInstallation: previousInstallation ?? null,
      previousSignedRelease: previousSignedPath ? readJson(previousSignedPath, 16 * 1024 * 1024) : null,
    });
    process.stdout.write(`${canonicalJson(result)}\n`);
  } else {
    throw new Error("usage: wallet-export build WALLET_PACKAGE TOOL_PACKAGE SIGNED_RELEASE TRUSTED_RELEASE_ADDRESS PREVIOUS_BUNDLE|none OUTPUT | wallet-export assemble BUNDLE AUTHORITY_SET OUTPUT APPROVAL... | wallet-export verify EXPORT TRUSTED_RELEASE_ADDRESS TRUSTED_AUTHORITY_SET_ID NETWORK GENESIS WALLET_PACKAGE_HASH TOOL_PACKAGE_HASH SIGNED_CHECKPOINT INCLUSION_PROOF TRUSTED_CHECKPOINT_HASH NOW_MS [TRANSITION CONSISTENCY_PROOF] | wallet-export import EXPORT TRUSTED_RELEASE_ADDRESS TRUSTED_AUTHORITY_SET_ID NETWORK GENESIS WALLET_PACKAGE_HASH TOOL_PACKAGE_HASH SIGNED_CHECKPOINT INCLUSION_PROOF TRUSTED_CHECKPOINT_HASH NOW_MS TARGET [PREVIOUS_INSTALLATION PREVIOUS_SIGNED_RELEASE PREVIOUS_PACKAGE_HASH] [TRANSITION CONSISTENCY_PROOF]");
  }
} catch (error) {
  process.stderr.write(`Production wallet export failed safely: ${error.message}\n`);
  process.exitCode = 1;
}
