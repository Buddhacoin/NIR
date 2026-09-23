import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedPublicJson } from "./production-release-gate.mjs";
import { verifyProductionStartupFromHead } from "./production-head-store.mjs";
import { verifyProductionRuntimePolicy } from "./production-runtime-policy.mjs";

function readAnchor(path) {
  return path ? readBoundedPublicJson(path, {
    maximumBytes: 64 * 1024, requireCanonical: true,
  }) : undefined;
}

function assertActiveLink(installationTarget) {
  const target = resolve(installationTarget); const metadata = lstatSync(target);
  if (!metadata.isSymbolicLink()) throw new Error("production startup installation is not active");
  const link = readlinkSync(target);
  if (!/^\.[^/\x00-\x1f\x7f]{1,200}\.nir-generation-[0-9a-f]{32}$/.test(link)) {
    throw new Error("production startup activation link is invalid");
  }
  const generation = realpathSync(join(dirname(target), link));
  const current = lstatSync(target);
  if (!current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino ||
      readlinkSync(target) !== link) throw new Error("production startup activation changed");
  return generation;
}

function assertEntrypointIsInstalled(installationTarget, moduleUrl) {
  const generation = assertActiveLink(installationTarget);
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  if (!modulePath.startsWith(`${generation}${sep}`)) {
    throw new Error("production node entrypoint is not from the anchored active generation");
  }
}

const RELEASE_LINEAGE_FIELDS = [
  "genesisHash", "networkId", "releaseManifestHash", "releaseVersion", "sourceRevision",
];

function assertSameReleaseLineage(wallet, tool) {
  if (RELEASE_LINEAGE_FIELDS.some((field) =>
    wallet.productionTarget[field] !== tool.productionTarget[field])) {
    throw new Error("production wallet and bridge tool release lineage is mixed");
  }
}

function runtimeBinding(wallet, tool) {
  return { genesisHash: wallet.productionTarget.genesisHash,
    networkId: wallet.productionTarget.networkId,
    releaseManifestHash: wallet.productionTarget.releaseManifestHash,
    releaseVersion: wallet.productionTarget.releaseVersion,
    sourceRevision: wallet.productionTarget.sourceRevision,
    toolPackageHash: tool.packageHash, walletPackageHash: wallet.packageHash };
}

export function createProductionRuntimePolicyGuard({ command, expectedPolicyHash,
  expectedSequence, policyPath, tool, wallet } = {}) {
  if (!policyPath || !expectedPolicyHash || !Number.isSafeInteger(expectedSequence) ||
      expectedSequence < 1) throw new Error("production runtime policy trust inputs are required");
  const envelope = readBoundedPublicJson(policyPath, {
    maximumBytes: 4 * 1024 * 1024, requireCanonical: true,
  });
  const expectedBinding = runtimeBinding(wallet, tool);
  const verify = () => verifyProductionRuntimePolicy(envelope, { command, expectedBinding,
    expectedPolicyHash, expectedSequence, now: Date.now() });
  return { initial: verify(), verifyBeforeSensitiveAction: verify };
}

export function createProductionStartupGuard({
  externalAnchorPath, headStore, includeArtifact = false, installationTarget, kind, moduleUrl,
  requireExternalAnchor = true, requireInstalledEntrypoint = kind === "node",
  signedReleasePath, trustedAddress,
} = {}) {
  if (!["node", "wallet"].includes(kind)) throw new Error("production startup kind is invalid");
  if (requireExternalAnchor && !externalAnchorPath) {
    throw new Error("production startup requires an external monotonic anchor");
  }
  const signedRelease = readBoundedPublicJson(signedReleasePath, {
    maximumBytes: 16 * 1024 * 1024,
  });
  const externalAnchor = readAnchor(externalAnchorPath);
  const verify = () => {
    if (requireInstalledEntrypoint) assertEntrypointIsInstalled(installationTarget, moduleUrl);
    const result = verifyProductionStartupFromHead(headStore, installationTarget, {
      externalAnchor, includeArtifact, signedRelease, trustedAddress,
    });
    if (result.kind !== kind) throw new Error("production startup anchor kind is mixed");
    if (requireInstalledEntrypoint) assertEntrypointIsInstalled(installationTarget, moduleUrl);
    else assertActiveLink(installationTarget);
    return result;
  };
  return { initial: verify(), verifyBeforeOpen: verify };
}

export function createWalletToolProductionGuard({
  includeWalletArtifact = false,
  moduleUrl, signedReleasePath, toolExternalAnchorPath, toolHeadStore,
  toolInstallationTarget, trustedAddress, walletExternalAnchorPath, walletHeadStore,
  walletInstallationTarget,
} = {}) {
  const tool = createProductionStartupGuard({
    externalAnchorPath: toolExternalAnchorPath, headStore: toolHeadStore,
    installationTarget: toolInstallationTarget, kind: "node", moduleUrl,
    signedReleasePath, trustedAddress,
  });
  const wallet = createProductionStartupGuard({
    externalAnchorPath: walletExternalAnchorPath, headStore: walletHeadStore,
    includeArtifact: includeWalletArtifact, installationTarget: walletInstallationTarget,
    kind: "wallet",
    requireInstalledEntrypoint: false, signedReleasePath, trustedAddress,
  });
  const verify = () => {
    const toolResult = tool.verifyBeforeOpen();
    const walletResult = wallet.verifyBeforeOpen();
    assertSameReleaseLineage(walletResult, toolResult);
    if (toolResult.packageHash !== tool.initial.packageHash ||
        toolResult.anchorHead !== tool.initial.anchorHead ||
        walletResult.packageHash !== wallet.initial.packageHash ||
        walletResult.anchorHead !== wallet.initial.anchorHead) {
      throw new Error("production wallet or tool generation changed during startup");
    }
    return { tool: toolResult, wallet: walletResult };
  };
  assertSameReleaseLineage(wallet.initial, tool.initial);
  return { initial: { tool: tool.initial, wallet: wallet.initial }, verifyBeforeOpen: verify };
}

export const createWalletBridgeProductionGuard = createWalletToolProductionGuard;
