import {
  ATOMIC_UNITS,
  BEACON_NON_REVEAL_SLASH_BPS,
  CREDIT_UNSTAKE_DELAY_BLOCKS,
  EPOCH_REVEAL_TIMEOUT_BLOCKS,
  MAX_BLOCK_BYTES,
  MAX_CREDIT_TRANSFERS_PER_BLOCK,
  MAX_CREDIT_DELEGATIONS_PER_OWNER,
  MAX_CONSENSUS_ROUND,
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
  MIN_BEACON_BOND,
  MINING_POOL,
  MULTISIG_ALGORITHM,
  PROTOCOL_VERSION,
  SIGNATURE_ALGORITHM,
  TREASURY_ALLOCATION,
  TRANSFER_CREDIT_EPOCH_BLOCKS,
  TRANSFER_CREDIT_STAKE_UNIT,
  TRANSFER_CREDITS_PER_STAKE_UNIT,
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
  EpochRandomnessMachine,
  combineRandomnessReveals,
  randomnessCommitment,
  selectOperatorCommittee,
} from "./operators.mjs";
import {
  calculateSafetySettlement,
  safetyFailurePayload,
} from "./safety-bounty.mjs";
import { MIN_VALIDATOR_BOND, NON_REVEAL_SLASH_BPS } from "./validator-staking.mjs";
import { peerRegistryHash, verifyPeerRegistry } from "./peer-registry.mjs";
import { verifyValidatorOnboarding } from "./validator-onboarding.mjs";
import {
  activeValidatorSet,
  scheduleValidatorRotation,
  validatorSetId,
} from "./validator-rotation.mjs";

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

function creditDelegationKey(owner, delegate) {
  return `${owner}:${delegate}`;
}

const MAX_PENDING_PROGRESS_COMMITMENTS = 4_096;
const MAX_PROGRESS_COMMITMENT_AGE = 1_024;

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
      algorithm: member.algorithm,
      operatorId: member.operatorId,
      publicKey: member.publicKey,
    });
    operatorIds.add(member.operatorId);
  }
  return registry;
}

function normalizedStateValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entry]) => [key, normalizedStateValue(entry)]);
  }
  if (value instanceof Set) {
    return [...value].map(normalizedStateValue)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  if (Array.isArray(value)) return value.map(normalizedStateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizedStateValue(entry)]));
  }
  return value;
}

export function computeChainStateRoot(state) {
  return hashObject(normalizedStateValue(state), "CHAIN_STATE_V1");
}

function unsignedTransaction(transaction) {
  const {
    feePayerSignature: _feePayerSignature,
    signature: _signature,
    signatures: _signatures,
    ...unsigned
  } = transaction;
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

export function createSponsoredTransfer({
  wallet,
  sponsorWallet,
  networkId,
  recipient,
  amount,
  nonce,
  sponsorNonce,
  fee = MIN_TRANSFER_FEE.toString(),
  useCredits = false,
}) {
  if (!sponsorWallet || sponsorWallet.address === wallet?.address) {
    throw new Error("a sponsored transfer requires a distinct fee payer");
  }
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    fee: useCredits ? "0" : String(fee),
    feePayer: sponsorWallet.address,
    feePayerAlgorithm: SIGNATURE_ALGORITHM,
    feePayerNonce: sponsorNonce,
    feePayerPublicKey: sponsorWallet.publicKey,
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    recipient,
    sender: wallet.address,
    type: "transfer",
  };
  if (useCredits) transaction.resource = "transfer-credit";
  const signed = {
    ...transaction,
    signature: signObject(transaction, wallet, "TRANSFER"),
  };
  return {
    ...signed,
    feePayerSignature: signObject(signed, sponsorWallet, "SPONSORED_TRANSFER"),
  };
}

export function createCreditTransfer({ wallet, networkId, recipient, amount, nonce }) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    fee: "0",
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    recipient,
    resource: "transfer-credit",
    sender: wallet.address,
    type: "transfer",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "TRANSFER") };
}

export function createDelegatedCreditTransfer({
  wallet, creditOwner, networkId, recipient, amount, nonce,
}) {
  assertAddress(creditOwner, "credit owner");
  if (creditOwner === wallet?.address) throw new Error("delegated credit owner must be distinct");
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    creditOwner,
    fee: "0",
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    recipient,
    resource: "transfer-credit",
    sender: wallet.address,
    type: "transfer",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "TRANSFER") };
}

export function progressCandidateId({
  networkId, sender, recipient, artifactHash, baselineHash, suiteCommitment,
}) {
  return hashObject({
    artifactHash, baselineHash, networkId, recipient, sender, suiteCommitment,
  }, "PROGRESS_CANDIDATE_ID");
}

export function createProgressCommitment({
  wallet, networkId, recipient, artifactHash, baselineHash, suiteCommitment, nonce,
}) {
  const candidateId = progressCandidateId({
    networkId, sender: wallet.address, recipient, artifactHash, baselineHash, suiteCommitment,
  });
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    artifactHash,
    baselineHash,
    candidateId,
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    recipient,
    sender: wallet.address,
    suiteCommitment,
    type: "progress-commitment",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "PROGRESS_COMMITMENT") };
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

export function createValidatorBond({
  wallet, networkId, amount, nonce, operatorId, fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount), fee: String(fee), networkId, nonce,
    publicKey: wallet.publicKey, sender: wallet.address, type: "validator-bond",
  };
  if (operatorId !== undefined) transaction.operatorId = operatorId;
  return { ...transaction, signature: signObject(transaction, wallet, "VALIDATOR_BOND") };
}

export function createBeaconBond({
  wallet, networkId, amount, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount), fee: String(fee), networkId, nonce,
    publicKey: wallet.publicKey, sender: wallet.address, type: "beacon-bond",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "BEACON_BOND") };
}

export function createCreditStake({
  wallet, networkId, amount, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount), fee: String(fee), networkId, nonce,
    publicKey: wallet.publicKey, sender: wallet.address, type: "credit-stake",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "CREDIT_STAKE") };
}

export function createCreditDelegation({
  wallet, delegate, networkId, limit, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    delegate,
    fee: String(fee),
    limit,
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    sender: wallet.address,
    type: "credit-delegation",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "CREDIT_DELEGATION") };
}

export function createCreditUnstakeRequest({ wallet, networkId, amount, nonce }) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount),
    fee: MIN_TRANSFER_FEE.toString(),
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    sender: wallet.address,
    type: "credit-unstake-request",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "CREDIT_UNSTAKE_REQUEST") };
}

export function createCreditUnstakeClaim({ wallet, networkId, nonce }) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    sender: wallet.address,
    type: "credit-unstake-claim",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "CREDIT_UNSTAKE_CLAIM") };
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
      candidateId: evaluation.candidateId,
      executionBundleHash: evaluation.executionBundleHash,
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
    !/^[0-9a-f]{64}$/.test(evaluation.candidateId ?? "") ||
    !/^[0-9a-f]{64}$/.test(evaluation.executionBundleHash ?? "") ||
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
  const {
    certificate: _certificate,
    hash: _hash,
    prepareCertificate: _prepareCertificate,
    proposer: _proposer,
    round: _round,
    roundCertificate: _roundCertificate,
    ...unsigned
  } = block;
  return unsigned;
}

export function blockHash(block) {
  return hashObject(unsignedBlock(block), "BLOCK");
}

export function prepareVoteForBlock(block, validatorWallet) {
  const hash = blockHash(block);
  return {
    signature: signObject({ blockHash: hash }, validatorWallet, "BLOCK_PREPARE"),
    validator: validatorWallet.address,
  };
}

export const voteForBlock = prepareVoteForBlock;

export function prepareCertificateHash(certificate) {
  const ordered = [...certificate].sort((left, right) =>
    left.validator.localeCompare(right.validator));
  return hashObject(ordered, "PREPARE_CERTIFICATE");
}

export function commitVoteForBlock(block, prepareCertificate, validatorWallet) {
  return {
    signature: signObject({
      blockHash: blockHash(block),
      prepareCertificateHash: prepareCertificateHash(prepareCertificate),
    }, validatorWallet, "BLOCK_COMMIT"),
    validator: validatorWallet.address,
  };
}

function roundTimeoutPayload({ blockHash: valueHash, networkId, height, previousHash, nextRound }) {
  return { blockHash: valueHash, height, networkId, nextRound, previousHash };
}

export function timeoutForRound(fields, validatorWallet) {
  const payload = roundTimeoutPayload(fields);
  return {
    signature: signObject(payload, validatorWallet, "ROUND_TIMEOUT"),
    validator: validatorWallet.address,
  };
}

export function finalizeBlock(block, validatorWallets) {
  const prepareCertificate = validatorWallets.map((wallet) =>
    prepareVoteForBlock(block, wallet));
  const certificate = validatorWallets.map((wallet) =>
    commitVoteForBlock(block, prepareCertificate, wallet));
  return { ...block, hash: blockHash(block), prepareCertificate, certificate };
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

function snapshotEntries(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} snapshot is invalid`);
  const result = new Map();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || result.has(entry[0])) {
      throw new Error(`${field} snapshot is invalid`);
    }
    result.set(entry[0], entry[1]);
  }
  return result;
}

function snapshotAtomic(value, field) {
  return parseAtomic(value, `${field} snapshot`);
}

function snapshotInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} snapshot is invalid`);
  return value;
}

