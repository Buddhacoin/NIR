import {
  ATOMIC_UNITS,
  MAX_SUPPLY,
  MINING_POOL,
  PROTOCOL_VERSION,
  SIGNATURE_ALGORITHM,
  TREASURY_ALLOCATION,
  scheduledEpochBudget,
} from "./constants.mjs";
import {
  addressFromPublicKey,
  hashObject,
  signObject,
  verifyObject,
} from "./crypto.mjs";

function parseAtomic(value, field) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function assertAddress(address, field) {
  if (typeof address !== "string" || !/^nir1[0-9a-f]{64}$/.test(address)) {
    throw new Error(`${field} is not a canonical NIR address`);
  }
}

function unsignedTransaction(transaction) {
  const { signature: _signature, ...unsigned } = transaction;
  return unsigned;
}

export function createTransfer({ wallet, recipient, amount, nonce, fee = "0" }) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    fee: String(fee),
    nonce,
    publicKey: wallet.publicKey,
    recipient,
    sender: wallet.address,
    type: "transfer",
  };
  return { ...transaction, signature: signObject(transaction, wallet) };
}

export function transactionId(transaction) {
  return hashObject(transaction);
}

function unsignedBlock(block) {
  const { certificate: _certificate, hash: _hash, ...unsigned } = block;
  return unsigned;
}

export function blockHash(block) {
  return hashObject(unsignedBlock(block));
}

export function voteForBlock(block, validatorWallet) {
  const hash = blockHash(block);
  return {
    signature: signObject({ blockHash: hash }, validatorWallet),
    validator: validatorWallet.address,
  };
}

export function finalizeBlock(block, validatorWallets) {
  const certificate = validatorWallets.map((wallet) =>
    voteForBlock(block, wallet),
  );
  return { ...block, hash: blockHash(block), certificate };
}

