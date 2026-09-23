import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
} from "./constants.mjs";
import { generateWallet, publicWallet } from "./crypto.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { initializeBlockStore, loadBlockStore, persistBlock } from "./block-store.mjs";
import { createAccountProof } from "./account-proof.mjs";
import { createAssetProof } from "./asset-proof.mjs";
import { createFinalityProof, MAX_FINALITY_PROOFS } from "./light-client.mjs";
import { AccountHistoryIndex } from "./account-history-index.mjs";

const CONFIG_FILE = "genesis.json";
const DEV_KEYS_FILE = "DEVNET-KEYS.json";

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

export function initializeDevnet(directory, { networkId = "nir-local-devnet" } = {}) {
  const root = resolve(directory);
  mkdirSync(root, { mode: 0o700 });
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const genesis = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [referenceCapability()],
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members(validators, "validator"),
  };
  writeExclusive(join(root, CONFIG_FILE), genesis, 0o644);
  writeExclusive(join(root, DEV_KEYS_FILE), { treasury, validators }, 0o600);
  initializeBlockStore(root, new NirChain(genesis));
  return { directory: root, networkId, treasuryAddress: treasury.address };
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
    ({ chain: this.#chain } = loadBlockStore(this.#root, this.#config));
    this.#historyIndex = new AccountHistoryIndex(this.#root, this.#chain);
  }

  get networkId() { return this.#chain.networkId; }
  get height() { return this.#chain.height; }
  get tipHash() { return this.#chain.tipHash; }

  validatorHandoffHistory() { return []; }

  finalityProofsAfter(fromHeight, limit = MAX_FINALITY_PROOFS) {
    if (!Number.isSafeInteger(fromHeight) || fromHeight < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FINALITY_PROOFS) {
      throw new Error("finality proof range is invalid");
    }
    return this.#chain.blocks().filter(({ height }) => height > fromHeight)
      .slice(0, limit).map(createFinalityProof);
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

  feeQuote(amount, fee = MIN_TRANSFER_FEE.toString()) {
    return quoteTransferFee(String(amount), String(fee));
  }

  #commit(transactions) {
    const block = this.#chain.buildBlock({ transactions, timestamp: Date.now() });
    const finalized = finalizeBlock(block, validatorQuorum(block, this.#keys.validators));
    const verified = this.#chain.fork();
    verified.appendBlock(finalized);
    persistBlock(this.#root, finalized, verified);
    this.#historyIndex.appendBlock(finalized, verified);
    this.#chain = verified;
    return { blockHash: finalized.hash, height: finalized.height };
  }

  submitTransaction(transaction) {
    return { ...this.#commit([transaction]), transactionId: transactionId(transaction) };
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
    });
    return { ...this.#commit([transaction]), transactionId: transactionId(transaction) };
  }
}
