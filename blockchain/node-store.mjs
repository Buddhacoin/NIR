import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import {
  createTransfer,
  finalizeBlock,
  formatNir,
  NirChain,
  quoteTransferFee,
  transactionId,
} from "./chain.mjs";
import {
  ATOMIC_UNITS,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  MIN_TRANSFER_FEE,
  PROOF_MINING_PROTOCOL_VERSION,
  NAME_REGISTRY_PROTOCOL_VERSION,
  SAFETY_POLICY_V1_COMMITMENT,
  TRANSFER_GENESIS_BINDING_PROTOCOL_VERSION,
} from "./constants.mjs";
import { protocolVersionAtNextHeight } from "./protocol-upgrade.mjs";
import { devnetProtocolUpgrade } from "./devnet-upgrades.mjs";
import { createReleaseAuthoritySet, createReleaseTransparencyAnchor }
  from "./offline-release-governance.mjs";
import { createEpochRandomnessCommit, createEpochRandomnessReveal } from "./operators.mjs";
import { generateWallet, publicWallet } from "./crypto.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { initializeBlockStore, loadBlockStore, loadBlockStoreFromSnapshot, persistBlock } from "./block-store.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "./state-snapshot.mjs";
import { createAccountProof } from "./account-proof.mjs";
import { createAssetProof } from "./asset-proof.mjs";
import { createFinalityProof, MAX_FINALITY_PROOFS } from "./light-client.mjs";
import { AccountHistoryIndex } from "./account-history-index.mjs";
import { proofMiningView } from "./proof-mining-state.mjs";
import { NAMES_V1, lookupName, nameOfAddress, namePrice, nameProblem } from "./name-registry.mjs";

const CONFIG_FILE = "genesis.json";
const DEV_KEYS_FILE = "DEVNET-KEYS.json";

// A devnet signs a state snapshot of itself every RESUME_INTERVAL blocks, so
// opening it replays only the blocks after the snapshot instead of the whole
// chain. The blocks stay in the journal for finality proofs.
const RESUME_FILE = "DEVNET-RESUME.json";
const RESUME_INTERVAL = 256;

function writeExclusive(path, value, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode,
  });
  chmodSync(path, mode);
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function referenceCapability() {
  return {
    artifactHash: `sha256:${"1".repeat(64)}`,
    behaviorCommitment: "2".repeat(64),
    capabilitiesBps: { "reasoning-v1": 1 },
  };
}

// The version a proof-mining devnet runs; older devnets upgrade on open.
export const LATEST_DEVNET_PROTOCOL_VERSION = NAME_REGISTRY_PROTOCOL_VERSION;

