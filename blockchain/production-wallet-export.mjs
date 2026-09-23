import { canonicalJson } from "./crypto.mjs";
import {
  createOfflineReleaseBundleFromEntries, validateOfflineReleaseApproval,
  validateOfflineReleaseBundle,
} from "./offline-release-bundle.mjs";
import { validateReleaseAuthoritySet } from "./offline-release-governance.mjs";
import {
  installProductionReleasePackage, verifyProductionReleasePackage,
} from "./production-release-gate.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";
import { validateProductionWalletExtensionArtifact } from "./production-wallet-extension.mjs";
import { PRODUCTION_EXTENSION_FILES } from "./production-wallet-extension.mjs";
import { verifyWalletReleaseTransparencyEvidence } from "./production-wallet-transparency.mjs";

const FORMAT = "nir-production-wallet-export-v1";
const BINDING_FORMAT = "nir-production-wallet-export-binding-v1";
const HASH = /^[0-9a-f]{64}$/;
const GENESIS_HASH = /^(?:sha3-256:)?[0-9a-f]{64}$/;
const ENTRY_NAMES = Object.freeze([
  ...PRODUCTION_EXTENSION_FILES.map((path) => `extension/${path}`),
  "metadata/binding.json", "release/signed-release.json", "tool/package.json",
  "wallet/package.json",
].sort());

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema is invalid`);
  }
}

function sameLineage(left, right) {
  return ["networkId", "genesisHash", "releaseManifestHash", "releaseVersion", "sourceRevision"]
    .every((field) => left[field] === right[field]);
}

function packageDescriptor(value, kind) {
  return { artifactHash: value.artifact.artifactHash, kind, packageHash: value.packageHash };
}

function bindingPayload(value) {
  exact(value, ["format", "genesisHash", "networkId", "releaseManifestHash", "releaseVersion",
    "sourceRevision", "tool", "version", "wallet"], "wallet export binding");
  for (const [kind, descriptor] of [["node", value.tool], ["wallet", value.wallet]]) {
    exact(descriptor, ["artifactHash", "kind", "packageHash"], `${kind} generation binding`);
    if (descriptor.kind !== kind || !HASH.test(descriptor.artifactHash ?? "") ||
        !HASH.test(descriptor.packageHash ?? "")) throw new Error("wallet export generation binding is invalid");
  }
  if (value.format !== BINDING_FORMAT || value.version !== 1 ||
      typeof value.networkId !== "string" || value.networkId.length < 1 || value.networkId.length > 128 ||
      !GENESIS_HASH.test(value.genesisHash ?? "") || !HASH.test(value.releaseManifestHash ?? "") ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sourceRevision ?? "") ||
      !/^(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})$/.test(value.releaseVersion ?? "")) {
    throw new Error("wallet export lineage binding is invalid");
  }
  return structuredClone(value);
}

function jsonEntry(path, value) {
  return { contents: Buffer.from(`${canonicalJson(value)}\n`), mode: 0o644, path };
}

function entryJson(bundle, path) {
  const entry = bundle.entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`wallet export is missing ${path}`);
  const text = Buffer.from(entry.content, "base64").toString("utf8");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`wallet export ${path} is not JSON`); }
  if (text !== `${canonicalJson(value)}\n`) throw new Error(`wallet export ${path} is not canonical JSON`);
  return value;
}

export function createProductionWalletExportBundle({
  previousBundleHash = null, signedRelease, toolPackage: toolValue, trustedAddress,
  walletPackage: walletValue,
}) {
  const release = verifySignedRelease(signedRelease, { trustedAddress });
  const wallet = verifyProductionReleasePackage(walletValue, {
    now: walletValue?.productionReport?.observedAt, signedRelease, trustedAddress,
  });
  const tool = verifyProductionReleasePackage(toolValue, {
    now: toolValue?.productionReport?.observedAt, signedRelease, trustedAddress,
  });
  if (wallet.artifact.kind !== "wallet" || tool.artifact.kind !== "node" ||
      !sameLineage(wallet.productionTarget, tool.productionTarget)) {
    throw new Error("wallet export contains mixed wallet/tool release lineage");
  }
  validateProductionWalletExtensionArtifact(wallet.artifact);
  const target = wallet.productionTarget;
  if (target.releaseManifestHash !== release.manifest.manifestHash) {
    throw new Error("wallet export signed release does not match its production packages");
  }
  const binding = bindingPayload({ format: BINDING_FORMAT, genesisHash: target.genesisHash,
    networkId: target.networkId, releaseManifestHash: target.releaseManifestHash,
    releaseVersion: target.releaseVersion, sourceRevision: target.sourceRevision,
    tool: packageDescriptor(tool, "node"), version: 1,
    wallet: packageDescriptor(wallet, "wallet") });
  const extensionEntries = wallet.artifact.entries.map((entry) => ({
    contents: Buffer.from(entry.content, "base64"), mode: entry.executable ? 0o755 : 0o644,
    path: `extension/${entry.path.slice("wallet-ui/".length)}`,
  }));
  return createOfflineReleaseBundleFromEntries([
    ...extensionEntries,
    jsonEntry("metadata/binding.json", binding), jsonEntry("release/signed-release.json", signedRelease),
    jsonEntry("tool/package.json", tool), jsonEntry("wallet/package.json", wallet),
  ], { networkId: target.networkId, previousBundleHash, protocolVersion: 1,
    releaseVersion: target.releaseVersion, sourceRevision: target.sourceRevision });
}

function verifyQuorum(bundle, authoritySet, approvals) {
  const set = validateReleaseAuthoritySet(authoritySet);
  if (!Array.isArray(approvals) || approvals.length < set.threshold ||
      approvals.length > set.authorities.length) throw new Error("wallet export release quorum is missing");
  const seen = new Set();
  const verified = approvals.map((approval) => {
    const authority = set.authorities.find((candidate) => candidate.address === approval?.signer?.address);
    if (!authority || seen.has(authority.address)) throw new Error("wallet export approval is unknown or duplicate");
    seen.add(authority.address);
    return validateOfflineReleaseApproval(bundle, approval, {
      networkId: bundle.manifest.networkId, previousBundleHash: bundle.manifest.previousBundleHash,
      protocolVersion: bundle.manifest.protocolVersion, releaseVersion: bundle.manifest.releaseVersion,
      trustedAddress: authority.address,
    }).approval;
  }).sort((left, right) => left.signer.address < right.signer.address ? -1 : 1);
  return { approvals: verified, authoritySet: set };
}

export function assembleProductionWalletExport(bundleValue, authoritySetValue, approvalValues) {
  const bundle = validateOfflineReleaseBundle(bundleValue);
  const { approvals, authoritySet } = verifyQuorum(bundle, authoritySetValue, approvalValues);
  return verifyProductionWalletExport({ approvals, authoritySet, bundle, format: FORMAT, version: 1 }, {
    expectedAuthoritySetId: authoritySet.setId,
    trustedReleaseAddress: entryJson(bundle, "release/signed-release.json")?.signer?.address,
  }).envelope;
}

export function verifyProductionWalletExport(value, { expectedAuthoritySetId, expectedGenesisHash, expectedNetworkId,
  expectedToolPackageHash, expectedWalletPackageHash, trustedReleaseAddress } = {}) {
  exact(value, ["approvals", "authoritySet", "bundle", "format", "version"], "wallet export");
  if (value.format !== FORMAT || value.version !== 1 || !trustedReleaseAddress ||
      !/^sha3-256:[0-9a-f]{64}$/.test(expectedAuthoritySetId ?? "")) {
    throw new Error("wallet export envelope is invalid");
  }
  const bundle = validateOfflineReleaseBundle(value.bundle);
  if (bundle.entries.length !== ENTRY_NAMES.length ||
      bundle.entries.some((entry, index) => entry.path !== ENTRY_NAMES[index])) {
    throw new Error("wallet export archive contains missing, extra, or ambiguous entries");
  }
  const { approvals, authoritySet } = verifyQuorum(bundle, value.authoritySet, value.approvals);
  if (authoritySet.setId !== expectedAuthoritySetId) {
    throw new Error("wallet export release authority set is not trusted");
  }
  const signedRelease = entryJson(bundle, "release/signed-release.json");
  verifySignedRelease(signedRelease, { trustedAddress: trustedReleaseAddress });
  const walletPackage = entryJson(bundle, "wallet/package.json");
  const toolPackage = entryJson(bundle, "tool/package.json");
  const wallet = verifyProductionReleasePackage(walletPackage, {
    now: walletPackage?.productionReport?.observedAt, signedRelease,
    trustedAddress: trustedReleaseAddress,
  });
  const tool = verifyProductionReleasePackage(toolPackage, {
    now: toolPackage?.productionReport?.observedAt, signedRelease,
    trustedAddress: trustedReleaseAddress,
  });
  validateProductionWalletExtensionArtifact(wallet.artifact);
  for (const path of PRODUCTION_EXTENSION_FILES) {
    const archived = bundle.entries.find((entry) => entry.path === `extension/${path}`);
    const packaged = wallet.artifact.entries.find((entry) => entry.path === `wallet-ui/${path}`);
    if (!archived || !packaged || archived.content !== packaged.content) {
      throw new Error("wallet export extension snapshot does not match its signed wallet generation");
    }
  }
  const binding = bindingPayload(entryJson(bundle, "metadata/binding.json"));
  if (wallet.artifact.kind !== "wallet" || tool.artifact.kind !== "node" ||
      !sameLineage(wallet.productionTarget, tool.productionTarget) ||
      canonicalJson(binding.wallet) !== canonicalJson(packageDescriptor(wallet, "wallet")) ||
      canonicalJson(binding.tool) !== canonicalJson(packageDescriptor(tool, "node")) ||
      !sameLineage(binding, wallet.productionTarget) || bundle.manifest.networkId !== binding.networkId ||
      bundle.manifest.releaseVersion !== binding.releaseVersion ||
      bundle.manifest.sourceRevision !== binding.sourceRevision ||
      (expectedNetworkId !== undefined && binding.networkId !== expectedNetworkId) ||
      (expectedGenesisHash !== undefined && binding.genesisHash !== expectedGenesisHash) ||
      (expectedWalletPackageHash !== undefined && binding.wallet.packageHash !== expectedWalletPackageHash) ||
      (expectedToolPackageHash !== undefined && binding.tool.packageHash !== expectedToolPackageHash)) {
    throw new Error("wallet export archive has mixed or unexpected generation lineage");
  }
  const envelope = { approvals, authoritySet, bundle, format: FORMAT, version: 1 };
  return { approvals, authoritySet, binding, bundle, envelope, signedRelease, toolPackage: tool,
    walletPackage: wallet };
}

export function importProductionWalletExport(value, targetPath, options = {}) {
  const verified = verifyProductionWalletExport(value, options);
  verifyWalletReleaseTransparencyEvidence(verified, options.transparencyEvidence, {
    expectedCheckpointHash: options.expectedCheckpointHash, now: options.now,
  });
  const install = installProductionReleasePackage(verified.walletPackage, targetPath, {
    expectedPreviousPackageHash: options.expectedPreviousPackageHash ?? null, kind: "wallet",
    now: verified.walletPackage.productionReport.observedAt,
    previousInstallation: options.previousInstallation ?? null,
    previousSignedRelease: options.previousSignedRelease ?? null,
    signedRelease: verified.signedRelease, trustedAddress: options.trustedReleaseAddress,
  });
  return { bundleHash: verified.bundle.bundleHash, packageHash: install.packageHash,
    target: targetPath, verified: true };
}

export function serializeProductionWalletExport(value, options) {
  return `${canonicalJson(verifyProductionWalletExport(value, options).envelope)}\n`;
}

export function parseProductionWalletExport(text, options) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 192 * 1024 * 1024 || text.includes("\0")) {
    throw new Error("wallet export input is invalid or too large");
  }
  const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
  let value;
  try { value = JSON.parse(canonical); } catch { throw new Error("wallet export input is not JSON"); }
  if (canonicalJson(value) !== canonical) throw new Error("wallet export input is not canonical JSON");
  return verifyProductionWalletExport(value, options);
}
