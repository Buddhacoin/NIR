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
  blockHash,
  createTransfer,
  formatNir,
  NirChain,
  quoteTransferFee,
  transactionId,
  voteForBlock,
} from "./chain.mjs";
import {
  ATOMIC_UNITS,
  MAX_TRANSACTIONS_PER_BLOCK,
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
} from "./constants.mjs";
import { canonicalJson, generateWallet, publicWallet } from "./crypto.mjs";
import {
  createPeerRequest,
  createPeerResponse,
  verifyPeerRequest,
  verifyPeerResponse,
} from "./peer-auth.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const MAX_MEMPOOL_TRANSACTIONS = 1_000;

function writeExclusive(path, value, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode,
  });
  chmodSync(path, mode);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function referenceCapability() {
  return {
    artifactHash: `sha256:${"1".repeat(64)}`,
    behaviorCommitment: "2".repeat(64),
    capabilitiesBps: { "reasoning-v1": 1 },
  };
}

function blockFile(directory, height) {
  return join(directory, "blocks", `${String(height).padStart(12, "0")}.json`);
}

function persistBlock(directory, block) {
  const target = blockFile(directory, block.height);
  const temporary = `${target}.tmp`;
  writeExclusive(temporary, block);
  renameSync(temporary, target);
}

function loadChain(directory) {
  const genesis = readJson(join(directory, "genesis.json"));
  const chain = new NirChain(genesis);
  const files = readdirSync(join(directory, "blocks"))
    .filter((name) => /^[0-9]{12}\.json$/.test(name)).sort();
  for (const [index, name] of files.entries()) {
    if (name !== `${String(index + 1).padStart(12, "0")}.json`) {
      throw new Error("persistent block journal is not contiguous");
    }
    chain.appendBlock(readJson(join(directory, "blocks", name)));
  }
  return { chain, genesis };
}

export function initializeDistributedDevnet(
  directory,
  { networkId = "nir-distributed-devnet", firstValidatorPort = 8791 } = {},
) {
  const root = resolve(directory);
  const coordinatorDirectory = join(root, "coordinator");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(coordinatorDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(coordinatorDirectory, "blocks"), { mode: 0o700 });
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const coordinator = generateWallet();
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
  writeExclusive(join(coordinatorDirectory, "genesis.json"), genesis, 0o644);
  writeExclusive(join(coordinatorDirectory, "TREASURY-DEV-KEY.json"), treasury);
  writeExclusive(join(coordinatorDirectory, "COORDINATOR-KEY.json"), coordinator);

  const validatorDirectories = validators.map((wallet, index) => {
    const validatorDirectory = join(root, "validators", `validator-${index}`);
    mkdirSync(join(validatorDirectory, "blocks"), { recursive: true, mode: 0o700 });
    mkdirSync(join(validatorDirectory, "votes"), { mode: 0o700 });
    writeExclusive(join(validatorDirectory, "genesis.json"), genesis, 0o644);
    writeExclusive(join(validatorDirectory, "VALIDATOR-KEY.json"), wallet);
    writeExclusive(join(validatorDirectory, "AUTHORIZED-COORDINATOR.json"), publicWallet(coordinator), 0o644);
    return validatorDirectory;
  });
  const validatorUrls = validators.map((_, index) =>
    `http://127.0.0.1:${firstValidatorPort + index}`);
  writeExclusive(join(root, "network.json"), {
    coordinatorDirectory,
    networkId,
    validatorDirectories,
    validatorUrls,
  }, 0o644);
  return { coordinatorDirectory, directory: root, networkId, validatorDirectories, validatorUrls };
}

export class TransactionMempool {
  #transactions = new Map();

