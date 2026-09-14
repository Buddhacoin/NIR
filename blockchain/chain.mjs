import {
  ATOMIC_UNITS,
  MAX_BLOCK_BYTES,
  MAX_DECIMAL_DIGITS,
  MAX_FUTURE_DRIFT_MS,
  MAX_MULTISIG_MEMBERS,
  MIN_TRANSFER_FEE,
  MIN_REWARD_INTERVAL_MS,
  MAX_PROGRESS_REWARDS_PER_BLOCK,
  MAX_SAFETY_SETTLEMENTS_PER_BLOCK,
  MAX_SUPPLY,
  MAX_TRANSACTIONS_PER_BLOCK,
  MAX_VALIDATORS,
  MINING_POOL,
  MULTISIG_ALGORITHM,
  PROTOCOL_VERSION,
  SIGNATURE_ALGORITHM,
  TREASURY_ALLOCATION,
  scheduledEpochBudget,
  vestedTreasuryAtTimestamp,
} from "./constants.mjs";
import {
  addressFromPublicKey,
  canonicalJson,
  hashObject,
  signObject,
  verifyObject,
} from "./crypto.mjs";
import { CapabilityMemory } from "./memory.mjs";
import {
  combineRandomnessReveals,
  randomnessCommitment,
  selectOperatorCommittee,
} from "./operators.mjs";
import {
  calculateSafetySettlement,
  safetyFailurePayload,
} from "./safety-bounty.mjs";

function parseAtomic(value, field) {
  if (
    typeof value !== "string" ||
    value.length > MAX_DECIMAL_DIGITS ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(`${field} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function assertAddress(address, field) {
  if (typeof address !== "string" || !/^nir1[0-9a-f]{64}$/.test(address)) {
    throw new Error(`${field} is not a canonical NIR address`);
  }
}

function operatorRegistry(entries, role) {
  if (
    !Array.isArray(entries) ||
    entries.length < 4 ||
    entries.length > MAX_VALIDATORS
  ) {
    throw new Error(`${role} registry requires four to ${MAX_VALIDATORS} members`);
  }
  const registry = new Map();
  const operatorIds = new Set();
  for (const member of entries) {
    if (member.algorithm !== SIGNATURE_ALGORITHM) {
      throw new Error(`all ${role} members must use ML-DSA-65`);
    }
    if (
      typeof member.publicKey !== "string" ||
      member.publicKey.length > 4_000 ||
      typeof member.operatorId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(member.operatorId)
    ) {
      throw new Error(`${role} member key or operator id is invalid`);
    }
    if (addressFromPublicKey(member.publicKey) !== member.address) {
      throw new Error(`${role} member address does not match public key`);
    }
    if (registry.has(member.address) || operatorIds.has(member.operatorId)) {
      throw new Error(`${role} member addresses and operators must be unique`);
    }
    registry.set(member.address, {
      address: member.address,
      operatorId: member.operatorId,
      publicKey: member.publicKey,
    });
    operatorIds.add(member.operatorId);
  }
  return registry;
}

function unsignedTransaction(transaction) {
  const { signature: _signature, signatures: _signatures, ...unsigned } = transaction;
  return unsigned;
}

function multisigDescriptor(memberPublicKeys, threshold) {
  if (
    !Array.isArray(memberPublicKeys) || memberPublicKeys.length < 2 ||
    memberPublicKeys.length > MAX_MULTISIG_MEMBERS ||
    !Number.isSafeInteger(threshold) || threshold < 2 || threshold > memberPublicKeys.length ||
    memberPublicKeys.some((key) => typeof key !== "string" || key.length > 4_000) ||
    new Set(memberPublicKeys).size !== memberPublicKeys.length
  ) throw new Error("multisignature descriptor is invalid");
  return {
    algorithm: SIGNATURE_ALGORITHM,
    memberPublicKeys: [...memberPublicKeys].sort(),
    threshold,
  };
}

export function multisigAddress(memberPublicKeys, threshold) {
  return `nir1${hashObject(multisigDescriptor(memberPublicKeys, threshold), "MULTISIG_ADDRESS")}`;
}

export function createTransfer({
  wallet,
  networkId,
  recipient,
  amount,
  nonce,
  fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    fee: String(fee),
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    recipient,
    sender: wallet.address,
    type: "transfer",
  };
  return {
    ...transaction,
    signature: signObject(transaction, wallet, "TRANSFER"),
  };
}

export function createCandidateBond({
  wallet,
  networkId,
  candidateId,
  amount,
  nonce,
  fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    candidateId,
    fee: String(fee),
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    sender: wallet.address,
    type: "candidate-bond",
  };
  return {
    ...transaction,
    signature: signObject(transaction, wallet, "CANDIDATE_BOND"),
  };
}

export function createMultisigTransfer({
  signerWallets,
  memberPublicKeys,
  threshold,
  networkId,
  recipient,
  amount,
  nonce,
  fee = MIN_TRANSFER_FEE.toString(),
}) {
  const descriptor = multisigDescriptor(memberPublicKeys, threshold);
  const transaction = {
    algorithm: MULTISIG_ALGORITHM,
    amount: String(amount),
    fee: String(fee),
    memberPublicKeys: descriptor.memberPublicKeys,
    networkId,
    nonce,
    recipient,
    sender: multisigAddress(descriptor.memberPublicKeys, threshold),
    threshold,
    type: "transfer",
  };
  const allowed = new Set(descriptor.memberPublicKeys);
  const seen = new Set();
  const signatures = [];
  for (const wallet of signerWallets ?? []) {
    if (!allowed.has(wallet.publicKey) || seen.has(wallet.publicKey)) {
      throw new Error("multisignature signer is unknown or duplicated");
    }
    seen.add(wallet.publicKey);
    signatures.push({
      publicKey: wallet.publicKey,
      signature: signObject(transaction, wallet, "TRANSFER"),
    });
  }
  return { ...transaction, signatures };
}

export function transactionId(transaction) {
  return hashObject(transaction, "TRANSACTION_ID");
}

function assertMetric(value, field, minimum = 0, maximum = 10_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} is outside protocol limits`);
  }
}

