import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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

const CONFIG_FILE = "genesis.json";
const DEV_KEYS_FILE = "DEVNET-KEYS.json";
const BLOCKS_DIRECTORY = "blocks";

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
  mkdirSync(join(root, BLOCKS_DIRECTORY), { mode: 0o700 });
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
  return { directory: root, networkId, treasuryAddress: treasury.address };
}

function blockPath(root, height) {
  return join(root, BLOCKS_DIRECTORY, `${String(height).padStart(12, "0")}.json`);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validatorQuorum(block, wallets) {
  const proposer = wallets.find(({ address }) => address === block.proposer);
  if (!proposer) throw new Error("devnet does not hold the active proposer key");
  return [proposer, ...wallets.filter((wallet) => wallet !== proposer).slice(0, 2)];
}

export class PersistentDevNode {
  #chain;
  #config;
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
    this.#chain = new NirChain(this.#config);
    const files = readdirSync(join(this.#root, BLOCKS_DIRECTORY))
      .filter((name) => /^[0-9]{12}\.json$/.test(name)).sort();
    for (const [index, name] of files.entries()) {
      const expectedHeight = index + 1;
      if (name !== `${String(expectedHeight).padStart(12, "0")}.json`) {
        throw new Error("persistent block journal is not contiguous");
      }
      this.#chain.appendBlock(loadJson(join(this.#root, BLOCKS_DIRECTORY, name)));
    }
  }

  get networkId() { return this.#chain.networkId; }
  get height() { return this.#chain.height; }
  get tipHash() { return this.#chain.tipHash; }

  account(address) {
    const transactions = this.#chain.blocks().flatMap((block) => block.transactions)
      .filter((transaction) => transaction.sender === address || transaction.recipient === address)
      .map((transaction) => ({
        amount: transaction.amount,
        fee: transaction.fee,
        id: transactionId(transaction),
        nonce: transaction.nonce,
        recipient: transaction.recipient,
        sender: transaction.sender,
        type: transaction.type,
      }));
    const balance = this.#chain.balance(address);
    return {
      address,
      atomicBalance: balance.toString(),
      balance: formatNir(balance),
      nextNonce: this.#chain.nextNonce(address),
      transactions,
    };
  }

  feeQuote(amount, fee = MIN_TRANSFER_FEE.toString()) {
    return quoteTransferFee(String(amount), String(fee));
  }

  #commit(transactions) {
    const block = this.#chain.buildBlock({ transactions, timestamp: Date.now() });
    const finalized = finalizeBlock(block, validatorQuorum(block, this.#keys.validators));
    this.#chain.appendBlock(finalized);
    const target = blockPath(this.#root, finalized.height);
    const temporary = `${target}.tmp`;
    writeExclusive(temporary, finalized);
    renameSync(temporary, target);
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
    if (this.account(recipient).transactions.length > 0) {
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