  get size() { return this.#transactions.size; }

  add(transaction) {
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
      throw new Error("transaction must be an object");
    }
    if (Buffer.byteLength(canonicalJson(transaction)) > 64 * 1024) {
      throw new Error("transaction exceeds the mempool size limit");
    }
    const id = transactionId(transaction);
    if (this.#transactions.has(id)) throw new Error("transaction is already in the mempool");
    if (this.#transactions.size >= MAX_MEMPOOL_TRANSACTIONS) throw new Error("mempool is full");
    this.#transactions.set(id, structuredClone(transaction));
    return id;
  }

  take(limit = MAX_TRANSACTIONS_PER_BLOCK) {
    return [...this.#transactions.values()].slice(0, limit).map((transaction) =>
      structuredClone(transaction));
  }

  remove(transactions) {
    for (const transaction of transactions) this.#transactions.delete(transactionId(transaction));
  }
}

function proposalFields(block) {
  return {
    fallbackBeacons: block.fallbackBeacons,
    randomnessCommits: block.randomnessCommits,
    randomnessReveals: block.randomnessReveals,
    rewardClaims: [],
    safetyClaims: [],
    timestamp: block.timestamp,
    transactions: block.transactions,
    validatorRotation: block.validatorRotation,
  };
}

export class ValidatorReplica {
  #chain;
  #directory;
  #wallet;
  #coordinator;
  #seenNonces = new Map();

  constructor(directory) {
    this.#directory = resolve(directory);
    ({ chain: this.#chain } = loadChain(this.#directory));
    this.#wallet = readJson(join(this.#directory, "VALIDATOR-KEY.json"));
    this.#coordinator = readJson(join(this.#directory, "AUTHORIZED-COORDINATOR.json"));
    const member = readJson(join(this.#directory, "genesis.json")).validators
      .find(({ address }) => address === this.#wallet.address);
    if (!member || member.publicKey !== this.#wallet.publicKey) {
      throw new Error("validator key does not belong to this network");
    }
  }

  get address() { return this.#wallet.address; }
  get height() { return this.#chain.height; }
  get networkId() { return this.#chain.networkId; }
  get tipHash() { return this.#chain.tipHash; }

  authorize(auth, method, path, body) {
    return verifyPeerRequest({
      auth, body, method, networkId: this.networkId, path,
      seenNonces: this.#seenNonces, trustedPeer: this.#coordinator,
    });
  }

  authenticateResponse(requestNonce, result) {
    return createPeerResponse({ networkId: this.networkId, requestNonce, result, wallet: this.#wallet });
  }

  vote(block) {
    if (block.networkId !== this.networkId || block.height !== this.height + 1 ||
        block.previousHash !== this.tipHash || block.proposer !== this.#chain.expectedProposer(block.height)) {
      throw new Error("proposal does not extend the validator state");
    }
    const rebuilt = this.#chain.buildBlock(proposalFields(block));
    if (canonicalJson(rebuilt) !== canonicalJson(block)) {
      throw new Error("proposal is not the deterministic block for this state");
    }
    this.#chain.validateProposal(block);
    const hash = blockHash(block);
    const decisionPath = join(this.#directory, "votes", `${String(block.height).padStart(12, "0")}.json`);
    try {
      const decision = readJson(decisionPath);
      if (decision.blockHash !== hash) throw new Error("validator refuses to equivocate at this height");
      return decision.vote;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const vote = voteForBlock(block, this.#wallet);
    writeExclusive(decisionPath, { blockHash: hash, vote });
    return vote;
  }

  commit(block) {
    if (block.height <= this.height) {
      const existing = this.#chain.blocks().find(({ height }) => height === block.height);
      if (existing?.hash === block.hash) return { height: this.height, status: "known" };
      throw new Error("committed block conflicts with validator state");
    }
    this.#chain.appendBlock(block);
    persistBlock(this.#directory, block);
    return { height: this.height, status: "committed" };
  }
}

async function peerStatus(url) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `validator returned ${response.status}`);
  return body;
}

async function peerRequest(url, path, value, { networkId, peer, wallet }) {
  const auth = createPeerRequest({ body: value, networkId, path, wallet });
  const response = await fetch(`${url}${path}`, {
    body: JSON.stringify({ auth, payload: value }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `validator returned ${response.status}`);
  return verifyPeerResponse({
    auth: body.auth, networkId, requestNonce: auth.nonce, result: body.result, trustedPeer: peer,
  });
}

export class DistributedCoordinator {
  #chain;
  #directory;
  #mempool = new TransactionMempool();
  #peers;
  #treasury;
  #wallet;
  #validators;

  constructor(directory, validatorUrls) {
    this.#directory = resolve(directory);
    ({ chain: this.#chain } = loadChain(this.#directory));
    this.#treasury = readJson(join(this.#directory, "TREASURY-DEV-KEY.json"));
    this.#wallet = readJson(join(this.#directory, "COORDINATOR-KEY.json"));
    if (!Array.isArray(validatorUrls) || validatorUrls.length < 4) {
      throw new Error("four validator peer URLs are required");
    }
    this.#peers = [...validatorUrls];
    this.#validators = readJson(join(this.#directory, "genesis.json")).validators;
  }

  get consensusMode() { return "remote-validator-quorum"; }
  get height() { return this.#chain.height; }
  get mempoolSize() { return this.#mempool.size; }
  get networkId() { return this.#chain.networkId; }
  get tipHash() { return this.#chain.tipHash; }

  account(address) {
    if (!ADDRESS.test(address)) throw new Error("address is invalid");
    const transactions = this.#chain.blocks().flatMap((block) => block.transactions)
      .filter((transaction) => transaction.sender === address || transaction.recipient === address)
      .map((transaction) => ({ ...transaction, id: transactionId(transaction) }));
    const balance = this.#chain.balance(address);
    return { address, atomicBalance: balance.toString(), balance: formatNir(balance),
      nextNonce: this.#chain.nextNonce(address), transactions };
  }

  feeQuote(amount, fee = MIN_TRANSFER_FEE.toString()) {
    return quoteTransferFee(String(amount), String(fee));
  }

  submitTransaction(transaction) {
    const id = this.#mempool.add(transaction);
    try {
      const proposal = this.#chain.buildBlock({
        transactions: this.#mempool.take(), timestamp: Date.now(),
      });
      this.#chain.validateProposal(proposal);
    } catch (error) {
      this.#mempool.remove([transaction]);
      throw error;
    }
    return { status: "queued", transactionId: id };
  }

  async #request(index, path, value) {
    return peerRequest(this.#peers[index], path, value, {
      networkId: this.networkId, peer: this.#validators[index], wallet: this.#wallet,
    });
  }

  async #synchronizePeer(index) {
    const status = await peerStatus(this.#peers[index]);
    const expected = this.#validators[index];
    if (status.address !== expected.address || status.networkId !== this.networkId) {
      throw new Error("validator health identity does not match the configured peer");
    }
    if (!Number.isSafeInteger(status.height) || status.height < 0 || status.height > this.height) {
      throw new Error("validator height is incompatible with coordinator state");
    }
    if (status.height === this.height) {
      if (status.tipHash !== this.tipHash) throw new Error("validator tip conflicts with coordinator state");
      return 0;
    }
    const missing = this.#chain.blocks().filter(({ height }) => height > status.height);
    for (const block of missing) await this.#request(index, "/v1/blocks", block);
    return missing.length;
  }

  async produceBlock() {
    const transactions = this.#mempool.take();
    if (transactions.length === 0) throw new Error("mempool is empty");
    const proposal = this.#chain.buildBlock({ transactions, timestamp: Date.now() });
    const syncResults = await Promise.allSettled(this.#peers.map((_, index) =>
      this.#synchronizePeer(index)));
    const available = syncResults.map((result, index) => result.status === "fulfilled" ? index : -1)
      .filter((index) => index >= 0);
    const results = await Promise.allSettled(available.map((index) =>
      this.#request(index, "/v1/proposals", proposal)));
    const votes = results.filter(({ status }) => status === "fulfilled").map(({ value }) => value.vote);
    const uniqueVotes = new Map(votes.map((vote) => [vote.validator, vote]));
    const quorum = Math.floor((this.#peers.length * 2) / 3) + 1;
    if (uniqueVotes.size < quorum || !uniqueVotes.has(proposal.proposer)) {
      throw new Error(`remote finality quorum not reached (${uniqueVotes.size}/${quorum})`);
    }
    const block = { ...proposal, hash: blockHash(proposal), certificate: [...uniqueVotes.values()] };
    this.#chain.appendBlock(block);
    persistBlock(this.#directory, block);
    this.#mempool.remove(transactions);
    const commits = await Promise.allSettled(this.#peers.map((_, index) =>
      this.#request(index, "/v1/blocks", block)));
    return {
      blockHash: block.hash,
      committedPeers: commits.filter(({ status }) => status === "fulfilled").length,
      height: block.height,
      transactions: transactions.map(transactionId),
      votes: uniqueVotes.size,
      synchronizedPeers: syncResults.filter(({ status, value }) => status === "fulfilled" && value > 0).length,
    };
  }

  async faucet(recipient, amount = (10n * ATOMIC_UNITS).toString()) {
    const atomic = BigInt(amount);
    if (!ADDRESS.test(recipient) || atomic <= 0n || atomic > 10n * ATOMIC_UNITS) {
      throw new Error("invalid devnet faucet request");
    }
    if (this.account(recipient).transactions.length > 0) {
      throw new Error("devnet faucet is limited to one request per fresh address");
    }
    const transaction = createTransfer({
      wallet: this.#treasury, networkId: this.networkId, recipient,
      amount: atomic.toString(), nonce: this.#chain.nextNonce(this.#treasury.address),
    });
    const queued = this.submitTransaction(transaction);
    return { ...queued, ...(await this.produceBlock()) };
  }
}
