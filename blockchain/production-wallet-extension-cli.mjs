#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { createProductionRuntimePolicyGuard,
  createWalletToolProductionGuard } from "./production-startup.mjs";
import { installProductionReleasePackage,
  readBoundedPublicJson } from "./production-release-gate.mjs";
import { productionPackageFromWalletStartup,
  validateProductionWalletExtensionArtifact } from "./production-wallet-extension.mjs";

const [command, walletInstallationTarget, walletHeadStore, signedReleasePath, trustedAddress,
  walletExternalAnchorPath, toolInstallationTarget, toolHeadStore, toolExternalAnchorPath,
  runtimePolicyPath, expectedRuntimePolicyHash, runtimePolicySequenceText,
  ...remaining] = process.argv.slice(2);

function guard(target = walletInstallationTarget) {
  return createWalletToolProductionGuard({
    includeWalletArtifact: true, moduleUrl: import.meta.url, signedReleasePath,
    toolExternalAnchorPath, toolHeadStore, toolInstallationTarget, trustedAddress,
    walletExternalAnchorPath, walletHeadStore, walletInstallationTarget: target,
  });
}

function launchRecord(target, verified) {
  return { artifactHash: verified.artifactHash, extensionPath: realpathSync(target),
    format: "nir-production-extension-launch-v1", networkId: verified.productionTarget.networkId,
    packageHash: verified.packageHash, releaseManifestHash:
      verified.productionTarget.releaseManifestHash, releaseVersion:
      verified.productionTarget.releaseVersion, sourceRevision:
      verified.productionTarget.sourceRevision, version: 1 };
}

try {
  if (![walletInstallationTarget, walletHeadStore, signedReleasePath, trustedAddress,
    walletExternalAnchorPath, toolInstallationTarget, toolHeadStore,
    toolExternalAnchorPath, runtimePolicyPath, expectedRuntimePolicyHash].every(Boolean) ||
      !Number.isSafeInteger(Number(runtimePolicySequenceText)) || Number(runtimePolicySequenceText) < 1) {
    throw new Error("production extension trust inputs are required");
  }
  const source = guard();
  const runtimeGuard = createProductionRuntimePolicyGuard({ command: "extension",
    expectedPolicyHash: expectedRuntimePolicyHash,
    expectedSequence: Number(runtimePolicySequenceText), policyPath: runtimePolicyPath,
    tool: source.initial.tool, wallet: source.initial.wallet });
  const packageValue = productionPackageFromWalletStartup(source.initial.wallet);
  const signedRelease = readBoundedPublicJson(signedReleasePath, {
    maximumBytes: 16 * 1024 * 1024,
  });
  if (command === "install" && remaining.length === 1) {
    const [newTarget] = remaining;
    source.verifyBeforeOpen(); runtimeGuard.verifyBeforeSensitiveAction();
    installProductionReleasePackage(packageValue, newTarget, {
      kind: "wallet", now: packageValue.productionReport.observedAt,
      signedRelease, trustedAddress,
    });
    const installed = guard(newTarget);
    validateProductionWalletExtensionArtifact(installed.initial.wallet.artifact);
    installed.verifyBeforeOpen(); runtimeGuard.verifyBeforeSensitiveAction();
    console.log(canonicalJson(launchRecord(newTarget, installed.initial.wallet)));
  } else if (command === "update" && remaining.length === 4) {
    const [currentTarget, previousSignedPath, expectedPreviousPackageHash, newTarget] = remaining;
    const previousSignedRelease = readBoundedPublicJson(previousSignedPath, {
      maximumBytes: 16 * 1024 * 1024,
    });
    source.verifyBeforeOpen(); runtimeGuard.verifyBeforeSensitiveAction();
    installProductionReleasePackage(packageValue, newTarget, {
      expectedPreviousPackageHash, kind: "wallet",
      now: packageValue.productionReport.observedAt, previousInstallation: currentTarget,
      previousSignedRelease, signedRelease, trustedAddress,
    });
    const installed = guard(newTarget);
    validateProductionWalletExtensionArtifact(installed.initial.wallet.artifact);
    installed.verifyBeforeOpen(); runtimeGuard.verifyBeforeSensitiveAction();
    console.log(canonicalJson(launchRecord(newTarget, installed.initial.wallet)));
  } else if (command === "verify-launch" && remaining.length === 1) {
    const [target] = remaining; const installed = guard(target);
    validateProductionWalletExtensionArtifact(installed.initial.wallet.artifact);
    const current = installed.verifyBeforeOpen();
    runtimeGuard.verifyBeforeSensitiveAction();
    console.log(canonicalJson(launchRecord(target, current.wallet)));
  } else {
    throw new Error("usage: wallet:extension-production <install|update|verify-launch> <wallet-installation> <wallet-head> <signed-release> <trusted-address> <wallet-anchor> <tool-installation> <tool-head> <tool-anchor> <runtime-policy> <expected-policy-hash> <policy-sequence> <command-arguments>");
  }
} catch (error) {
  console.error(`Production extension failed: ${error.message}`);
  process.exitCode = 1;
}
