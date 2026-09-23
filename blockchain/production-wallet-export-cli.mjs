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
  } else if (command === "verify" && args.length === 7) {
    const [path, trustedReleaseAddress, expectedAuthoritySetId, expectedNetworkId, expectedGenesisHash,
      expectedWalletPackageHash, expectedToolPackageHash] = args;
    const text = `${canonicalJson(readJson(path, 192 * 1024 * 1024, true))}\n`;
    const verified = parseProductionWalletExport(text, { expectedAuthoritySetId,
      expectedGenesisHash, expectedNetworkId,
      expectedToolPackageHash, expectedWalletPackageHash, trustedReleaseAddress });
    process.stdout.write(`${canonicalJson({ bundleHash: verified.bundle.bundleHash,
      packageHash: verified.walletPackage.packageHash, status: "VERIFIED" })}\n`);
  } else if (command === "import" && (args.length === 8 || args.length === 11)) {
    const [path, trustedReleaseAddress, expectedAuthoritySetId, expectedNetworkId, expectedGenesisHash,
      expectedWalletPackageHash, expectedToolPackageHash, target,
      previousInstallation, previousSignedPath, expectedPreviousPackageHash] = args;
    const envelope = readJson(path, 192 * 1024 * 1024, true);
    const result = importProductionWalletExport(envelope, target, { expectedAuthoritySetId,
      expectedGenesisHash,
      expectedNetworkId, expectedPreviousPackageHash: expectedPreviousPackageHash ?? null,
      expectedToolPackageHash, expectedWalletPackageHash,
      previousInstallation: previousInstallation ?? null,
      previousSignedRelease: previousSignedPath ? readJson(previousSignedPath, 16 * 1024 * 1024) : null,
      trustedReleaseAddress });
    process.stdout.write(`${canonicalJson(result)}\n`);
  } else {
    throw new Error("usage: wallet-export build WALLET_PACKAGE TOOL_PACKAGE SIGNED_RELEASE TRUSTED_RELEASE_ADDRESS PREVIOUS_BUNDLE|none OUTPUT | wallet-export assemble BUNDLE AUTHORITY_SET OUTPUT APPROVAL... | wallet-export verify EXPORT TRUSTED_RELEASE_ADDRESS TRUSTED_AUTHORITY_SET_ID NETWORK GENESIS WALLET_PACKAGE_HASH TOOL_PACKAGE_HASH | wallet-export import EXPORT TRUSTED_RELEASE_ADDRESS TRUSTED_AUTHORITY_SET_ID NETWORK GENESIS WALLET_PACKAGE_HASH TOOL_PACKAGE_HASH TARGET [PREVIOUS_INSTALLATION PREVIOUS_SIGNED_RELEASE PREVIOUS_PACKAGE_HASH]");
  }
} catch (error) {
  process.stderr.write(`Production wallet export failed safely: ${error.message}\n`);
  process.exitCode = 1;
}