function snapshotSignedInteger(value, field) {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} snapshot is invalid`);
  return value;
}

export class NirChain {
  #balances;
  #beaconBondingActive;
  #beaconBonds;
  #beaconFaults;
  #blocks;
  #burned;
  #candidateBonds;
  #capabilityMemory;
  #creditDelegations;
  #creditStakes;
  #creditUnstakes;
  #creditUsage;
  #evaluationQuorum;
  #epochRandomness;
  #beaconAuthorities;
  #beaconQuorum;
  #evaluatorOrder;
  #evaluators;
  #mined;
  #lastRewardTimestamp;
  #networkId;
  #nonces;
  #quorum;
  #rewardEpoch;
  #rewardedProofs;
  #randomnessFaults;
  #validatorFaults;
  #validatorBonds;
  #registeredValidators;
  #pendingValidatorRotation;
  #peerRegistry;
  #progressCommitments;
  #safetyEvidence;
  #safetyPolicies;
  #treasuryAddress;
  #genesisTimestamp;
  #genesisConfig;
  #validatorOrder;
  #validators;

  constructor({
    networkId,
    validators,
    evaluators,
    treasuryAddress,
    capabilityReferences,
    safetyPolicyCommitments,
    beaconAuthorities,
    peerRegistry = null,
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
    this.#genesisConfig = structuredClone({
      beaconAuthorities,
      capabilityReferences,
      evaluators,
      genesisTimestamp,
      networkId,
      peerRegistry,
      safetyPolicyCommitments,
      treasuryAddress,
      validators,
    });
    this.#genesisTimestamp = genesisTimestamp;
    this.#treasuryAddress = treasuryAddress;
    this.#validators = operatorRegistry(validators, "validator");
    this.#evaluators = operatorRegistry(evaluators, "evaluator");
    this.#beaconAuthorities = operatorRegistry(beaconAuthorities, "beacon authority");
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
    const occupiedOperators = new Set([
      ...[...this.#validators.values()].map(({ operatorId }) => operatorId),
      ...[...this.#evaluators.values()].map(({ operatorId }) => operatorId),
    ]);
    if ([...this.#beaconAuthorities.entries()].some(([address, { operatorId }]) =>
      this.#validators.has(address) || this.#evaluators.has(address) || occupiedOperators.has(operatorId))) {
      throw new Error("beacon authorities must be independent from chain operators");
    }
    this.#validatorOrder = [...this.#validators.keys()].sort();
    this.#quorum = Math.floor((this.#validatorOrder.length * 2) / 3) + 1;
    this.#evaluatorOrder = [...this.#evaluators.keys()].sort();
    this.#evaluationQuorum = Math.floor((this.#evaluatorOrder.length * 2) / 3) + 1;
    this.#beaconQuorum = Math.floor((this.#beaconAuthorities.size * 2) / 3) + 1;
    this.#epochRandomness = new EpochRandomnessMachine({
      networkId,
      registry: this.#beaconAuthorities,
      committeeSize: this.#beaconQuorum,
      genesisSeed: hashObject({
        authorities: [...this.#beaconAuthorities.keys()].sort(),
        networkId,
      }, "EPOCH_RANDOMNESS_GENESIS"),
    });
    assertAddress(treasuryAddress, "treasury address");
    this.#balances = new Map([[treasuryAddress, TREASURY_ALLOCATION]]);
    this.#beaconBondingActive = false;
    this.#beaconBonds = new Map();
    this.#beaconFaults = new Map();
    this.#burned = 0n;
    this.#candidateBonds = new Map();
    this.#creditDelegations = new Map();
    this.#creditStakes = new Map();
    this.#creditUnstakes = new Map();
    this.#creditUsage = new Map();
    this.#nonces = new Map();
    this.#rewardedProofs = new Set();
    this.#randomnessFaults = new Map();
    this.#validatorFaults = new Map();
    this.#validatorBonds = new Map();
    this.#registeredValidators = new Map(this.#validators);
    this.#pendingValidatorRotation = null;
    this.#progressCommitments = new Map();
    this.#peerRegistry = peerRegistry === null ? null : verifyPeerRegistry(peerRegistry, {
      currentHeight: 0,
      networkId,
      validators: [...this.#validators.values()],
    });
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
    const stateRoot = this.#stateRoot();
    const genesis = {
      balances: { [treasuryAddress]: TREASURY_ALLOCATION.toString() },
      beaconAuthorities: [...this.#beaconAuthorities.values()].map(({ address, operatorId }) => ({ address, operatorId })),
      capabilityMemoryRoot: this.#capabilityMemory.stateRoot,
      evaluators: this.#evaluatorOrder.map((address) => ({
        address,
        operatorId: this.#evaluators.get(address).operatorId,
      })),
      genesisTimestamp,
      networkId,
      peerRegistryHash: this.#peerRegistry ? peerRegistryHash(this.#peerRegistry) : "0".repeat(64),
      protocolVersion: PROTOCOL_VERSION,
      safetyPolicyCommitments: [...this.#safetyPolicies].sort(),
      stateRoot,
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
        peerRegistryHash: this.#peerRegistry ? peerRegistryHash(this.#peerRegistry) : "0".repeat(64),
        previousHash: "0".repeat(64),
        progressRewards: [],
        safetySettlements: [],
        stateRoot,
        protocolVersion: PROTOCOL_VERSION,
        timestamp: genesisTimestamp,
        transactions: [],
      },
    ];
  }

  static fromVerifiedSnapshot(genesisConfig, snapshot) {
    const chain = new NirChain(genesisConfig);
    if (!snapshot || snapshot.networkId !== chain.#networkId ||
        snapshot.checkpoint?.hash !== snapshot.tipHash ||
        snapshot.checkpoint?.stateRoot !== snapshot.stateRoot ||
        computeChainStateRoot(snapshot.state) !== snapshot.stateRoot) {
      throw new Error("verified snapshot does not match the target chain");
    }
    const state = snapshot.state;
    const balances = snapshotEntries(state.balances, "balances");
    for (const [address, value] of balances) {
      assertAddress(address, "snapshot balance address");
      balances.set(address, snapshotAtomic(value, "balance"));
    }
    if (typeof state.beaconBondingActive !== "boolean") {
      throw new Error("beacon bonding activation snapshot is invalid");
    }
    const beaconBonds = snapshotEntries(state.beaconBonds, "beacon bonds");
    for (const [address, value] of beaconBonds) {
      if (!chain.#beaconAuthorities.has(address)) throw new Error("beacon bond snapshot address is invalid");
      beaconBonds.set(address, snapshotAtomic(value, "beacon bond"));
    }
    const beaconFaults = snapshotEntries(state.beaconFaults, "beacon faults");
    for (const [address, value] of beaconFaults) {
      if (!chain.#beaconAuthorities.has(address)) throw new Error("beacon fault snapshot address is invalid");
      beaconFaults.set(address, snapshotInteger(value, "beacon fault"));
    }
    const nonces = snapshotEntries(state.nonces, "nonces");
    for (const [address, value] of nonces) {
      assertAddress(address, "snapshot nonce address");
      nonces.set(address, snapshotInteger(value, "nonce"));
    }
    const validatorBonds = snapshotEntries(state.validatorBonds, "validator bonds");
    for (const [address, value] of validatorBonds) {
      assertAddress(address, "snapshot validator bond address");
      validatorBonds.set(address, snapshotAtomic(value, "validator bond"));
    }
    const validatorFaults = snapshotEntries(state.validatorFaults, "validator faults");
    for (const [address, value] of validatorFaults) {
      assertAddress(address, "snapshot validator fault address");
      validatorFaults.set(address, snapshotInteger(value, "validator fault"));
    }
    const candidateBonds = snapshotEntries(state.candidateBonds, "candidate bonds");
    for (const [candidateId, candidate] of candidateBonds) {
      if (!/^[0-9a-f]{64}$/.test(candidateId) || !candidate ||
          !Number.isSafeInteger(candidate.committedHeight) || candidate.committedHeight < 0) {
        throw new Error("candidate bond snapshot is invalid");
      }
      candidateBonds.set(candidateId, {
        ...structuredClone(candidate),
        bond: snapshotAtomic(candidate.bond, "candidate bond"),
        randomnessCommits: snapshotEntries(candidate.randomnessCommits, "randomness commits"),
        randomnessReveals: snapshotEntries(candidate.randomnessReveals, "randomness reveals"),
      });
    }
    const creditStakes = snapshotEntries(state.creditStakes, "credit stakes");
    for (const [address, value] of creditStakes) {
      assertAddress(address, "credit stake address");
      creditStakes.set(address, snapshotAtomic(value, "credit stake"));
    }
    const creditDelegations = snapshotEntries(state.creditDelegations, "credit delegations");
    for (const [key, value] of creditDelegations) {
      if (!value || creditDelegationKey(value.owner, value.delegate) !== key ||
          value.owner === value.delegate ||
          !Number.isSafeInteger(value.limit) || value.limit < 1 ||
          !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
          !Number.isSafeInteger(value.spent) || value.spent < 0 || value.spent > value.limit) {
        throw new Error("credit delegation snapshot is invalid");
      }
      assertAddress(value.owner, "credit delegation owner");
      assertAddress(value.delegate, "credit delegation delegate");
    }
    const creditUnstakes = snapshotEntries(state.creditUnstakes, "credit unstakes");
    for (const [address, value] of creditUnstakes) {
      assertAddress(address, "credit unstake address");
      if (!value || !Number.isSafeInteger(value.unlockHeight) || value.unlockHeight < 1) {
        throw new Error("credit unstake snapshot is invalid");
      }
      creditUnstakes.set(address, {
        amount: snapshotAtomic(value.amount, "credit unstake amount"),
        unlockHeight: value.unlockHeight,
      });
    }
    const creditUsage = snapshotEntries(state.creditUsage, "credit usage");
    for (const [address, value] of creditUsage) {
      assertAddress(address, "credit usage address");
      if (!value || !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
          !Number.isSafeInteger(value.spent) || value.spent < 0) {
        throw new Error("credit usage snapshot is invalid");
      }
    }
    const progressCommitments = snapshotEntries(
      state.progressCommitments,
      "progress commitments",
    );
    const progressSubmitters = new Set();
    for (const [candidateId, commitment] of progressCommitments) {
      if (
        !/^[0-9a-f]{64}$/.test(candidateId) ||
        !commitment ||
        !Number.isSafeInteger(commitment.committedHeight) ||
        commitment.committedHeight < 1 ||
        !Number.isSafeInteger(commitment.randomnessRound) || commitment.randomnessRound < 1 ||
        !/^sha256:[0-9a-f]{64}$/.test(commitment.artifactHash ?? "") ||
        !/^sha256:[0-9a-f]{64}$/.test(commitment.baselineHash ?? "") ||
        commitment.artifactHash === commitment.baselineHash ||
        !/^[0-9a-f]{64}$/.test(commitment.suiteCommitment ?? "") ||
        !/^nir1[0-9a-f]{64}$/.test(commitment.sender ?? "") ||
        !/^nir1[0-9a-f]{64}$/.test(commitment.recipient ?? "") ||
        progressSubmitters.has(commitment.sender) ||
        candidateId !== progressCandidateId({
          ...commitment,
          networkId: chain.#networkId,
        })
      ) {
        throw new Error("progress commitment snapshot is invalid");
      }
      const beaconUnassigned = commitment.beaconCommittee === null &&
        commitment.beaconCommitteeHeight === null && commitment.beaconCommitteeSource === null &&
        commitment.beaconRandomnessRound === null;
      const beaconAssigned =
        Array.isArray(commitment.beaconCommittee) &&
        commitment.beaconCommittee.length === chain.#beaconQuorum &&
        new Set(commitment.beaconCommittee).size === commitment.beaconCommittee.length &&
        commitment.beaconCommittee.every((address) => chain.#beaconAuthorities.has(address)) &&
        Number.isSafeInteger(commitment.beaconCommitteeHeight) &&
        commitment.beaconCommitteeHeight > commitment.committedHeight &&
        commitment.beaconCommitteeHeight <= commitment.committedHeight + MAX_PROGRESS_COMMITMENT_AGE &&
        Number.isSafeInteger(commitment.beaconRandomnessRound) &&
        commitment.beaconRandomnessRound >= commitment.randomnessRound &&
        /^[0-9a-f]{64}$/.test(commitment.beaconCommitteeSource ?? "");
      if (!beaconUnassigned && !beaconAssigned) {
        throw new Error("progress beacon committee snapshot is invalid");
      }
      const challengeFields = [
        commitment.beaconValue,
        commitment.challengeHeight,
        commitment.challengeSeed,
        commitment.committee,
      ];
      const unassigned = challengeFields.every((value) => value === null);
      const assigned =
        /^[0-9a-f]{64}$/.test(commitment.beaconValue ?? "") &&
        /^[0-9a-f]{64}$/.test(commitment.challengeSeed ?? "") &&
        Number.isSafeInteger(commitment.challengeHeight) &&
        commitment.challengeHeight > commitment.committedHeight &&
        commitment.challengeHeight <= commitment.committedHeight + MAX_PROGRESS_COMMITMENT_AGE &&
        Array.isArray(commitment.committee) &&
        commitment.committee.length === chain.#evaluationQuorum &&
        new Set(commitment.committee).size === commitment.committee.length &&
        commitment.committee.every((address) => chain.#evaluators.has(address));
      if (!unassigned && !assigned) {
        throw new Error("progress challenge snapshot is invalid");
      }
      progressSubmitters.add(commitment.sender);
    }
    const validators = snapshotEntries(state.validators, "validators");
    const registeredValidators = snapshotEntries(state.registeredValidators, "registered validators");
    const validatorMembers = operatorRegistry([...validators.values()], "validator snapshot");
    const registeredMembers = operatorRegistry([...registeredValidators.values()], "registered validator snapshot");
    const memory = CapabilityMemory.fromSnapshot(snapshot.capabilityMemory);
    if (memory.stateRoot !== state.capabilityMemoryRoot) {
      throw new Error("capability memory snapshot root is invalid");
    }
    chain.#balances = balances;
    chain.#beaconBondingActive = state.beaconBondingActive;
    chain.#beaconBonds = beaconBonds;
    chain.#beaconFaults = beaconFaults;
    chain.#burned = snapshotAtomic(state.burned, "burned supply");
    chain.#candidateBonds = candidateBonds;
    chain.#capabilityMemory = memory;
    chain.#creditDelegations = creditDelegations;
    chain.#creditStakes = creditStakes;
    chain.#creditUnstakes = creditUnstakes;
    chain.#creditUsage = creditUsage;
    chain.#epochRandomness = EpochRandomnessMachine.fromSnapshot({
      networkId: chain.#networkId,
      registry: chain.#beaconAuthorities,
      committeeSize: chain.#beaconQuorum,
      snapshot: state.epochRandomness,
    });
    chain.#lastRewardTimestamp = snapshotSignedInteger(state.lastRewardTimestamp, "last reward timestamp");
    chain.#mined = snapshotAtomic(state.mined, "mined supply");
    chain.#nonces = nonces;
    chain.#pendingValidatorRotation = structuredClone(state.pendingValidatorRotation);
    chain.#progressCommitments = progressCommitments;
    chain.#peerRegistry = structuredClone(state.peerRegistry);
    chain.#randomnessFaults = snapshotEntries(state.randomnessFaults, "randomness faults");
    chain.#registeredValidators = registeredMembers;
    chain.#rewardEpoch = snapshotInteger(state.rewardEpoch, "reward epoch");
    if (!Array.isArray(state.rewardedProofs) || !Array.isArray(state.safetyEvidence)) {
      throw new Error("snapshot replay-protection sets are invalid");
    }
    chain.#rewardedProofs = new Set(state.rewardedProofs);
    chain.#safetyEvidence = new Set(state.safetyEvidence);
    chain.#validatorBonds = validatorBonds;
    chain.#validatorFaults = validatorFaults;
    chain.#validators = validatorMembers;
    chain.#validatorOrder = [...validatorMembers.keys()].sort();
    chain.#quorum = Math.floor((chain.#validatorOrder.length * 2) / 3) + 1;
    chain.#blocks = [structuredClone(snapshot.checkpoint)];
    if (chain.#stateRoot() !== snapshot.stateRoot) {
      throw new Error("restored snapshot state root is invalid");
    }
    return chain;
  }

  get height() {
    return this.#blocks.at(-1).height;
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

  blocks() {
    return structuredClone(this.#blocks);
  }

  get networkId() {
    return this.#networkId;
  }

  get capabilityMemoryRoot() {
    return this.#capabilityMemory.stateRoot;
  }

  get stateRoot() { return this.#stateRoot(); }

  epochRandomnessStatus() {
    return structuredClone(this.#epochRandomness.snapshot());
  }

  #stateRoot(overrides = {}) {
    return computeChainStateRoot({
      balances: overrides.balances ?? this.#balances,
      beaconBondingActive: overrides.beaconBondingActive ?? this.#beaconBondingActive,
      beaconBonds: overrides.beaconBonds ?? this.#beaconBonds,
      beaconFaults: overrides.beaconFaults ?? this.#beaconFaults,
      burned: overrides.burned ?? this.#burned,
      candidateBonds: overrides.candidateBonds ?? this.#candidateBonds,
      capabilityMemoryRoot: overrides.capabilityMemoryRoot ?? this.#capabilityMemory.stateRoot,
      creditDelegations: overrides.creditDelegations ?? this.#creditDelegations,
      creditStakes: overrides.creditStakes ?? this.#creditStakes,
      creditUnstakes: overrides.creditUnstakes ?? this.#creditUnstakes,
      creditUsage: overrides.creditUsage ?? this.#creditUsage,
      epochRandomness: overrides.epochRandomness ?? this.#epochRandomness.snapshot(),
      lastRewardTimestamp: overrides.lastRewardTimestamp ?? this.#lastRewardTimestamp,
      mined: overrides.mined ?? this.#mined,
      nonces: overrides.nonces ?? this.#nonces,
      pendingValidatorRotation:
        overrides.pendingValidatorRotation === undefined
          ? this.#pendingValidatorRotation : overrides.pendingValidatorRotation,
      peerRegistry: overrides.peerRegistry === undefined ? this.#peerRegistry : overrides.peerRegistry,
      progressCommitments: overrides.progressCommitments ?? this.#progressCommitments,
      randomnessFaults: overrides.randomnessFaults ?? this.#randomnessFaults,
      registeredValidators: overrides.registeredValidators ?? this.#registeredValidators,
      rewardEpoch: overrides.rewardEpoch ?? this.#rewardEpoch,
      rewardedProofs: overrides.rewardedProofs ?? this.#rewardedProofs,
      safetyEvidence: overrides.safetyEvidence ?? this.#safetyEvidence,
      validatorBonds: overrides.validatorBonds ?? this.#validatorBonds,
      validatorFaults: overrides.validatorFaults ?? this.#validatorFaults,
      validators: overrides.validators ?? this.#validators,
    });
  }

  consensusSnapshot() {
    return {
      capabilityMemory: this.#capabilityMemory.snapshot(),
      state: normalizedStateValue({
        balances: this.#balances,
        beaconBondingActive: this.#beaconBondingActive,
        beaconBonds: this.#beaconBonds,
        beaconFaults: this.#beaconFaults,
        burned: this.#burned,
        candidateBonds: this.#candidateBonds,
        capabilityMemoryRoot: this.#capabilityMemory.stateRoot,
        creditDelegations: this.#creditDelegations,
        creditStakes: this.#creditStakes,
        creditUnstakes: this.#creditUnstakes,
        creditUsage: this.#creditUsage,
        epochRandomness: this.#epochRandomness.snapshot(),
        lastRewardTimestamp: this.#lastRewardTimestamp,
        mined: this.#mined,
        nonces: this.#nonces,
        pendingValidatorRotation: this.#pendingValidatorRotation,
        peerRegistry: this.#peerRegistry,
        progressCommitments: this.#progressCommitments,
        randomnessFaults: this.#randomnessFaults,
        registeredValidators: this.#registeredValidators,
        rewardEpoch: this.#rewardEpoch,
        rewardedProofs: this.#rewardedProofs,
        safetyEvidence: this.#safetyEvidence,
        validatorBonds: this.#validatorBonds,
        validatorFaults: this.#validatorFaults,
        validators: this.#validators,
      }),
    };
  }

  get nextIssuanceEpoch() {
    return this.#rewardEpoch;
  }

  assignedSafetyEvaluators(candidateId) {
    const candidate = this.#candidateBonds.get(candidateId);
    if (!candidate?.committee) throw new Error("candidate safety committee is not assigned");
    return [...candidate.committee];
  }

  progressChallenge(candidateId) {
    const commitment = this.#progressCommitments.get(candidateId);
    if (!commitment) throw new Error("progress commitment is unknown or expired");
    if (!commitment.challengeSeed || !Array.isArray(commitment.committee)) {
      throw new Error("progress challenge is not available yet");
    }
    return {
      beaconValue: commitment.beaconValue,
      challengeSeed: commitment.challengeSeed,
      committee: [...commitment.committee],
      committedHeight: commitment.committedHeight,
      sourceHeight: commitment.challengeHeight,
    };
  }

  progressBeaconCommittee(candidateId) {
    const commitment = this.#progressCommitments.get(candidateId);
    if (!commitment) throw new Error("progress commitment is unknown or expired");
    if (!Array.isArray(commitment.beaconCommittee)) {
      throw new Error("progress beacon committee is not assigned yet");
    }
    return [...commitment.beaconCommittee];
  }

  validatorRandomnessFaults(address) {
    return this.#validatorFaults.get(address) ?? 0;
  }

  validatorBond(address) { return this.#validatorBonds.get(address) ?? 0n; }
  beaconBond(address) { return this.#beaconBonds.get(address) ?? 0n; }
  beaconFaultCount(address) { return this.#beaconFaults.get(address) ?? 0; }
  get beaconBondingActive() { return this.#beaconBondingActive; }
  creditStake(address) { return this.#creditStakes.get(address) ?? 0n; }
  creditDelegation(owner, delegate) {
    return structuredClone(this.#creditDelegations.get(creditDelegationKey(owner, delegate)) ?? null);
  }
  creditUnstake(address) { return structuredClone(this.#creditUnstakes.get(address) ?? null); }

  transferCredits(address, height = this.height + 1) {
    if (!Number.isSafeInteger(height) || height < 1) throw new Error("credit height is invalid");
    const allowance = (this.creditStake(address) * BigInt(TRANSFER_CREDITS_PER_STAKE_UNIT)) /
      TRANSFER_CREDIT_STAKE_UNIT;
    const epoch = Math.floor((height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
    const usage = this.#creditUsage.get(address);
    const spent = usage?.epoch === epoch ? BigInt(usage.spent) : 0n;
    return allowance > spent ? allowance - spent : 0n;
  }

  get validatorSetId() { return validatorSetId([...this.#validators.values()].sort((a, b) => a.address.localeCompare(b.address))); }

  get validatorMembers() {
    return [...this.#validators.values()].sort((left, right) =>
      left.address.localeCompare(right.address)).map((member) => structuredClone(member));
  }

  validatorMembersForHeight(height) {
    if (!Number.isSafeInteger(height) || height < this.height + 1) {
      throw new Error("validator membership height is invalid");
    }
    return this.#validatorsForHeight(height).map((member) => structuredClone(member));
  }

  get pendingValidatorRotation() {
    return this.#pendingValidatorRotation ? structuredClone(this.#pendingValidatorRotation) : null;
  }

  get peerRegistryHash() {
    return this.#peerRegistry ? peerRegistryHash(this.#peerRegistry) : "0".repeat(64);
  }

  get peerRegistry() {
    return this.#peerRegistry ? structuredClone(this.#peerRegistry) : null;
  }

  randomnessFault(candidateId) {
    const fault = this.#randomnessFaults.get(candidateId);
    return fault ? structuredClone(fault) : null;
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

  expectedProposer(height, round = 0) {
    const order = this.#validatorsForHeight(height).map(({ address }) => address);
    if (!Number.isSafeInteger(round) || round < 0 || round > MAX_CONSENSUS_ROUND) {
      throw new Error("consensus round is outside protocol limits");
    }
    return order[(height + round) % order.length];
  }

  #validatorsForHeight(height) {
    return activeValidatorSet({
      current: [...this.#validators.values()].sort((a, b) => a.address.localeCompare(b.address)),
      pending: this.#pendingValidatorRotation,
      height,
    });
  }

  #verifyProgressClaim(claim, epoch, capabilityMemory, progressCommitments) {
    if (claim.networkId !== this.#networkId || claim.epoch !== epoch) {
      throw new Error("progress receipt belongs to another network or epoch");
    }
    if (claim.evaluation.challengeEpoch !== epoch) {
      throw new Error("progress challenge belongs to another epoch");
    }
    const candidateId = claim.evaluation.candidateId;
    const admission = progressCommitments.get(candidateId);
    if (!admission) throw new Error("progress candidate was not committed on chain");
    const challenge = this.progressChallenge(candidateId);
    if (
      admission.committedHeight >= epoch ||
      epoch > admission.committedHeight + MAX_PROGRESS_COMMITMENT_AGE ||
      admission.artifactHash !== claim.evaluation.artifactHash ||
      admission.baselineHash !== claim.evaluation.baselineHash ||
      admission.suiteCommitment !== claim.evaluation.suiteCommitment ||
      admission.recipient !== claim.recipient ||
      claim.evaluation.committedEpoch !== admission.committedHeight ||
      claim.evaluation.challengeSeed !== challenge.challengeSeed
    ) {
      throw new Error("progress claim does not match its finalized admission");
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
    const actualCommittee = [...evaluators].sort();
    const expectedCommittee = [...challenge.committee].sort();
    if (
      actualCommittee.length !== expectedCommittee.length ||
      !actualCommittee.every((address, index) => address === expectedCommittee[index])
    ) {
      throw new Error("progress receipt was not signed by the assigned committee");
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
    randomnessCommits = [], randomnessReveals = [], fallbackBeacons = [],
    epochRandomnessCommits = [], epochRandomnessReveals = [],
    progressBeacons = [],
    validatorRotation = null, peerRegistryUpdate = null,
    timestamp = Date.now(), round = 0, roundCertificate = null,
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
      this.#verifyProgressClaim(
        claim,
        height,
        stagedMemory,
        this.#progressCommitments,
      );
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
    let scheduledRotation = null;
    if (validatorRotation !== null) {
      if (this.#pendingValidatorRotation) throw new Error("a validator rotation is already pending");
      const proposed = (validatorRotation.validators ?? []).map(({ address }) => {
        const member = this.#registeredValidators.get(address);
        if (!member) throw new Error("proposed validator is not registered");
        return member;
      });
      scheduledRotation = scheduleValidatorRotation({
        current: [...this.#validators.values()], proposed, bonds: this.#validatorBonds,
        currentHeight: this.height, activationHeight: validatorRotation.activationHeight,
      });
      if (this.#peerRegistry) {
        const onboarding = verifyValidatorOnboarding(validatorRotation.onboarding, {
          activationHeight: scheduledRotation.activationHeight,
          currentPeerRegistry: this.#peerRegistry,
          currentValidators: [...this.#validators.values()],
          networkId: this.#networkId,
          nextValidators: scheduledRotation.validators,
        });
        scheduledRotation = { ...scheduledRotation, onboarding };
      } else if (validatorRotation.onboarding != null) {
        throw new Error("validator onboarding requires an active peer registry");
      }
    }
    if ((validatorRotation !== null || this.#pendingValidatorRotation) && peerRegistryUpdate !== null) {
      throw new Error("validator and peer registry rotations require separate blocks");
    }
    const activatingOnboarding = this.#pendingValidatorRotation?.activationHeight === height
      ? this.#pendingValidatorRotation.onboarding ?? null : null;
    const nextPeerRegistry = activatingOnboarding ?? (peerRegistryUpdate === null ? this.#peerRegistry :
      verifyPeerRegistry(peerRegistryUpdate, {
        currentHeight: height,
        networkId: this.#networkId,
        previousRegistry: this.#peerRegistry,
        validators: [...this.#validators.values()],
      }));
    if (peerRegistryUpdate !== null && nextPeerRegistry.activationHeight !== height) {
      throw new Error("peer registry must activate at its containing block height");
    }
    const proposal = {
      capabilityMemoryRoot: stagedMemory.stateRoot,
      height,
      networkId: this.#networkId,
      peerRegistryHash: nextPeerRegistry ? peerRegistryHash(nextPeerRegistry) : "0".repeat(64),
      peerRegistryUpdate: activatingOnboarding || nextPeerRegistry === this.#peerRegistry
        ? null : nextPeerRegistry,
      previousHash: this.#blocks.at(-1).hash,
      epochRandomnessCommits,
      epochRandomnessReveals,
      progressRewards,
      fallbackBeacons,
      progressBeacons,
      randomnessCommits,
      randomnessReveals,
      safetySettlements,
      validatorRotation: scheduledRotation,
      issuanceEpoch: progressRewards.length > 0 ? this.#rewardEpoch : null,
      feeRecipient: this.expectedProposer(height, 0),
      proposer: this.expectedProposer(height, round),
      protocolVersion: PROTOCOL_VERSION,
      round,
      roundCertificate,
      timestamp,
      transactions,
    };
    const provisional = { ...proposal, stateRoot: "0".repeat(64) };
    const simulation = {
      ...provisional,
      certificate: [],
      hash: blockHash(provisional),
      prepareCertificate: [],
      proposer: this.expectedProposer(height, 0),
      round: 0,
      roundCertificate: null,
    };
    try {
      const trial = this.fork();
      trial.#applyBlock(simulation, false, false);
      return { ...proposal, stateRoot: trial.stateRoot };
    } catch {
      // An assembler may still return an invalid proposal for diagnostic and
      // adversarial tests; validators will reject it before trusting this root.
      return provisional;
    }
  }

  #verifyCertificate(block, validators, previousValidators = null) {
    const acceptedValidators = previousValidators
      ? new Map([...previousValidators, ...validators])
      : validators;
    if (block.hash !== blockHash(block)) throw new Error("block hash mismatch");
    if (!Array.isArray(block.prepareCertificate) ||
        block.prepareCertificate.length > acceptedValidators.size ||
        !Array.isArray(block.certificate) || block.certificate.length > acceptedValidators.size) {
      throw new Error("invalid finality certificate size");
    }
    const prepareVoters = new Set();
    for (const vote of block.prepareCertificate) {
      const validator = acceptedValidators.get(vote.validator);
      if (!validator || prepareVoters.has(vote.validator) ||
          typeof vote.signature !== "string" || vote.signature.length > 7_000 ||
          !verifyObject({ blockHash: block.hash }, vote.signature, validator.publicKey, "BLOCK_PREPARE")) {
        throw new Error("invalid or duplicate prepare vote");
      }
      prepareVoters.add(vote.validator);
    }
    const quorum = Math.floor((validators.size * 2) / 3) + 1;
    const preparesInSet = [...prepareVoters].filter((address) => validators.has(address)).length;
    if (preparesInSet < quorum) throw new Error("prepare quorum not reached");
    if (previousValidators) {
      const previousQuorum = Math.floor((previousValidators.size * 2) / 3) + 1;
      const previousPrepares = [...prepareVoters]
        .filter((address) => previousValidators.has(address)).length;
      if (previousPrepares < previousQuorum) throw new Error("old-set prepare quorum not reached");
    }
    const commitPayload = {
      blockHash: block.hash,
      prepareCertificateHash: prepareCertificateHash(block.prepareCertificate),
    };
    const voters = new Set();
    for (const vote of block.certificate ?? []) {
      if (voters.has(vote.validator)) throw new Error("duplicate validator vote");
      const validator = acceptedValidators.get(vote.validator);
      if (!validator) throw new Error("vote from unknown validator");
      if (
        typeof vote.signature !== "string" ||
        vote.signature.length > 7_000 ||
        !verifyObject(
          commitPayload,
          vote.signature,
          validator.publicKey,
          "BLOCK_COMMIT",
        )
      ) {
        throw new Error("invalid validator signature");
      }
      voters.add(vote.validator);
    }
    const votesInSet = [...voters].filter((address) => validators.has(address)).length;
    if (votesInSet < quorum) throw new Error("finality quorum not reached");
    if (previousValidators) {
      const previousQuorum = Math.floor((previousValidators.size * 2) / 3) + 1;
      const previousVotes = [...voters].filter((address) => previousValidators.has(address)).length;
      if (previousVotes < previousQuorum) throw new Error("old-set transition quorum not reached");
    }
  }

  #verifyRoundCertificate(block, validators) {
    if (!Number.isSafeInteger(block.round) || block.round < 0 || block.round > MAX_CONSENSUS_ROUND) {
      throw new Error("invalid consensus round");
    }
    if (block.round === 0) {
      if (block.roundCertificate !== null) throw new Error("round zero cannot carry a timeout certificate");
      return;
    }
    if (!Array.isArray(block.roundCertificate) || block.roundCertificate.length > validators.size) {
      throw new Error("invalid round timeout certificate size");
    }
    const payload = roundTimeoutPayload({
      blockHash: blockHash(block), height: block.height, networkId: block.networkId,
      nextRound: block.round, previousHash: block.previousHash,
    });
    const signers = new Set();
    for (const vote of block.roundCertificate) {
      const validator = validators.get(vote.validator);
      if (!validator || signers.has(vote.validator) ||
          typeof vote.signature !== "string" || vote.signature.length > 7_000 ||
          !verifyObject(payload, vote.signature, validator.publicKey, "ROUND_TIMEOUT")) {
        throw new Error("invalid or duplicate round timeout vote");
      }
      signers.add(vote.validator);
    }
    const quorum = Math.floor((validators.size * 2) / 3) + 1;
    if (signers.size < quorum) throw new Error("round timeout quorum not reached");
  }

  #verifyFallbackBeacon(claim, candidateId, round) {
    if (claim?.candidateId !== candidateId || claim?.networkId !== this.#networkId ||
        claim?.round !== round || !/^[0-9a-f]{64}$/.test(claim?.value ?? "") ||
        !Array.isArray(claim.attestations) || claim.attestations.length > this.#beaconAuthorities.size) {
      throw new Error("fallback beacon is invalid");
    }
    const signers = new Set();
    for (const attestation of claim.attestations) {
      const authority = this.#beaconAuthorities.get(attestation.authority);
      const payload = {
        authority: attestation.authority, candidateId, networkId: this.#networkId,
        round, value: attestation.value,
      };
      if (!authority || signers.has(attestation.authority) ||
          !/^[0-9a-f]{64}$/.test(attestation.value ?? "") ||
          !verifyObject(payload, attestation.signature, authority.publicKey, "FALLBACK_RANDOMNESS_SHARE")) {
        throw new Error("fallback beacon signature is invalid or duplicated");
      }
      signers.add(attestation.authority);
    }
    if (signers.size < this.#beaconQuorum) throw new Error("fallback beacon quorum not reached");
    const expectedValue = hashObject({
      candidateId, networkId: this.#networkId, round,
      shares: [...claim.attestations]
        .map(({ authority, value }) => ({ authority, value }))
        .sort((a, b) => a.authority.localeCompare(b.authority)),
    }, "FALLBACK_RANDOMNESS_SHARES");
    if (claim.value !== expectedValue) throw new Error("fallback beacon aggregate is invalid");
    return claim.value;
  }

  #verifyProgressBeacon(claim, candidateId, round, expectedCommittee) {
    if (claim?.candidateId !== candidateId || claim?.networkId !== this.#networkId ||
        claim?.round !== round || !/^[0-9a-f]{64}$/.test(claim?.value ?? "") ||
        !Array.isArray(claim.attestations) ||
        claim.attestations.length !== expectedCommittee.length) {
      throw new Error("progress beacon is invalid");
    }
    const required = new Set(expectedCommittee);
    const signers = new Set();
    for (const attestation of claim.attestations) {
      const authority = this.#beaconAuthorities.get(attestation.authority);
      const payload = {
        authority: attestation.authority, candidateId, networkId: this.#networkId,
        round, value: attestation.value,
      };
      if (!authority || !required.has(attestation.authority) || signers.has(attestation.authority) ||
          !/^[0-9a-f]{64}$/.test(attestation.value ?? "") ||
          !verifyObject(payload, attestation.signature, authority.publicKey, "PROGRESS_RANDOMNESS_SHARE")) {
        throw new Error("progress beacon signature is invalid or duplicated");
      }
      signers.add(attestation.authority);
    }
    if (signers.size !== required.size || [...required].some((address) => !signers.has(address))) {
      throw new Error("assigned progress beacon committee is incomplete");
    }
    const expectedValue = hashObject({
      candidateId, networkId: this.#networkId, round,
      shares: [...claim.attestations]
        .map(({ authority, value }) => ({ authority, value }))
        .sort((a, b) => a.authority.localeCompare(b.authority)),
    }, "PROGRESS_RANDOMNESS_SHARES");
    if (claim.value !== expectedValue) throw new Error("progress beacon aggregate is invalid");
    return claim.value;
  }

  #consumeTransferCredit(
    address, height, creditStakes, creditUsage, creditDelegations, delegate = null,
  ) {
    const stake = creditStakes.get(address) ?? 0n;
    const allowance = (stake * BigInt(TRANSFER_CREDITS_PER_STAKE_UNIT)) /
      TRANSFER_CREDIT_STAKE_UNIT;
    const epoch = Math.floor((height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
    const previous = creditUsage.get(address);
    const spent = previous?.epoch === epoch ? previous.spent : 0;
    if (allowance <= BigInt(spent)) throw new Error("transfer credit quota is exhausted");
    let delegation = null;
    let delegationSpent = 0;
    if (delegate !== null) {
      const key = creditDelegationKey(address, delegate);
      delegation = creditDelegations.get(key);
      if (!delegation) throw new Error("transfer credit delegation is missing");
      delegationSpent = delegation.epoch === epoch ? delegation.spent : 0;
      if (delegationSpent >= delegation.limit) {
        throw new Error("transfer credit delegation is exhausted");
      }
      creditDelegations.set(key, { ...delegation, epoch, spent: delegationSpent + 1 });
    }
    creditUsage.set(address, { epoch, spent: spent + 1 });
  }

  #applyTransfer(
    transaction, balances, nonces, proposer, timestamp, height,
    creditStakes, creditUsage, creditDelegations,
  ) {
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
    const creditPaid = transaction.resource === "transfer-credit";
    if (transaction.resource !== undefined && !creditPaid) {
      throw new Error("unknown transfer resource");
    }
    if (amount === 0n) throw new Error("transfer amount must be positive");
    if ((!creditPaid && fee < MIN_TRANSFER_FEE) || (creditPaid && fee !== 0n)) {
      throw new Error("transfer fee is below the protocol minimum");
    }
    const senderBalance = balances.get(transaction.sender) ?? 0n;
    const sponsorFields = [
      transaction.feePayer,
      transaction.feePayerAlgorithm,
      transaction.feePayerNonce,
      transaction.feePayerPublicKey,
      transaction.feePayerSignature,
    ];
    const sponsored = sponsorFields.every((value) => value !== undefined);
    if (!sponsored && sponsorFields.some((value) => value !== undefined)) {
      throw new Error("sponsored transfer fields are incomplete");
    }
    const delegated = transaction.creditOwner !== undefined;
    if (delegated && (!creditPaid || sponsored || transaction.creditOwner === transaction.sender)) {
      throw new Error("delegated transfer credit payer is invalid");
    }
    if (delegated) assertAddress(transaction.creditOwner, "transfer credit owner");
    let feePayerBalance = 0n;
    let expectedFeePayerNonce = 0;
    if (sponsored) {
      if (
        transaction.feePayer === transaction.sender ||
        transaction.feePayerAlgorithm !== SIGNATURE_ALGORITHM ||
        typeof transaction.feePayerPublicKey !== "string" || transaction.feePayerPublicKey.length > 4_000 ||
        typeof transaction.feePayerSignature !== "string" || transaction.feePayerSignature.length > 7_000 ||
        addressFromPublicKey(transaction.feePayerPublicKey) !== transaction.feePayer ||
        !Number.isSafeInteger(transaction.feePayerNonce) || transaction.feePayerNonce < 0
      ) throw new Error("sponsored transfer fee payer is invalid");
      const { feePayerSignature: _feePayerSignature, ...sponsorPayload } = transaction;
      if (!verifyObject(
        sponsorPayload,
        transaction.feePayerSignature,
        transaction.feePayerPublicKey,
        "SPONSORED_TRANSFER",
      )) throw new Error("invalid fee payer signature");
      expectedFeePayerNonce = nonces.get(transaction.feePayer) ?? 0;
      if (transaction.feePayerNonce !== expectedFeePayerNonce) {
        throw new Error("unexpected fee payer nonce");
      }
      feePayerBalance = balances.get(transaction.feePayer) ?? 0n;
      if (senderBalance < amount || (!creditPaid && feePayerBalance < fee)) {
        throw new Error("insufficient balance");
      }
    } else if (senderBalance < amount + fee) {
      throw new Error("insufficient balance");
    }
    if (transaction.sender === this.#treasuryAddress) {
      const locked = TREASURY_ALLOCATION - vestedTreasuryAtTimestamp(
        this.#genesisTimestamp,
        timestamp,
      );
      if (senderBalance - amount - (sponsored ? 0n : fee) < locked) {
        throw new Error("treasury funds are still vesting");
      }
    }
    if (sponsored && !creditPaid && transaction.feePayer === this.#treasuryAddress) {
      const locked = TREASURY_ALLOCATION - vestedTreasuryAtTimestamp(
        this.#genesisTimestamp,
        timestamp,
      );
      if (feePayerBalance - fee < locked) throw new Error("treasury funds are still vesting");
    }
    if (creditPaid) {
      this.#consumeTransferCredit(
        sponsored ? transaction.feePayer : delegated ? transaction.creditOwner : transaction.sender,
        height,
        creditStakes,
        creditUsage,
        creditDelegations,
        delegated ? transaction.sender : null,
      );
    }
    balances.set(transaction.sender, senderBalance - amount - (sponsored ? 0n : fee));
    balances.set(transaction.recipient, (balances.get(transaction.recipient) ?? 0n) + amount);
    if (sponsored) {
      if (!creditPaid) {
        balances.set(transaction.feePayer, (balances.get(transaction.feePayer) ?? 0n) - fee);
      }
      nonces.set(transaction.feePayer, expectedFeePayerNonce + 1);
    }
    if (!creditPaid) balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
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

  #applyProgressCommitment(transaction, nonces, progressCommitments, height, randomnessRound) {
    if (
      transaction.type !== "progress-commitment" ||
      transaction.algorithm !== SIGNATURE_ALGORITHM ||
      transaction.networkId !== this.#networkId ||
      !/^sha256:[0-9a-f]{64}$/.test(transaction.artifactHash ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(transaction.baselineHash ?? "") ||
      transaction.artifactHash === transaction.baselineHash ||
      !/^[0-9a-f]{64}$/.test(transaction.suiteCommitment ?? "")
    ) {
      throw new Error("progress commitment transaction is invalid");
    }
    assertAddress(transaction.sender, "progress submitter");
    assertAddress(transaction.recipient, "progress recipient");
    const expectedId = progressCandidateId(transaction);
    if (
      transaction.candidateId !== expectedId ||
      progressCommitments.has(expectedId) ||
      progressCommitments.size >= MAX_PENDING_PROGRESS_COMMITMENTS ||
      [...progressCommitments.values()].some(({ sender }) => sender === transaction.sender)
    ) {
      throw new Error("progress commitment is duplicated or capacity is exhausted");
    }
    if (
      typeof transaction.publicKey !== "string" ||
      transaction.publicKey.length > 4_000 ||
      typeof transaction.signature !== "string" ||
      transaction.signature.length > 7_000 ||
      addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
      !verifyObject(
        unsignedTransaction(transaction),
        transaction.signature,
        transaction.publicKey,
        "PROGRESS_COMMITMENT",
      )
    ) {
      throw new Error("invalid progress commitment signature");
    }
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0) {
      throw new Error("invalid transaction nonce");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    nonces.set(transaction.sender, expectedNonce + 1);
    progressCommitments.set(expectedId, {
      artifactHash: transaction.artifactHash,
      baselineHash: transaction.baselineHash,
      beaconCommittee: null,
      beaconCommitteeHeight: null,
      beaconCommitteeSource: null,
      beaconRandomnessRound: null,
      beaconValue: null,
      challengeHeight: null,
      challengeSeed: null,
      committee: null,
      committedHeight: height,
      randomnessRound,
      recipient: transaction.recipient,
      sender: transaction.sender,
      suiteCommitment: transaction.suiteCommitment,
    });
  }

  #applyValidatorBond(transaction, balances, nonces, validatorBonds, registeredValidators, proposer) {
    let validator = registeredValidators.get(transaction.sender);
    if (transaction.type !== "validator-bond" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature, transaction.publicKey, "VALIDATOR_BOND")) {
      throw new Error("validator bond transaction is invalid");
    }
    if (!validator) {
      if (typeof transaction.operatorId !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(transaction.operatorId) ||
          registeredValidators.size >= MAX_VALIDATORS ||
          this.#evaluators.has(transaction.sender) || this.#beaconAuthorities.has(transaction.sender) ||
          [...registeredValidators.values(), ...this.#evaluators.values(), ...this.#beaconAuthorities.values()]
            .some(({ operatorId }) => operatorId === transaction.operatorId)) {
        throw new Error("new validator operator id is invalid or duplicated");
      }
      validator = {
        address: transaction.sender, algorithm: transaction.algorithm,
        operatorId: transaction.operatorId, publicKey: transaction.publicKey,
      };
      registeredValidators.set(transaction.sender, validator);
    } else if (validator.publicKey !== transaction.publicKey ||
        (transaction.operatorId !== undefined && transaction.operatorId !== validator.operatorId)) {
      throw new Error("validator identity does not match its registration");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    const amount = parseAtomic(transaction.amount, "validator bond");
    const fee = parseAtomic(transaction.fee, "fee");
    if (amount === 0n || fee < MIN_TRANSFER_FEE) throw new Error("validator bond or fee is below minimum");
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < amount + fee) throw new Error("insufficient balance");
    balances.set(transaction.sender, balance - amount - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    validatorBonds.set(transaction.sender, (validatorBonds.get(transaction.sender) ?? 0n) + amount);
  }

  #applyBeaconBond(transaction, balances, nonces, beaconBonds, proposer, epochRandomness) {
    const authority = this.#beaconAuthorities.get(transaction.sender);
    if (transaction.type !== "beacon-bond" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId || !authority ||
        epochRandomness.snapshot().disabled.includes(transaction.sender) ||
        authority.publicKey !== transaction.publicKey ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature, transaction.publicKey, "BEACON_BOND")) {
      throw new Error("beacon bond transaction is invalid");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    const amount = parseAtomic(transaction.amount, "beacon bond");
    const fee = parseAtomic(transaction.fee, "fee");
    if (amount === 0n || fee < MIN_TRANSFER_FEE) {
      throw new Error("beacon bond or fee is below minimum");
    }
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < amount + fee) throw new Error("insufficient balance");
    balances.set(transaction.sender, balance - amount - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    beaconBonds.set(transaction.sender, (beaconBonds.get(transaction.sender) ?? 0n) + amount);
  }

  #applyCreditStake(transaction, balances, nonces, creditStakes, proposer, timestamp) {
    if (transaction.type !== "credit-stake" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature, transaction.publicKey, "CREDIT_STAKE")) {
      throw new Error("credit stake transaction is invalid");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    const amount = parseAtomic(transaction.amount, "credit stake");
    const fee = parseAtomic(transaction.fee, "fee");
    if (amount === 0n || fee < MIN_TRANSFER_FEE) {
      throw new Error("credit stake or fee is below minimum");
    }
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < amount + fee) throw new Error("insufficient balance");
    if (transaction.sender === this.#treasuryAddress) {
      const locked = TREASURY_ALLOCATION - vestedTreasuryAtTimestamp(this.#genesisTimestamp, timestamp);
      if (balance - amount - fee < locked) throw new Error("treasury funds are still vesting");
    }
    balances.set(transaction.sender, balance - amount - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    creditStakes.set(transaction.sender, (creditStakes.get(transaction.sender) ?? 0n) + amount);
  }

  #applyCreditDelegation(
    transaction, balances, nonces, creditStakes, creditDelegations, proposer, timestamp, height,
  ) {
    if (transaction.type !== "credit-delegation" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(
          unsignedTransaction(transaction), transaction.signature,
          transaction.publicKey, "CREDIT_DELEGATION",
        )) throw new Error("credit delegation transaction is invalid");
    assertAddress(transaction.delegate, "credit delegate");
    if (transaction.delegate === transaction.sender ||
        !Number.isSafeInteger(transaction.limit) || transaction.limit < 0 ||
        transaction.limit > 1_000_000) {
      throw new Error("credit delegation limit is invalid");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    if (transaction.limit > 0 &&
        (creditStakes.get(transaction.sender) ?? 0n) < TRANSFER_CREDIT_STAKE_UNIT) {
      throw new Error("credit delegation owner has insufficient stake");
    }
    const fee = parseAtomic(transaction.fee, "fee");
    if (fee < MIN_TRANSFER_FEE) throw new Error("transfer fee is below the protocol minimum");
    const balance = balances.get(transaction.sender) ?? 0n;
    const stake = creditStakes.get(transaction.sender) ?? 0n;
    const payRevocationFromStake = transaction.limit === 0 && balance < fee;
    if ((!payRevocationFromStake && balance < fee) || (payRevocationFromStake && stake < fee)) {
      throw new Error("insufficient balance");
    }
    if (!payRevocationFromStake && transaction.sender === this.#treasuryAddress) {
      const locked = TREASURY_ALLOCATION - vestedTreasuryAtTimestamp(this.#genesisTimestamp, timestamp);
      if (balance - fee < locked) throw new Error("treasury funds are still vesting");
    }
    const key = creditDelegationKey(transaction.sender, transaction.delegate);
    const previous = creditDelegations.get(key);
    if (transaction.limit === 0) {
      if (!previous) throw new Error("credit delegation does not exist");
      creditDelegations.delete(key);
    } else {
      const owned = [...creditDelegations.values()]
        .filter(({ owner }) => owner === transaction.sender).length;
      if (!previous && owned >= MAX_CREDIT_DELEGATIONS_PER_OWNER) {
        throw new Error("credit delegation capacity is exhausted");
      }
      const epoch = Math.floor((height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
      creditDelegations.set(key, {
        delegate: transaction.delegate,
        epoch,
        limit: transaction.limit,
        owner: transaction.sender,
        spent: previous?.epoch === epoch ? previous.spent : 0,
      });
    }
    if (payRevocationFromStake) creditStakes.set(transaction.sender, stake - fee);
    else balances.set(transaction.sender, balance - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
  }

  #applyCreditUnstakeRequest(
    transaction, nonces, creditStakes, creditUnstakes, proposer, balances, height,
  ) {
    if (transaction.type !== "credit-unstake-request" ||
        transaction.algorithm !== SIGNATURE_ALGORITHM || transaction.networkId !== this.#networkId ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(
          unsignedTransaction(transaction), transaction.signature,
          transaction.publicKey, "CREDIT_UNSTAKE_REQUEST",
        )) throw new Error("credit unstake request is invalid");
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    if (creditUnstakes.has(transaction.sender)) throw new Error("credit unstake is already pending");
    const amount = parseAtomic(transaction.amount, "credit unstake amount");
    const fee = parseAtomic(transaction.fee, "fee");
    const stake = creditStakes.get(transaction.sender) ?? 0n;
    if (fee < MIN_TRANSFER_FEE || amount <= fee || stake < amount) {
      throw new Error("credit unstake amount or fee is invalid");
    }
    creditStakes.set(transaction.sender, stake - amount);
    creditUnstakes.set(transaction.sender, {
      amount: amount - fee,
      unlockHeight: height + CREDIT_UNSTAKE_DELAY_BLOCKS,
    });
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
  }

  #applyCreditUnstakeClaim(
    transaction, nonces, creditUnstakes, balances, height,
    creditStakes, creditUsage, creditDelegations,
  ) {
    if (transaction.type !== "credit-unstake-claim" ||
        transaction.algorithm !== SIGNATURE_ALGORITHM || transaction.networkId !== this.#networkId ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(
          unsignedTransaction(transaction), transaction.signature,
          transaction.publicKey, "CREDIT_UNSTAKE_CLAIM",
        )) throw new Error("credit unstake claim is invalid");
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    const pending = creditUnstakes.get(transaction.sender);
    if (!pending || height < pending.unlockHeight) throw new Error("credit unstake is not unlocked");
    balances.set(transaction.sender, (balances.get(transaction.sender) ?? 0n) + pending.amount);
    creditUnstakes.delete(transaction.sender);
    if ((creditStakes.get(transaction.sender) ?? 0n) === 0n) {
      creditUsage.delete(transaction.sender);
      for (const [key, delegation] of creditDelegations) {
        if (delegation.owner === transaction.sender) creditDelegations.delete(key);
      }
    }
    nonces.set(transaction.sender, expectedNonce + 1);
  }

  appendBlock(block) {
    return this.#applyBlock(block, true);
  }

  fork() {
    const fork = new NirChain(this.#genesisConfig);
    fork.#balances = new Map(this.#balances);
    fork.#beaconBondingActive = this.#beaconBondingActive;
    fork.#beaconBonds = new Map(this.#beaconBonds);
    fork.#beaconFaults = new Map(this.#beaconFaults);
    fork.#blocks = structuredClone(this.#blocks);
    fork.#burned = this.#burned;
    fork.#candidateBonds = new Map([...this.#candidateBonds].map(([id, candidate]) => [id, {
      ...structuredClone(candidate),
      randomnessCommits: new Map(candidate.randomnessCommits),
      randomnessReveals: new Map(candidate.randomnessReveals),
    }]));
    fork.#creditDelegations = new Map([...this.#creditDelegations]
      .map(([key, delegation]) => [key, { ...delegation }]));
    fork.#creditStakes = new Map(this.#creditStakes);
    fork.#creditUnstakes = new Map([...this.#creditUnstakes]
      .map(([address, pending]) => [address, { ...pending }]));
    fork.#creditUsage = new Map([...this.#creditUsage]
      .map(([address, usage]) => [address, { ...usage }]));
    fork.#capabilityMemory = this.#capabilityMemory.clone();
    fork.#epochRandomness = EpochRandomnessMachine.fromSnapshot({
      networkId: this.#networkId,
      registry: this.#beaconAuthorities,
      committeeSize: this.#beaconQuorum,
      snapshot: this.#epochRandomness.snapshot(),
    });
    fork.#lastRewardTimestamp = this.#lastRewardTimestamp;
    fork.#mined = this.#mined;
    fork.#nonces = new Map(this.#nonces);
    fork.#pendingValidatorRotation = structuredClone(this.#pendingValidatorRotation);
    fork.#peerRegistry = structuredClone(this.#peerRegistry);
    fork.#progressCommitments = new Map(this.#progressCommitments);
    fork.#randomnessFaults = new Map(this.#randomnessFaults);
    fork.#registeredValidators = new Map(this.#registeredValidators);
    fork.#rewardEpoch = this.#rewardEpoch;
    fork.#rewardedProofs = new Set(this.#rewardedProofs);
    fork.#safetyEvidence = new Set(this.#safetyEvidence);
    fork.#validatorBonds = new Map(this.#validatorBonds);
    fork.#validatorFaults = new Map(this.#validatorFaults);
    fork.#validators = new Map(this.#validators);
    fork.#validatorOrder = [...this.#validatorOrder];
    fork.#quorum = this.#quorum;
    return fork;
  }

  validateProposal(block) {
    if (block?.hash !== undefined || block?.certificate !== undefined) {
      throw new Error("proposal must not contain finality fields");
    }
    const fork = this.fork();
    const candidate = {
      ...structuredClone(block), certificate: [], hash: blockHash(block), prepareCertificate: [],
    };
    fork.#applyBlock(candidate, false);
    return candidate.hash;
  }

  #applyBlock(block, verifyCertificate, verifyStateRoot = true) {
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
        !Array.isArray(block.randomnessReveals) || !Array.isArray(block.fallbackBeacons) ||
        !Array.isArray(block.progressBeacons) || !Array.isArray(block.epochRandomnessCommits) ||
        !Array.isArray(block.epochRandomnessReveals)) {
      throw new Error("block collections are invalid");
    }
    const blockValidatorMembers = this.#validatorsForHeight(block.height);
    const blockValidators = new Map(blockValidatorMembers.map((member) => [member.address, member]));
    const blockQuorum = Math.floor((blockValidators.size * 2) / 3) + 1;
    this.#verifyRoundCertificate(block, blockValidators);
    if (block.randomnessCommits.length > blockValidators.size ||
        block.randomnessReveals.length > blockValidators.size ||
        block.epochRandomnessCommits.length > this.#beaconAuthorities.size ||
        block.epochRandomnessReveals.length > this.#beaconAuthorities.size ||
        block.fallbackBeacons.length > MAX_SAFETY_SETTLEMENTS_PER_BLOCK ||
        block.progressBeacons.length > MAX_PROGRESS_REWARDS_PER_BLOCK) {
      throw new Error("too many randomness contributions");
    }
    if (block.transactions.length > MAX_TRANSACTIONS_PER_BLOCK) {
      throw new Error("too many transactions in one block");
    }
    if (block.transactions.filter(({ resource }) => resource === "transfer-credit").length >
        MAX_CREDIT_TRANSFERS_PER_BLOCK) {
      throw new Error("too many credit-paid transfers in one block");
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
    if (block.proposer !== this.expectedProposer(block.height, block.round)) {
      throw new Error("unexpected block proposer");
    }
    if (block.feeRecipient !== this.expectedProposer(block.height, 0)) {
      throw new Error("unexpected block fee recipient");
    }
    const transitionValidators = this.#pendingValidatorRotation &&
      block.height === this.#pendingValidatorRotation.activationHeight
      ? this.#validators
      : null;
    if (verifyCertificate) {
      this.#verifyCertificate(block, blockValidators, transitionValidators);
    } else if (block.hash !== blockHash(block)) {
      throw new Error("block hash mismatch");
    }

    if ((block.validatorRotation !== null || this.#pendingValidatorRotation) &&
        block.peerRegistryUpdate !== null) {
      throw new Error("validator and peer registry rotations require separate blocks");
    }
    const activatingOnboarding = this.#pendingValidatorRotation?.activationHeight === block.height
      ? this.#pendingValidatorRotation.onboarding ?? null : null;
    let nextPeerRegistry = activatingOnboarding ?? this.#peerRegistry;
    if (block.peerRegistryUpdate !== null) {
      nextPeerRegistry = verifyPeerRegistry(block.peerRegistryUpdate, {
        currentHeight: block.height,
        networkId: this.#networkId,
        previousRegistry: this.#peerRegistry,
        validators: [...this.#validators.values()],
      });
      if (nextPeerRegistry.activationHeight !== block.height) {
        throw new Error("peer registry must activate at its containing block height");
      }
    }
    const expectedPeerRegistryHash = nextPeerRegistry
      ? peerRegistryHash(nextPeerRegistry) : "0".repeat(64);
    if (block.peerRegistryHash !== expectedPeerRegistryHash) {
      throw new Error("block peer registry commitment is invalid");
    }

    const capabilityMemory = this.#capabilityMemory.clone();
    const epochRandomness = EpochRandomnessMachine.fromSnapshot({
      networkId: this.#networkId,
      registry: this.#beaconAuthorities,
      committeeSize: this.#beaconQuorum,
      snapshot: this.#epochRandomness.snapshot(),
    });
    const epochFault = epochRandomness.expire(block.height, EPOCH_REVEAL_TIMEOUT_BLOCKS);
    for (const commitment of block.epochRandomnessCommits) {
      if (this.#beaconBondingActive &&
          (this.#beaconBonds.get(commitment.authority) ?? 0n) < MIN_BEACON_BOND) {
        throw new Error("epoch randomness authority bond is below minimum");
      }
      epochRandomness.commit(commitment, block.height);
    }
    for (const reveal of block.epochRandomnessReveals) {
      if (this.#beaconBondingActive &&
          (this.#beaconBonds.get(reveal.authority) ?? 0n) < MIN_BEACON_BOND) {
        throw new Error("epoch randomness authority bond is below minimum");
      }
      epochRandomness.reveal(reveal, block.height);
    }
    for (const claim of block.progressRewards) {
      this.#verifyProgressClaim(
        claim,
        block.height,
        capabilityMemory,
        this.#progressCommitments,
      );
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
    let beaconBondingActive = this.#beaconBondingActive;
    const beaconBonds = new Map(this.#beaconBonds);
    const beaconFaults = new Map(this.#beaconFaults);
    const creditDelegations = new Map([...this.#creditDelegations]
      .map(([key, delegation]) => [key, { ...delegation }]));
    const creditStakes = new Map(this.#creditStakes);
    const creditUnstakes = new Map([...this.#creditUnstakes]
      .map(([address, pending]) => [address, { ...pending }]));
    const creditUsage = new Map([...this.#creditUsage]
      .map(([address, usage]) => [address, { ...usage }]));
    const nonces = new Map(this.#nonces);
    const rewardedProofs = new Set(this.#rewardedProofs);
    const candidateBonds = new Map([...this.#candidateBonds].map(([id, candidate]) => [id, {
      ...candidate,
      randomnessCommits: new Map(candidate.randomnessCommits),
      randomnessReveals: new Map(candidate.randomnessReveals),
    }]));
    const safetyEvidence = new Set(this.#safetyEvidence);
    const randomnessFaults = new Map(this.#randomnessFaults);
    const validatorFaults = new Map(this.#validatorFaults);
    const validatorBonds = new Map(this.#validatorBonds);
    const registeredValidators = new Map(this.#registeredValidators);
    const progressCommitments = new Map(this.#progressCommitments);
    let scheduledRotation = null;
    if (block.validatorRotation !== null) {
      if (this.#pendingValidatorRotation) throw new Error("a validator rotation is already pending");
      if (!block.validatorRotation || !Array.isArray(block.validatorRotation.validators)) {
        throw new Error("validator rotation is invalid");
      }
      const proposed = block.validatorRotation.validators.map(({ address }) => {
        const member = registeredValidators.get(address);
        if (!member) throw new Error("proposed validator is not registered");
        return member;
      });
      scheduledRotation = scheduleValidatorRotation({
        current: [...this.#validators.values()], proposed, bonds: validatorBonds,
        currentHeight: previous.height,
        activationHeight: block.validatorRotation.activationHeight,
      });
      if (this.#peerRegistry) {
        const onboarding = verifyValidatorOnboarding(block.validatorRotation.onboarding, {
          activationHeight: scheduledRotation.activationHeight,
          currentPeerRegistry: this.#peerRegistry,
          currentValidators: [...this.#validators.values()],
          networkId: this.#networkId,
          nextValidators: scheduledRotation.validators,
        });
        scheduledRotation = { ...scheduledRotation, onboarding };
      } else if (block.validatorRotation.onboarding != null) {
        throw new Error("validator onboarding requires an active peer registry");
      }
      if (hashObject(scheduledRotation, "VALIDATOR_ROTATION") !==
          hashObject(block.validatorRotation, "VALIDATOR_ROTATION")) {
        throw new Error("validator rotation does not match registered consensus state");
      }
    }
    let newlyBurned = 0n;
    if (beaconBondingActive && epochFault) {
      for (const address of epochFault.nonRevealers) {
        const currentBond = beaconBonds.get(address) ?? 0n;
        if (currentBond < MIN_BEACON_BOND) {
          throw new Error("epoch randomness fault references an ineligible authority");
        }
        const proportional = (currentBond * BEACON_NON_REVEAL_SLASH_BPS) / 10_000n;
        const penalty = proportional > 0n ? proportional : 1n;
        const remaining = currentBond - penalty;
        beaconBonds.set(address, remaining);
        beaconFaults.set(address, (beaconFaults.get(address) ?? 0) + 1);
        newlyBurned += penalty;
        if (remaining < MIN_BEACON_BOND) epochRandomness.disable(address);
      }
    }
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
      progressCommitments.delete(reward.evaluation.candidateId);
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
        this.#applyTransfer(
          transaction, balances, nonces, block.feeRecipient, block.timestamp,
          block.height, creditStakes, creditUsage, creditDelegations,
        );
      } else if (transaction.type === "candidate-bond") {
        this.#applyCandidateBond(
          transaction, balances, nonces, candidateBonds, block.feeRecipient,
          block.timestamp, block.height,
        );
      } else if (transaction.type === "progress-commitment") {
        this.#applyProgressCommitment(
          transaction,
          nonces,
          progressCommitments,
          block.height,
          epochRandomness.round,
        );
      } else if (transaction.type === "validator-bond") {
        this.#applyValidatorBond(transaction, balances, nonces, validatorBonds, registeredValidators, block.feeRecipient);
      } else if (transaction.type === "beacon-bond") {
        this.#applyBeaconBond(
          transaction, balances, nonces, beaconBonds, block.feeRecipient, epochRandomness,
        );
      } else if (transaction.type === "credit-stake") {
        this.#applyCreditStake(
          transaction, balances, nonces, creditStakes, block.feeRecipient, block.timestamp,
        );
      } else if (transaction.type === "credit-delegation") {
        this.#applyCreditDelegation(
          transaction, balances, nonces, creditStakes, creditDelegations,
          block.feeRecipient, block.timestamp, block.height,
        );
      } else if (transaction.type === "credit-unstake-request") {
        this.#applyCreditUnstakeRequest(
          transaction, nonces, creditStakes, creditUnstakes,
          block.feeRecipient, balances, block.height,
        );
      } else if (transaction.type === "credit-unstake-claim") {
        this.#applyCreditUnstakeClaim(
          transaction, nonces, creditUnstakes, balances, block.height,
          creditStakes, creditUsage, creditDelegations,
        );
      } else {
        throw new Error("unknown transaction type");
      }
    }
    if (!beaconBondingActive && [...this.#beaconAuthorities.keys()].every(
      (address) => (beaconBonds.get(address) ?? 0n) >= MIN_BEACON_BOND,
    )) beaconBondingActive = true;

    for (const [candidateId, commitment] of progressCommitments) {
      if (block.height > commitment.committedHeight + MAX_PROGRESS_COMMITMENT_AGE) {
        progressCommitments.delete(candidateId);
      }
    }

    for (const [candidateId, commitment] of progressCommitments) {
      if (commitment.beaconCommittee === null &&
          epochRandomness.round > commitment.randomnessRound) {
        const randomness = epochRandomness.previousSeed;
        const randomnessRound = epochRandomness.round - 1;
        progressCommitments.set(candidateId, {
          ...commitment,
          beaconCommittee: selectOperatorCommittee({
            registry: this.#beaconAuthorities,
            randomness,
            context: { candidateId, randomnessRound },
            size: this.#beaconQuorum,
          }).map(({ address }) => address),
          beaconCommitteeHeight: block.height,
          beaconCommitteeSource: randomness,
          beaconRandomnessRound: randomnessRound,
        });
      }
    }

    const progressedBeacons = new Set();
    for (const claim of block.progressBeacons) {
      const commitment = progressCommitments.get(claim.candidateId);
      if (
        !commitment ||
        !Array.isArray(commitment.beaconCommittee) ||
        block.height <= commitment.beaconCommitteeHeight ||
        commitment.challengeSeed !== null ||
        progressedBeacons.has(claim.candidateId) ||
        block.height <= commitment.committedHeight ||
        block.height > commitment.committedHeight + MAX_PROGRESS_COMMITMENT_AGE
      ) {
        throw new Error("progress beacon target is invalid or already assigned");
      }
      const beaconValue = this.#verifyProgressBeacon(
        claim,
        claim.candidateId,
        block.height,
        commitment.beaconCommittee,
      );
      const challengeSeed = hashObject(
        { beaconValue, candidateId: claim.candidateId },
        "PROGRESS_CHALLENGE",
      );
      progressCommitments.set(claim.candidateId, {
        ...commitment,
        beaconValue,
        challengeHeight: block.height,
        challengeSeed,
        committee: selectOperatorCommittee({
          registry: this.#evaluators,
          randomness: challengeSeed,
          context: { candidateId: claim.candidateId, challengeHeight: block.height },
          size: this.#evaluationQuorum,
        }).map(({ address }) => address),
      });
      progressedBeacons.add(claim.candidateId);
    }

    for (const contribution of block.randomnessCommits) {
      const candidate = candidateBonds.get(contribution.candidateId);
      const validator = blockValidators.get(contribution.contributor);
      const payload = {
        candidateId: contribution.candidateId, commitment: contribution.commitment,
        contributor: contribution.contributor, networkId: contribution.networkId,
      };
      if (!candidate || candidate.committee !== null || block.height !== candidate.committedHeight + 1 ||
          contribution.networkId !== this.#networkId || !/^[0-9a-f]{64}$/.test(contribution.commitment ?? "") ||
          !validator || (validatorBonds.get(contribution.contributor) ?? 0n) < MIN_VALIDATOR_BOND ||
          candidate.randomnessCommits.has(contribution.contributor) ||
          !verifyObject(payload, contribution.signature, validator.publicKey, "RANDOMNESS_COMMIT")) {
        throw new Error("invalid or duplicate randomness commitment");
      }
      candidate.randomnessCommits.set(contribution.contributor, contribution.commitment);
    }

    for (const contribution of block.randomnessReveals) {
      const candidate = candidateBonds.get(contribution.candidateId);
      const validator = blockValidators.get(contribution.contributor);
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

    const fallbackBeacons = new Map();
    for (const claim of block.fallbackBeacons) {
      const candidate = candidateBonds.get(claim.candidateId);
      if (!candidate || fallbackBeacons.has(claim.candidateId) ||
          block.height !== candidate.committedHeight + 3) throw new Error("fallback beacon target is invalid");
      fallbackBeacons.set(claim.candidateId, this.#verifyFallbackBeacon(claim, claim.candidateId, block.height));
    }

    for (const [candidateId, candidate] of candidateBonds) {
      if (candidate.committee === null && candidate.randomnessReveals.size >= blockQuorum) {
        const randomness = combineRandomnessReveals({
          networkId: this.#networkId, candidateId,
          commitments: candidate.randomnessCommits,
          reveals: candidate.randomnessReveals,
          quorum: blockQuorum,
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
      } else if (candidate.committee === null && block.height >= candidate.committedHeight + 3 &&
          candidate.randomnessCommits.size >= blockQuorum) {
        const nonRevealers = [...candidate.randomnessCommits.keys()]
          .filter((address) => !candidate.randomnessReveals.has(address)).sort();
        if (nonRevealers.length > 0) {
          const fault = {
            candidateId,
            committedHeight: candidate.committedHeight,
            detectedHeight: block.height,
            nonRevealers,
            reason: "committed randomness contribution was not revealed",
          };
          randomnessFaults.set(candidateId, fault);
          for (const address of nonRevealers) {
            validatorFaults.set(address, (validatorFaults.get(address) ?? 0) + 1);
            const currentBond = validatorBonds.get(address) ?? 0n;
            const proportional = (currentBond * NON_REVEAL_SLASH_BPS) / 10_000n;
            const penalty = proportional > 0n ? proportional : 1n;
            validatorBonds.set(address, currentBond - penalty);
            newlyBurned += penalty;
          }
          const fallbackValue = fallbackBeacons.get(candidateId);
          if (fallbackValue) {
            const randomness = hashObject({
              candidateId,
              fallbackValue,
              reveals: [...candidate.randomnessReveals.entries()].sort(([a], [b]) => a.localeCompare(b)),
            }, "FALLBACK_RANDOMNESS");
            candidateBonds.set(candidateId, {
              ...candidate,
              assignedHeight: block.height,
              committee: selectOperatorCommittee({
                registry: this.#evaluators, randomness,
                context: { candidateId, committedHeight: candidate.committedHeight },
                size: this.#evaluationQuorum,
              }).map(({ address }) => address),
              randomness,
              randomnessSource: "fallback-beacon",
            });
          } else {
            balances.set(candidate.submitter, (balances.get(candidate.submitter) ?? 0n) + candidate.bond);
            candidateBonds.delete(candidateId);
          }
        }
      }
    }

    let validatorsAfter = this.#validators;
    let validatorOrderAfter = this.#validatorOrder;
    let pendingValidatorRotationAfter = this.#pendingValidatorRotation;
    if (pendingValidatorRotationAfter &&
        block.height >= pendingValidatorRotationAfter.activationHeight) {
      validatorsAfter = new Map(blockValidatorMembers.map((member) => [member.address, member]));
      validatorOrderAfter = blockValidatorMembers.map(({ address }) => address);
      pendingValidatorRotationAfter = null;
    }
    if (scheduledRotation) pendingValidatorRotationAfter = scheduledRotation;
    const rewardEpochAfter = this.#rewardEpoch + (block.progressRewards.length > 0 ? 1 : 0);
    const lastRewardTimestampAfter = block.progressRewards.length > 0
      ? block.timestamp : this.#lastRewardTimestamp;
    const expectedStateRoot = this.#stateRoot({
      balances,
      beaconBondingActive,
      beaconBonds,
      beaconFaults,
      burned: this.#burned + newlyBurned,
      candidateBonds,
      capabilityMemoryRoot: capabilityMemory.stateRoot,
      creditDelegations,
      creditStakes,
      creditUnstakes,
      creditUsage,
      epochRandomness: epochRandomness.snapshot(),
      lastRewardTimestamp: lastRewardTimestampAfter,
      mined: this.#mined + newlyMined,
      nonces,
      pendingValidatorRotation: pendingValidatorRotationAfter,
      peerRegistry: nextPeerRegistry,
      progressCommitments,
      randomnessFaults,
      registeredValidators,
      rewardEpoch: rewardEpochAfter,
      rewardedProofs,
      safetyEvidence,
      validatorBonds,
      validatorFaults,
      validators: validatorsAfter,
    });
    if (verifyStateRoot && block.stateRoot !== expectedStateRoot) {
      throw new Error("block state root is invalid");
    }
    this.#balances = balances;
    this.#beaconBondingActive = beaconBondingActive;
    this.#beaconBonds = beaconBonds;
    this.#beaconFaults = beaconFaults;
    this.#burned += newlyBurned;
    this.#candidateBonds = candidateBonds;
    this.#creditDelegations = creditDelegations;
    this.#creditStakes = creditStakes;
    this.#creditUnstakes = creditUnstakes;
    this.#creditUsage = creditUsage;
    this.#nonces = nonces;
    this.#rewardedProofs = rewardedProofs;
    this.#randomnessFaults = randomnessFaults;
    this.#validatorFaults = validatorFaults;
    this.#validatorBonds = validatorBonds;
    this.#registeredValidators = registeredValidators;
    this.#peerRegistry = nextPeerRegistry;
    this.#progressCommitments = progressCommitments;
    this.#safetyEvidence = safetyEvidence;
    this.#capabilityMemory = capabilityMemory;
    this.#epochRandomness = epochRandomness;
    this.#mined += newlyMined;
    this.#rewardEpoch = rewardEpochAfter;
    this.#lastRewardTimestamp = lastRewardTimestampAfter;
    this.#validators = validatorsAfter;
    this.#validatorOrder = validatorOrderAfter;
    this.#quorum = Math.floor((this.#validatorOrder.length * 2) / 3) + 1;
    this.#pendingValidatorRotation = pendingValidatorRotationAfter;
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
