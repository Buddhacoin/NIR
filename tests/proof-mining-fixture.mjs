// Shared fixture for proof-mining chain tests: a v27 genesis upgraded to the
// requested protocol version through authorized releases, with a funded miner.
import {
  NirChain, createTransfer, finalizeBlock,
} from "../blockchain/chain.mjs";
import { cliqueEdge, cliqueSearchParameters } from "../blockchain/clique-search.mjs";
import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, PROOF_MINING_PROTOCOL_VERSION, SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { createReleaseAuthoritySet, createReleaseTransparencyAnchor }
  from "../blockchain/offline-release-governance.mjs";
import { createEpochRandomnessCommit, createEpochRandomnessReveal } from "../blockchain/operators.mjs";
import { approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload } from "../blockchain/protocol-upgrade-authorization.mjs";

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));
const quorumFor = (proposal, wallets) => [
  wallets.find(({ address }) => address === proposal.proposer),
  ...wallets.filter(({ address }) => address !== proposal.proposer),
].slice(0, Math.floor(wallets.length * 2 / 3) + 1);

export function append(chain, options, wallets) {
  const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1, ...options });
  const block = finalizeBlock(proposal, quorumFor(proposal, wallets));
  chain.appendBlock(block);
  return block;
}

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

function authorizedUpgrade(chain, set, wallets, targetVersion, activationHeight) {
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

// A v27 genesis upgraded step by step to `targetVersion`, with a funded miner.
export function fixture(targetVersion = PROOF_MINING_PROTOCOL_VERSION, miner = generateWallet()) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const releases = Array.from({ length: 4 }, generateWallet);
  const set = createReleaseAuthoritySet({ authorities: members(releases, "release"), generation: 1,
    rotationDelayEntries: 2, threshold: 3 });
  const networkId = "nir-proof-mining-test";
  const genesis = { beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 }, evaluators: members(Array.from({ length: 4 }, generateWallet), "eval"),
    genesisProtocolVersion: 27, genesisTimestamp: 0, networkId,
    protocolUpgradeReleaseAnchor: createReleaseTransparencyAnchor({ initialSet: set,
      logId: "nir-protocol-releases", networkId }),
    // The easiest level, where plain backtracking finds a clique at once.
    proofMiningInitialLevel: 0,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT], treasuryAddress: treasury.address,
    validators: members(validators, "validator") };
  const chain = new NirChain(genesis);
  append(chain, { timestamp: TREASURY_VESTING_MS, transactions: [createTransfer({
    amount: "100000000", networkId, nonce: 0, recipient: miner.address, wallet: treasury,
  })] }, validators);
  for (const version of [28, 29, 30, 31, 32, 33, 34, 35].filter((v) => v <= targetVersion)) {
    const activationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    append(chain, { protocolUpgrade: version === 28
      ? { activationHeight, format: "nir-protocol-upgrade-v1", version }
      : authorizedUpgrade(chain, set, releases, version, activationHeight) }, validators);
    while (chain.height < activationHeight) append(chain, {}, validators);
  }
  return { beacons, chain, genesis, miner, validators };
}

// One beacon round: a commit block and a reveal block.
export function finalizeBeaconRound(chain, beacons, validators) {
  const status = chain.epochRandomnessStatus();
  const committee = status.committee.map((address) => beacons.find((w) => w.address === address));
  const secrets = committee.map((_, i) => hashObject({ i, round: status.round }, "TEST_SECRET"));
  append(chain, { epochRandomnessCommits: committee.map((wallet, i) => createEpochRandomnessCommit({
    networkId: chain.networkId, round: status.round, secret: secrets[i], wallet })) }, validators);
  append(chain, { epochRandomnessReveals: committee.map((wallet, i) => createEpochRandomnessReveal({
    networkId: chain.networkId, round: status.round, secret: secrets[i], wallet })) }, validators);
  return status.round;
}

export function findClique(seed, level) {
  const { n, k } = cliqueSearchParameters(level);
  const adjacent = Array.from({ length: n }, () => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (cliqueEdge(seed, n, i, j)) adjacent[i][j] = adjacent[j][i] = 1;
  }
  const extend = (chosen, candidates) => {
    if (chosen.length === k) return chosen;
    if (chosen.length + candidates.length < k) return null;
    for (let x = 0; x < candidates.length; x++) {
      const v = candidates[x];
      const found = extend([...chosen, v], candidates.slice(x + 1).filter((u) => adjacent[v][u]));
      if (found) return found;
    }
    return null;
  };
  return extend([], [...Array(n).keys()]);
}