export function progressFingerprint(evaluation) {
  return hashObject(
    {
      artifactHash: evaluation.artifactHash,
      baselineHash: evaluation.baselineHash,
      suiteCommitment: evaluation.suiteCommitment,
    },
    "PROGRESS_FINGERPRINT",
  );
}

export function computeProgressScore(evaluation) {
  if (
    typeof evaluation !== "object" ||
    evaluation === null ||
    !/^sha256:[0-9a-f]{64}$/.test(evaluation.artifactHash ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(evaluation.baselineHash ?? "") ||
    !/^[0-9a-f]{64}$/.test(evaluation.suiteCommitment ?? "")
  ) {
    throw new Error("evaluation commitments are invalid");
  }
  if (evaluation.artifactHash === evaluation.baselineHash) {
    throw new Error("candidate artifact must differ from baseline");
  }
  assertMetric(evaluation.gainPpm, "gain", 1, 1_000_000);
  assertMetric(evaluation.generalityBps, "generality");
  assertMetric(evaluation.reproducibilityBps, "reproducibility", 6_667);
  assertMetric(evaluation.safetyBps, "safety", 8_000);
  if (
    evaluation.criticalSafetyPass !== true ||
    !/^[0-9a-f]{64}$/.test(evaluation.safetyPolicyHash ?? "")
  ) {
    throw new Error("critical safety clearance is missing or invalid");
  }
  assertMetric(evaluation.noveltyBps, "novelty");
  if (
    !Number.isSafeInteger(evaluation.candidateEnergyWh) ||
    !Number.isSafeInteger(evaluation.baselineEnergyWh) ||
    evaluation.candidateEnergyWh <= 0 ||
    evaluation.baselineEnergyWh <= 0 ||
    evaluation.energyAttested !== true
  ) {
    throw new Error("evaluation energy must be positive and attested");
  }
  let quality = BigInt(evaluation.gainPpm);
  for (const factor of [
    evaluation.generalityBps,
    evaluation.reproducibilityBps,
    evaluation.safetyBps,
    evaluation.noveltyBps,
  ]) {
    quality = (quality * BigInt(factor)) / 10_000n;
  }
  const rawEfficiency =
    (BigInt(evaluation.baselineEnergyWh) * 10_000n) /
    BigInt(evaluation.candidateEnergyWh);
  const efficiency = rawEfficiency < 5_000n
    ? 5_000n
    : rawEfficiency > 20_000n
      ? 20_000n
      : rawEfficiency;
  const score = (quality * efficiency) / 10_000n;
  if (score <= 0n) throw new Error("evaluation produces no rewardable progress");
  return score.toString();
}

function progressReceiptPayload({ networkId, epoch, recipient, evaluation }) {
  return {
    epoch,
    evaluation,
    fingerprint: progressFingerprint(evaluation),
    networkId,
    recipient,
    score: computeProgressScore(evaluation),
  };
}

export function createProgressClaim({
  networkId,
  epoch,
  recipient,
  evaluation,
  evaluatorWallets,
}) {
  assertAddress(recipient, "reward recipient");
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("evaluation epoch is invalid");
  }
  if (!Array.isArray(evaluatorWallets)) {
    throw new Error("evaluator wallets are required");
  }
  const payload = progressReceiptPayload({
    networkId,
    epoch,
    recipient,
    evaluation: structuredClone(evaluation),
  });
  return {
    ...payload,
    attestations: evaluatorWallets.map((wallet) => ({
      evaluator: wallet.address,
      signature: signObject(payload, wallet, "PROGRESS_RECEIPT"),
    })),
  };
}