// `proofMining: true` starts from v27 with local release and beacon keys,
// upgrades to v35 at once, and lets `tick()` run the beacon, so network clique
// tasks can be mined against this node (docs/proof-mining.md).
export function initializeDevnet(directory, {
  networkId = "nir-local-devnet", proofMining = false, proofMiningInitialLevel = 32,
} = {}) {
  const root = resolve(directory);
  mkdirSync(root, { mode: 0o700 });
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const releases = proofMining ? Array.from({ length: 4 }, generateWallet) : [];
  const releaseSet = proofMining ? createReleaseAuthoritySet({ authorities: members(releases, "release"),
    generation: 1, rotationDelayEntries: 2, threshold: 3 }) : null;
  const genesis = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [referenceCapability()],
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members(validators, "validator"),
    ...(proofMining ? {
      evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
        format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
        memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`, timeout_seconds: 60 },
      genesisProtocolVersion: 27,
      proofMiningInitialLevel,
      protocolUpgradeReleaseAnchor: createReleaseTransparencyAnchor({ initialSet: releaseSet,
        logId: "nir-protocol-releases", networkId }),
    } : {}),
  };
  writeExclusive(join(root, CONFIG_FILE), genesis, 0o644);
  writeExclusive(join(root, DEV_KEYS_FILE), { treasury, validators,
    ...(proofMining ? { beacons, releaseSet, releases } : {}) }, 0o600);
  initializeBlockStore(root, new NirChain(genesis));
  if (proofMining) new PersistentDevNode(root).upgradeTo(LATEST_DEVNET_PROTOCOL_VERSION);
  return { directory: root, networkId, treasuryAddress: treasury.address,
    ...(proofMining ? { protocolVersion: LATEST_DEVNET_PROTOCOL_VERSION } : {}) };
}

function loadJson(path) {
  return parseConsensusJson(readFileSync(path, "utf8"));
}

function validatorQuorum(block, wallets) {
  const proposer = wallets.find(({ address }) => address === block.proposer);
  if (!proposer) throw new Error("devnet does not hold the active proposer key");
  return [proposer, ...wallets.filter((wallet) => wallet !== proposer).slice(0, 2)];
}

export class PersistentDevNode {
  #chain;
  #config;
  #historyIndex;
  #keys;
  #root;

  constructor(directory) {
    this.#root = resolve(directory);
    this.#config = loadJson(join(this.#root, CONFIG_FILE));
    this.#keys = loadJson(join(this.#root, DEV_KEYS_FILE));
    if (!Array.isArray(this.#keys.validators) || this.#keys.validators.length !== this.#config.validators.length ||
        this.#keys.validators.some((wallet) =>
          !this.#config.validators.some((member) => member.address === wallet.address && member.publicKey === wallet.publicKey))) {
      throw new Error("devnet validator keys do not match genesis");
    }
    this.#chain = this.#loadChain();
    this.#historyIndex = new AccountHistoryIndex(this.#root, this.#chain);
  }

  get networkId() { return this.#chain.networkId; }
  get height() { return this.#chain.height; }
  get tipHash() { return this.#chain.tipHash; }
  get protocolVersion() { return this.#chain.protocolVersion; }
  // Public genesis: validators, release anchor and parameters, no keys.
  get genesisConfig() { return structuredClone(this.#config); }

  // What a founder transfer needs besides the allocations: the network and
  // its genesis, which v36+ transfers name.
  genesisAllocations() {
    return { ...this.#chain.genesisAllocations(), chainIdentityGenesisHash: this.#chain.blockAtHeight(0).hash,
      networkId: this.#chain.networkId };
  }

  validatorHandoffHistory() { return []; }

  finalityProofsAfter(fromHeight, limit = MAX_FINALITY_PROOFS) {
    if (!Number.isSafeInteger(fromHeight) || fromHeight < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FINALITY_PROOFS) {
      throw new Error("finality proof range is invalid");
    }
    // Only the requested blocks are copied, not the whole chain.
    const to = Math.min(this.#chain.height, fromHeight + limit);
    if (fromHeight >= to) return [];
    return this.#chain.blockRange(fromHeight, to, limit).map(createFinalityProof);
  }

  transactionProof(id) {
    return this.#historyIndex.transactionProof(id);
  }

  accountHistoryPage(address, { before, limit = 20 } = {}) {
    return this.#historyIndex.page(address, { before, limit });
  }

  account(address) {
    const balance = this.#chain.balance(address);
    const pendingUnstake = this.#chain.creditUnstake(address);
    const authenticatedResources = this.#chain.accountState(address).resources;
    return {
      address,
      atomicBalance: balance.toString(),
      balance: formatNir(balance),
      history: this.#chain.accountState(address).history,
      resources: {
        atomicStake: this.#chain.creditStake(address).toString(),
        availableTransferCredits: this.#chain.transferCredits(address).toString(),
        delegations: this.#chain.creditDelegations(address),
        pendingProgressBondRefund: authenticatedResources.pendingProgressBondRefund,
        pendingProgressReward: authenticatedResources.pendingProgressReward,
        pendingUnstake: pendingUnstake ? {
          amount: pendingUnstake.amount.toString(), unlockHeight: pendingUnstake.unlockHeight,
        } : null,
      },
      nextNonce: this.#chain.nextNonce(address),
    };
  }

  accountProof(address) {
    const authenticated = this.#chain.accountStateProof(address);
    const validators = this.#chain.validatorMembers;
    const active = new Set(validators.map((member) => member.address));
    const validatorWallets = this.#keys.validators.filter((wallet) => active.has(wallet.address));
    return createAccountProof({
      account: authenticated.account,
      accountStateRoot: authenticated.accountStateRoot,
      inclusionProof: authenticated.inclusionProof,
      height: this.#chain.height,
      networkId: this.#chain.networkId,
      pendingProtocolUpgrade: this.#chain.pendingProtocolUpgrade,
      protocolVersion: this.#chain.protocolVersion,
      stateRoot: this.#chain.stateRoot,
      tipHash: this.#chain.tipHash,
      validators,
      validatorWallets,
    });
  }

  assetProof(assetId, holder) {
    const validators = this.#chain.validatorMembers;
    const active = new Set(validators.map((member) => member.address));
    const validatorWallets = this.#keys.validators.filter((wallet) => active.has(wallet.address));
    return createAssetProof({ asset: this.#chain.nativeAsset(assetId), assetId,
      balance: this.#chain.nativeAssetBalance(assetId, holder).toString(),
      height: this.#chain.height, holder, networkId: this.#chain.networkId,
      pendingProtocolUpgrade: this.#chain.pendingProtocolUpgrade,
      protocolVersion: this.#chain.protocolVersion, stateRoot: this.#chain.stateRoot,
      tipHash: this.#chain.tipHash, validators, validatorWallets });
  }

  proofRewards(address) {
    if (!/^nir1[0-9a-f]{64}$/.test(address)) throw new Error("address is invalid");
    return this.#chain.proofRewardHistory(address);
  }

  // Pioneer points (docs/pioneer-program.md): the proof rewards an address
  // received on this network, against all others. The operator's own keys
  // never count.
  pioneerPoints(address) {
    if (!/^nir1[0-9a-f]{64}$/.test(address)) throw new Error("address is invalid");
    const excluded = new Set(Object.values(this.#keys).flat()
      .map((key) => key?.address).filter((key) => typeof key === "string"));
    const { points, pioneers, totalPoints } = this.#chain.pioneerPoints(address, excluded);
    return { address, height: this.#chain.height, networkId: this.#chain.networkId, pioneers,
      points: points.toString(), poolNir: "210000", totalPoints: totalPoints.toString() };
  }

  proofMining() {
    // Miners sign answers bound to this genesis.
    return { ...proofMiningView(this.#chain.proofMiningStatus(),
      { height: this.#chain.height, timestampMs: this.#chain.tipTimestamp }),
    chainIdentityGenesisHash: this.#chain.blockAtHeight(0).hash };
  }

  // Account names (docs/names.md): what a wallet needs to check and register one.
  nameRegistry() {
    const state = this.#chain.nameRegistryStatus();
    return { active: state !== null, chainIdentityGenesisHash: this.#chain.blockAtHeight(0).hash,
      height: this.#chain.height, networkId: this.#chain.networkId,
      revealDelayBlocks: NAMES_V1.revealDelayBlocks, commitLifetimeBlocks: NAMES_V1.commitLifetimeBlocks,
      names: state?.names.size ?? 0 };
  }

  nameLookup(input) {
    const name = String(input ?? "").trim().toLowerCase().replace(/\.nir$/u, "");
    const problem = nameProblem(name);
    const state = this.#chain.nameRegistryStatus();
    const entry = problem === null ? lookupName(state, name) : null;
    return { name, problem, available: state !== null && problem === null && entry === null,
      owner: entry?.owner ?? null, price: problem === null ? namePrice(name).toString() : null };
  }

  accountName(address) {
    if (!/^nir1[0-9a-f]{64}$/.test(address)) throw new Error("address is invalid");
    return { address, name: nameOfAddress(this.#chain.nameRegistryStatus(), address) };
  }

  feeQuote(amount, fee = MIN_TRANSFER_FEE.toString()) {
    return quoteTransferFee(String(amount), String(fee));
  }

  get proofMiningEnabled() {
    return Array.isArray(this.#keys.beacons) && Array.isArray(this.#keys.releases);
  }

  // Schedules and activates every version up to `targetVersion` with the
  // devnet's own release keys.
  upgradeTo(targetVersion) {
    if (!this.proofMiningEnabled) throw new Error("devnet holds no release keys");
    while (this.#chain.protocolVersion < targetVersion) {
      const activationHeight = this.#chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
      this.#commit({ protocolUpgrade: devnetProtocolUpgrade(this.#chain, this.#keys.releaseSet,
        this.#keys.releases, this.#chain.protocolVersion + 1, activationHeight) });
      while (this.#chain.height < activationHeight) this.#commit({});
    }
  }

  // Whether the devnet still needs new blocks without a miner: answers to
  // reveal, rewards to mature, or names waiting for their registration.
  get hasPendingWork() {
    const mining = this.#chain.proofMiningStatus();
    const names = this.#chain.nameRegistryStatus();
    return Boolean((mining && (mining.commits.size > 0 || mining.pendingRewards.length > 0 ||
      mining.escrows.size > 0)) || (names && names.commits.size > 0));
  }

  // One devnet heartbeat: run a beacon round when no task is open, so the
  // network issues the next one; otherwise produce a block so reveal delays
  // pass. A public network gets both from independent operators.
  tick() {
    const status = this.#chain.proofMiningStatus();
    if (!this.proofMiningEnabled || status === null ||
        [...status.tasks.values()].some((task) => task.status === "open")) {
      return this.#commit({});
    }
    const { committee, round } = this.#chain.epochRandomnessStatus();
    const wallets = committee.map((address) => this.#keys.beacons.find((w) => w.address === address));
    const secrets = wallets.map(() => randomBytes(32).toString("hex"));
    const networkId = this.#chain.networkId;
    this.#commit({ epochRandomnessCommits: wallets.map((wallet, i) =>
      createEpochRandomnessCommit({ networkId, round, secret: secrets[i], wallet })) });
    return this.#commit({ epochRandomnessReveals: wallets.map((wallet, i) =>
      createEpochRandomnessReveal({ networkId, round, secret: secrets[i], wallet })) });
  }

  #loadChain() {
    const path = join(this.#root, RESUME_FILE);
    if (existsSync(path)) {
      try {
        const resume = parseConsensusJson(readFileSync(path, "utf8"));
        if (resume?.format !== "nir-devnet-resume-v1") throw new Error("devnet resume file is invalid");
        const trustAnchor = { expectedNetworkId: this.#config.networkId, handoffs: [],
          trustedValidators: this.#config.validators };
        return loadBlockStoreFromSnapshot(this.#root, this.#config, {
          snapshotHeight: resume.snapshot?.height,
          restore: (blocks) => {
            verifyStateSnapshot(resume.snapshot, trustAnchor);
            const chain = NirChain.fromVerifiedSnapshotWithHistory(this.#config, resume.snapshot, blocks);
            chain.restoreProofRewardLog(resume.proofRewardLog);
            // Older resume files have no totals: the full replay below rebuilds them.
            chain.restoreProofRewardTotals(resume.proofRewardTotals);
            return chain;
          },
        }).chain;
      } catch {
        // A stale or damaged resume file only costs the full replay below.
      }
    }
    const { chain } = loadBlockStore(this.#root, this.#config);
    this.#saveResume(chain);
    return chain;
  }

  #saveResume(chain) {
    if (chain.height < 1) return;
    const path = join(this.#root, RESUME_FILE);
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ format: "nir-devnet-resume-v1",
      proofRewardLog: chain.proofRewardLogEntries(),
      proofRewardTotals: chain.proofRewardTotalEntries(),
      snapshot: createStateSnapshot(chain, this.#keys.validators) })}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  #nextProtocolVersion() {
    return protocolVersionAtNextHeight({ currentHeight: this.#chain.height,
      currentVersion: this.#chain.protocolVersion, pendingUpgrade: this.#chain.pendingProtocolUpgrade });
  }

  #commit(options) {
    const block = this.#chain.buildBlock({ timestamp: Date.now(), ...options });
    const finalized = finalizeBlock(block, validatorQuorum(block, this.#keys.validators));
    const verified = this.#chain.fork();
    verified.appendBlock(finalized);
    persistBlock(this.#root, finalized, verified);
    if (finalized.height % RESUME_INTERVAL === 0) this.#saveResume(verified);
    this.#historyIndex.appendBlock(finalized, verified);
    this.#chain = verified;
    return { blockHash: finalized.hash, height: finalized.height };
  }

  submitTransaction(transaction) {
    return { ...this.#commit({ transactions: [transaction] }), transactionId: transactionId(transaction) };
  }

  faucet(recipient, amount = (10n * ATOMIC_UNITS).toString()) {
    const atomic = BigInt(amount);
    if (atomic <= 0n || atomic > 10n * ATOMIC_UNITS) {
      throw new Error("devnet faucet amount must be between 1 atomic unit and 10 NIR");
    }
    if (this.#chain.accountState(recipient).history.count > 0) {
      throw new Error("devnet faucet is limited to one request per fresh address");
    }
    const transaction = createTransfer({
      wallet: this.#keys.treasury,
      networkId: this.#chain.networkId,
      recipient,
      amount: atomic.toString(),
      nonce: this.#chain.nextNonce(this.#keys.treasury.address),
      // From v36 a transfer names the genesis it belongs to.
      ...(this.#nextProtocolVersion() >= TRANSFER_GENESIS_BINDING_PROTOCOL_VERSION
        ? { chainIdentityGenesisHash: this.#chain.blockAtHeight(0).hash } : {}),
    });
    return { ...this.#commit({ transactions: [transaction] }), transactionId: transactionId(transaction) };
  }
}
