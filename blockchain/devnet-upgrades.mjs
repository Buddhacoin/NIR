import { hashObject, signObject } from "./crypto.mjs";
import {
  approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload,
} from "./protocol-upgrade-authorization.mjs";

// Protocol upgrades for a local devnet whose release authority keys all sit
// in DEVNET-KEYS.json. A public network gathers these approvals from
// independent release operators instead (docs/protocol-upgrades.md).

function releaseEntry(chain, set, wallets, version) {
  const bundle = (value) => `sha3-256:${String(value).padStart(64, "a").slice(-64)}`;
  const payload = { bundleHash: bundle(version), manifestHash: `sha3-256:${String(version)
    .padStart(64, "b").slice(-64)}`, networkId: chain.networkId,
    previousBundleHash: version === 29 ? null : bundle(version - 1), protocolVersion: version,
    releaseVersion: `0.${version}.0`, sourceRevision: String(version).padStart(40, "c").slice(-40) };
  const proposal = { activeSetId: set.setId, format: "nir-release-log-proposal-v1",
    logId: "nir-protocol-releases", networkId: chain.networkId, payload,
    previousEntryHash: chain.protocolReleaseHead.entryHash,
    sequence: chain.protocolReleaseHead.sequence + 1, type: "release", version: 1 };
  proposal.proposalHash = `sha3-256:${hashObject(proposal, "RELEASE_LOG_PROPOSAL_V1")}`;
  const approvals = wallets.slice(0, set.threshold).map((wallet, index) => ({
    address: wallet.address, format: "nir-release-governance-approval-v1",
    operatorId: `release-${index}`, proposalHash: proposal.proposalHash, role: "active",
    setId: set.setId, signature: signObject({ proposalHash: proposal.proposalHash,
      sequence: proposal.sequence, role: "active", setId: set.setId }, wallet,
    "RELEASE_GOVERNANCE_APPROVAL_V1"), version: 1 }));
  const unsigned = { activeSetId: set.setId, activationApprovals: [], approvals,
    format: "nir-release-transparency-entry-v1", logId: proposal.logId,
    networkId: chain.networkId, nextSetAcceptances: [], payload,
    previousEntryHash: proposal.previousEntryHash, proposalHash: proposal.proposalHash,
    sequence: proposal.sequence, type: "release", version: 1 };
  return { ...unsigned, entryHash: `sha3-256:${hashObject(unsigned, "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
}

// The schedule object for the next version, approved by the devnet's
// release authorities.
export function devnetProtocolUpgrade(chain, set, wallets, targetVersion, activationHeight) {
  if (targetVersion < 29) return { activationHeight, format: "nir-protocol-upgrade-v1", version: targetVersion };
  const entry = releaseEntry(chain, set, wallets, targetVersion);
  const payload = createProtocolUpgradeAuthorizationPayload({ activationHeight,
    authoritySetId: set.setId, baseHeight: chain.height, baseTipHash: chain.tipHash,
    bundleHash: entry.payload.bundleHash, chainIdentityGenesisHash: chain.blocks()[0].hash,
    currentVersion: chain.protocolVersion, entryHash: entry.entryHash,
    manifestHash: entry.payload.manifestHash, networkId: chain.networkId,
    releaseVersion: entry.payload.releaseVersion, sourceRevision: entry.payload.sourceRevision,
    targetVersion });
  const approvals = wallets.slice(0, set.threshold).map((wallet, index) =>
    approveProtocolUpgradeAuthorization(payload, set, { operatorId: `release-${index}`, wallet }))
    .sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  return { activationHeight, authorization: assembleProtocolUpgradeAuthorization(
    payload, entry, approvals), format: "nir-protocol-upgrade-v2", version: targetVersion };
}