function unsignedBlock(block) {
  const { certificate: _certificate, hash: _hash, ...unsigned } = block;
  return unsigned;
}

export function blockHash(block) {
  return hashObject(unsignedBlock(block), "BLOCK");
}

export function voteForBlock(block, validatorWallet) {
  const hash = blockHash(block);
  return {
    signature: signObject({ blockHash: hash }, validatorWallet, "BLOCK_VOTE"),
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
  if (claims.length > MAX_PROGRESS_REWARDS_PER_BLOCK) {
    throw new Error("too many progress rewards in one block");
  }
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
  if (budget === 0n) throw new Error("no mining budget remains for this epoch");
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
  #balances;
  #blocks;
  #burned;
  #candidateBonds;
  #capabilityMemory;
  #evaluationQuorum;
  #evaluatorOrder;
  #evaluators;
  #mined;
  #lastRewardTimestamp;
  #networkId;
  #nonces;
  #quorum;
  #rewardEpoch;
  #rewardedProofs;
  #safetyEvidence;
  #safetyPolicies;
  #treasuryAddress;
  #genesisTimestamp;
  #validatorOrder;
  #validators;

  constructor({
    networkId,
    validators,
    evaluators,
    treasuryAddress,
    capabilityReferences,
    safetyPolicyCommitments,
    genesisTimestamp = Date.now(),
  }) {
    if (
      typeof networkId !== "string" ||
      networkId.length === 0 ||
      Buffer.byteLength(networkId) > 64 ||
      !Array.isArray(validators)
    ) {
      throw new Error("network id and validator registry are required");
    }
    if (
      !Number.isSafeInteger(genesisTimestamp) ||
      genesisTimestamp < 0 ||
      genesisTimestamp > Date.now() + MAX_FUTURE_DRIFT_MS
    ) {
      throw new Error("invalid genesis timestamp");
    }
    this.#networkId = networkId;
    this.#genesisTimestamp = genesisTimestamp;
    this.#treasuryAddress = treasuryAddress;
    this.#validators = operatorRegistry(validators, "validator");
    this.#evaluators = operatorRegistry(evaluators, "evaluator");
    const validatorOperators = new Set(
      [...this.#validators.values()].map(({ operatorId }) => operatorId),
    );
    if (
      [...this.#evaluators.entries()].some(([address, { operatorId }]) =>
        this.#validators.has(address) || validatorOperators.has(operatorId),
      )
    ) {
      throw new Error("consensus and evaluation keys and operators must be disjoint");
    }
    this.#validatorOrder = [...this.#validators.keys()].sort();
    this.#quorum = Math.floor((this.#validatorOrder.length * 2) / 3) + 1;
    this.#evaluatorOrder = [...this.#evaluators.keys()].sort();
    this.#evaluationQuorum = Math.floor((this.#evaluatorOrder.length * 2) / 3) + 1;
    assertAddress(treasuryAddress, "treasury address");
    this.#balances = new Map([[treasuryAddress, TREASURY_ALLOCATION]]);
    this.#burned = 0n;
    this.#candidateBonds = new Map();
    this.#nonces = new Map();
    this.#rewardedProofs = new Set();
    this.#safetyEvidence = new Set();
    this.#rewardEpoch = 0;
    this.#lastRewardTimestamp = genesisTimestamp - MIN_REWARD_INTERVAL_MS;
    this.#mined = 0n;
    this.#capabilityMemory = new CapabilityMemory(capabilityReferences);
    if (
      !Array.isArray(safetyPolicyCommitments) ||
      safetyPolicyCommitments.length === 0 ||
      safetyPolicyCommitments.length > 32 ||
      safetyPolicyCommitments.some(
        (commitment) => !/^[0-9a-f]{64}$/.test(commitment),
      ) ||
      new Set(safetyPolicyCommitments).size !== safetyPolicyCommitments.length
    ) {
      throw new Error("genesis safety policies are invalid");
    }
    this.#safetyPolicies = new Set(safetyPolicyCommitments);
    const genesis = {
      balances: { [treasuryAddress]: TREASURY_ALLOCATION.toString() },
      capabilityMemoryRoot: this.#capabilityMemory.stateRoot,
      evaluators: this.#evaluatorOrder.map((address) => ({
        address,
        operatorId: this.#evaluators.get(address).operatorId,
      })),
      genesisTimestamp,
      networkId,
      protocolVersion: PROTOCOL_VERSION,
      safetyPolicyCommitments: [...this.#safetyPolicies].sort(),
      validators: this.#validatorOrder.map((address) => ({
        address,
        operatorId: this.#validators.get(address).operatorId,
      })),
    };
    this.#blocks = [
      {
        capabilityMemoryRoot: this.#capabilityMemory.stateRoot,
        certificate: [],
        hash: hashObject(genesis, "GENESIS"),
        height: 0,
        networkId,
        previousHash: "0".repeat(64),
        progressRewards: [],
        safetySettlements: [],
        protocolVersion: PROTOCOL_VERSION,
        timestamp: genesisTimestamp,
        transactions: [],
      },
    ];
  }

  get height() {
    return this.#blocks.length - 1;
  }

  get issued() {
    return TREASURY_ALLOCATION + this.#mined;
  }

  get burned() {
    return this.#burned;
  }

  get circulatingSupply() {
    return this.issued - this.#burned;
  }

  balance(address) {
    return this.#balances.get(address) ?? 0n;
  }

  nextNonce(address) {
    return this.#nonces.get(address) ?? 0;
  }

  get tipHash() {
    return this.#blocks.at(-1).hash;
  }

  get networkId() {
    return this.#networkId;
  }

  get capabilityMemoryRoot() {
    return this.#capabilityMemory.stateRoot;
  }

  get nextIssuanceEpoch() {
    return this.#rewardEpoch;
  }

  assignedSafetyEvaluators(candidateId) {
    const candidate = this.#candidateBonds.get(candidateId);
    if (!candidate?.committee) throw new Error("candidate safety committee is not assigned");
    return [...candidate.committee];
  }

  prepareProgressEvaluation(evaluation) {
    const report = this.#capabilityMemory.assess(evaluation);
    return {
      ...structuredClone(evaluation),
      frontierRootBefore: report.frontierRootBefore,
      frontierRootAfter: report.frontierRootAfter,
      noveltyBps: report.noveltyBps,
    };
  }

  expectedProposer(height) {
    return this.#validatorOrder[height % this.#validatorOrder.length];
  }

  #verifyProgressClaim(claim, epoch, capabilityMemory) {
    if (claim.networkId !== this.#networkId || claim.epoch !== epoch) {
      throw new Error("progress receipt belongs to another network or epoch");
    }
    if (claim.evaluation.challengeEpoch !== epoch) {
      throw new Error("progress challenge belongs to another epoch");
    }
    if (!this.#safetyPolicies.has(claim.evaluation.safetyPolicyHash)) {
      throw new Error("progress evaluation uses an unapproved safety policy");
    }
    assertAddress(claim.recipient, "reward recipient");
    const novelty = capabilityMemory.assess(claim.evaluation);
    if (
      claim.evaluation.frontierRootBefore !== novelty.frontierRootBefore ||
      claim.evaluation.frontierRootAfter !== novelty.frontierRootAfter ||
      claim.evaluation.noveltyBps !== novelty.noveltyBps
    ) {
      throw new Error("progress claim uses an invalid world frontier transition");
    }
    const payload = progressReceiptPayload({
      networkId: claim.networkId,
      epoch: claim.epoch,
      recipient: claim.recipient,
      evaluation: claim.evaluation,
    });
    if (claim.fingerprint !== payload.fingerprint || claim.score !== payload.score) {
      throw new Error("progress claim does not match its evaluation");
    }
    if (
      !Array.isArray(claim.attestations) ||
      claim.attestations.length > this.#evaluators.size
    ) {
      throw new Error("invalid progress attestation count");
    }
    const evaluators = new Set();
    for (const attestation of claim.attestations) {
      if (evaluators.has(attestation.evaluator)) {
        throw new Error("duplicate progress evaluator");
      }
      const evaluator = this.#evaluators.get(attestation.evaluator);
      if (
        !evaluator ||
        typeof attestation.signature !== "string" ||
        attestation.signature.length > 7_000 ||
        !verifyObject(
          payload,
          attestation.signature,
          evaluator.publicKey,
          "PROGRESS_RECEIPT",
        )
      ) {
        throw new Error("invalid progress evaluator signature");
      }
      evaluators.add(attestation.evaluator);
    }
    if (evaluators.size < this.#evaluationQuorum) {
      throw new Error("progress evaluation quorum not reached");
    }
    capabilityMemory.accept(claim.evaluation);
  }

  #verifySafetyClaim(claim, epoch, candidateBonds, safetyEvidence) {
    const payload = safetyFailurePayload({
      networkId: claim.networkId,
      epoch: claim.epoch,
      candidateId: claim.candidateId,
      evidenceHash: claim.evidenceHash,
      reporter: claim.reporter,
      safetyPolicyHash: claim.safetyPolicyHash,
    });
    if (payload.networkId !== this.#networkId || payload.epoch !== epoch) {
      throw new Error("safety receipt belongs to another network or epoch");
    }
    if (!this.#safetyPolicies.has(payload.safetyPolicyHash)) {
      throw new Error("safety failure uses an unapproved safety policy");
    }
    if (safetyEvidence.has(payload.evidenceHash)) throw new Error("safety evidence was already settled");
    const candidate = candidateBonds.get(payload.candidateId);
    if (!candidate) throw new Error("safety claim has no locked candidate bond");
    if (!Array.isArray(candidate.committee)) {
      throw new Error("candidate safety committee is not assigned yet");
    }
    if (!Array.isArray(claim.attestations) || claim.attestations.length > this.#evaluators.size) {
      throw new Error("invalid safety attestation count");
    }
    const evaluators = new Set();
    for (const attestation of claim.attestations) {
      if (evaluators.has(attestation.evaluator)) throw new Error("duplicate safety evaluator");
      const evaluator = this.#evaluators.get(attestation.evaluator);
      if (
        !evaluator || typeof attestation.signature !== "string" || attestation.signature.length > 7_000 ||
        !verifyObject(payload, attestation.signature, evaluator.publicKey, "SAFETY_FAILURE_RECEIPT")
      ) throw new Error("invalid safety evaluator signature");
      evaluators.add(attestation.evaluator);
    }
    if (evaluators.size < this.#evaluationQuorum) throw new Error("safety evaluation quorum not reached");
    const assigned = [...candidate.committee].sort();
    const signed = [...evaluators].sort();
    if (
      signed.length !== assigned.length ||
      signed.some((address, index) => address !== assigned[index])
    ) throw new Error("safety receipt was not signed by the assigned committee");
    const settlement = calculateSafetySettlement({
      candidate,
      candidateId: payload.candidateId,
      evidenceHash: payload.evidenceHash,
      evaluatorAddresses: [...evaluators],
      reporter: payload.reporter,
    });
    candidateBonds.delete(payload.candidateId);
    safetyEvidence.add(payload.evidenceHash);
    return settlement;
  }

  buildBlock({
    transactions = [], rewardClaims = [], safetyClaims = [],
    randomnessCommits = [], randomnessReveals = [], timestamp = Date.now(),
  }) {
    const height = this.height + 1;
    const remaining = MINING_POOL - this.#mined;
    const progressRewards = allocateProgressRewards(
      this.#rewardEpoch,
      rewardClaims,
      remaining,
    );
    if (
      progressRewards.length > 0 &&
      timestamp < this.#lastRewardTimestamp + MIN_REWARD_INTERVAL_MS
    ) {
      throw new Error("intelligence rewards are being issued too quickly");
    }
    const stagedMemory = this.#capabilityMemory.clone();
    for (const claim of progressRewards) {
      this.#verifyProgressClaim(claim, height, stagedMemory);
    }
    if (!Array.isArray(safetyClaims) || safetyClaims.length > MAX_SAFETY_SETTLEMENTS_PER_BLOCK) {
      throw new Error("too many safety settlements in one block");
    }
    const stagedBonds = new Map(this.#candidateBonds);
    const stagedEvidence = new Set(this.#safetyEvidence);
    const safetySettlements = safetyClaims.map((claim) => ({
      ...structuredClone(claim),
      settlement: this.#verifySafetyClaim(claim, height, stagedBonds, stagedEvidence),
    }));
    return {
      capabilityMemoryRoot: stagedMemory.stateRoot,
      height,
      networkId: this.#networkId,
      previousHash: this.#blocks.at(-1).hash,
      progressRewards,
      randomnessCommits,
      randomnessReveals,
      safetySettlements,
      issuanceEpoch: progressRewards.length > 0 ? this.#rewardEpoch : null,
      proposer: this.expectedProposer(height),
      protocolVersion: PROTOCOL_VERSION,
      timestamp,
      transactions,
    };
  }

  #verifyCertificate(block) {
    if (block.hash !== blockHash(block)) throw new Error("block hash mismatch");
    if (
      !Array.isArray(block.certificate) ||
      block.certificate.length > this.#validators.size
    ) {
      throw new Error("invalid finality certificate size");
    }
    const voters = new Set();
    for (const vote of block.certificate ?? []) {
      if (voters.has(vote.validator)) throw new Error("duplicate validator vote");
      const validator = this.#validators.get(vote.validator);
      if (!validator) throw new Error("vote from unknown validator");
      if (
        typeof vote.signature !== "string" ||
        vote.signature.length > 7_000 ||
        !verifyObject(
          { blockHash: block.hash },
          vote.signature,
          validator.publicKey,
          "BLOCK_VOTE",
        )
      ) {
        throw new Error("invalid validator signature");
      }
      voters.add(vote.validator);
    }
    if (voters.size < this.#quorum) throw new Error("finality quorum not reached");
    if (!voters.has(block.proposer)) throw new Error("proposer did not sign block");
  }

  #applyTransfer(transaction, balances, nonces, proposer, timestamp) {
    if (transaction.type !== "transfer") throw new Error("unknown transaction type");
    if (![SIGNATURE_ALGORITHM, MULTISIG_ALGORITHM].includes(transaction.algorithm)) {
      throw new Error("transaction is not post-quantum signed");
    }
    if (transaction.networkId !== this.#networkId) {
      throw new Error("transaction belongs to another network");
    }
    assertAddress(transaction.recipient, "transfer recipient");
    const unsigned = unsignedTransaction(transaction);
    if (transaction.algorithm === SIGNATURE_ALGORITHM) {
      if (
        typeof transaction.publicKey !== "string" || transaction.publicKey.length > 4_000 ||
        typeof transaction.signature !== "string" || transaction.signature.length > 7_000
      ) throw new Error("transaction cryptographic material exceeds limits");
      if (addressFromPublicKey(transaction.publicKey) !== transaction.sender) {
        throw new Error("sender address does not match public key");
      }
      if (!verifyObject(unsigned, transaction.signature, transaction.publicKey, "TRANSFER")) {
        throw new Error("invalid transaction signature");
      }
    } else {
      const descriptor = multisigDescriptor(transaction.memberPublicKeys, transaction.threshold);
      if (multisigAddress(descriptor.memberPublicKeys, descriptor.threshold) !== transaction.sender) {
        throw new Error("sender address does not match multisignature descriptor");
      }
      if (!Array.isArray(transaction.signatures) || transaction.signatures.length > descriptor.memberPublicKeys.length) {
        throw new Error("multisignature collection is invalid");
      }
      const allowed = new Set(descriptor.memberPublicKeys);
      const signers = new Set();
      for (const approval of transaction.signatures) {
        if (
          !allowed.has(approval.publicKey) || signers.has(approval.publicKey) ||
          typeof approval.signature !== "string" || approval.signature.length > 7_000 ||
          !verifyObject(unsigned, approval.signature, approval.publicKey, "TRANSFER")
        ) throw new Error("invalid multisignature approval");
        signers.add(approval.publicKey);
      }
      if (signers.size < descriptor.threshold) throw new Error("multisignature threshold not reached");
    }
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0) {
      throw new Error("invalid transaction nonce");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    const amount = parseAtomic(transaction.amount, "amount");
    const fee = parseAtomic(transaction.fee, "fee");
    if (amount === 0n) throw new Error("transfer amount must be positive");
    if (fee < MIN_TRANSFER_FEE) {
      throw new Error("transfer fee is below the protocol minimum");
    }
    const senderBalance = balances.get(transaction.sender) ?? 0n;
    if (senderBalance < amount + fee) throw new Error("insufficient balance");
    if (transaction.sender === this.#treasuryAddress) {
      const locked = TREASURY_ALLOCATION - vestedTreasuryAtTimestamp(
        this.#genesisTimestamp,
        timestamp,
      );
      if (senderBalance - amount - fee < locked) {
        throw new Error("treasury funds are still vesting");
      }
    }
    balances.set(transaction.sender, senderBalance - amount - fee);
    balances.set(transaction.recipient, (balances.get(transaction.recipient) ?? 0n) + amount);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
  }

  #applyCandidateBond(transaction, balances, nonces, candidateBonds, proposer, timestamp, height) {
    if (transaction.type !== "candidate-bond" || transaction.algorithm !== SIGNATURE_ALGORITHM) {
      throw new Error("candidate bond transaction is invalid");
    }
    if (transaction.networkId !== this.#networkId) throw new Error("transaction belongs to another network");
    if (!/^[0-9a-f]{64}$/.test(transaction.candidateId ?? "") || candidateBonds.has(transaction.candidateId)) {
      throw new Error("candidate bond id is invalid or duplicated");
    }
    if (
      typeof transaction.publicKey !== "string" || transaction.publicKey.length > 4_000 ||
      typeof transaction.signature !== "string" || transaction.signature.length > 7_000 ||
      addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
      !verifyObject(unsignedTransaction(transaction), transaction.signature, transaction.publicKey, "CANDIDATE_BOND")
    ) throw new Error("invalid candidate bond signature");
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0) throw new Error("invalid transaction nonce");
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    const bond = parseAtomic(transaction.amount, "candidate bond");
    const fee = parseAtomic(transaction.fee, "fee");
    if (bond === 0n) throw new Error("candidate bond must be positive");
    if (fee < MIN_TRANSFER_FEE) throw new Error("transfer fee is below the protocol minimum");
    const senderBalance = balances.get(transaction.sender) ?? 0n;
    if (senderBalance < bond + fee) throw new Error("insufficient balance");
    if (transaction.sender === this.#treasuryAddress) {
      const locked = TREASURY_ALLOCATION - vestedTreasuryAtTimestamp(this.#genesisTimestamp, timestamp);
      if (senderBalance - bond - fee < locked) throw new Error("treasury funds are still vesting");
    }
    balances.set(transaction.sender, senderBalance - bond - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    candidateBonds.set(transaction.candidateId, {
      bond,
      committedHeight: height,
      committee: null,
      randomnessCommits: new Map(),
      randomnessReveals: new Map(),
      submitter: transaction.sender,
    });
  }

  appendBlock(block) {
    const previous = this.#blocks.at(-1);
    if (block.networkId !== this.#networkId) throw new Error("wrong network id");
    if (block.protocolVersion !== PROTOCOL_VERSION) throw new Error("wrong protocol version");
    if (block.height !== previous.height + 1) throw new Error("unexpected block height");
    if (block.previousHash !== previous.hash) throw new Error("broken hash chain");
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp < previous.timestamp) {
      throw new Error("invalid block timestamp");
    }
    if (block.timestamp > Date.now() + MAX_FUTURE_DRIFT_MS) {
      throw new Error("block timestamp is too far in the future");
    }
    if (!Array.isArray(block.transactions) || !Array.isArray(block.progressRewards) ||
        !Array.isArray(block.safetySettlements) || !Array.isArray(block.randomnessCommits) ||
        !Array.isArray(block.randomnessReveals)) {
      throw new Error("block collections are invalid");
    }
    if (block.randomnessCommits.length > this.#validators.size ||
        block.randomnessReveals.length > this.#validators.size) {
      throw new Error("too many randomness contributions");
    }
    if (block.transactions.length > MAX_TRANSACTIONS_PER_BLOCK) {
      throw new Error("too many transactions in one block");
    }
    if (block.progressRewards.length > MAX_PROGRESS_REWARDS_PER_BLOCK) {
      throw new Error("too many progress rewards in one block");
    }
    if (block.safetySettlements.length > MAX_SAFETY_SETTLEMENTS_PER_BLOCK) {
      throw new Error("too many safety settlements in one block");
    }
    if (Buffer.byteLength(canonicalJson(unsignedBlock(block))) > MAX_BLOCK_BYTES) {
      throw new Error("block exceeds the byte-size limit");
    }
    if (block.proposer !== this.expectedProposer(block.height)) {
      throw new Error("unexpected block proposer");
    }
    this.#verifyCertificate(block);

    const capabilityMemory = this.#capabilityMemory.clone();
    for (const claim of block.progressRewards) {
      this.#verifyProgressClaim(claim, block.height, capabilityMemory);
    }
    if (block.capabilityMemoryRoot !== capabilityMemory.stateRoot) {
      throw new Error("invalid world capability memory root");
    }

    if (
      (block.progressRewards.length === 0 && block.issuanceEpoch !== null) ||
      (block.progressRewards.length > 0 && block.issuanceEpoch !== this.#rewardEpoch)
    ) {
      throw new Error("unexpected intelligence issuance epoch");
    }
    if (
      block.progressRewards.length > 0 &&
      block.timestamp < this.#lastRewardTimestamp + MIN_REWARD_INTERVAL_MS
    ) {
      throw new Error("intelligence rewards are being issued too quickly");
    }

    const expectedRewards = allocateProgressRewards(
      this.#rewardEpoch,
      block.progressRewards.map(({ amount: _amount, ...claim }) => claim),
      MINING_POOL - this.#mined,
    );
    if (
      hashObject(expectedRewards, "REWARD_ALLOCATION") !==
      hashObject(block.progressRewards, "REWARD_ALLOCATION")
    ) {
      throw new Error("invalid progress reward allocation");
    }

    const balances = new Map(this.#balances);
    const nonces = new Map(this.#nonces);
    const rewardedProofs = new Set(this.#rewardedProofs);
    const candidateBonds = new Map([...this.#candidateBonds].map(([id, candidate]) => [id, {
      ...candidate,
      randomnessCommits: new Map(candidate.randomnessCommits),
      randomnessReveals: new Map(candidate.randomnessReveals),
    }]));
    const safetyEvidence = new Set(this.#safetyEvidence);
    let newlyBurned = 0n;
    const expectedSafetySettlements = block.safetySettlements.map(({ settlement: _settlement, ...claim }) => ({
      ...claim,
      settlement: this.#verifySafetyClaim(claim, block.height, candidateBonds, safetyEvidence),
    }));
    if (
      hashObject(expectedSafetySettlements, "SAFETY_SETTLEMENTS") !==
      hashObject(block.safetySettlements, "SAFETY_SETTLEMENTS")
    ) throw new Error("invalid safety settlement allocation");
    for (const { settlement } of expectedSafetySettlements) {
      const reporterAmount = parseAtomic(settlement.reporterReward.amount, "safety reporter reward");
      balances.set(
        settlement.reporterReward.recipient,
        (balances.get(settlement.reporterReward.recipient) ?? 0n) + reporterAmount,
      );
      for (const reward of settlement.evaluatorRewards) {
        const amount = parseAtomic(reward.amount, "safety evaluator reward");
        balances.set(reward.recipient, (balances.get(reward.recipient) ?? 0n) + amount);
      }
      newlyBurned += parseAtomic(settlement.burned, "burned safety penalty");
    }
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
    if (TREASURY_ALLOCATION + this.#mined + newlyMined > MAX_SUPPLY) {
      throw new Error("hard supply cap exceeded");
    }
    const transactionIds = new Set();
    for (const transaction of block.transactions) {
      const id = transactionId(transaction);
      if (transactionIds.has(id)) throw new Error("duplicate transaction in block");
      transactionIds.add(id);
      if (transaction.type === "transfer") {
        this.#applyTransfer(transaction, balances, nonces, block.proposer, block.timestamp);
      } else if (transaction.type === "candidate-bond") {
        this.#applyCandidateBond(
          transaction, balances, nonces, candidateBonds, block.proposer,
          block.timestamp, block.height,
        );
      } else {
        throw new Error("unknown transaction type");
      }
    }

    for (const contribution of block.randomnessCommits) {
      const candidate = candidateBonds.get(contribution.candidateId);
      const validator = this.#validators.get(contribution.contributor);
      const payload = {
        candidateId: contribution.candidateId, commitment: contribution.commitment,
        contributor: contribution.contributor, networkId: contribution.networkId,
      };
      if (!candidate || candidate.committee !== null || block.height !== candidate.committedHeight + 1 ||
          contribution.networkId !== this.#networkId || !/^[0-9a-f]{64}$/.test(contribution.commitment ?? "") ||
          !validator || candidate.randomnessCommits.has(contribution.contributor) ||
          !verifyObject(payload, contribution.signature, validator.publicKey, "RANDOMNESS_COMMIT")) {
        throw new Error("invalid or duplicate randomness commitment");
      }
      candidate.randomnessCommits.set(contribution.contributor, contribution.commitment);
    }

    for (const contribution of block.randomnessReveals) {
      const candidate = candidateBonds.get(contribution.candidateId);
      const validator = this.#validators.get(contribution.contributor);
      const payload = {
        candidateId: contribution.candidateId, contributor: contribution.contributor,
        networkId: contribution.networkId, secret: contribution.secret,
      };
      if (!candidate || candidate.committee !== null || block.height !== candidate.committedHeight + 2 ||
          contribution.networkId !== this.#networkId || !validator ||
          candidate.randomnessReveals.has(contribution.contributor) ||
          candidate.randomnessCommits.get(contribution.contributor) !== randomnessCommitment({
            networkId: this.#networkId, candidateId: contribution.candidateId, secret: contribution.secret,
          }) || !verifyObject(payload, contribution.signature, validator.publicKey, "RANDOMNESS_REVEAL")) {
        throw new Error("invalid or unmatched randomness reveal");
      }
      candidate.randomnessReveals.set(contribution.contributor, contribution.secret);
    }

    for (const [candidateId, candidate] of candidateBonds) {
      if (candidate.committee === null && candidate.randomnessReveals.size >= this.#quorum) {
        const randomness = combineRandomnessReveals({
          networkId: this.#networkId, candidateId,
          commitments: candidate.randomnessCommits,
          reveals: candidate.randomnessReveals,
          quorum: this.#quorum,
        });
        candidateBonds.set(candidateId, {
          ...candidate,
          assignedHeight: block.height,
          committee: selectOperatorCommittee({
            registry: this.#evaluators,
            randomness,
            context: { candidateId, committedHeight: candidate.committedHeight },
            size: this.#evaluationQuorum,
          }).map(({ address }) => address),
          randomness,
        });
      }
    }

    this.#balances = balances;
    this.#burned += newlyBurned;
    this.#candidateBonds = candidateBonds;
    this.#nonces = nonces;
    this.#rewardedProofs = rewardedProofs;
    this.#safetyEvidence = safetyEvidence;
    this.#capabilityMemory = capabilityMemory;
    this.#mined += newlyMined;
    if (block.progressRewards.length > 0) {
      this.#rewardEpoch += 1;
      this.#lastRewardTimestamp = block.timestamp;
    }
    this.#blocks.push(structuredClone(block));
    return block.hash;
  }
}

export function formatNir(atomic) {
  const whole = atomic / ATOMIC_UNITS;
  const fraction = (atomic % ATOMIC_UNITS).toString().padStart(8, "0");
  return `${whole}.${fraction} NIR`;
}

export function formatFeePercent(amount, fee) {
  const atomicAmount = parseAtomic(String(amount), "amount");
  const atomicFee = parseAtomic(String(fee), "fee");
  if (atomicAmount === 0n) throw new Error("amount must be positive");
  // Six decimal places of percentage, rounded up so the UI never understates cost.
  const scaled = (atomicFee * 100_000_000n + atomicAmount - 1n) / atomicAmount;
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}%`;
}

export function quoteTransferFee(amount, fee) {
  const atomicAmount = parseAtomic(String(amount), "amount");
  const atomicFee = parseAtomic(String(fee), "fee");
  if (atomicAmount === 0n) throw new Error("amount must be positive");
  return {
    amount: atomicFee.toString(),
    percent: formatFeePercent(atomicAmount.toString(), atomicFee.toString()),
    requiresExplicitConfirmation: atomicFee * 10_000n > atomicAmount * 10n,
    warningThresholdPercent: "0.100000%",
  };
}