export function allocateProgressRewards(epoch, claims, remaining = MINING_POOL) {
  if (!Array.isArray(claims) || claims.length === 0) return [];
  const fingerprints = new Set();
  const normalized = claims.map((claim) => {
    if (typeof claim.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(claim.fingerprint)) {
      throw new Error("proof fingerprint must be a 64-character hash");
    }
    if (fingerprints.has(claim.fingerprint)) {
      throw new Error("duplicate proof claim");
    }
    fingerprints.add(claim.fingerprint);
    const score = parseAtomic(String(claim.score), "proof score");
    if (score === 0n) throw new Error("proof score must be positive");
    assertAddress(claim.recipient, "reward recipient");
    return { ...claim, score: score.toString() };
  });

  const budget = [scheduledEpochBudget(epoch), remaining].reduce((a, b) =>
    a < b ? a : b,
  );
  const totalScore = normalized.reduce(
    (total, claim) => total + BigInt(claim.score),
    0n,
  );
  const allocations = normalized.map(
    (claim) => (budget * BigInt(claim.score)) / totalScore,
  );
  let remainder = budget - allocations.reduce((a, b) => a + b, 0n);
  const rank = normalized
    .map((claim, index) => ({ claim, index }))
    .sort((a, b) => {
      const aScore = BigInt(a.claim.score);
      const bScore = BigInt(b.claim.score);
      if (aScore !== bScore) return aScore > bScore ? -1 : 1;
      return a.claim.fingerprint.localeCompare(b.claim.fingerprint);
    });
  for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) {
    allocations[rank[index % rank.length].index] += 1n;
  }
  return normalized
    .map((claim, index) => ({ ...claim, amount: allocations[index].toString() }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export class NirChain {
  constructor({ networkId, validators, treasuryAddress }) {
    if (!networkId || validators.length < 4) {
      throw new Error("network id and at least four validators are required");
    }
    this.networkId = networkId;
    this.validators = new Map();
    for (const validator of validators) {
      if (validator.algorithm !== SIGNATURE_ALGORITHM) {
        throw new Error("all validators must use ML-DSA-65");
      }
      if (addressFromPublicKey(validator.publicKey) !== validator.address) {
        throw new Error("validator address does not match public key");
      }
      if (this.validators.has(validator.address)) {
        throw new Error("validator addresses must be unique");
      }
      this.validators.set(validator.address, validator.publicKey);
    }
    this.validatorOrder = [...this.validators.keys()].sort();
    this.quorum = Math.floor((this.validatorOrder.length * 2) / 3) + 1;
    assertAddress(treasuryAddress, "treasury address");
    this.balances = new Map([[treasuryAddress, TREASURY_ALLOCATION]]);
    this.nonces = new Map();
    this.rewardedProofs = new Set();
    this.mined = 0n;
    this.genesis = {
      balances: { [treasuryAddress]: TREASURY_ALLOCATION.toString() },
      networkId,
      protocolVersion: PROTOCOL_VERSION,
      validators: this.validatorOrder,
    };
    this.blocks = [
      {
        certificate: [],
        hash: hashObject(this.genesis),
        height: 0,
        networkId,
        previousHash: "0".repeat(64),
        progressRewards: [],
        protocolVersion: PROTOCOL_VERSION,
        timestamp: 0,
        transactions: [],
      },
    ];
  }

  get height() {
    return this.blocks.length - 1;
  }

  get issued() {
    return TREASURY_ALLOCATION + this.mined;
  }

  balance(address) {
    return this.balances.get(address) ?? 0n;
  }

  nextNonce(address) {
    return this.nonces.get(address) ?? 0;
  }

  expectedProposer(height) {
    return this.validatorOrder[height % this.validatorOrder.length];
  }

  buildBlock({ transactions = [], rewardClaims = [], timestamp = Date.now() }) {
    const height = this.height + 1;
    const remaining = MINING_POOL - this.mined;
    return {
      height,
      networkId: this.networkId,
      previousHash: this.blocks.at(-1).hash,
      progressRewards: allocateProgressRewards(
        height - 1,
        rewardClaims,
        remaining,
      ),
      proposer: this.expectedProposer(height),
      protocolVersion: PROTOCOL_VERSION,
      timestamp,
      transactions,
    };
  }

  #verifyCertificate(block) {
    if (block.hash !== blockHash(block)) throw new Error("block hash mismatch");
    const voters = new Set();
    for (const vote of block.certificate ?? []) {
      if (voters.has(vote.validator)) throw new Error("duplicate validator vote");
      const publicKey = this.validators.get(vote.validator);
      if (!publicKey) throw new Error("vote from unknown validator");
      if (!verifyObject({ blockHash: block.hash }, vote.signature, publicKey)) {
        throw new Error("invalid validator signature");
      }
      voters.add(vote.validator);
    }
    if (voters.size < this.quorum) throw new Error("finality quorum not reached");
    if (!voters.has(block.proposer)) throw new Error("proposer did not sign block");
  }

  #applyTransfer(transaction, balances, nonces, proposer) {
    if (transaction.type !== "transfer") throw new Error("unknown transaction type");
    if (transaction.algorithm !== SIGNATURE_ALGORITHM) {
      throw new Error("transaction is not post-quantum signed");
    }
    if (addressFromPublicKey(transaction.publicKey) !== transaction.sender) {
      throw new Error("sender address does not match public key");
    }
    assertAddress(transaction.recipient, "transfer recipient");
    if (!verifyObject(
      unsignedTransaction(transaction),
      transaction.signature,
      transaction.publicKey,
    )) {
      throw new Error("invalid transaction signature");
    }
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0) {
      throw new Error("invalid transaction nonce");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    const amount = parseAtomic(transaction.amount, "amount");
    const fee = parseAtomic(transaction.fee, "fee");
    if (amount === 0n) throw new Error("transfer amount must be positive");
    const senderBalance = balances.get(transaction.sender) ?? 0n;
    if (senderBalance < amount + fee) throw new Error("insufficient balance");
    balances.set(transaction.sender, senderBalance - amount - fee);
    balances.set(transaction.recipient, (balances.get(transaction.recipient) ?? 0n) + amount);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
  }

  appendBlock(block) {
    const previous = this.blocks.at(-1);
    if (block.networkId !== this.networkId) throw new Error("wrong network id");
    if (block.protocolVersion !== PROTOCOL_VERSION) throw new Error("wrong protocol version");
    if (block.height !== previous.height + 1) throw new Error("unexpected block height");
    if (block.previousHash !== previous.hash) throw new Error("broken hash chain");
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp < previous.timestamp) {
      throw new Error("invalid block timestamp");
    }
    if (block.proposer !== this.expectedProposer(block.height)) {
      throw new Error("unexpected block proposer");
    }
    this.#verifyCertificate(block);

    const expectedRewards = allocateProgressRewards(
      block.height - 1,
      block.progressRewards.map(({ amount: _amount, ...claim }) => claim),
      MINING_POOL - this.mined,
    );
    if (hashObject(expectedRewards) !== hashObject(block.progressRewards)) {
      throw new Error("invalid progress reward allocation");
    }

    const balances = new Map(this.balances);
    const nonces = new Map(this.nonces);
    const rewardedProofs = new Set(this.rewardedProofs);
    let newlyMined = 0n;
    for (const reward of block.progressRewards) {
      if (rewardedProofs.has(reward.fingerprint)) {
        throw new Error("proof was already rewarded");
      }
      rewardedProofs.add(reward.fingerprint);
      const amount = parseAtomic(reward.amount, "reward amount");
      newlyMined += amount;
      balances.set(reward.recipient, (balances.get(reward.recipient) ?? 0n) + amount);
    }
    if (TREASURY_ALLOCATION + this.mined + newlyMined > MAX_SUPPLY) {
      throw new Error("hard supply cap exceeded");
    }
    for (const transaction of block.transactions) {
      this.#applyTransfer(transaction, balances, nonces, block.proposer);
    }

    this.balances = balances;
    this.nonces = nonces;
    this.rewardedProofs = rewardedProofs;
    this.mined += newlyMined;
    this.blocks.push(block);
    return block.hash;
  }
}

export function formatNir(atomic) {
  const whole = atomic / ATOMIC_UNITS;
  const fraction = (atomic % ATOMIC_UNITS).toString().padStart(8, "0");
  return `${whole}.${fraction} NIR`;
}
