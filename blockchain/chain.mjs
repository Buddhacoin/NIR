import {
  ATOMIC_UNITS,
  BEACON_NON_REVEAL_SLASH_BPS,
  CREDIT_UNSTAKE_DELAY_BLOCKS,
  EPOCH_REVEAL_TIMEOUT_BLOCKS,
  EVALUATOR_ACTIVATION_DELAY_BLOCKS,
  EVALUATOR_CREDENTIAL_LIFETIME_BLOCKS,
  MAX_BLOCK_BYTES,
  MAX_CREDIT_TRANSFERS_PER_BLOCK,
  MAX_CREDIT_DELEGATIONS_PER_OWNER,
  MAX_CONSENSUS_ROUND,
  MAX_DECIMAL_DIGITS,
  MAX_FUTURE_DRIFT_MS,
  MAX_MULTISIG_MEMBERS,
  MAX_NATIVE_ASSETS,
  MAX_NATIVE_ASSET_BALANCES,
  MIN_TRANSFER_FEE,
  MIN_REWARD_INTERVAL_MS,
  MAX_PROGRESS_REWARDS_PER_BLOCK,
  MAX_PROGRESS_FRAUD_PROOFS_PER_BLOCK,
  MAX_SAFETY_SETTLEMENTS_PER_BLOCK,
  MAX_SUPPLY,
  MAX_TRANSACTIONS_PER_BLOCK,
  MAX_VALIDATORS,
  MIN_BEACON_BOND,
  MIN_EVALUATOR_BOND,
  MINING_POOL,
  MIN_PROGRESS_CANDIDATE_BOND,
  PROGRESS_REWARD_ESCROW_DELAY_BLOCKS,
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
  verifyOperatorCredential,
} from "./operators.mjs";
import {
  calculateSafetySettlement,
  safetyFailurePayload,
} from "./safety-bounty.mjs";
import { MIN_VALIDATOR_BOND, NON_REVEAL_SLASH_BPS } from "./validator-staking.mjs";
import {
  createValidatorRecoveryPeerRegistry, peerRegistryHash, verifyPeerRegistry,
} from "./peer-registry.mjs";
import {
  BEACON_ADMISSION_DELAY_BLOCKS,
  BEACON_ADMISSION_EXPIRY_BLOCKS,
  BEACON_ADMISSION_EXPIRY_PENALTY_BPS,
  BEACON_RETIREMENT_DELAY_BLOCKS,
  MAX_REGISTERED_BEACON_AUTHORITIES,
  MAX_PENDING_BEACON_ADMISSIONS,
  beaconAdmissionRank,
  beaconAuthoritySetId,
  retiredBeaconIdentity,
  verifyBeaconRotation,
} from "./beacon-rotation.mjs";
import { verifyValidatorOnboarding } from "./validator-onboarding.mjs";
import {
  normalizePendingProtocolUpgrade,
  normalizeSupportedProtocolVersions,
  protocolTransition,
  protocolVersionAtNextHeight,
} from "./protocol-upgrade.mjs";
import {
  consensusEncodingVersionForProtocol,
  consensusValueBytes,
} from "./consensus-codec.mjs";
import {
  activeValidatorSet,
  scheduleValidatorRotation,
  validatorSetId,
} from "./validator-rotation.mjs";
import {
  accountStateRoot as computeAccountStateRoot,
  createAccountStateWitness,
  emptyAccountState,
  normalizeAccountState,
} from "./account-tree.mjs";
import { transactionRoot } from "./transaction-tree.mjs";
import {
  verifyFinalizedValidatorEquivocationEvidence,
  verifyValidatorEquivocationTransactionEnvelope,
} from "./validator-equivocation.mjs";
import {
  ADMISSION_OMISSION_REPORTER_REWARD_BPS,
  verifyValidatorAdmissionOmissionEvidence,
  verifyValidatorAdmissionOmissionTransactionEnvelope,
} from "./validator-admission-omission.mjs";
import {
  verifyValidatorRecoveryCheckpoint,
  verifyValidatorRecoveryEnvelope,
  verifyValidatorRecoveryPlan,
  verifyValidatorRecoveryPlanTransaction,
  verifyValidatorRecoveryVotes,
} from "./validator-recovery.mjs";
import { ValidatorRecoveryLockStore } from "./validator-recovery-store.mjs";
import {
  appendAccountHistory,
  emptyAccountHistory,
  emptyAccountHistoryAccumulator,
  normalizeAccountHistoryAccumulator,
} from "./account-history.mjs";

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

export function transferCreditAllowance(stake) {
  if (typeof stake !== "bigint" || stake < 0n) {
    throw new Error("credit stake must be a non-negative bigint");
  }
  return (stake * BigInt(TRANSFER_CREDITS_PER_STAKE_UNIT)) /
    TRANSFER_CREDIT_STAKE_UNIT;
}

export function transferCreditEpoch(height) {
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new Error("credit height is invalid");
  }
  if (height === 0) return 0;
  return Math.floor((height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS);
}

export const SYSTEM_NIR_ASSET_ID = "0".repeat(64);

export function nativeAssetId({ networkId, creator, nonce }) {
  if (typeof networkId !== "string" || networkId.length === 0 ||
      Buffer.byteLength(networkId) > 64) throw new Error("asset network id is invalid");
  assertAddress(creator, "asset creator");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("asset nonce is invalid");
  return hashObject({ creator, networkId, nonce }, "NATIVE_ASSET_ID_V1");
}

function assetBalanceKey(assetId, address) { return `${assetId}:${address}`; }

const MAX_PENDING_PROGRESS_COMMITMENTS = 4_096;
export const MAX_PROGRESS_COMMITMENT_AGE = 1_024;
export const PROGRESS_BOND_BINDING_TIMEOUT_BLOCKS = 64;
export const MAX_PROGRESS_REWARD_ESCROWS =
  MAX_PROGRESS_REWARDS_PER_BLOCK * PROGRESS_REWARD_ESCROW_DELAY_BLOCKS;
export const MAX_PROGRESS_FRAUD_EVIDENCE =
  MAX_PROGRESS_FRAUD_PROOFS_PER_BLOCK * (PROGRESS_REWARD_ESCROW_DELAY_BLOCKS + 1);

function orderedProgressEscrows(progressEscrows) {
  return [...progressEscrows].sort(([, left], [, right]) =>
    left.createdHeight - right.createdHeight || left.fingerprint.localeCompare(right.fingerprint));
}

function progressReservation(evaluation, marginalCapabilities) {
  return {
    artifactHash: evaluation.artifactHash,
    behaviorCommitment: evaluation.behaviorCommitment,
    contentHash: evaluation.contentHash,
    marginalCapabilities: [...marginalCapabilities].sort(),
  };
}

function assertProgressReservationAvailable(evaluation, marginalCapabilities, reservations) {
  const candidate = progressReservation(evaluation, marginalCapabilities);
  for (const reserved of reservations) {
    if (candidate.artifactHash === reserved.artifactHash ||
        candidate.contentHash === reserved.contentHash ||
        candidate.behaviorCommitment === reserved.behaviorCommitment ||
        candidate.marginalCapabilities.some((capability) =>
          reserved.marginalCapabilities.includes(capability))) {
      throw new Error("progress capability collides with a pending escrow reservation");
    }
  }
  reservations.push(candidate);
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

function accountStatesFromMaps({
  accountHistories, balances, creditDelegations, creditStakes, creditUnstakes, creditUsage,
  height, nonces, progressEscrows,
}) {
  const escrowSummaries = new Map();
  for (const escrow of progressEscrows.values()) {
    for (const [address, field, amountField] of [
      [escrow.recipient, "pendingProgressReward", "amount"],
      [escrow.refundAddress, "pendingProgressBondRefund", "bondAmount"],
    ]) {
      const summary = escrowSummaries.get(address) ?? {};
      const current = summary[field] ?? { amount: 0n, count: 0,
        nextUnlockHeight: escrow.unlockHeight };
      summary[field] = {
        amount: current.amount + escrow[amountField],
        count: current.count + 1,
        nextUnlockHeight: Math.min(current.nextUnlockHeight, escrow.unlockHeight),
      };
      escrowSummaries.set(address, summary);
    }
  }
  const addresses = new Set([
    ...accountHistories.keys(), ...balances.keys(), ...creditStakes.keys(), ...creditUnstakes.keys(),
    ...creditUsage.keys(), ...nonces.keys(),
    ...[...creditDelegations.values()].map(({ owner }) => owner),
    ...[...progressEscrows.values()].flatMap(({ recipient, refundAddress }) =>
      [recipient, refundAddress]),
  ]);
  const epoch = transferCreditEpoch(height);
  return [...addresses].sort().map((address) => {
    const stake = creditStakes.get(address) ?? 0n;
    const allowance = transferCreditAllowance(stake);
    const usage = creditUsage.get(address);
    const spent = usage?.epoch === epoch ? BigInt(usage.spent) : 0n;
    const pending = creditUnstakes.get(address) ?? null;
    const escrowSummary = (field) => {
      const summary = escrowSummaries.get(address)?.[field];
      return summary ? { ...summary, amount: summary.amount.toString() } : null;
    };
    return normalizeAccountState({
      address,
      atomicBalance: (balances.get(address) ?? 0n).toString(),
      history: accountHistories.get(address) ?? emptyAccountHistory(),
      nextNonce: nonces.get(address) ?? 0,
      resources: {
        atomicStake: stake.toString(),
        availableTransferCredits: (allowance > spent ? allowance - spent : 0n).toString(),
        delegations: [...creditDelegations.values()]
          .filter((delegation) => delegation.owner === address),
        pendingUnstake: pending ? {
          amount: pending.amount.toString(), unlockHeight: pending.unlockHeight,
        } : null,
        pendingProgressBondRefund: escrowSummary("pendingProgressBondRefund"),
        pendingProgressReward: escrowSummary("pendingProgressReward"),
      },
    });
  });
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

const SINGLE_TRANSFER_FIELDS = [
  "algorithm", "amount", "fee", "networkId", "nonce", "publicKey", "recipient",
  "sender", "signature", "type",
];
const SPONSOR_FIELDS = [
  "feePayer", "feePayerAlgorithm", "feePayerNonce", "feePayerPublicKey",
  "feePayerSignature",
];
const TRANSACTION_SCHEMAS = Object.freeze({
  "asset-burn": [[
    "algorithm", "amount", "assetId", "fee", "networkId", "nonce", "publicKey",
    "sender", "signature", "type",
  ]],
  "asset-create": [[
    "algorithm", "assetId", "fee", "fixedSupply", "initialSupply", "maxSupply",
    "metadataHash", "networkId", "nonce", "publicKey", "sender", "signature", "type",
  ]],
  "asset-mint": [[
    "algorithm", "amount", "assetId", "fee", "networkId", "nonce", "publicKey",
    "sender", "signature", "type",
  ]],
  "asset-revoke-authority": [[
    "algorithm", "assetId", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ]],
  "asset-transfer": [[
    "algorithm", "amount", "assetId", "fee", "networkId", "nonce", "publicKey",
    "recipient", "sender", "signature", "type",
  ]],
  "beacon-bond": [[
    "algorithm", "amount", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ], [
    "activationHeight", "algorithm", "amount", "fee", "networkId", "nonce", "operatorId",
    "publicKey", "sender", "signature", "type",
  ]],
  "beacon-retire": [[
    "algorithm", "fee", "networkId", "nonce", "publicKey", "sender", "signature", "type",
  ]],
  "candidate-bond": [[
    "algorithm", "amount", "candidateId", "fee", "networkId", "nonce", "publicKey",
    "sender", "signature", "type",
  ], [
    "algorithm", "amount", "candidateId", "candidateOwner", "fee", "networkId", "nonce",
    "publicKey", "purpose", "sender", "signature", "type",
  ]],
  "credit-delegation": [[
    "algorithm", "delegate", "fee", "limit", "networkId", "nonce", "publicKey",
    "sender", "signature", "type",
  ]],
  "credit-stake": [[
    "algorithm", "amount", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ]],
  "credit-unstake-claim": [[
    "algorithm", "networkId", "nonce", "publicKey", "sender", "signature", "type",
  ]],
  "credit-unstake-request": [[
    "algorithm", "amount", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ]],
  "progress-commitment": [[
    "algorithm", "artifactHash", "baselineContentHash", "baselineHash", "candidateId", "contentHash", "networkId",
    "nonce", "parents", "publicKey", "recipient", "sender", "signature", "suiteCommitment", "type",
  ]],
  "evaluator-bond": [[
    "algorithm", "amount", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ], [
    "activationHeight", "algorithm", "amount", "credentials", "fee", "networkId", "nonce",
    "operatorId", "publicKey", "sender", "signature", "type",
  ]],
  "validator-equivocation": [[
    "algorithm", "evidence", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ]],
  "validator-admission-omission": [[
    "algorithm", "evidence", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ]],
  "validator-recovery-plan": [[
    "algorithm", "fee", "networkId", "nonce", "plan", "publicKey", "sender",
    "signature", "type",
  ]],
  "validator-recovery": [[
    "checkpoint", "checkpointCertificate", "evidenceTransaction", "format", "generation",
    "planHash", "type",
  ]],
  "validator-bond": [[
    "algorithm", "amount", "fee", "networkId", "nonce", "publicKey", "sender",
    "signature", "type",
  ], [
    "algorithm", "amount", "fee", "networkId", "nonce", "operatorId", "publicKey",
    "sender", "signature", "type",
  ]],
  transfer: [
    SINGLE_TRANSFER_FIELDS,
    [...SINGLE_TRANSFER_FIELDS, "resource"],
    [...SINGLE_TRANSFER_FIELDS, "resource", "creditOwner"],
    [...SINGLE_TRANSFER_FIELDS, ...SPONSOR_FIELDS],
    [...SINGLE_TRANSFER_FIELDS, "resource", ...SPONSOR_FIELDS],
    [
      "algorithm", "amount", "fee", "memberPublicKeys", "networkId", "nonce",
      "recipient", "sender", "signatures", "threshold", "type",
    ],
  ],
});

function requireExactTransactionSchema(transaction) {
  if (!transaction || Object.getPrototypeOf(transaction) !== Object.prototype) {
    throw new Error("transaction schema is invalid");
  }
  const actual = Object.keys(transaction).sort().join("\0");
  const schemas = TRANSACTION_SCHEMAS[transaction.type] ?? [];
  if (!schemas.some((fields) => [...fields].sort().join("\0") === actual)) {
    throw new Error("transaction schema contains missing or extra fields");
  }
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

function createSignedAssetTransaction(fields, wallet, domain) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    fee: String(fields.fee ?? MIN_TRANSFER_FEE),
    networkId: fields.networkId,
    nonce: fields.nonce,
    publicKey: wallet.publicKey,
    sender: wallet.address,
    ...fields,
  };
  delete transaction.wallet;
  return { ...transaction, signature: signObject(transaction, wallet, domain) };
}

export function createNativeAsset({
  wallet, networkId, metadataHash, maxSupply, initialSupply, fixedSupply, nonce,
  fee = MIN_TRANSFER_FEE.toString(),
}) {
  return createSignedAssetTransaction({
    assetId: nativeAssetId({ networkId, creator: wallet.address, nonce }),
    fee: String(fee), fixedSupply, initialSupply: String(initialSupply), maxSupply: String(maxSupply),
    metadataHash, networkId, nonce, type: "asset-create",
  }, wallet, "NATIVE_ASSET_CREATE");
}

export function createNativeAssetMint({
  wallet, networkId, assetId, amount, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  return createSignedAssetTransaction({
    amount: String(amount), assetId, fee: String(fee), networkId, nonce, type: "asset-mint",
  }, wallet, "NATIVE_ASSET_MINT");
}

export function createNativeAssetTransfer({
  wallet, networkId, assetId, recipient, amount, nonce,
  fee = MIN_TRANSFER_FEE.toString(),
}) {
  return createSignedAssetTransaction({
    amount: String(amount), assetId, fee: String(fee), networkId, nonce, recipient,
    type: "asset-transfer",
  }, wallet, "NATIVE_ASSET_TRANSFER");
}

export function createNativeAssetBurn({
  wallet, networkId, assetId, amount, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  return createSignedAssetTransaction({
    amount: String(amount), assetId, fee: String(fee), networkId, nonce, type: "asset-burn",
  }, wallet, "NATIVE_ASSET_BURN");
}

export function createNativeAssetAuthorityRevoke({
  wallet, networkId, assetId, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  return createSignedAssetTransaction({
    assetId, fee: String(fee), networkId, nonce, type: "asset-revoke-authority",
  }, wallet, "NATIVE_ASSET_REVOKE_AUTHORITY");
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
  networkId, sender, recipient, artifactHash, baselineHash, baselineContentHash, contentHash, parents, suiteCommitment,
}) {
  return hashObject({
    artifactHash, baselineContentHash, baselineHash, contentHash, networkId, parents, recipient, sender, suiteCommitment,
  }, "PROGRESS_CANDIDATE_ID");
}

export function createProgressCommitment({
  wallet, networkId, recipient, artifactHash, baselineHash, baselineContentHash, contentHash = artifactHash,
  parents = [baselineHash], suiteCommitment, nonce,
}) {
  const canonicalParents = [...parents].sort();
  const candidateId = progressCandidateId({
    networkId, sender: wallet.address, recipient, artifactHash, baselineHash, baselineContentHash, contentHash,
    parents: canonicalParents, suiteCommitment,
  });
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    artifactHash,
    baselineContentHash,
    baselineHash,
    candidateId,
    contentHash,
    networkId,
    nonce,
    parents: canonicalParents,
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
  candidateOwner,
  purpose,
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
  if (purpose !== undefined || candidateOwner !== undefined) {
    transaction.candidateOwner = candidateOwner;
    transaction.purpose = purpose;
  }
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

export function createEvaluatorBond({
  wallet, networkId, amount, nonce, operatorId, activationHeight, credentials,
  fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount), fee: String(fee), networkId, nonce,
    publicKey: wallet.publicKey, sender: wallet.address, type: "evaluator-bond",
  };
  if (operatorId !== undefined || activationHeight !== undefined) {
    transaction.operatorId = operatorId;
    transaction.activationHeight = activationHeight;
    transaction.credentials = structuredClone(credentials);
  }
  return { ...transaction, signature: signObject(transaction, wallet, "EVALUATOR_BOND") };
}

export function createBeaconBond({
  wallet, networkId, amount, nonce, operatorId, activationHeight,
  fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    amount: String(amount), fee: String(fee), networkId, nonce,
    publicKey: wallet.publicKey, sender: wallet.address, type: "beacon-bond",
  };
  if (operatorId !== undefined || activationHeight !== undefined) {
    transaction.activationHeight = activationHeight;
    transaction.operatorId = operatorId;
  }
  return { ...transaction, signature: signObject(transaction, wallet, "BEACON_BOND") };
}

export function createBeaconRetirement({
  wallet, networkId, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM, fee: String(fee), networkId, nonce,
    publicKey: wallet.publicKey, sender: wallet.address, type: "beacon-retire",
  };
  return { ...transaction, signature: signObject(transaction, wallet, "BEACON_RETIREMENT_V1") };
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
      baselineContentHash: evaluation.baselineContentHash,
      baselineHash: evaluation.baselineHash,
      candidateId: evaluation.candidateId,
      contentHash: evaluation.contentHash,
      executionBundleHash: evaluation.executionBundleHash,
      parents: evaluation.parents,
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
    !/^sha256:[0-9a-f]{64}$/.test(evaluation.baselineContentHash ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(evaluation.baselineHash ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(evaluation.contentHash ?? "") ||
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

export function createProgressEvaluatorEquivocationEvidence({ candidateId, conflictingClaim }) {
  if (!/^[0-9a-f]{64}$/.test(candidateId ?? "") || !conflictingClaim ||
      conflictingClaim.evaluation?.candidateId !== candidateId) {
    throw new Error("progress fraud evidence input is invalid");
  }
  const payload = { candidateId, conflictingClaim: structuredClone(conflictingClaim),
    format: "nir-progress-evaluator-equivocation-v1" };
  return { ...payload, evidenceHash: hashObject(payload, "PROGRESS_FRAUD_EVIDENCE_V1") };
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

const BLOCK_FIELDS = Object.freeze([
  "accountStateRoot",
  "beaconRotation",
  "capabilityMemoryRoot",
  "certificate",
  "epochRandomnessCommits",
  "epochRandomnessReveals",
  "fallbackBeacons",
  "feeRecipient",
  "hash",
  "height",
  "issuanceEpoch",
  "networkId",
  "peerRegistryHash",
  "peerRegistryUpdate",
  "prepareCertificate",
  "previousHash",
  "progressBeacons",
  "progressFraudProofs",
  "progressRewards",
  "proposer",
  "protocolUpgrade",
  "protocolVersion",
  "randomnessCommits",
  "randomnessReveals",
  "round",
  "roundCertificate",
  "safetySettlements",
  "stateRoot",
  "timestamp",
  "transactionCount",
  "transactions",
  "transactionsRoot",
  "validatorRotation",
].sort());

function requireExactBlockSchema(block) {
  consensusValueBytes(block);
  if (!block || Object.getPrototypeOf(block) !== Object.prototype ||
      Object.keys(block).sort().join("\0") !== BLOCK_FIELDS.join("\0")) {
    throw new Error("block schema contains missing or extra fields");
  }
}

const FINALITY_HEADER_FORMAT = "nir-finality-header-v1";

export function blockHeader(block) {
  const unsigned = unsignedBlock(block);
  const {
    accountStateRoot,
    capabilityMemoryRoot,
    height,
    networkId,
    peerRegistryHash,
    previousHash,
    protocolUpgrade,
    protocolVersion,
    stateRoot,
    timestamp,
    transactionCount,
    transactionsRoot,
    ...body
  } = unsigned;
  return {
    bodyHash: hashObject(body, "BLOCK_BODY"),
    accountStateRoot,
    capabilityMemoryRoot,
    format: FINALITY_HEADER_FORMAT,
    height,
    networkId,
    peerRegistryHash,
    previousHash,
    protocolUpgrade: protocolUpgrade ?? null,
    protocolVersion,
    stateRoot,
    timestamp,
    transactionCount,
    transactionsRoot,
  };
}

export function blockHeaderHash(header) {
  return hashObject(header, "BLOCK");
}

export function blockHash(block) {
  return blockHeaderHash(blockHeader(block));
}

export function prepareVoteForBlock(block, validatorWallet) {
  const hash = blockHash(block);
  return {
    round: block.round,
    signature: signObject(
      { blockHash: hash, height: block.height, round: block.round },
      validatorWallet,
      "BLOCK_PREPARE",
    ),
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

export function finalizeValidatorRecoveryBlock(block, reserveSigners, plan, {
  checkpointHash, evidenceHash,
}) {
  const context = { blockHash: blockHash(block), checkpointHash, evidenceHash,
    generation: plan.generation, height: block.height, networkId: block.networkId,
    planHash: plan.planHash, reserveSetId: plan.reserveSetId };
  if (!Array.isArray(reserveSigners) || reserveSigners.some((signer) =>
    !(signer instanceof ValidatorRecoveryLockStore))) {
    throw new Error("validator recovery requires durable reserve signers");
  }
  const prepareCertificate = reserveSigners.map((signer) =>
    signer.recoveryVote(context, "prepare"));
  const certificate = reserveSigners.map((signer) =>
    signer.recoveryVote(context, "commit"));
  return { ...block, certificate, hash: context.blockHash, prepareCertificate };
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

function assertProgressRewardCollateral(rewards, candidateBonds) {
  for (const reward of rewards) {
    const bond = candidateBonds.get(reward.evaluation?.candidateId);
    const amount = parseAtomic(reward.amount, "reward amount");
    if (!bond || bond.purpose !== "progress" || !bond.admissionBound || amount > bond.bond) {
      throw new Error("progress reward exceeds its locked candidate bond collateral");
    }
  }
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
  #accountHistories;
  #assetBalances;
  #assets;
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
  #disabledValidators;
  #disabledEvaluators;
  #evaluationQuorum;
  #epochRandomness;
  #beaconAuthorities;
  #beaconGeneration;
  #beaconQuorum;
  #pendingBeaconRotation;
  #pendingBeaconRetirements;
  #pendingBeaconAdmissions;
  #registeredBeaconAuthorities;
  #retiredBeaconAuthorities;
  #evaluatorOrder;
  #evaluators;
  #evaluatorBonds;
  #evaluatorFaults;
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
  #validatorAdmissionOmissionEvidence;
  #validatorEquivocationEvidence;
  #validatorRecoveryGeneration;
  #validatorRecoveryPlan;
  #registeredValidators;
  #pendingEvaluatorRegistrations;
  #pendingValidatorRotation;
  #pendingProtocolUpgrade;
  #peerRegistry;
  #progressCommitments;
  #progressEscrows;
  #progressFraudEvidence;
  #protocolVersion;
  #safetyEvidence;
  #safetyPolicies;
  #treasuryAddress;
  #genesisTimestamp;
  #genesisEvaluatorBondAllocation;
  #genesisEvaluatorCount;
  #genesisConfig;
  #validatorOrder;
  #validators;
  #supportedProtocolVersions;

  constructor({
    networkId,
    validators,
    evaluators,
    treasuryAddress,
    capabilityReferences,
    safetyPolicyCommitments,
    beaconAuthorities,
    peerRegistry = null,
    evaluatorBondAmount = MIN_EVALUATOR_BOND.toString(),
    genesisTimestamp = Date.now(),
  }, { supportedProtocolVersions } = {}) {
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
    this.#supportedProtocolVersions = normalizeSupportedProtocolVersions(
      supportedProtocolVersions,
    );
    this.#genesisConfig = structuredClone({
      beaconAuthorities,
      capabilityReferences,
      evaluatorBondAmount,
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
    const genesisEvaluatorBond = parseAtomic(evaluatorBondAmount, "genesis evaluator bond");
    if (genesisEvaluatorBond < MIN_EVALUATOR_BOND) {
      throw new Error("genesis evaluator bond is below the protocol minimum");
    }
    const genesisEvaluatorBonds = genesisEvaluatorBond * BigInt(this.#evaluators.size);
    if (genesisEvaluatorBonds > TREASURY_ALLOCATION) {
      throw new Error("genesis evaluator bonds exceed the treasury allocation");
    }
    this.#genesisConfig.evaluatorBondAmount = genesisEvaluatorBond.toString();
    this.#genesisEvaluatorBondAllocation = genesisEvaluatorBonds;
    this.#beaconAuthorities = operatorRegistry(beaconAuthorities, "beacon authority");
    this.#registeredBeaconAuthorities = new Map(this.#beaconAuthorities);
    this.#beaconGeneration = 0;
    this.#pendingBeaconRotation = null;
    this.#pendingBeaconRetirements = new Map();
    this.#pendingBeaconAdmissions = new Map();
    this.#retiredBeaconAuthorities = new Map();
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
    this.#genesisEvaluatorCount = this.#evaluatorOrder.length;
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
      generation: this.#beaconGeneration,
    });
    assertAddress(treasuryAddress, "treasury address");
    this.#accountHistories = new Map();
    this.#assetBalances = new Map();
    this.#assets = new Map();
    this.#balances = new Map([[treasuryAddress, TREASURY_ALLOCATION - genesisEvaluatorBonds]]);
    this.#beaconBondingActive = false;
    this.#beaconBonds = new Map();
    this.#beaconFaults = new Map();
    this.#burned = 0n;
    this.#candidateBonds = new Map();
    this.#creditDelegations = new Map();
    this.#creditStakes = new Map();
    this.#creditUnstakes = new Map();
    this.#creditUsage = new Map();
    this.#disabledValidators = new Set();
    this.#disabledEvaluators = new Set();
    this.#evaluatorBonds = new Map(
      this.#evaluatorOrder.map((address) => [address, genesisEvaluatorBond]),
    );
    this.#evaluatorFaults = new Map();
    this.#nonces = new Map();
    this.#rewardedProofs = new Set();
    this.#randomnessFaults = new Map();
    this.#validatorFaults = new Map();
    this.#validatorBonds = new Map();
    this.#validatorAdmissionOmissionEvidence = new Set();
    this.#validatorEquivocationEvidence = new Set();
    this.#validatorRecoveryGeneration = 0;
    this.#validatorRecoveryPlan = null;
    this.#registeredValidators = new Map(this.#validators);
    this.#pendingEvaluatorRegistrations = new Map();
    this.#pendingValidatorRotation = null;
    this.#pendingProtocolUpgrade = null;
    this.#progressCommitments = new Map();
    this.#progressEscrows = new Map();
    this.#progressFraudEvidence = new Map();
    this.#protocolVersion = PROTOCOL_VERSION;
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
    const accountStateRoot = computeAccountStateRoot(this.#accountStates({ height: 0 }));
    const transactionsRoot = transactionRoot([]);
    const genesis = {
      accountStateRoot,
      balances: { [treasuryAddress]: (TREASURY_ALLOCATION - genesisEvaluatorBonds).toString() },
      beaconAuthorities: [...this.#beaconAuthorities.values()].map(({ address, operatorId }) => ({ address, operatorId })),
      capabilityMemoryRoot: this.#capabilityMemory.stateRoot,
      evaluators: this.#evaluatorOrder.map((address) => ({
        address,
        bond: genesisEvaluatorBond.toString(),
        operatorId: this.#evaluators.get(address).operatorId,
      })),
      genesisTimestamp,
      networkId,
      peerRegistryHash: this.#peerRegistry ? peerRegistryHash(this.#peerRegistry) : "0".repeat(64),
      protocolVersion: PROTOCOL_VERSION,
      safetyPolicyCommitments: [...this.#safetyPolicies].sort(),
      stateRoot,
      transactionCount: 0,
      transactionsRoot,
      validators: this.#validatorOrder.map((address) => ({
        address,
        operatorId: this.#validators.get(address).operatorId,
      })),
    };
    this.#blocks = [
      {
        accountStateRoot,
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
        transactionCount: 0,
        transactions: [],
        transactionsRoot,
      },
    ];
  }

  static fromVerifiedSnapshot(genesisConfig, snapshot, options = {}) {
    const chain = new NirChain(genesisConfig, options);
    if (!snapshot || snapshot.networkId !== chain.#networkId ||
        snapshot.checkpoint?.hash !== snapshot.tipHash ||
        snapshot.checkpoint?.stateRoot !== snapshot.stateRoot ||
        computeChainStateRoot(snapshot.state) !== snapshot.stateRoot) {
      throw new Error("verified snapshot does not match the target chain");
    }
    const state = snapshot.state;
    const accountHistories = snapshotEntries(state.accountHistories, "account histories");
    for (const [address, history] of accountHistories) {
      assertAddress(address, "account history address");
      accountHistories.set(address, normalizeAccountHistoryAccumulator(history));
    }
    const balances = snapshotEntries(state.balances, "balances");
    for (const [address, value] of balances) {
      assertAddress(address, "snapshot balance address");
      balances.set(address, snapshotAtomic(value, "balance"));
    }
    const snapshotProtocolVersion = snapshotInteger(state.protocolVersion, "protocol version");
    const assets = snapshotProtocolVersion >= 25
      ? snapshotEntries(state.assets, "native assets") : new Map();
    const assetBalances = snapshotProtocolVersion >= 25
      ? snapshotEntries(state.assetBalances, "native asset balances") : new Map();
    if (snapshotProtocolVersion < 25 &&
        (state.assets !== undefined || state.assetBalances !== undefined)) {
      throw new Error("native asset snapshot state predates protocol support");
    }
    if (assets.size > MAX_NATIVE_ASSETS || assetBalances.size > MAX_NATIVE_ASSET_BALANCES) {
      throw new Error("native asset snapshot capacity is exceeded");
    }
    for (const [assetId, asset] of assets) {
      if (assetId === SYSTEM_NIR_ASSET_ID || !/^[0-9a-f]{64}$/.test(assetId) || !asset ||
          asset.assetId !== assetId || !/^nir1[0-9a-f]{64}$/.test(asset.creator ?? "") ||
          !(asset.authority === null || asset.authority === asset.creator) ||
          !Number.isSafeInteger(asset.creationNonce) || asset.creationNonce < 0 ||
          assetId !== nativeAssetId({ creator: asset.creator, networkId: chain.#networkId,
            nonce: asset.creationNonce }) ||
          typeof asset.fixedSupply !== "boolean" ||
          !/^[0-9a-f]{64}$/.test(asset.metadataHash ?? "")) {
        throw new Error("native asset snapshot definition is invalid");
      }
      const maxSupply = snapshotAtomic(asset.maxSupply, "native asset maximum supply");
      const minted = snapshotAtomic(asset.minted, "native asset minted supply");
      const supply = snapshotAtomic(asset.supply, "native asset supply");
      if (maxSupply === 0n || minted > maxSupply || supply > minted ||
          (asset.fixedSupply && (asset.authority !== null || minted !== maxSupply))) {
        throw new Error("native asset snapshot supply is invalid");
      }
      assets.set(assetId, { ...asset, maxSupply, minted, supply });
    }
    const assetTotals = new Map();
    for (const [key, value] of assetBalances) {
      const separator = key.indexOf(":");
      const assetId = key.slice(0, separator);
      const address = key.slice(separator + 1);
      const amount = snapshotAtomic(value, "native asset balance");
      if (separator !== 64 || !assets.has(assetId) || amount === 0n) {
        throw new Error("native asset snapshot balance is invalid");
      }
      assertAddress(address, "native asset snapshot holder");
      assetBalances.set(key, amount);
      assetTotals.set(assetId, (assetTotals.get(assetId) ?? 0n) + amount);
    }
    for (const [assetId, asset] of assets) {
      if ((assetTotals.get(assetId) ?? 0n) !== asset.supply) {
        throw new Error("native asset snapshot balances do not match supply");
      }
    }
    if (typeof state.beaconBondingActive !== "boolean") {
      throw new Error("beacon bonding activation snapshot is invalid");
    }
    const beaconAuthorities = operatorRegistry(
      [...snapshotEntries(state.beaconAuthorities, "beacon authorities").values()],
      "beacon authority snapshot",
    );
    const registeredBeaconAuthorities = operatorRegistry(
      [...snapshotEntries(state.registeredBeaconAuthorities,
        "registered beacon authorities").values()],
      "registered beacon authority snapshot",
    );
    const retiredBeaconAuthorities = snapshotEntries(
      state.retiredBeaconAuthorities, "retired beacon authorities",
    );
    const retiredOperators = new Set();
    const retiredPublicKeys = new Set();
    for (const [address, record] of retiredBeaconAuthorities) {
      if (!record || Object.keys(record).sort().join("\0") !== [
        "address", "algorithm", "faults", "identityCommitment", "operatorId", "publicKey",
        "retiredHeight",
      ].sort().join("\0") || record.address !== address ||
          canonicalJson(record) !== canonicalJson(retiredBeaconIdentity({
            address: record.address, algorithm: record.algorithm,
            operatorId: record.operatorId, publicKey: record.publicKey,
          }, record.retiredHeight, record.faults)) ||
          registeredBeaconAuthorities.has(address) || retiredOperators.has(record.operatorId) ||
          retiredPublicKeys.has(record.publicKey)) {
        throw new Error("retired beacon authority snapshot is invalid");
      }
      retiredOperators.add(record.operatorId);
      retiredPublicKeys.add(record.publicKey);
    }
    const pendingBeaconAdmissions = snapshotEntries(
      state.pendingBeaconAdmissions, "pending beacon admissions",
    );
    if (pendingBeaconAdmissions.size > MAX_PENDING_BEACON_ADMISSIONS) {
      throw new Error("pending beacon admission snapshot capacity is exceeded");
    }
    const admissionOperators = new Set();
    const admissionPublicKeys = new Set();
    for (const [address, admission] of pendingBeaconAdmissions) {
      const member = { address: admission?.address, algorithm: admission?.algorithm,
        operatorId: admission?.operatorId, publicKey: admission?.publicKey };
      if (!admission || Object.keys(admission).sort().join("\0") !== [
        "activationHeight", "address", "algorithm", "expiryHeight", "operatorId", "publicKey",
        "rank", "submittedHeight",
      ].sort().join("\0") || admission.address !== address ||
          !Number.isSafeInteger(admission.submittedHeight) || admission.submittedHeight < 1 ||
          admission.activationHeight !== admission.submittedHeight + BEACON_ADMISSION_DELAY_BLOCKS ||
          admission.expiryHeight !== admission.activationHeight + BEACON_ADMISSION_EXPIRY_BLOCKS ||
          admission.submittedHeight > snapshot.height || admission.expiryHeight <= snapshot.height ||
          admission.rank !== beaconAdmissionRank({ member, networkId: chain.#networkId,
            submittedHeight: admission.submittedHeight }) ||
          registeredBeaconAuthorities.has(address) || retiredBeaconAuthorities.has(address) ||
          retiredOperators.has(admission.operatorId) || retiredPublicKeys.has(admission.publicKey) ||
          admissionOperators.has(admission.operatorId) || admissionPublicKeys.has(admission.publicKey)) {
        throw new Error("pending beacon admission snapshot is invalid");
      }
      admissionOperators.add(admission.operatorId);
      admissionPublicKeys.add(admission.publicKey);
    }
    const beaconGeneration = snapshotInteger(state.beaconGeneration, "beacon generation");
    if (beaconAuthorities.size < 4 || beaconAuthorities.size > 64 ||
        registeredBeaconAuthorities.size > MAX_REGISTERED_BEACON_AUTHORITIES ||
        [...beaconAuthorities].some(([address, member]) =>
          canonicalJson(registeredBeaconAuthorities.get(address)) !== canonicalJson(member))) {
      throw new Error("beacon authority snapshot registry is invalid");
    }
    if ([...registeredBeaconAuthorities.values()].some(({ operatorId, publicKey }) =>
      retiredOperators.has(operatorId) || retiredPublicKeys.has(publicKey) ||
      admissionOperators.has(operatorId) || admissionPublicKeys.has(publicKey))) {
      throw new Error("retired beacon identity was reused");
    }
    const beaconBonds = snapshotEntries(state.beaconBonds, "beacon bonds");
    for (const [address, value] of beaconBonds) {
      if (!registeredBeaconAuthorities.has(address) && !pendingBeaconAdmissions.has(address)) {
        throw new Error("beacon bond snapshot address is invalid");
      }
      beaconBonds.set(address, snapshotAtomic(value, "beacon bond"));
    }
    if ([...pendingBeaconAdmissions.keys()].some((address) =>
      beaconBonds.get(address) !== MIN_BEACON_BOND)) {
      throw new Error("pending beacon admission bond snapshot is invalid");
    }
    const beaconFaults = snapshotEntries(state.beaconFaults, "beacon faults");
    for (const [address, value] of beaconFaults) {
      if (!registeredBeaconAuthorities.has(address)) throw new Error("beacon fault snapshot address is invalid");
      beaconFaults.set(address, snapshotInteger(value, "beacon fault"));
    }
    let pendingBeaconRotation = null;
    if (state.pendingBeaconRotation !== null) {
      pendingBeaconRotation = verifyBeaconRotation(state.pendingBeaconRotation, {
        bonds: beaconBonds,
        currentAuthorities: [...beaconAuthorities.values()],
        currentGeneration: beaconGeneration,
        currentHeight: state.pendingBeaconRotation.activationHeight - 64,
        networkId: chain.#networkId,
      });
      if (pendingBeaconRotation.activationHeight <= snapshot.height ||
          pendingBeaconRotation.authorities.some((member) => {
            const registered = registeredBeaconAuthorities.get(member.address);
            const admission = pendingBeaconAdmissions.get(member.address);
            const admittedMember = admission && { address: admission.address,
              algorithm: admission.algorithm, operatorId: admission.operatorId,
              publicKey: admission.publicKey };
            return canonicalJson(registered ?? admittedMember) !== canonicalJson(member) ||
              (admission && admission.expiryHeight <= pendingBeaconRotation.activationHeight);
          })) {
        throw new Error("pending beacon rotation snapshot is invalid");
      }
    }
    const pendingBeaconRetirements = snapshotEntries(
      state.pendingBeaconRetirements, "pending beacon retirements",
    );
    for (const [address, pending] of pendingBeaconRetirements) {
      if (!pending || Object.keys(pending).sort().join("\0") !==
          "address\0requestedHeight\0unlockHeight" || pending.address !== address ||
          !Number.isSafeInteger(pending.requestedHeight) || pending.requestedHeight < 1 ||
          pending.unlockHeight !== pending.requestedHeight + BEACON_RETIREMENT_DELAY_BLOCKS ||
          pending.requestedHeight > snapshot.height || pending.unlockHeight <= snapshot.height ||
          !registeredBeaconAuthorities.has(address) || beaconAuthorities.has(address) ||
          pendingBeaconRotation?.authorities.some((member) => member.address === address) ||
          (beaconBonds.get(address) ?? 0n) <= 0n) {
        throw new Error("pending beacon retirement snapshot is invalid");
      }
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
    if (!Array.isArray(state.disabledValidators) ||
        state.disabledValidators.some((address) => !/^nir1[0-9a-f]{64}$/.test(address)) ||
        new Set(state.disabledValidators).size !== state.disabledValidators.length ||
        !Array.isArray(state.validatorAdmissionOmissionEvidence) ||
        state.validatorAdmissionOmissionEvidence.length > MAX_VALIDATORS ||
        state.validatorAdmissionOmissionEvidence.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
        new Set(state.validatorAdmissionOmissionEvidence).size !==
          state.validatorAdmissionOmissionEvidence.length ||
        !Array.isArray(state.validatorEquivocationEvidence) ||
        state.validatorEquivocationEvidence.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
        new Set(state.validatorEquivocationEvidence).size !== state.validatorEquivocationEvidence.length) {
      throw new Error("validator equivocation snapshot state is invalid");
    }
    const disabledValidators = new Set(state.disabledValidators);
    const validatorAdmissionOmissionEvidence = new Set(
      state.validatorAdmissionOmissionEvidence,
    );
    const validatorEquivocationEvidence = new Set(state.validatorEquivocationEvidence);
    const validatorRecoveryGeneration = snapshotInteger(
      state.validatorRecoveryGeneration, "validator recovery generation",
    );
    const evaluatorEntries = snapshotEntries(state.evaluators, "evaluators");
    const evaluators = operatorRegistry([...evaluatorEntries.values()], "evaluator snapshot");
    for (const [address, member] of chain.#evaluators) {
      if (canonicalJson(evaluators.get(address)) !== canonicalJson(member)) {
        throw new Error("snapshot evaluator registry does not preserve genesis identities");
      }
    }
    const pendingEvaluatorRegistrations = snapshotEntries(
      state.pendingEvaluatorRegistrations, "pending evaluator registrations",
    );
    const evaluatorBonds = snapshotEntries(state.evaluatorBonds, "evaluator bonds");
    for (const [address, value] of evaluatorBonds) {
      if (!evaluators.has(address) && !pendingEvaluatorRegistrations.has(address)) {
        throw new Error("evaluator bond snapshot address is invalid");
      }
      const amount = snapshotAtomic(value, "evaluator bond");
      if (amount === 0n) throw new Error("evaluator bond snapshot amount is invalid");
      evaluatorBonds.set(address, amount);
    }
    const evaluatorFaults = snapshotEntries(state.evaluatorFaults, "evaluator faults");
    for (const [address, value] of evaluatorFaults) {
      if (!evaluators.has(address) || snapshotInteger(value, "evaluator fault") !== 1) {
        throw new Error("evaluator fault snapshot is invalid");
      }
    }
    if (!Array.isArray(state.disabledEvaluators) ||
        state.disabledEvaluators.some((address) => !evaluators.has(address)) ||
        new Set(state.disabledEvaluators).size !== state.disabledEvaluators.length) {
      throw new Error("disabled evaluator snapshot state is invalid");
    }
    const disabledEvaluators = new Set(state.disabledEvaluators);
    if (pendingEvaluatorRegistrations.size > chain.#genesisEvaluatorCount ||
        evaluators.size + pendingEvaluatorRegistrations.size > 256) {
      throw new Error("pending evaluator registration capacity is exceeded");
    }
    for (const [address, pending] of pendingEvaluatorRegistrations) {
      if (!pending || Object.keys(pending).sort().join("\0") !==
          ["activationHeight", "address", "algorithm", "operatorId", "publicKey"].sort().join("\0") ||
          pending.address !== address || evaluators.has(address) ||
          chain.#validators.has(address) || registeredBeaconAuthorities.has(address) ||
          pending.algorithm !== SIGNATURE_ALGORITHM ||
          addressFromPublicKey(pending.publicKey) !== address ||
          !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(pending.operatorId ?? "") ||
          !Number.isSafeInteger(pending.activationHeight) ||
          pending.activationHeight <= snapshot.height ||
          (evaluatorBonds.get(address) ?? 0n) < MIN_EVALUATOR_BOND) {
        throw new Error("pending evaluator registration snapshot is invalid");
      }
    }
    const allOperators = [
      ...evaluators.values(), ...chain.#validators.values(), ...registeredBeaconAuthorities.values(),
      ...pendingBeaconAdmissions.values(),
      ...retiredBeaconAuthorities.values(),
      ...pendingEvaluatorRegistrations.values(),
    ].map(({ operatorId }) => operatorId);
    if (new Set(allOperators).size !== allOperators.length) {
      throw new Error("pending evaluator operator identity is duplicated");
    }
    const activeEvaluatorCount = [...evaluators.keys()].filter((address) =>
      !disabledEvaluators.has(address) &&
      (evaluatorBonds.get(address) ?? 0n) >= MIN_EVALUATOR_BOND).length;
    if (activeEvaluatorCount + pendingEvaluatorRegistrations.size >
        chain.#genesisEvaluatorCount) {
      throw new Error("evaluator replacement snapshot exceeds the active-set bound");
    }
    if ([...disabledEvaluators].some((address) => evaluatorBonds.has(address) ||
        evaluatorFaults.get(address) !== 1) ||
        [...evaluatorFaults.keys()].some((address) => !disabledEvaluators.has(address))) {
      throw new Error("evaluator slash snapshot state is inconsistent");
    }
    const candidateBonds = snapshotEntries(state.candidateBonds, "candidate bonds");
    for (const [candidateId, candidate] of candidateBonds) {
      if (!/^[0-9a-f]{64}$/.test(candidateId) || !candidate ||
          !Number.isSafeInteger(candidate.committedHeight) || candidate.committedHeight < 0 ||
          !["progress", "safety"].includes(candidate.purpose) ||
          typeof candidate.admissionBound !== "boolean" ||
          !/^nir1[0-9a-f]{64}$/.test(candidate.submitter ?? "") ||
          !/^nir1[0-9a-f]{64}$/.test(candidate.candidateOwner ?? "") ||
          (candidate.purpose === "progress" && (
            candidate.bond === undefined || candidate.randomnessCommits.length !== 0 ||
            candidate.randomnessReveals.length !== 0 || candidate.committee !== null
          )) ||
          (candidate.purpose === "safety" && (
            candidate.candidateOwner !== candidate.submitter || candidate.admissionBound
          ))) {
        throw new Error("candidate bond snapshot is invalid");
      }
      const normalizedCandidate = {
        ...structuredClone(candidate),
        bond: snapshotAtomic(candidate.bond, "candidate bond"),
        randomnessCommits: snapshotEntries(candidate.randomnessCommits, "randomness commits"),
        randomnessReveals: snapshotEntries(candidate.randomnessReveals, "randomness reveals"),
      };
      if (normalizedCandidate.bond === 0n ||
          (normalizedCandidate.purpose === "progress" &&
            normalizedCandidate.bond < MIN_PROGRESS_CANDIDATE_BOND)) {
        throw new Error("candidate bond snapshot amount is invalid");
      }
      candidateBonds.set(candidateId, normalizedCandidate);
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
        !/^sha256:[0-9a-f]{64}$/.test(commitment.baselineContentHash ?? "") ||
        !/^sha256:[0-9a-f]{64}$/.test(commitment.baselineHash ?? "") ||
        !/^sha256:[0-9a-f]{64}$/.test(commitment.contentHash ?? "") ||
        commitment.artifactHash === commitment.baselineHash ||
        !Array.isArray(commitment.parents) || commitment.parents.length === 0 ||
        commitment.parents.length > 32 ||
        commitment.parents.some((parent) => !/^sha256:[0-9a-f]{64}$/.test(parent)) ||
        new Set(commitment.parents).size !== commitment.parents.length ||
        commitment.parents.some((parent, index) => index > 0 && parent <= commitment.parents[index - 1]) ||
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
        commitment.beaconRandomnessRound === null && commitment.beaconGeneration === null;
      const beaconAssigned =
        Array.isArray(commitment.beaconCommittee) &&
        commitment.beaconCommittee.length === chain.#beaconQuorum &&
        new Set(commitment.beaconCommittee).size === commitment.beaconCommittee.length &&
        commitment.beaconCommittee.every((address) => registeredBeaconAuthorities.has(address)) &&
        Number.isSafeInteger(commitment.beaconCommitteeHeight) &&
        commitment.beaconCommitteeHeight > commitment.committedHeight &&
        commitment.beaconCommitteeHeight <= commitment.committedHeight + MAX_PROGRESS_COMMITMENT_AGE &&
        Number.isSafeInteger(commitment.beaconRandomnessRound) &&
        commitment.beaconRandomnessRound >= commitment.randomnessRound &&
        Number.isSafeInteger(commitment.beaconGeneration) && commitment.beaconGeneration >= 0 &&
        commitment.beaconGeneration <= beaconGeneration &&
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
        commitment.committee.every((address) => evaluators.has(address) &&
          !disabledEvaluators.has(address) &&
          (evaluatorBonds.get(address) ?? 0n) >= MIN_EVALUATOR_BOND);
      if (!unassigned && !assigned) {
        throw new Error("progress challenge snapshot is invalid");
      }
      progressSubmitters.add(commitment.sender);
    }
    const validators = snapshotEntries(state.validators, "validators");
    const registeredValidators = snapshotEntries(state.registeredValidators, "registered validators");
    const validatorMembers = operatorRegistry([...validators.values()], "validator snapshot");
    const registeredMembers = operatorRegistry([...registeredValidators.values()], "registered validator snapshot");
    const validatorRecoveryPlan = state.validatorRecoveryPlan === null ? null :
      verifyValidatorRecoveryPlan(state.validatorRecoveryPlan, {
        activeValidators: [...validatorMembers.values()],
        bonds: validatorBonds,
        currentHeight: state.validatorRecoveryPlan.scheduledHeight,
        expectedGeneration: validatorRecoveryGeneration + 1,
        networkId: chain.#networkId,
        peerRegistryRequired: state.peerRegistry !== null,
        registeredValidators: registeredMembers,
      });
    if (validatorRecoveryPlan && validatorRecoveryPlan.activationHeight > snapshot.height) {
      // A plan may be pending eligibility; activationHeight is a lower bound, not an expiry.
    }
    if ([...registeredMembers.values()].some(({ address, operatorId, publicKey }) =>
      retiredBeaconAuthorities.has(address) || retiredOperators.has(operatorId) ||
      retiredPublicKeys.has(publicKey) || pendingBeaconAdmissions.has(address) ||
      admissionOperators.has(operatorId) || admissionPublicKeys.has(publicKey))) {
      throw new Error("retired beacon identity was reused by a validator");
    }
    const evaluatorOperators = new Set([...evaluators.values()].map(({ operatorId }) => operatorId));
    const pendingEvaluatorOperators = new Set(
      [...pendingEvaluatorRegistrations.values()].map(({ operatorId }) => operatorId),
    );
    if ([...evaluators.values()].some(({ address, operatorId, publicKey }) =>
      registeredMembers.has(address) || registeredBeaconAuthorities.has(address) ||
      retiredBeaconAuthorities.has(address) || retiredPublicKeys.has(publicKey) ||
      pendingBeaconAdmissions.has(address) || admissionPublicKeys.has(publicKey) ||
      [...registeredMembers.values(), ...registeredBeaconAuthorities.values(),
        ...retiredBeaconAuthorities.values(), ...pendingBeaconAdmissions.values()]
        .some((member) => member.operatorId === operatorId)) ||
        [...pendingEvaluatorRegistrations.values()].some(({ address, operatorId, publicKey }) =>
          registeredMembers.has(address) || registeredBeaconAuthorities.has(address) ||
          retiredBeaconAuthorities.has(address) || retiredPublicKeys.has(publicKey) ||
          pendingBeaconAdmissions.has(address) || admissionPublicKeys.has(publicKey) ||
          evaluatorOperators.has(operatorId) ||
          [...registeredMembers.values(), ...registeredBeaconAuthorities.values(),
            ...retiredBeaconAuthorities.values(), ...pendingBeaconAdmissions.values()]
            .some((member) => member.operatorId === operatorId)) ||
        pendingEvaluatorOperators.size !== pendingEvaluatorRegistrations.size) {
      throw new Error("snapshot evaluator roles or operators overlap another protocol role");
    }
    const progressEscrows = snapshotEntries(state.progressEscrows, "progress reward escrows");
    if (progressEscrows.size > MAX_PROGRESS_REWARD_ESCROWS) {
      throw new Error("progress reward escrow snapshot capacity is exceeded");
    }
    for (const [candidateId, escrow] of progressEscrows) {
      const expectedKeys = ["acceptedReceiptHash", "amount", "bondAmount", "candidateId",
        "committee", "createdHeight", "epoch", "evaluation", "fingerprint", "recipient",
        "marginalCapabilities", "refundAddress", "unlockHeight"].sort().join("\0");
      if (!/^[0-9a-f]{64}$/.test(candidateId) || !escrow ||
          Object.keys(escrow).sort().join("\0") !== expectedKeys || escrow.candidateId !== candidateId ||
          !/^[0-9a-f]{64}$/.test(escrow.acceptedReceiptHash ?? "") ||
          !/^[0-9a-f]{64}$/.test(escrow.fingerprint ?? "") ||
          !/^nir1[0-9a-f]{64}$/.test(escrow.recipient ?? "") ||
          !/^nir1[0-9a-f]{64}$/.test(escrow.refundAddress ?? "") ||
          !Number.isSafeInteger(escrow.createdHeight) || escrow.createdHeight < 1 ||
          !Number.isSafeInteger(escrow.epoch) || escrow.epoch !== escrow.createdHeight ||
          !Number.isSafeInteger(escrow.unlockHeight) ||
          escrow.unlockHeight !== escrow.createdHeight + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS ||
          escrow.evaluation?.candidateId !== candidateId ||
          !Array.isArray(escrow.marginalCapabilities) || escrow.marginalCapabilities.length === 0 ||
          escrow.marginalCapabilities.length > 256 ||
          new Set(escrow.marginalCapabilities).size !== escrow.marginalCapabilities.length ||
          escrow.marginalCapabilities.some((capability, index) =>
            typeof capability !== "string" || Buffer.byteLength(capability) === 0 ||
            Buffer.byteLength(capability) > 64 ||
            (index > 0 && capability <= escrow.marginalCapabilities[index - 1])) ||
          !Array.isArray(escrow.committee) || escrow.committee.length !== chain.#evaluationQuorum ||
          new Set(escrow.committee).size !== escrow.committee.length ||
          escrow.committee.some((address) => !evaluators.has(address))) {
        throw new Error("progress reward escrow snapshot is invalid");
      }
      const amount = snapshotAtomic(escrow.amount, "progress escrow reward");
      const bondAmount = snapshotAtomic(escrow.bondAmount, "progress escrow bond");
      const bond = candidateBonds.get(candidateId);
      const acceptedReceipt = progressReceiptPayload({
        networkId: chain.#networkId, epoch: escrow.epoch,
        recipient: escrow.recipient, evaluation: escrow.evaluation,
      });
      if (amount === 0n || bondAmount === 0n || amount > bondAmount ||
          acceptedReceipt.fingerprint !== escrow.fingerprint ||
          hashObject(acceptedReceipt, "PROGRESS_ESCROW_RECEIPT_V1") !== escrow.acceptedReceiptHash ||
          !bond || bond.purpose !== "progress" || !bond.admissionBound ||
          bond.bond !== bondAmount || bond.submitter !== escrow.refundAddress ||
          [bond.candidateOwner, escrow.recipient, escrow.refundAddress].some((address) =>
            chain.#evaluators.has(address) || registeredBeaconAuthorities.has(address) ||
            registeredMembers.has(address))) {
        throw new Error("progress reward escrow bond or role binding is invalid");
      }
      progressEscrows.set(candidateId, { ...structuredClone(escrow), amount, bondAmount });
    }
    const progressFraudEvidence = snapshotEntries(
      state.progressFraudEvidence, "progress fraud evidence",
    );
    if (progressFraudEvidence.size > MAX_PROGRESS_FRAUD_EVIDENCE ||
        [...progressFraudEvidence].some(([hash, acceptedHeight]) =>
          !/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(acceptedHeight) ||
          acceptedHeight < 1 || acceptedHeight > snapshot.height ||
          snapshot.height > acceptedHeight + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS)) {
      throw new Error("progress fraud replay snapshot state is invalid");
    }
    if ([...disabledValidators].some((address) => !registeredMembers.has(address) ||
        (validatorBonds.get(address) ?? 0n) !== 0n)) {
      throw new Error("disabled validator snapshot state is inconsistent");
    }
    for (const [candidateId, commitment] of progressCommitments) {
      const bond = candidateBonds.get(candidateId);
      if (!bond || bond.purpose !== "progress" || !bond.admissionBound ||
          bond.candidateOwner !== commitment.sender ||
          [commitment.sender, commitment.recipient].some((address) =>
            chain.#evaluators.has(address) || registeredBeaconAuthorities.has(address) ||
            registeredMembers.has(address))) {
        throw new Error("progress commitment snapshot role or bond binding is invalid");
      }
    }
    for (const [candidateId, bond] of candidateBonds) {
      if (bond.purpose === "progress" && bond.admissionBound &&
          Number(progressCommitments.has(candidateId)) + Number(progressEscrows.has(candidateId)) !== 1) {
        throw new Error("bound progress bond snapshot has no unique commitment or escrow");
      }
    }
    const memory = CapabilityMemory.fromSnapshot(snapshot.capabilityMemory);
    if (memory.stateRoot !== state.capabilityMemoryRoot) {
      throw new Error("capability memory snapshot root is invalid");
    }
    const reservedMemory = memory.clone();
    for (const [, escrow] of orderedProgressEscrows(progressEscrows)) {
      const report = reservedMemory.accept(escrow.evaluation);
      if (JSON.stringify(Object.keys(report.marginalGainsBps).sort()) !==
          JSON.stringify(escrow.marginalCapabilities)) {
        throw new Error("progress escrow capability reservation is invalid");
      }
    }
    chain.#accountHistories = accountHistories;
    chain.#assetBalances = assetBalances;
    chain.#assets = assets;
    chain.#balances = balances;
    chain.#beaconBondingActive = state.beaconBondingActive;
    chain.#beaconBonds = beaconBonds;
    chain.#beaconAuthorities = beaconAuthorities;
    chain.#beaconFaults = beaconFaults;
    chain.#beaconGeneration = beaconGeneration;
    chain.#beaconQuorum = Math.floor((beaconAuthorities.size * 2) / 3) + 1;
    chain.#pendingBeaconRotation = pendingBeaconRotation;
    chain.#pendingBeaconRetirements = pendingBeaconRetirements;
    chain.#pendingBeaconAdmissions = pendingBeaconAdmissions;
    chain.#registeredBeaconAuthorities = registeredBeaconAuthorities;
    chain.#retiredBeaconAuthorities = retiredBeaconAuthorities;
    chain.#burned = snapshotAtomic(state.burned, "burned supply");
    chain.#candidateBonds = candidateBonds;
    chain.#capabilityMemory = memory;
    chain.#creditDelegations = creditDelegations;
    chain.#creditStakes = creditStakes;
    chain.#creditUnstakes = creditUnstakes;
    chain.#creditUsage = creditUsage;
    chain.#disabledEvaluators = disabledEvaluators;
    chain.#disabledValidators = disabledValidators;
    chain.#epochRandomness = EpochRandomnessMachine.fromSnapshot({
      networkId: chain.#networkId,
      registry: chain.#beaconAuthorities,
      committeeSize: chain.#beaconQuorum,
      snapshot: state.epochRandomness,
    });
    if (chain.#epochRandomness.snapshot().generation !== chain.#beaconGeneration) {
      throw new Error("epoch randomness and beacon generations are inconsistent");
    }
    chain.#lastRewardTimestamp = snapshotSignedInteger(state.lastRewardTimestamp, "last reward timestamp");
    chain.#evaluatorBonds = evaluatorBonds;
    chain.#evaluatorFaults = evaluatorFaults;
    chain.#evaluators = evaluators;
    chain.#mined = snapshotAtomic(state.mined, "mined supply");
    chain.#nonces = nonces;
    chain.#protocolVersion = snapshotInteger(state.protocolVersion, "protocol version");
    if (!chain.#supportedProtocolVersions.includes(chain.#protocolVersion) ||
        snapshot.checkpoint?.protocolVersion !== chain.#protocolVersion) {
      throw new Error("snapshot protocol version is unsupported or inconsistent");
    }
    chain.#pendingProtocolUpgrade = normalizePendingProtocolUpgrade(
      state.pendingProtocolUpgrade, {
        currentHeight: snapshot.height,
        currentVersion: chain.#protocolVersion,
      },
    );
    chain.#pendingEvaluatorRegistrations = pendingEvaluatorRegistrations;
    chain.#pendingValidatorRotation = structuredClone(state.pendingValidatorRotation);
    chain.#progressCommitments = progressCommitments;
    chain.#progressEscrows = progressEscrows;
    chain.#progressFraudEvidence = progressFraudEvidence;
    chain.#peerRegistry = structuredClone(state.peerRegistry);
    chain.#randomnessFaults = snapshotEntries(state.randomnessFaults, "randomness faults");
    chain.#registeredValidators = registeredMembers;
    chain.#rewardEpoch = snapshotInteger(state.rewardEpoch, "reward epoch");
    if (!Array.isArray(state.rewardedProofs) || !Array.isArray(state.safetyEvidence)) {
      throw new Error("snapshot replay-protection sets are invalid");
    }
    chain.#rewardedProofs = new Set(state.rewardedProofs);
    if ([...progressEscrows.values()].some(({ fingerprint }) =>
      !chain.#rewardedProofs.has(fingerprint))) {
      throw new Error("progress reward escrow snapshot has no rewarded fingerprint");
    }
    chain.#safetyEvidence = new Set(state.safetyEvidence);
    chain.#validatorBonds = validatorBonds;
    chain.#validatorAdmissionOmissionEvidence = validatorAdmissionOmissionEvidence;
    chain.#validatorEquivocationEvidence = validatorEquivocationEvidence;
    chain.#validatorRecoveryGeneration = validatorRecoveryGeneration;
    chain.#validatorRecoveryPlan = validatorRecoveryPlan;
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

  nativeAsset(assetId) {
    if (!/^[0-9a-f]{64}$/.test(assetId ?? "") || assetId === SYSTEM_NIR_ASSET_ID) {
      throw new Error("native asset id is invalid");
    }
    const asset = this.#assets.get(assetId);
    return asset ? structuredClone(asset) : null;
  }

  nativeAssetBalance(assetId, address) {
    if (!/^[0-9a-f]{64}$/.test(assetId ?? "") || assetId === SYSTEM_NIR_ASSET_ID) {
      throw new Error("native asset id is invalid");
    }
    assertAddress(address, "native asset holder");
    return this.#assetBalances.get(assetBalanceKey(assetId, address)) ?? 0n;
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

  #accountStates(overrides = {}) {
    return accountStatesFromMaps({
      accountHistories: overrides.accountHistories ?? this.#accountHistories,
      balances: overrides.balances ?? this.#balances,
      creditDelegations: overrides.creditDelegations ?? this.#creditDelegations,
      creditStakes: overrides.creditStakes ?? this.#creditStakes,
      creditUnstakes: overrides.creditUnstakes ?? this.#creditUnstakes,
      creditUsage: overrides.creditUsage ?? this.#creditUsage,
      height: overrides.height ?? this.height,
      nonces: overrides.nonces ?? this.#nonces,
      progressEscrows: overrides.progressEscrows ?? this.#progressEscrows,
    });
  }

  get accountStateRoot() { return computeAccountStateRoot(this.#accountStates()); }

  accountState(address) {
    assertAddress(address, "account state address");
    return this.#accountStates().find((account) => account.address === address) ??
      emptyAccountState(address);
  }

  accountStateProof(address) {
    const accounts = this.#accountStates();
    const witness = createAccountStateWitness(accounts, address);
    return {
      account: accounts.find((entry) => entry.address === address) ?? emptyAccountState(address),
      ...witness,
    };
  }

  epochRandomnessStatus() {
    return structuredClone(this.#epochRandomness.snapshot());
  }

  beaconAuthorityStatus() {
    const authorities = [...this.#beaconAuthorities.values()]
      .map((member) => structuredClone(member))
      .sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
    return {
      authorities,
      generation: this.#beaconGeneration,
      pendingRetirements: [...this.#pendingBeaconRetirements.values()]
        .map((pending) => structuredClone(pending))
        .sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0),
      pendingRotation: structuredClone(this.#pendingBeaconRotation),
      pendingAdmissions: [...this.#pendingBeaconAdmissions.values()]
        .map((admission) => structuredClone(admission))
        .sort((left, right) => left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0),
      registeredCount: this.#registeredBeaconAuthorities.size,
      retiredCount: this.#retiredBeaconAuthorities.size,
      setId: beaconAuthoritySetId({
        generation: this.#beaconGeneration, members: authorities, networkId: this.#networkId,
      }),
    };
  }

  #assertBeaconRotationAdmissions(rotation, currentHeight) {
    const proposedNew = [];
    for (const member of rotation.authorities ?? []) {
      const active = this.#beaconAuthorities.get(member.address);
      if (active) {
        if (canonicalJson(active) !== canonicalJson(member)) {
          throw new Error("active beacon authority identity changed during rotation");
        }
        continue;
      }
      const admission = this.#pendingBeaconAdmissions.get(member.address);
      const admittedMember = admission && { address: admission.address,
        algorithm: admission.algorithm, operatorId: admission.operatorId,
        publicKey: admission.publicKey };
      if (!admission || canonicalJson(admittedMember) !== canonicalJson(member) ||
          admission.activationHeight > currentHeight ||
          admission.expiryHeight <= rotation.activationHeight) {
        throw new Error("next beacon authority lacks an eligible admission");
      }
      proposedNew.push(admission);
    }
    const eligible = [...this.#pendingBeaconAdmissions.values()]
      .filter((admission) => admission.activationHeight <= currentHeight &&
        admission.expiryHeight > rotation.activationHeight)
      .sort((left, right) => left.rank < right.rank ? -1 : left.rank > right.rank ? 1 :
        left.address < right.address ? -1 : left.address > right.address ? 1 : 0)
      .slice(0, proposedNew.length)
      .map(({ address }) => address)
      .sort();
    if (canonicalJson(proposedNew.map(({ address }) => address).sort()) !== canonicalJson(eligible)) {
      throw new Error("next beacon authorities do not match deterministic admission priority");
    }
  }

  #stateRoot(overrides = {}) {
    const protocolVersion = overrides.protocolVersion ?? this.#protocolVersion;
    return computeChainStateRoot({
      accountHistories: overrides.accountHistories ?? this.#accountHistories,
      ...(protocolVersion >= 25 ? {
        assetBalances: overrides.assetBalances ?? this.#assetBalances,
        assets: overrides.assets ?? this.#assets,
      } : {}),
      balances: overrides.balances ?? this.#balances,
      beaconBondingActive: overrides.beaconBondingActive ?? this.#beaconBondingActive,
      beaconBonds: overrides.beaconBonds ?? this.#beaconBonds,
      beaconAuthorities: overrides.beaconAuthorities ?? this.#beaconAuthorities,
      beaconFaults: overrides.beaconFaults ?? this.#beaconFaults,
      beaconGeneration: overrides.beaconGeneration ?? this.#beaconGeneration,
      burned: overrides.burned ?? this.#burned,
      candidateBonds: overrides.candidateBonds ?? this.#candidateBonds,
      capabilityMemoryRoot: overrides.capabilityMemoryRoot ?? this.#capabilityMemory.stateRoot,
      creditDelegations: overrides.creditDelegations ?? this.#creditDelegations,
      creditStakes: overrides.creditStakes ?? this.#creditStakes,
      creditUnstakes: overrides.creditUnstakes ?? this.#creditUnstakes,
      creditUsage: overrides.creditUsage ?? this.#creditUsage,
      disabledEvaluators: overrides.disabledEvaluators ?? this.#disabledEvaluators,
      disabledValidators: overrides.disabledValidators ?? this.#disabledValidators,
      epochRandomness: overrides.epochRandomness ?? this.#epochRandomness.snapshot(),
      evaluatorBonds: overrides.evaluatorBonds ?? this.#evaluatorBonds,
      evaluatorFaults: overrides.evaluatorFaults ?? this.#evaluatorFaults,
      evaluators: overrides.evaluators ?? this.#evaluators,
      lastRewardTimestamp: overrides.lastRewardTimestamp ?? this.#lastRewardTimestamp,
      mined: overrides.mined ?? this.#mined,
      nonces: overrides.nonces ?? this.#nonces,
      pendingEvaluatorRegistrations:
        overrides.pendingEvaluatorRegistrations ?? this.#pendingEvaluatorRegistrations,
      pendingBeaconRotation:
        overrides.pendingBeaconRotation === undefined
          ? this.#pendingBeaconRotation : overrides.pendingBeaconRotation,
      pendingBeaconRetirements:
        overrides.pendingBeaconRetirements ?? this.#pendingBeaconRetirements,
      pendingBeaconAdmissions:
        overrides.pendingBeaconAdmissions ?? this.#pendingBeaconAdmissions,
      pendingValidatorRotation:
        overrides.pendingValidatorRotation === undefined
          ? this.#pendingValidatorRotation : overrides.pendingValidatorRotation,
      pendingProtocolUpgrade:
        overrides.pendingProtocolUpgrade === undefined
          ? this.#pendingProtocolUpgrade : overrides.pendingProtocolUpgrade,
      peerRegistry: overrides.peerRegistry === undefined ? this.#peerRegistry : overrides.peerRegistry,
      progressCommitments: overrides.progressCommitments ?? this.#progressCommitments,
      progressEscrows: overrides.progressEscrows ?? this.#progressEscrows,
      progressFraudEvidence: overrides.progressFraudEvidence ?? this.#progressFraudEvidence,
      protocolVersion,
      randomnessFaults: overrides.randomnessFaults ?? this.#randomnessFaults,
      registeredBeaconAuthorities:
        overrides.registeredBeaconAuthorities ?? this.#registeredBeaconAuthorities,
      retiredBeaconAuthorities:
        overrides.retiredBeaconAuthorities ?? this.#retiredBeaconAuthorities,
      registeredValidators: overrides.registeredValidators ?? this.#registeredValidators,
      rewardEpoch: overrides.rewardEpoch ?? this.#rewardEpoch,
      rewardedProofs: overrides.rewardedProofs ?? this.#rewardedProofs,
      safetyEvidence: overrides.safetyEvidence ?? this.#safetyEvidence,
      validatorBonds: overrides.validatorBonds ?? this.#validatorBonds,
      validatorAdmissionOmissionEvidence:
        overrides.validatorAdmissionOmissionEvidence ?? this.#validatorAdmissionOmissionEvidence,
      validatorEquivocationEvidence:
        overrides.validatorEquivocationEvidence ?? this.#validatorEquivocationEvidence,
      validatorRecoveryGeneration:
        overrides.validatorRecoveryGeneration ?? this.#validatorRecoveryGeneration,
      validatorRecoveryPlan: overrides.validatorRecoveryPlan === undefined
        ? this.#validatorRecoveryPlan : overrides.validatorRecoveryPlan,
      validatorFaults: overrides.validatorFaults ?? this.#validatorFaults,
      validators: overrides.validators ?? this.#validators,
    });
  }

  consensusSnapshot() {
    return {
      capabilityMemory: this.#capabilityMemory.snapshot(),
      state: normalizedStateValue({
        accountHistories: this.#accountHistories,
        ...(this.#protocolVersion >= 25 ? {
          assetBalances: this.#assetBalances,
          assets: this.#assets,
        } : {}),
        balances: this.#balances,
        beaconBondingActive: this.#beaconBondingActive,
        beaconBonds: this.#beaconBonds,
        beaconAuthorities: this.#beaconAuthorities,
        beaconFaults: this.#beaconFaults,
        beaconGeneration: this.#beaconGeneration,
        burned: this.#burned,
        candidateBonds: this.#candidateBonds,
        capabilityMemoryRoot: this.#capabilityMemory.stateRoot,
        creditDelegations: this.#creditDelegations,
        creditStakes: this.#creditStakes,
        creditUnstakes: this.#creditUnstakes,
        creditUsage: this.#creditUsage,
        disabledEvaluators: this.#disabledEvaluators,
        disabledValidators: this.#disabledValidators,
        epochRandomness: this.#epochRandomness.snapshot(),
        evaluatorBonds: this.#evaluatorBonds,
        evaluatorFaults: this.#evaluatorFaults,
        lastRewardTimestamp: this.#lastRewardTimestamp,
        mined: this.#mined,
        nonces: this.#nonces,
        pendingEvaluatorRegistrations: this.#pendingEvaluatorRegistrations,
        pendingBeaconRotation: this.#pendingBeaconRotation,
        pendingBeaconRetirements: this.#pendingBeaconRetirements,
        pendingBeaconAdmissions: this.#pendingBeaconAdmissions,
        pendingProtocolUpgrade: this.#pendingProtocolUpgrade,
        pendingValidatorRotation: this.#pendingValidatorRotation,
        peerRegistry: this.#peerRegistry,
        progressCommitments: this.#progressCommitments,
        progressEscrows: this.#progressEscrows,
        progressFraudEvidence: this.#progressFraudEvidence,
        protocolVersion: this.#protocolVersion,
        randomnessFaults: this.#randomnessFaults,
        registeredBeaconAuthorities: this.#registeredBeaconAuthorities,
        retiredBeaconAuthorities: this.#retiredBeaconAuthorities,
        registeredValidators: this.#registeredValidators,
        rewardEpoch: this.#rewardEpoch,
        rewardedProofs: this.#rewardedProofs,
        safetyEvidence: this.#safetyEvidence,
        validatorBonds: this.#validatorBonds,
        validatorAdmissionOmissionEvidence: this.#validatorAdmissionOmissionEvidence,
        validatorEquivocationEvidence: this.#validatorEquivocationEvidence,
        validatorRecoveryGeneration: this.#validatorRecoveryGeneration,
        validatorRecoveryPlan: this.#validatorRecoveryPlan,
        validatorFaults: this.#validatorFaults,
        validators: this.#validators,
        evaluators: this.#evaluators,
      }),
    };
  }

  get nextIssuanceEpoch() {
    return this.#rewardEpoch;
  }

  assignedSafetyEvaluators(candidateId) {
    const candidate = this.#candidateBonds.get(candidateId);
    if (candidate?.purpose !== "safety" || !candidate.committee) {
      throw new Error("candidate safety committee is not assigned");
    }
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
  validatorDisabled(address) { return this.#disabledValidators.has(address); }
  validatorAdmissionOmissionEvidenceUsed(evidenceHash) {
    return this.#validatorAdmissionOmissionEvidence.has(evidenceHash);
  }
  validatorEquivocationEvidenceUsed(evidenceHash) {
    return this.#validatorEquivocationEvidence.has(evidenceHash);
  }
  get validatorRecoveryGeneration() { return this.#validatorRecoveryGeneration; }
  get validatorRecoveryPlan() {
    return this.#validatorRecoveryPlan ? structuredClone(this.#validatorRecoveryPlan) : null;
  }
  beaconBond(address) { return this.#beaconBonds.get(address) ?? 0n; }
  beaconFaultCount(address) { return this.#beaconFaults.get(address) ?? 0; }
  evaluatorBond(address) { return this.#evaluatorBonds.get(address) ?? 0n; }
  evaluatorDisabled(address) { return this.#disabledEvaluators.has(address); }
  evaluatorFaultCount(address) { return this.#evaluatorFaults.get(address) ?? 0; }
  get beaconBondingActive() { return this.#beaconBondingActive; }
  creditStake(address) { return this.#creditStakes.get(address) ?? 0n; }
  creditDelegation(owner, delegate) {
    return structuredClone(this.#creditDelegations.get(creditDelegationKey(owner, delegate)) ?? null);
  }
  creditDelegations(owner) {
    assertAddress(owner, "credit delegation owner");
    return [...this.#creditDelegations.values()]
      .filter((delegation) => delegation.owner === owner)
      .sort((left, right) => left.delegate.localeCompare(right.delegate))
      .map((delegation) => structuredClone(delegation));
  }
  creditUnstake(address) { return structuredClone(this.#creditUnstakes.get(address) ?? null); }

  transferCredits(address, height = this.height + 1) {
    const allowance = transferCreditAllowance(this.creditStake(address));
    const epoch = transferCreditEpoch(height);
    const usage = this.#creditUsage.get(address);
    const spent = usage?.epoch === epoch ? BigInt(usage.spent) : 0n;
    return allowance > spent ? allowance - spent : 0n;
  }

  get validatorSetId() { return validatorSetId([...this.#validators.values()]
    .sort((left, right) => left.address.localeCompare(right.address))); }

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

  get protocolVersion() { return this.#protocolVersion; }

  get pendingProtocolUpgrade() {
    return this.#pendingProtocolUpgrade ? structuredClone(this.#pendingProtocolUpgrade) : null;
  }

  get peerRegistryHash() {
    return this.#peerRegistry ? peerRegistryHash(this.#peerRegistry) : "0".repeat(64);
  }

  get peerRegistry() {
    return this.#peerRegistry ? structuredClone(this.#peerRegistry) : null;
  }

  #eligibleEvaluators(evaluatorBonds = this.#evaluatorBonds,
    disabledEvaluators = this.#disabledEvaluators, evaluators = this.#evaluators) {
    return new Map([...evaluators].filter(([address]) =>
      !disabledEvaluators.has(address) &&
      (evaluatorBonds.get(address) ?? 0n) >= MIN_EVALUATOR_BOND));
  }

  #treasuryLockedFloor(timestamp) {
    const floor = TREASURY_ALLOCATION - this.#genesisEvaluatorBondAllocation -
      vestedTreasuryAtTimestamp(this.#genesisTimestamp, timestamp);
    return floor > 0n ? floor : 0n;
  }

  randomnessFault(candidateId) {
    const fault = this.#randomnessFaults.get(candidateId);
    return fault ? structuredClone(fault) : null;
  }

  prepareProgressEvaluation(evaluation) {
    const normalized = {
      ...structuredClone(evaluation),
      contentHash: evaluation.contentHash ?? evaluation.artifactHash,
    };
    const report = this.#capabilityMemory.assess(normalized);
    return {
      ...normalized,
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

  #expectedRecoveryProposer(height) {
    if (!this.#validatorRecoveryPlan) throw new Error("validator recovery plan is unavailable");
    const order = this.#validatorRecoveryPlan.reserves.map(({ address }) => address).sort();
    return order[height % order.length];
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
      admission.baselineContentHash !== claim.evaluation.baselineContentHash ||
      admission.baselineHash !== claim.evaluation.baselineHash ||
      admission.contentHash !== claim.evaluation.contentHash ||
      JSON.stringify(admission.parents) !== JSON.stringify(claim.evaluation.parents) ||
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
    if (claim.evaluation.gainPpm > novelty.noveltyBps * 100) {
      throw new Error("progress gain exceeds its world-frontier improvement bound");
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
        this.#disabledEvaluators.has(attestation.evaluator) ||
        (this.#evaluatorBonds.get(attestation.evaluator) ?? 0n) < MIN_EVALUATOR_BOND ||
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
    return novelty;
  }

  #verifyProgressFraudProof(evidence, height, progressEscrows, progressFraudEvidence) {
    if (!evidence || Object.keys(evidence).sort().join("\0") !==
        ["candidateId", "conflictingClaim", "evidenceHash", "format"].sort().join("\0") ||
        evidence.format !== "nir-progress-evaluator-equivocation-v1" ||
        !/^[0-9a-f]{64}$/.test(evidence.candidateId ?? "") ||
        !/^[0-9a-f]{64}$/.test(evidence.evidenceHash ?? "") ||
        progressFraudEvidence.has(evidence.evidenceHash)) {
      throw new Error("progress fraud evidence is invalid or replayed");
    }
    const { evidenceHash, ...payload } = evidence;
    if (evidenceHash !== hashObject(payload, "PROGRESS_FRAUD_EVIDENCE_V1")) {
      throw new Error("progress fraud evidence hash is invalid");
    }
    const escrow = progressEscrows.get(evidence.candidateId);
    if (!escrow || height > escrow.unlockHeight) {
      throw new Error("progress fraud evidence is late or has no escrow");
    }
    const claim = evidence.conflictingClaim;
    if (!claim || Object.keys(claim).sort().join("\0") !==
        ["attestations", "epoch", "evaluation", "fingerprint", "networkId", "recipient", "score"]
          .sort().join("\0") || claim.networkId !== this.#networkId ||
        claim.epoch !== escrow.epoch || claim.evaluation?.candidateId !== evidence.candidateId) {
      throw new Error("conflicting progress receipt context is invalid");
    }
    const receipt = progressReceiptPayload({ networkId: claim.networkId, epoch: claim.epoch,
      recipient: claim.recipient, evaluation: claim.evaluation });
    if (claim.fingerprint !== receipt.fingerprint || claim.score !== receipt.score ||
        hashObject(receipt, "PROGRESS_ESCROW_RECEIPT_V1") === escrow.acceptedReceiptHash) {
      throw new Error("progress fraud evidence does not prove a conflicting receipt");
    }
    if (!Array.isArray(claim.attestations) || claim.attestations.length !== escrow.committee.length) {
      throw new Error("conflicting progress receipt has no assigned quorum");
    }
    const seen = new Set();
    for (const attestation of claim.attestations) {
      const evaluator = this.#evaluators.get(attestation?.evaluator);
      if (!evaluator || !escrow.committee.includes(attestation.evaluator) ||
          seen.has(attestation.evaluator) || typeof attestation.signature !== "string" ||
          attestation.signature.length > 7_000 ||
          !verifyObject(receipt, attestation.signature, evaluator.publicKey, "PROGRESS_RECEIPT")) {
        throw new Error("conflicting progress receipt signature is invalid");
      }
      seen.add(attestation.evaluator);
    }
    if (seen.size !== escrow.committee.length) {
      throw new Error("conflicting progress receipt committee is incomplete");
    }
    if (progressFraudEvidence.size >= MAX_PROGRESS_FRAUD_EVIDENCE) {
      throw new Error("progress fraud replay capacity is exceeded");
    }
    progressFraudEvidence.set(evidenceHash, height);
    return { candidateId: evidence.candidateId, evaluators: [...seen].sort() };
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
    if (candidate.purpose !== "safety") throw new Error("progress bond cannot fund a safety claim");
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
        !evaluator || this.#disabledEvaluators.has(attestation.evaluator) ||
        (this.#evaluatorBonds.get(attestation.evaluator) ?? 0n) < MIN_EVALUATOR_BOND ||
        typeof attestation.signature !== "string" || attestation.signature.length > 7_000 ||
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
    progressFraudProofs = [],
    beaconRotation = null, validatorRotation = null, peerRegistryUpdate = null,
    protocolUpgrade = null,
    timestamp = Date.now(), round = 0, roundCertificate = null,
  }) {
    const recovery = transactions.length === 1 && transactions[0]?.type === "validator-recovery";
    if (recovery && (rewardClaims.length > 0 || safetyClaims.length > 0 ||
        randomnessCommits.length > 0 || randomnessReveals.length > 0 ||
        fallbackBeacons.length > 0 || epochRandomnessCommits.length > 0 ||
        epochRandomnessReveals.length > 0 || progressBeacons.length > 0 ||
        progressFraudProofs.length > 0 || beaconRotation !== null || validatorRotation !== null ||
        peerRegistryUpdate !== null || protocolUpgrade !== null || round !== 0 ||
        roundCertificate !== null)) {
      throw new Error("validator recovery block cannot contain ordinary consensus work");
    }
    if (validatorRotation !== null &&
        transactions.some(({ type }) => type === "validator-equivocation")) {
      throw new Error("validator equivocation and rotation require separate blocks");
    }
    const height = this.height + 1;
    const nextProtocolVersion = protocolVersionAtNextHeight({
      currentHeight: this.height,
      currentVersion: this.#protocolVersion,
      pendingUpgrade: this.#pendingProtocolUpgrade,
      supportedVersions: this.#supportedProtocolVersions,
    });
    const protocolState = protocolTransition({
      blockVersion: nextProtocolVersion,
      currentHeight: height,
      currentVersion: this.#protocolVersion,
      pendingUpgrade: this.#pendingProtocolUpgrade,
      proposedUpgrade: protocolUpgrade,
      supportedVersions: this.#supportedProtocolVersions,
    });
    consensusEncodingVersionForProtocol(protocolState.protocolVersion);
    if (recovery && protocolState.protocolVersion !== this.#protocolVersion) {
      throw new Error("validator recovery cannot share a protocol activation boundary");
    }
    const scheduledProtocolUpgrade = protocolUpgrade === null
      ? null : protocolState.pendingUpgrade;
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
    const reservations = orderedProgressEscrows(this.#progressEscrows)
      .map(([, escrow]) => progressReservation(escrow.evaluation, escrow.marginalCapabilities));
    for (const claim of progressRewards) {
      const novelty = this.#verifyProgressClaim(
        claim,
        height,
        stagedMemory,
        this.#progressCommitments,
      );
      assertProgressReservationAvailable(
        claim.evaluation, Object.keys(novelty.marginalGainsBps), reservations,
      );
    }
    assertProgressRewardCollateral(progressRewards, this.#candidateBonds);
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
    let scheduledBeaconRotation = null;
    if (beaconRotation !== null) {
      if (this.#pendingBeaconRotation || !this.#beaconBondingActive) {
        throw new Error("beacon rotation is already pending or bonding is inactive");
      }
      this.#assertBeaconRotationAdmissions(beaconRotation, this.height);
      scheduledBeaconRotation = verifyBeaconRotation(beaconRotation, {
        bonds: this.#beaconBonds,
        currentAuthorities: [...this.#beaconAuthorities.values()],
        currentGeneration: this.#beaconGeneration,
        currentHeight: this.height,
        networkId: this.#networkId,
      });
    }
    if (validatorRotation !== null) {
      if (this.#pendingValidatorRotation) throw new Error("a validator rotation is already pending");
      const proposed = (validatorRotation.validators ?? []).map(({ address }) => {
        const member = this.#registeredValidators.get(address);
        if (!member) throw new Error("proposed validator is not registered");
        if (this.#disabledValidators.has(address)) {
          throw new Error("disabled validator cannot be proposed for rotation");
        }
        return member;
      });
      scheduledRotation = scheduleValidatorRotation({
        current: [...this.#validators.values()], proposed, bonds: this.#validatorBonds,
        disabled: this.#disabledValidators,
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
    if (beaconRotation !== null && (validatorRotation !== null || peerRegistryUpdate !== null)) {
      throw new Error("beacon, validator, and peer rotations require separate blocks");
    }
    if ((validatorRotation !== null || this.#pendingValidatorRotation) && peerRegistryUpdate !== null) {
      throw new Error("validator and peer registry rotations require separate blocks");
    }
    const activatingOnboarding = this.#pendingValidatorRotation?.activationHeight === height
      ? this.#pendingValidatorRotation.onboarding ?? null : null;
    let nextPeerRegistry = activatingOnboarding ?? (peerRegistryUpdate === null ? this.#peerRegistry :
      verifyPeerRegistry(peerRegistryUpdate, {
        currentHeight: height,
        networkId: this.#networkId,
        previousRegistry: this.#peerRegistry,
        validators: [...this.#validators.values()],
      }));
    if (recovery && this.#peerRegistry) {
      nextPeerRegistry = createValidatorRecoveryPeerRegistry({
        activationHeight: height,
        generation: this.#validatorRecoveryPlan.generation,
        networkId: this.#networkId,
        peers: this.#validatorRecoveryPlan.peers,
        planHash: this.#validatorRecoveryPlan.planHash,
        previousRegistry: this.#peerRegistry,
      });
    }
    if (peerRegistryUpdate !== null && nextPeerRegistry.activationHeight !== height) {
      throw new Error("peer registry must activate at its containing block height");
    }
    const proposer = recovery ? this.#expectedRecoveryProposer(height) :
      this.expectedProposer(height, round);
    const proposal = {
      accountStateRoot: "0".repeat(64),
      beaconRotation: scheduledBeaconRotation,
      capabilityMemoryRoot: this.#capabilityMemory.stateRoot,
      height,
      networkId: this.#networkId,
      peerRegistryHash: nextPeerRegistry ? peerRegistryHash(nextPeerRegistry) : "0".repeat(64),
      peerRegistryUpdate: activatingOnboarding || nextPeerRegistry === this.#peerRegistry
        ? null : nextPeerRegistry,
      previousHash: this.#blocks.at(-1).hash,
      epochRandomnessCommits,
      epochRandomnessReveals,
      progressRewards,
      progressFraudProofs,
      fallbackBeacons,
      progressBeacons,
      randomnessCommits,
      randomnessReveals,
      safetySettlements,
      validatorRotation: scheduledRotation,
      issuanceEpoch: progressRewards.length > 0 ? this.#rewardEpoch : null,
      feeRecipient: recovery ? proposer : this.expectedProposer(height, 0),
      proposer,
      protocolUpgrade: scheduledProtocolUpgrade,
      protocolVersion: nextProtocolVersion,
      round,
      roundCertificate,
      timestamp,
      transactionCount: transactions.length,
      transactions,
      transactionsRoot: transactionRoot(transactions),
    };
    const provisional = { ...proposal, stateRoot: "0".repeat(64) };
    const simulation = {
      ...provisional,
      certificate: [],
      hash: blockHash(provisional),
      prepareCertificate: [],
      proposer: recovery ? proposer : this.expectedProposer(height, 0),
      round: 0,
      roundCertificate: null,
    };
    try {
      const trial = this.fork();
      trial.#applyBlock(simulation, false, false);
      return {
        ...proposal,
        accountStateRoot: trial.accountStateRoot,
        capabilityMemoryRoot: trial.capabilityMemoryRoot,
        stateRoot: trial.stateRoot,
      };
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
    let prepareRound = null;
    for (const vote of block.prepareCertificate) {
      const validator = acceptedValidators.get(vote.validator);
      if (!validator || prepareVoters.has(vote.validator) ||
          !Number.isSafeInteger(vote.round) || vote.round < 0 || vote.round > block.round ||
          (prepareRound !== null && vote.round !== prepareRound) ||
          typeof vote.signature !== "string" || vote.signature.length > 7_000 ||
          !verifyObject(
            { blockHash: block.hash, height: block.height, round: vote.round },
            vote.signature,
            validator.publicKey,
            "BLOCK_PREPARE",
          )) {
        throw new Error("invalid or duplicate prepare vote");
      }
      prepareRound = vote.round;
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
        claim?.generation !== this.#beaconGeneration || claim?.round !== round ||
        !/^[0-9a-f]{64}$/.test(claim?.value ?? "") ||
        !Array.isArray(claim.attestations) || claim.attestations.length > this.#beaconAuthorities.size) {
      throw new Error("fallback beacon is invalid");
    }
    const signers = new Set();
    for (const attestation of claim.attestations) {
      const authority = this.#beaconAuthorities.get(attestation.authority);
      const payload = {
        authority: attestation.authority, candidateId, generation: claim.generation,
        networkId: this.#networkId,
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
      candidateId, generation: claim.generation, networkId: this.#networkId, round,
      shares: [...claim.attestations]
        .map(({ authority, value }) => ({ authority, value }))
        .sort((a, b) => a.authority.localeCompare(b.authority)),
    }, "FALLBACK_RANDOMNESS_SHARES");
    if (claim.value !== expectedValue) throw new Error("fallback beacon aggregate is invalid");
    return claim.value;
  }

  #verifyProgressBeacon(claim, candidateId, round, expectedCommittee) {
    if (claim?.candidateId !== candidateId || claim?.networkId !== this.#networkId ||
        claim?.generation !== this.#beaconGeneration || claim?.round !== round ||
        !/^[0-9a-f]{64}$/.test(claim?.value ?? "") ||
        !Array.isArray(claim.attestations) ||
        claim.attestations.length !== expectedCommittee.length) {
      throw new Error("progress beacon is invalid");
    }
    const required = new Set(expectedCommittee);
    const signers = new Set();
    for (const attestation of claim.attestations) {
      const authority = this.#beaconAuthorities.get(attestation.authority);
      const payload = {
        authority: attestation.authority, candidateId, generation: claim.generation,
        networkId: this.#networkId,
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
      candidateId, generation: claim.generation, networkId: this.#networkId, round,
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
    const allowance = transferCreditAllowance(stake);
    const epoch = transferCreditEpoch(height);
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
      const locked = this.#treasuryLockedFloor(timestamp);
      if (senderBalance - amount - (sponsored ? 0n : fee) < locked) {
        throw new Error("treasury funds are still vesting");
      }
    }
    if (sponsored && !creditPaid && transaction.feePayer === this.#treasuryAddress) {
      const locked = this.#treasuryLockedFloor(timestamp);
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
    const progressPurpose = transaction.purpose === "progress";
    if (progressPurpose) {
      assertAddress(transaction.candidateOwner, "progress candidate owner");
      if (bond < MIN_PROGRESS_CANDIDATE_BOND || fee !== 0n) {
        throw new Error("progress candidate bond amount or fee is invalid");
      }
    } else if (transaction.purpose !== undefined || transaction.candidateOwner !== undefined) {
      throw new Error("candidate bond purpose is invalid");
    } else {
      if (bond === 0n) throw new Error("candidate bond must be positive");
      if (fee < MIN_TRANSFER_FEE) throw new Error("transfer fee is below the protocol minimum");
    }
    const senderBalance = balances.get(transaction.sender) ?? 0n;
    if (senderBalance < bond + fee) throw new Error("insufficient balance");
    if (transaction.sender === this.#treasuryAddress) {
      const locked = this.#treasuryLockedFloor(timestamp);
      if (senderBalance - bond - fee < locked) throw new Error("treasury funds are still vesting");
    }
    balances.set(transaction.sender, senderBalance - bond - fee);
    if (fee > 0n) balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    candidateBonds.set(transaction.candidateId, {
      bond,
      committedHeight: height,
      committee: null,
      randomnessCommits: new Map(),
      randomnessReveals: new Map(),
      submitter: transaction.sender,
      candidateOwner: progressPurpose ? transaction.candidateOwner : transaction.sender,
      purpose: progressPurpose ? "progress" : "safety",
      admissionBound: false,
    });
  }

  #applyProgressCommitment(
    transaction, nonces, progressCommitments, capabilityMemory, candidateBonds,
    progressEscrows, registeredValidators, evaluatorBonds, disabledEvaluators,
    evaluators, pendingEvaluatorRegistrations, registeredBeaconAuthorities,
    pendingBeaconAdmissions,
    height, randomnessRound,
  ) {
    if (
      transaction.type !== "progress-commitment" ||
      transaction.algorithm !== SIGNATURE_ALGORITHM ||
      transaction.networkId !== this.#networkId ||
      !/^sha256:[0-9a-f]{64}$/.test(transaction.artifactHash ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(transaction.baselineContentHash ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(transaction.baselineHash ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(transaction.contentHash ?? "") ||
      transaction.artifactHash === transaction.baselineHash ||
      !Array.isArray(transaction.parents) || transaction.parents.length === 0 ||
      transaction.parents.length > 32 ||
      transaction.parents.some((parent) => !/^sha256:[0-9a-f]{64}$/.test(parent)) ||
      new Set(transaction.parents).size !== transaction.parents.length ||
      transaction.parents.some((parent, index) => index > 0 && parent <= transaction.parents[index - 1]) ||
      !/^[0-9a-f]{64}$/.test(transaction.suiteCommitment ?? "")
    ) {
      throw new Error("progress commitment transaction is invalid");
    }
    assertAddress(transaction.sender, "progress submitter");
    assertAddress(transaction.recipient, "progress recipient");
    if (this.#eligibleEvaluators(evaluatorBonds, disabledEvaluators, evaluators).size <
        this.#evaluationQuorum) {
      throw new Error("progress admission has no bonded evaluator quorum");
    }
    if ([transaction.sender, transaction.recipient].some((address) =>
      evaluators.has(address) || pendingEvaluatorRegistrations.has(address) ||
      registeredBeaconAuthorities.has(address) ||
      pendingBeaconAdmissions.has(address) ||
      registeredValidators.has(address))) {
      throw new Error("progress submitter and recipient must use keys outside protocol operator roles");
    }
    const candidateBond = candidateBonds.get(transaction.candidateId);
    if (
      !candidateBond || candidateBond.purpose !== "progress" ||
      candidateBond.candidateOwner !== transaction.sender ||
      candidateBond.bond < MIN_PROGRESS_CANDIDATE_BOND ||
      candidateBond.admissionBound || candidateBond.committedHeight >= height
    ) {
      throw new Error("progress commitment requires a prior unbound candidate bond");
    }
    if (capabilityMemory.contentForArtifact(transaction.baselineHash) !==
        transaction.baselineContentHash) {
      if ([...progressEscrows.values()].some(({ evaluation }) =>
        evaluation.artifactHash === transaction.baselineHash)) {
        throw new Error("pending progress escrow cannot be used as a baseline");
      }
      throw new Error("baseline canonical content does not match the known baseline artifact");
    }
    const expectedId = progressCandidateId(transaction);
    if (
      transaction.candidateId !== expectedId ||
      progressCommitments.has(expectedId) ||
      capabilityMemory.hasContent(transaction.contentHash) ||
      [...progressEscrows.values()].some(({ evaluation }) =>
        evaluation.artifactHash === transaction.artifactHash ||
        evaluation.contentHash === transaction.contentHash) ||
      [...progressCommitments.values()].some(({ contentHash }) =>
        contentHash === transaction.contentHash) ||
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
    candidateBonds.set(expectedId, { ...candidateBond, admissionBound: true });
    progressCommitments.set(expectedId, {
      artifactHash: transaction.artifactHash,
      baselineContentHash: transaction.baselineContentHash,
      baselineHash: transaction.baselineHash,
      contentHash: transaction.contentHash,
      beaconCommittee: null,
      beaconCommitteeHeight: null,
      beaconCommitteeSource: null,
      beaconGeneration: null,
      beaconRandomnessRound: null,
      beaconValue: null,
      challengeHeight: null,
      challengeSeed: null,
      committee: null,
      committedHeight: height,
      randomnessRound,
      parents: structuredClone(transaction.parents),
      recipient: transaction.recipient,
      sender: transaction.sender,
      suiteCommitment: transaction.suiteCommitment,
    });
  }

  #applyValidatorBond(
    transaction, balances, nonces, validatorBonds, registeredValidators,
    disabledValidators, progressCommitments, evaluators, pendingEvaluatorRegistrations,
    registeredBeaconAuthorities, pendingBeaconAdmissions, retiredBeaconAuthorities, proposer,
  ) {
    if ([...progressCommitments.values()].some(({ sender, recipient }) =>
      transaction.sender === sender || transaction.sender === recipient)) {
      throw new Error("validator key cannot have a pending progress commitment");
    }
    let validator = registeredValidators.get(transaction.sender);
    if (transaction.type !== "validator-bond" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature, transaction.publicKey, "VALIDATOR_BOND")) {
      throw new Error("validator bond transaction is invalid");
    }
    if (disabledValidators.has(transaction.sender)) {
      throw new Error("disabled validator identity cannot bond again");
    }
    if (!validator) {
      if (typeof transaction.operatorId !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(transaction.operatorId) ||
          registeredValidators.size >= MAX_VALIDATORS ||
          evaluators.has(transaction.sender) || pendingEvaluatorRegistrations.has(transaction.sender) ||
          registeredBeaconAuthorities.has(transaction.sender) ||
          pendingBeaconAdmissions.has(transaction.sender) ||
          retiredBeaconAuthorities.has(transaction.sender) ||
          [...retiredBeaconAuthorities.values()].some((member) =>
            member.publicKey === transaction.publicKey ||
            member.operatorId === transaction.operatorId) ||
          [...registeredValidators.values(), ...evaluators.values(),
            ...pendingEvaluatorRegistrations.values(), ...registeredBeaconAuthorities.values(),
            ...pendingBeaconAdmissions.values(),
            ...retiredBeaconAuthorities.values()]
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

  #applyEvaluatorBond(transaction, balances, nonces, evaluatorBonds,
    disabledEvaluators, evaluators, pendingEvaluatorRegistrations,
    registeredValidators, registeredBeaconAuthorities, pendingBeaconAdmissions,
    retiredBeaconAuthorities,
    activeValidators, proposer, height) {
    const evaluator = evaluators.get(transaction.sender);
    if (transaction.type !== "evaluator-bond" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature,
          transaction.publicKey, "EVALUATOR_BOND")) {
      throw new Error("evaluator bond transaction is invalid");
    }
    if (evaluator && (evaluator.publicKey !== transaction.publicKey ||
        transaction.operatorId !== undefined || transaction.activationHeight !== undefined)) {
      throw new Error("evaluator bond identity does not match its registration");
    }
    if (evaluator && disabledEvaluators.has(transaction.sender)) {
      throw new Error("disabled evaluator identity cannot bond again");
    }
    if (!evaluator) {
      const eligibleCount = this.#eligibleEvaluators(
        evaluatorBonds, disabledEvaluators, evaluators,
      ).size;
      const occupiedOperators = [
        ...evaluators.values(), ...pendingEvaluatorRegistrations.values(),
        ...registeredValidators.values(), ...registeredBeaconAuthorities.values(),
        ...pendingBeaconAdmissions.values(),
        ...retiredBeaconAuthorities.values(),
      ].some(({ operatorId }) => operatorId === transaction.operatorId);
      if (pendingEvaluatorRegistrations.has(transaction.sender) ||
          registeredValidators.has(transaction.sender) ||
          registeredBeaconAuthorities.has(transaction.sender) ||
          pendingBeaconAdmissions.has(transaction.sender) ||
          retiredBeaconAuthorities.has(transaction.sender) ||
          [...retiredBeaconAuthorities.values()].some(({ publicKey }) =>
            publicKey === transaction.publicKey) ||
          typeof transaction.operatorId !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(transaction.operatorId) ||
          occupiedOperators || evaluators.size + pendingEvaluatorRegistrations.size >= 256 ||
          eligibleCount + pendingEvaluatorRegistrations.size >= this.#genesisEvaluatorCount ||
          transaction.activationHeight !== height + EVALUATOR_ACTIVATION_DELAY_BLOCKS) {
        throw new Error("new evaluator registration is invalid or has no vacant slot");
      }
      const credentialFields = [
        "algorithm", "authority", "networkId", "operatorAddress", "operatorId",
        "publicKeyHash", "role", "signature", "validFromEpoch", "validUntilEpoch",
      ].sort().join("\0");
      const validatorQuorum = Math.floor((activeValidators.size * 2) / 3) + 1;
      const authorities = new Map([...activeValidators]
        .map(([address, member]) => [address, member.publicKey]));
      const operator = {
        address: transaction.sender,
        operatorId: transaction.operatorId,
        publicKey: transaction.publicKey,
      };
      const attesters = new Set();
      if (!Array.isArray(transaction.credentials) ||
          transaction.credentials.length < validatorQuorum ||
          transaction.credentials.length > activeValidators.size) {
        throw new Error("new evaluator lacks a bounded validator credential quorum");
      }
      for (const credential of transaction.credentials) {
        if (!credential || Object.keys(credential).sort().join("\0") !== credentialFields ||
            attesters.has(credential.authority) ||
            !Number.isSafeInteger(credential.validFromEpoch) ||
            !Number.isSafeInteger(credential.validUntilEpoch) ||
            credential.validFromEpoch > height ||
            credential.validUntilEpoch < transaction.activationHeight ||
            height - credential.validFromEpoch > EVALUATOR_CREDENTIAL_LIFETIME_BLOCKS ||
            credential.validUntilEpoch - credential.validFromEpoch >
              EVALUATOR_CREDENTIAL_LIFETIME_BLOCKS ||
            !verifyOperatorCredential({
              credential, operator, role: "evaluator", networkId: this.#networkId,
              epoch: height, authorities,
            })) {
          throw new Error("new evaluator credential is duplicated, stale, or invalid");
        }
        attesters.add(credential.authority);
      }
      if (attesters.size < validatorQuorum) {
        throw new Error("new evaluator credential quorum is not independent");
      }
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    const amount = parseAtomic(transaction.amount, "evaluator bond");
    const fee = parseAtomic(transaction.fee, "fee");
    if (amount === 0n || (!evaluator && amount < MIN_EVALUATOR_BOND) ||
        fee < MIN_TRANSFER_FEE) {
      throw new Error("evaluator bond or fee is below minimum");
    }
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < amount + fee) throw new Error("insufficient balance");
    balances.set(transaction.sender, balance - amount - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    evaluatorBonds.set(transaction.sender,
      (evaluatorBonds.get(transaction.sender) ?? 0n) + amount);
    if (!evaluator) {
      pendingEvaluatorRegistrations.set(transaction.sender, {
        activationHeight: transaction.activationHeight,
        address: transaction.sender,
        algorithm: transaction.algorithm,
        operatorId: transaction.operatorId,
        publicKey: transaction.publicKey,
      });
    }
  }

  #applyValidatorEquivocation(
    transaction, balances, nonces, validatorBonds, validatorFaults,
    disabledValidators, equivocationEvidence, proposer, finalizedBlock,
  ) {
    verifyValidatorEquivocationTransactionEnvelope(transaction, this.#networkId);
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    if (equivocationEvidence.has(transaction.evidence.evidenceHash)) {
      throw new Error("validator equivocation evidence was already used");
    }
    const fee = parseAtomic(transaction.fee, "fee");
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < fee) throw new Error("insufficient balance");
    const penalty = verifyFinalizedValidatorEquivocationEvidence(transaction.evidence, {
      finalizedHeader: blockHeader(finalizedBlock),
      finalizedRound: finalizedBlock.prepareCertificate[0]?.round,
      headerHash: blockHeaderHash,
      validatorBonds,
      validators: [...this.#validators.values()],
    });
    balances.set(transaction.sender, balance - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    validatorBonds.delete(penalty.validator);
    validatorFaults.set(penalty.validator, (validatorFaults.get(penalty.validator) ?? 0) + 1);
    disabledValidators.add(penalty.validator);
    equivocationEvidence.add(penalty.evidenceHash);
    return penalty.bond;
  }

  #applyValidatorRecoveryPlan(
    transaction, balances, nonces, validatorBonds, registeredValidators, proposer, height,
  ) {
    verifyValidatorRecoveryPlanTransaction(transaction, this.#networkId);
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    const fee = parseAtomic(transaction.fee, "fee");
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < fee) throw new Error("insufficient balance");
    const plan = verifyValidatorRecoveryPlan(transaction.plan, {
      activeValidators: [...this.#validators.values()],
      bonds: validatorBonds,
      currentHeight: height,
      expectedGeneration: this.#validatorRecoveryGeneration + 1,
      networkId: this.#networkId,
      peerRegistryRequired: this.#peerRegistry !== null,
      registeredValidators,
    });
    balances.set(transaction.sender, balance - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    return plan;
  }

  #applyValidatorAdmissionOmission(
    transaction, balances, nonces, validatorBonds, validatorFaults,
    disabledValidators, usedEvidence, proposer, finalizedBlock, currentHeight,
  ) {
    verifyValidatorAdmissionOmissionTransactionEnvelope(transaction, this.#networkId);
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (transaction.nonce !== expectedNonce) throw new Error("unexpected nonce");
    if (usedEvidence.has(transaction.evidence.evidenceHash)) {
      throw new Error("validator admission omission evidence was already used");
    }
    if (usedEvidence.size >= MAX_VALIDATORS) {
      throw new Error("validator admission omission evidence capacity is exhausted");
    }
    const fee = parseAtomic(transaction.fee, "fee");
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < fee) throw new Error("insufficient balance");
    const proof = verifyValidatorAdmissionOmissionEvidence(transaction.evidence, {
      canonicalBlockHash: finalizedBlock.hash,
      canonicalCertificate: finalizedBlock.certificate,
      canonicalHeader: blockHeader(finalizedBlock),
      canonicalPrepareCertificateHash: prepareCertificateHash(finalizedBlock.prepareCertificate),
      canonicalRound: finalizedBlock.round,
      canonicalTransactionIds: finalizedBlock.transactions.map(transactionId),
      currentHeight,
      networkId: this.#networkId,
      validators: [...this.#validators.values()],
    });
    if (proof.offenders.includes(transaction.sender)) {
      throw new Error("an omission offender cannot report its own evidence");
    }
    let slashed = 0n;
    for (const offender of proof.offenders) {
      const bond = validatorBonds.get(offender) ?? 0n;
      if (disabledValidators.has(offender) || bond < MIN_VALIDATOR_BOND) {
        throw new Error("validator admission omission offender is not slashable");
      }
      slashed += bond;
    }
    const reporterReward = slashed * BigInt(ADMISSION_OMISSION_REPORTER_REWARD_BPS) / 10_000n;
    balances.set(transaction.sender, balance - fee + reporterReward);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    for (const offender of proof.offenders) {
      validatorBonds.delete(offender);
      validatorFaults.set(offender, (validatorFaults.get(offender) ?? 0) + 1);
      disabledValidators.add(offender);
    }
    usedEvidence.add(proof.evidenceHash);
    return slashed - reporterReward;
  }

  #applyBeaconBond(transaction, balances, nonces, beaconBonds, proposer, epochRandomness,
    registeredBeaconAuthorities, pendingBeaconAdmissions, retiredBeaconAuthorities,
    registeredValidators, evaluators, height) {
    const authority = registeredBeaconAuthorities.get(transaction.sender);
    const pendingAdmission = pendingBeaconAdmissions.get(transaction.sender);
    const activeAuthority = this.#beaconAuthorities.get(transaction.sender);
    if (transaction.type !== "beacon-bond" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId ||
        (activeAuthority && epochRandomness.snapshot().disabled.includes(transaction.sender)) ||
        (authority && authority.publicKey !== transaction.publicKey) || pendingAdmission ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature, transaction.publicKey, "BEACON_BOND")) {
      throw new Error("beacon bond transaction is invalid");
    }
    if (authority && transaction.operatorId !== undefined) {
      throw new Error("beacon bond identity does not match its registration");
    }
    if (!authority) {
      if (transaction.operatorId === undefined) {
        throw new Error("beacon bond transaction is invalid");
      }
      const occupied = [
        ...registeredBeaconAuthorities.values(), ...pendingBeaconAdmissions.values(),
        ...retiredBeaconAuthorities.values(),
        ...registeredValidators.values(), ...evaluators.values(),
      ].some(({ operatorId }) => operatorId === transaction.operatorId);
      const retiredIdentity = [...retiredBeaconAuthorities.values()].some((member) =>
        member.address === transaction.sender || member.publicKey === transaction.publicKey ||
        member.operatorId === transaction.operatorId);
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(transaction.operatorId ?? "") || occupied ||
          registeredValidators.has(transaction.sender) || evaluators.has(transaction.sender) ||
          retiredIdentity || pendingBeaconAdmissions.size >= MAX_PENDING_BEACON_ADMISSIONS ||
          transaction.activationHeight !== height + BEACON_ADMISSION_DELAY_BLOCKS) {
        throw new Error("new beacon authority identity is invalid or duplicated");
      }
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    const amount = parseAtomic(transaction.amount, "beacon bond");
    const fee = parseAtomic(transaction.fee, "fee");
    if (amount === 0n || (!authority && amount !== MIN_BEACON_BOND) || fee < MIN_TRANSFER_FEE) {
      throw new Error("beacon bond or fee is below minimum");
    }
    const balance = balances.get(transaction.sender) ?? 0n;
    if (balance < amount + fee) throw new Error("insufficient balance");
    balances.set(transaction.sender, balance - amount - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    beaconBonds.set(transaction.sender, (beaconBonds.get(transaction.sender) ?? 0n) + amount);
    if (!authority) {
      const member = { address: transaction.sender, algorithm: transaction.algorithm,
        operatorId: transaction.operatorId, publicKey: transaction.publicKey };
      pendingBeaconAdmissions.set(transaction.sender, {
        ...member,
        activationHeight: transaction.activationHeight,
        expiryHeight: transaction.activationHeight + BEACON_ADMISSION_EXPIRY_BLOCKS,
        rank: beaconAdmissionRank({ member, networkId: this.#networkId, submittedHeight: height }),
        submittedHeight: height,
      });
    }
  }

  #applyBeaconRetirement(transaction, nonces, beaconBonds, balances, proposer,
    registeredBeaconAuthorities, pendingBeaconRetirements, height) {
    const authority = registeredBeaconAuthorities.get(transaction.sender);
    if (transaction.type !== "beacon-retire" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
        transaction.networkId !== this.#networkId || !authority ||
        authority.publicKey !== transaction.publicKey ||
        this.#beaconAuthorities.has(transaction.sender) ||
        this.#pendingBeaconRotation?.authorities.some(({ address }) =>
          address === transaction.sender) || pendingBeaconRetirements.has(transaction.sender) ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature,
          transaction.publicKey, "BEACON_RETIREMENT_V1")) {
      throw new Error("beacon retirement transaction is invalid or authority is still referenced");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    const fee = parseAtomic(transaction.fee, "fee");
    const bond = beaconBonds.get(transaction.sender) ?? 0n;
    if (fee < MIN_TRANSFER_FEE || bond <= fee) {
      throw new Error("beacon retirement fee or remaining bond is invalid");
    }
    beaconBonds.set(transaction.sender, bond - fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + fee);
    nonces.set(transaction.sender, expectedNonce + 1);
    pendingBeaconRetirements.set(transaction.sender, {
      address: transaction.sender,
      requestedHeight: height,
      unlockHeight: height + BEACON_RETIREMENT_DELAY_BLOCKS,
    });
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
      const locked = this.#treasuryLockedFloor(timestamp);
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
      const locked = this.#treasuryLockedFloor(timestamp);
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
      const epoch = transferCreditEpoch(height);
      const spent = previous?.epoch === epoch ? previous.spent : 0;
      if (transaction.limit < spent) {
        throw new Error("credit delegation limit is below already spent credits");
      }
      creditDelegations.set(key, {
        delegate: transaction.delegate,
        epoch,
        limit: transaction.limit,
        owner: transaction.sender,
        spent,
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

  #assetFeeDecision(transaction, balances, nonces, timestamp, domain) {
    if (transaction.algorithm !== SIGNATURE_ALGORITHM || transaction.networkId !== this.#networkId ||
        typeof transaction.publicKey !== "string" || transaction.publicKey.length > 4_000 ||
        typeof transaction.signature !== "string" || transaction.signature.length > 7_000 ||
        addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
        !verifyObject(unsignedTransaction(transaction), transaction.signature, transaction.publicKey, domain)) {
      throw new Error("native asset transaction signature is invalid");
    }
    const expectedNonce = nonces.get(transaction.sender) ?? 0;
    if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce !== expectedNonce) {
      throw new Error("unexpected nonce");
    }
    const fee = parseAtomic(transaction.fee, "native asset fee");
    const balance = balances.get(transaction.sender) ?? 0n;
    if (fee < MIN_TRANSFER_FEE || balance < fee) throw new Error("native asset fee is invalid");
    if (transaction.sender === this.#treasuryAddress) {
      const locked = this.#treasuryLockedFloor(timestamp);
      if (balance - fee < locked) throw new Error("treasury funds are still vesting");
    }
    return { balance, expectedNonce, fee };
  }

  #chargeAssetFee(transaction, decision, balances, nonces, proposer) {
    balances.set(transaction.sender, decision.balance - decision.fee);
    balances.set(proposer, (balances.get(proposer) ?? 0n) + decision.fee);
    nonces.set(transaction.sender, decision.expectedNonce + 1);
  }

  #applyNativeAssetTransaction(
    transaction, balances, nonces, assets, assetBalances, proposer, timestamp,
  ) {
    if (transaction.assetId === SYSTEM_NIR_ASSET_ID ||
        !/^[0-9a-f]{64}$/.test(transaction.assetId ?? "")) {
      throw new Error("native asset id is invalid or reserved");
    }
    const domains = {
      "asset-burn": "NATIVE_ASSET_BURN",
      "asset-create": "NATIVE_ASSET_CREATE",
      "asset-mint": "NATIVE_ASSET_MINT",
      "asset-revoke-authority": "NATIVE_ASSET_REVOKE_AUTHORITY",
      "asset-transfer": "NATIVE_ASSET_TRANSFER",
    };
    const decision = this.#assetFeeDecision(
      transaction, balances, nonces, timestamp, domains[transaction.type],
    );
    if (transaction.type === "asset-create") {
      if (assets.size >= MAX_NATIVE_ASSETS || assets.has(transaction.assetId) ||
          transaction.assetId !== nativeAssetId({
            creator: transaction.sender, networkId: transaction.networkId, nonce: transaction.nonce,
          }) || !/^[0-9a-f]{64}$/.test(transaction.metadataHash ?? "") ||
          typeof transaction.fixedSupply !== "boolean") {
        throw new Error("native asset definition is invalid or duplicated");
      }
      const initialSupply = parseAtomic(transaction.initialSupply, "native asset initial supply");
      const maxSupply = parseAtomic(transaction.maxSupply, "native asset maximum supply");
      if (maxSupply === 0n || initialSupply > maxSupply ||
          (transaction.fixedSupply && initialSupply !== maxSupply)) {
        throw new Error("native asset supply definition is invalid");
      }
      if (initialSupply > 0n && assetBalances.size >= MAX_NATIVE_ASSET_BALANCES) {
        throw new Error("native asset balance capacity is exhausted");
      }
      assets.set(transaction.assetId, {
        assetId: transaction.assetId,
        authority: transaction.fixedSupply ? null : transaction.sender,
        creationNonce: transaction.nonce,
        creator: transaction.sender,
        fixedSupply: transaction.fixedSupply,
        maxSupply,
        metadataHash: transaction.metadataHash,
        minted: initialSupply,
        supply: initialSupply,
      });
      if (initialSupply > 0n) {
        assetBalances.set(assetBalanceKey(transaction.assetId, transaction.sender), initialSupply);
      }
    } else {
      const asset = assets.get(transaction.assetId);
      if (!asset) throw new Error("native asset is unknown");
      if (transaction.type === "asset-mint") {
        const amount = parseAtomic(transaction.amount, "native asset mint amount");
        if (amount === 0n || asset.authority !== transaction.sender ||
            asset.minted + amount > asset.maxSupply) {
          throw new Error("native asset mint is unauthorized or exceeds its cap");
        }
        const key = assetBalanceKey(transaction.assetId, transaction.sender);
        if (!assetBalances.has(key) && assetBalances.size >= MAX_NATIVE_ASSET_BALANCES) {
          throw new Error("native asset balance capacity is exhausted");
        }
        assets.set(transaction.assetId, {
          ...asset, minted: asset.minted + amount, supply: asset.supply + amount,
        });
        assetBalances.set(key, (assetBalances.get(key) ?? 0n) + amount);
      } else if (transaction.type === "asset-transfer") {
        assertAddress(transaction.recipient, "native asset recipient");
        const amount = parseAtomic(transaction.amount, "native asset transfer amount");
        const senderKey = assetBalanceKey(transaction.assetId, transaction.sender);
        const recipientKey = assetBalanceKey(transaction.assetId, transaction.recipient);
        const senderBalance = assetBalances.get(senderKey) ?? 0n;
        if (amount === 0n || transaction.recipient === transaction.sender || senderBalance < amount) {
          throw new Error("native asset transfer is invalid or unfunded");
        }
        if (!assetBalances.has(recipientKey) && assetBalances.size >= MAX_NATIVE_ASSET_BALANCES &&
            senderBalance !== amount) {
          throw new Error("native asset balance capacity is exhausted");
        }
        if (senderBalance === amount) assetBalances.delete(senderKey);
        else assetBalances.set(senderKey, senderBalance - amount);
        assetBalances.set(recipientKey, (assetBalances.get(recipientKey) ?? 0n) + amount);
      } else if (transaction.type === "asset-burn") {
        const amount = parseAtomic(transaction.amount, "native asset burn amount");
        const key = assetBalanceKey(transaction.assetId, transaction.sender);
        const holderBalance = assetBalances.get(key) ?? 0n;
        if (amount === 0n || holderBalance < amount) {
          throw new Error("native asset burn is invalid or unfunded");
        }
        if (holderBalance === amount) assetBalances.delete(key);
        else assetBalances.set(key, holderBalance - amount);
        assets.set(transaction.assetId, { ...asset, supply: asset.supply - amount });
      } else if (transaction.type === "asset-revoke-authority") {
        if (asset.fixedSupply || asset.authority !== transaction.sender) {
          throw new Error("native asset authority revocation is unauthorized or already final");
        }
        assets.set(transaction.assetId, { ...asset, authority: null });
      }
    }
    this.#chargeAssetFee(transaction, decision, balances, nonces, proposer);
  }

  appendBlock(block) {
    return this.#applyBlock(block, true);
  }

  fork() {
    const fork = new NirChain(this.#genesisConfig);
    fork.#accountHistories = new Map([...this.#accountHistories]
      .map(([address, history]) => [address, { ...history }]));
    fork.#assetBalances = new Map(this.#assetBalances);
    fork.#assets = new Map([...this.#assets]
      .map(([assetId, asset]) => [assetId, { ...asset }]));
    fork.#balances = new Map(this.#balances);
    fork.#beaconBondingActive = this.#beaconBondingActive;
    fork.#beaconBonds = new Map(this.#beaconBonds);
    fork.#beaconAuthorities = new Map(this.#beaconAuthorities);
    fork.#beaconFaults = new Map(this.#beaconFaults);
    fork.#beaconGeneration = this.#beaconGeneration;
    fork.#beaconQuorum = this.#beaconQuorum;
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
    fork.#disabledEvaluators = new Set(this.#disabledEvaluators);
    fork.#disabledValidators = new Set(this.#disabledValidators);
    fork.#capabilityMemory = this.#capabilityMemory.clone();
    fork.#epochRandomness = EpochRandomnessMachine.fromSnapshot({
      networkId: this.#networkId,
      registry: this.#beaconAuthorities,
      committeeSize: this.#beaconQuorum,
      snapshot: this.#epochRandomness.snapshot(),
    });
    fork.#evaluatorBonds = new Map(this.#evaluatorBonds);
    fork.#evaluatorFaults = new Map(this.#evaluatorFaults);
    fork.#evaluators = new Map(this.#evaluators);
    fork.#lastRewardTimestamp = this.#lastRewardTimestamp;
    fork.#mined = this.#mined;
    fork.#nonces = new Map(this.#nonces);
    fork.#pendingEvaluatorRegistrations = new Map(
      [...this.#pendingEvaluatorRegistrations]
        .map(([address, pending]) => [address, { ...pending }]),
    );
    fork.#pendingBeaconRotation = structuredClone(this.#pendingBeaconRotation);
    fork.#pendingBeaconRetirements = new Map([...this.#pendingBeaconRetirements]
      .map(([address, pending]) => [address, { ...pending }]));
    fork.#pendingBeaconAdmissions = new Map([...this.#pendingBeaconAdmissions]
      .map(([address, admission]) => [address, { ...admission }]));
    fork.#pendingProtocolUpgrade = structuredClone(this.#pendingProtocolUpgrade);
    fork.#pendingValidatorRotation = structuredClone(this.#pendingValidatorRotation);
    fork.#peerRegistry = structuredClone(this.#peerRegistry);
    fork.#progressCommitments = new Map(this.#progressCommitments);
    fork.#progressEscrows = new Map([...this.#progressEscrows]
      .map(([candidateId, escrow]) => [candidateId, structuredClone(escrow)]));
    fork.#progressFraudEvidence = new Map(this.#progressFraudEvidence);
    fork.#protocolVersion = this.#protocolVersion;
    fork.#randomnessFaults = new Map(this.#randomnessFaults);
    fork.#registeredValidators = new Map(this.#registeredValidators);
    fork.#registeredBeaconAuthorities = new Map(this.#registeredBeaconAuthorities);
    fork.#retiredBeaconAuthorities = new Map([...this.#retiredBeaconAuthorities]
      .map(([address, retired]) => [address, { ...retired }]));
    fork.#rewardEpoch = this.#rewardEpoch;
    fork.#rewardedProofs = new Set(this.#rewardedProofs);
    fork.#safetyEvidence = new Set(this.#safetyEvidence);
    fork.#validatorBonds = new Map(this.#validatorBonds);
    fork.#validatorAdmissionOmissionEvidence = new Set(
      this.#validatorAdmissionOmissionEvidence,
    );
    fork.#validatorEquivocationEvidence = new Set(this.#validatorEquivocationEvidence);
    fork.#validatorRecoveryGeneration = this.#validatorRecoveryGeneration;
    fork.#validatorRecoveryPlan = structuredClone(this.#validatorRecoveryPlan);
    fork.#validatorFaults = new Map(this.#validatorFaults);
    fork.#validators = new Map(this.#validators);
    fork.#validatorOrder = [...this.#validatorOrder];
    fork.#quorum = this.#quorum;
    fork.#supportedProtocolVersions = [...this.#supportedProtocolVersions];
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

  finalityHeaderForProposal(block) {
    this.validateProposal(block);
    return blockHeader(block);
  }

  finalityHeaderHash(header) { return blockHeaderHash(header); }

  #applyBlock(block, verifyCertificate, verifyStateRoot = true) {
    const previous = this.#blocks.at(-1);
    requireExactBlockSchema(block);
    if (block.networkId !== this.#networkId) throw new Error("wrong network id");
    if (block.height !== previous.height + 1) throw new Error("unexpected block height");
    const protocolState = protocolTransition({
      blockVersion: block.protocolVersion,
      currentHeight: block.height,
      currentVersion: this.#protocolVersion,
      pendingUpgrade: this.#pendingProtocolUpgrade,
      proposedUpgrade: block.protocolUpgrade === undefined ? null : block.protocolUpgrade,
      supportedVersions: this.#supportedProtocolVersions,
    });
    consensusEncodingVersionForProtocol(protocolState.protocolVersion);
    if (block.transactions?.length === 1 &&
        block.transactions[0]?.type === "validator-recovery" &&
        protocolState.protocolVersion !== this.#protocolVersion) {
      throw new Error("validator recovery cannot share a protocol activation boundary");
    }
    if (block.previousHash !== previous.hash) throw new Error("broken hash chain");
    if (!Number.isSafeInteger(block.timestamp) || block.timestamp < previous.timestamp) {
      throw new Error("invalid block timestamp");
    }
    if (block.timestamp > Date.now() + MAX_FUTURE_DRIFT_MS) {
      throw new Error("block timestamp is too far in the future");
    }
    if (!Array.isArray(block.transactions) || !Array.isArray(block.progressRewards) ||
        !Array.isArray(block.progressFraudProofs) ||
        !Array.isArray(block.safetySettlements) || !Array.isArray(block.randomnessCommits) ||
        !Array.isArray(block.randomnessReveals) || !Array.isArray(block.fallbackBeacons) ||
        !Array.isArray(block.progressBeacons) || !Array.isArray(block.epochRandomnessCommits) ||
        !Array.isArray(block.epochRandomnessReveals)) {
      throw new Error("block collections are invalid");
    }
    const recoveryTransition = block.transactions.length === 1 &&
      block.transactions[0]?.type === "validator-recovery" ? block.transactions[0] : null;
    if (block.transactions.some(({ type }) => type === "validator-recovery") && !recoveryTransition) {
      throw new Error("validator recovery must be the only block transaction");
    }
    if (recoveryTransition && (block.progressRewards.length > 0 ||
        block.progressFraudProofs.length > 0 || block.safetySettlements.length > 0 ||
        block.randomnessCommits.length > 0 || block.randomnessReveals.length > 0 ||
        block.fallbackBeacons.length > 0 || block.progressBeacons.length > 0 ||
        block.epochRandomnessCommits.length > 0 || block.epochRandomnessReveals.length > 0 ||
        block.beaconRotation !== null || block.validatorRotation !== null ||
        block.peerRegistryUpdate !== null || block.protocolUpgrade !== null || block.round !== 0 ||
        block.roundCertificate !== null)) {
      throw new Error("validator recovery block contains ordinary consensus work");
    }
    const recoveryContext = recoveryTransition ? verifyValidatorRecoveryEnvelope(
      recoveryTransition, { currentHeight: block.height, networkId: this.#networkId,
        plan: this.#validatorRecoveryPlan, previousBlock: previous },
    ) : null;
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
    if ((block.validatorRotation !== null ||
        this.#pendingValidatorRotation?.activationHeight === block.height) &&
        block.transactions.some(({ type }) =>
          type === "validator-equivocation" || type === "validator-admission-omission")) {
      throw new Error("validator equivocation and rotation require separate blocks");
    }
    const hasBeaconBond = block.transactions.some(({ type }) => type === "beacon-bond");
    const hasBeaconRetirement = block.transactions.some(({ type }) => type === "beacon-retire");
    if ((block.beaconRotation !== null && (hasBeaconBond || hasBeaconRetirement)) ||
        (hasBeaconBond && hasBeaconRetirement)) {
      throw new Error("beacon registration, retirement, and rotation require separate blocks");
    }
    if (block.transactionCount !== block.transactions.length ||
        block.transactionsRoot !== transactionRoot(block.transactions)) {
      throw new Error("block transaction commitment is invalid");
    }
    const activatingBeaconRotation = this.#pendingBeaconRotation?.activationHeight === block.height
      ? this.#pendingBeaconRotation : null;
    if (this.#pendingBeaconRotation?.activationHeight < block.height) {
      throw new Error("beacon rotation activation was skipped");
    }
    if (activatingBeaconRotation && (block.epochRandomnessCommits.length > 0 ||
        block.epochRandomnessReveals.length > 0 || block.fallbackBeacons.length > 0 ||
        block.progressBeacons.length > 0)) {
      throw new Error("beacon contributions are forbidden at the rotation boundary");
    }
    let scheduledBeaconRotation = null;
    if (block.beaconRotation !== null) {
      if (this.#pendingBeaconRotation || !this.#beaconBondingActive) {
        throw new Error("beacon rotation is already pending or bonding is inactive");
      }
      this.#assertBeaconRotationAdmissions(block.beaconRotation, this.height);
      scheduledBeaconRotation = verifyBeaconRotation(block.beaconRotation, {
        bonds: this.#beaconBonds,
        currentAuthorities: [...this.#beaconAuthorities.values()],
        currentGeneration: this.#beaconGeneration,
        currentHeight: this.height,
        networkId: this.#networkId,
      });
      if (canonicalJson(scheduledBeaconRotation) !== canonicalJson(block.beaconRotation)) {
        throw new Error("beacon rotation is not canonical");
      }
    }
    if (block.beaconRotation !== null &&
        (block.validatorRotation !== null || block.peerRegistryUpdate !== null)) {
      throw new Error("beacon, validator, and peer rotations require separate blocks");
    }
    if (block.transactions.filter(({ resource }) => resource === "transfer-credit").length >
        MAX_CREDIT_TRANSFERS_PER_BLOCK) {
      throw new Error("too many credit-paid transfers in one block");
    }
    if (block.progressRewards.length > MAX_PROGRESS_REWARDS_PER_BLOCK) {
      throw new Error("too many progress rewards in one block");
    }
    if (block.progressFraudProofs.length > MAX_PROGRESS_FRAUD_PROOFS_PER_BLOCK) {
      throw new Error("too many progress fraud proofs in one block");
    }
    if (block.safetySettlements.length > MAX_SAFETY_SETTLEMENTS_PER_BLOCK) {
      throw new Error("too many safety settlements in one block");
    }
    if (Buffer.byteLength(canonicalJson(unsignedBlock(block))) > MAX_BLOCK_BYTES) {
      throw new Error("block exceeds the byte-size limit");
    }
    const expectedBlockProposer = recoveryTransition
      ? this.#expectedRecoveryProposer(block.height)
      : this.expectedProposer(block.height, block.round);
    if (block.proposer !== expectedBlockProposer) {
      throw new Error("unexpected block proposer");
    }
    if (block.feeRecipient !== (recoveryTransition
      ? expectedBlockProposer : this.expectedProposer(block.height, 0))) {
      throw new Error("unexpected block fee recipient");
    }
    const transitionValidators = this.#pendingValidatorRotation &&
      block.height === this.#pendingValidatorRotation.activationHeight
      ? this.#validators
      : null;
    if (verifyCertificate) {
      if (recoveryTransition) {
        verifyValidatorRecoveryVotes({ commits: block.certificate,
          prepares: block.prepareCertificate }, {
          blockHash: block.hash,
          checkpointHash: recoveryContext.checkpointHash,
          evidenceHash: recoveryContext.evidenceHash,
          generation: recoveryTransition.generation,
          height: block.height,
          networkId: block.networkId,
          planHash: recoveryTransition.planHash,
          reserveSetId: this.#validatorRecoveryPlan.reserveSetId,
        }, this.#validatorRecoveryPlan);
      } else {
        this.#verifyCertificate(block, blockValidators, transitionValidators);
      }
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
    if (recoveryTransition && this.#peerRegistry) {
      nextPeerRegistry = createValidatorRecoveryPeerRegistry({
        activationHeight: block.height,
        generation: this.#validatorRecoveryPlan.generation,
        networkId: this.#networkId,
        peers: this.#validatorRecoveryPlan.peers,
        planHash: this.#validatorRecoveryPlan.planHash,
        previousRegistry: this.#peerRegistry,
      });
    }
    const expectedPeerRegistryHash = nextPeerRegistry
      ? peerRegistryHash(nextPeerRegistry) : "0".repeat(64);
    if (block.peerRegistryHash !== expectedPeerRegistryHash) {
      throw new Error("block peer registry commitment is invalid");
    }

    const capabilityMemory = this.#capabilityMemory.clone();
    const progressNoveltyReports = new Map();
    const capabilityReservations = orderedProgressEscrows(this.#progressEscrows)
      .map(([, escrow]) => progressReservation(escrow.evaluation, escrow.marginalCapabilities));
    let epochRandomness = EpochRandomnessMachine.fromSnapshot({
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
      const novelty = this.#verifyProgressClaim(
        claim,
        block.height,
        capabilityMemory,
        this.#progressCommitments,
      );
      assertProgressReservationAvailable(
        claim.evaluation, Object.keys(novelty.marginalGainsBps), capabilityReservations,
      );
      progressNoveltyReports.set(claim.evaluation.candidateId, novelty);
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
    assertProgressRewardCollateral(block.progressRewards, this.#candidateBonds);

    const accountHistories = new Map([...this.#accountHistories]
      .map(([address, history]) => [address, { ...history }]));
    const assetBalances = new Map(this.#assetBalances);
    const assets = new Map([...this.#assets]
      .map(([assetId, asset]) => [assetId, { ...asset }]));
    const balances = new Map(this.#balances);
    let beaconBondingActive = this.#beaconBondingActive;
    const beaconBonds = new Map(this.#beaconBonds);
    const beaconFaults = new Map(this.#beaconFaults);
    const registeredBeaconAuthorities = new Map(this.#registeredBeaconAuthorities);
    const pendingBeaconRetirements = new Map([...this.#pendingBeaconRetirements]
      .map(([address, pending]) => [address, { ...pending }]));
    const pendingBeaconAdmissions = new Map([...this.#pendingBeaconAdmissions]
      .map(([address, admission]) => [address, { ...admission }]));
    const retiredBeaconAuthorities = new Map([...this.#retiredBeaconAuthorities]
      .map(([address, retired]) => [address, { ...retired }]));
    const creditDelegations = new Map([...this.#creditDelegations]
      .map(([key, delegation]) => [key, { ...delegation }]));
    const creditStakes = new Map(this.#creditStakes);
    const creditUnstakes = new Map([...this.#creditUnstakes]
      .map(([address, pending]) => [address, { ...pending }]));
    const creditUsage = new Map([...this.#creditUsage]
      .map(([address, usage]) => [address, { ...usage }]));
    const disabledEvaluators = new Set(this.#disabledEvaluators);
    const disabledValidators = new Set(this.#disabledValidators);
    const evaluatorBonds = new Map(this.#evaluatorBonds);
    const evaluatorFaults = new Map(this.#evaluatorFaults);
    const evaluatorsAfter = new Map(this.#evaluators);
    const nonces = new Map(this.#nonces);
    const pendingEvaluatorRegistrations = new Map(
      [...this.#pendingEvaluatorRegistrations]
        .map(([address, pending]) => [address, { ...pending }]),
    );
    for (const [address, pending] of pendingEvaluatorRegistrations) {
      if (pending.activationHeight === block.height) {
        evaluatorsAfter.set(address, {
          address: pending.address,
          algorithm: pending.algorithm,
          operatorId: pending.operatorId,
          publicKey: pending.publicKey,
        });
        pendingEvaluatorRegistrations.delete(address);
      } else if (pending.activationHeight < block.height) {
        throw new Error("evaluator registration activation was skipped");
      }
    }
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
    const validatorAdmissionOmissionEvidence = new Set(
      this.#validatorAdmissionOmissionEvidence,
    );
    const validatorEquivocationEvidence = new Set(this.#validatorEquivocationEvidence);
    let validatorRecoveryGeneration = this.#validatorRecoveryGeneration;
    let validatorRecoveryPlan = structuredClone(this.#validatorRecoveryPlan);
    let validatorRecoveryOccurred = false;
    const registeredValidators = new Map(this.#registeredValidators);
    const progressCommitments = new Map(this.#progressCommitments);
    const progressEscrows = new Map([...this.#progressEscrows]
      .map(([candidateId, escrow]) => [candidateId, structuredClone(escrow)]));
    const progressFraudEvidence = new Map(this.#progressFraudEvidence);
    for (const [evidenceHash, acceptedHeight] of progressFraudEvidence) {
      if (block.height > acceptedHeight + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS) {
        progressFraudEvidence.delete(evidenceHash);
      }
    }
    let scheduledRotation = null;
    if (block.validatorRotation !== null) {
      if (this.#pendingValidatorRotation) throw new Error("a validator rotation is already pending");
      if (!block.validatorRotation || !Array.isArray(block.validatorRotation.validators)) {
        throw new Error("validator rotation is invalid");
      }
      const proposed = block.validatorRotation.validators.map(({ address }) => {
        const member = registeredValidators.get(address);
        if (!member) throw new Error("proposed validator is not registered");
        if (this.#disabledValidators.has(address)) {
          throw new Error("disabled validator cannot be proposed for rotation");
        }
        return member;
      });
      scheduledRotation = scheduleValidatorRotation({
        current: [...this.#validators.values()], proposed, bonds: validatorBonds,
        disabled: this.#disabledValidators,
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
    const fraudCandidates = new Set();
    const newlyDisabledEvaluators = new Set();
    for (const evidence of block.progressFraudProofs) {
      if (fraudCandidates.has(evidence?.candidateId)) {
        throw new Error("duplicate progress fraud proof for candidate in block");
      }
      fraudCandidates.add(evidence?.candidateId);
      const { candidateId, evaluators } = this.#verifyProgressFraudProof(
        evidence, block.height, progressEscrows, progressFraudEvidence,
      );
      const escrow = progressEscrows.get(candidateId);
      const bond = candidateBonds.get(candidateId);
      if (!escrow || !bond || bond.purpose !== "progress" || !bond.admissionBound ||
          bond.bond !== escrow.bondAmount || bond.submitter !== escrow.refundAddress) {
        throw new Error("progress fraud escrow collateral is inconsistent");
      }
      newlyBurned += escrow.amount + escrow.bondAmount;
      progressEscrows.delete(candidateId);
      candidateBonds.delete(candidateId);
      for (const evaluator of evaluators) {
        if (disabledEvaluators.has(evaluator)) continue;
        const evaluatorBond = evaluatorBonds.get(evaluator) ?? 0n;
        if (evaluatorBond < MIN_EVALUATOR_BOND) {
          throw new Error("equivocating evaluator has no slashable minimum bond");
        }
        newlyBurned += evaluatorBond;
        evaluatorBonds.delete(evaluator);
        evaluatorFaults.set(evaluator, 1);
        disabledEvaluators.add(evaluator);
        newlyDisabledEvaluators.add(evaluator);
      }
    }
    if (newlyDisabledEvaluators.size > 0) {
      for (const [candidateId, commitment] of progressCommitments) {
        if (!commitment.committee?.some((address) => newlyDisabledEvaluators.has(address))) {
          continue;
        }
        const bond = candidateBonds.get(candidateId);
        if (!bond || bond.purpose !== "progress" || !bond.admissionBound) {
          throw new Error("disabled evaluator commitment has no locked candidate bond");
        }
        balances.set(bond.submitter, (balances.get(bond.submitter) ?? 0n) + bond.bond);
        candidateBonds.delete(candidateId);
        progressCommitments.delete(candidateId);
      }
    }
    // An objective proof included at unlockHeight wins over maturity in the same transition.
    for (const [candidateId, escrow] of orderedProgressEscrows(progressEscrows)) {
      if (block.height >= escrow.unlockHeight) {
        const bond = candidateBonds.get(candidateId);
        if (!bond || bond.purpose !== "progress" || !bond.admissionBound ||
            bond.bond !== escrow.bondAmount || bond.submitter !== escrow.refundAddress) {
          throw new Error("maturing progress escrow collateral is inconsistent");
        }
        capabilityMemory.accept(escrow.evaluation);
        balances.set(escrow.recipient, (balances.get(escrow.recipient) ?? 0n) + escrow.amount);
        balances.set(escrow.refundAddress,
          (balances.get(escrow.refundAddress) ?? 0n) + escrow.bondAmount);
        progressEscrows.delete(candidateId);
        candidateBonds.delete(candidateId);
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
      const bond = candidateBonds.get(reward.evaluation.candidateId);
      const commitment = progressCommitments.get(reward.evaluation.candidateId);
      if (!bond || bond.purpose !== "progress" || !bond.admissionBound) {
        throw new Error("progress reward has no locked candidate bond");
      }
      if (!commitment || !Array.isArray(commitment.committee) ||
          commitment.committee.length !== this.#evaluationQuorum ||
          commitment.committee.some((address) => disabledEvaluators.has(address) ||
            (evaluatorBonds.get(address) ?? 0n) < MIN_EVALUATOR_BOND)) {
        throw new Error("progress reward has no assigned evaluation committee");
      }
      if (amount > bond.bond) {
        throw new Error("progress reward exceeds its locked candidate bond collateral");
      }
      if (progressEscrows.size >= MAX_PROGRESS_REWARD_ESCROWS ||
          progressEscrows.has(reward.evaluation.candidateId)) {
        throw new Error("progress reward escrow capacity is exceeded");
      }
      const receipt = progressReceiptPayload({ networkId: reward.networkId, epoch: reward.epoch,
        recipient: reward.recipient, evaluation: reward.evaluation });
      progressEscrows.set(reward.evaluation.candidateId, {
        acceptedReceiptHash: hashObject(receipt, "PROGRESS_ESCROW_RECEIPT_V1"),
        amount,
        bondAmount: bond.bond,
        candidateId: reward.evaluation.candidateId,
        committee: [...commitment.committee].sort(),
        createdHeight: block.height,
        epoch: reward.epoch,
        evaluation: structuredClone(reward.evaluation),
        fingerprint: reward.fingerprint,
        marginalCapabilities: Object.keys(
          progressNoveltyReports.get(reward.evaluation.candidateId)?.marginalGainsBps ?? {},
        ).sort(),
        recipient: reward.recipient,
        refundAddress: bond.submitter,
        unlockHeight: block.height + PROGRESS_REWARD_ESCROW_DELAY_BLOCKS,
      });
      progressCommitments.delete(reward.evaluation.candidateId);
    }
    if (TREASURY_ALLOCATION + this.#mined + newlyMined > MAX_SUPPLY) {
      throw new Error("hard supply cap exceeded");
    }
    if (verifyStateRoot && block.capabilityMemoryRoot !== capabilityMemory.stateRoot) {
      throw new Error("invalid world capability memory root");
    }
    const transactionIds = new Set();
    for (const transaction of block.transactions) {
      requireExactTransactionSchema(transaction);
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
          capabilityMemory,
          candidateBonds,
          progressEscrows,
          registeredValidators,
          evaluatorBonds,
          disabledEvaluators,
          evaluatorsAfter,
          pendingEvaluatorRegistrations,
          registeredBeaconAuthorities,
          pendingBeaconAdmissions,
          block.height,
          epochRandomness.round,
        );
      } else if (transaction.type === "validator-bond") {
        this.#applyValidatorBond(
          transaction, balances, nonces, validatorBonds, registeredValidators,
          disabledValidators, progressCommitments, evaluatorsAfter,
          pendingEvaluatorRegistrations, registeredBeaconAuthorities,
          pendingBeaconAdmissions, retiredBeaconAuthorities, block.feeRecipient,
        );
      } else if (transaction.type === "evaluator-bond") {
        this.#applyEvaluatorBond(
          transaction, balances, nonces, evaluatorBonds,
          disabledEvaluators, evaluatorsAfter, pendingEvaluatorRegistrations,
          registeredValidators, registeredBeaconAuthorities, pendingBeaconAdmissions,
          retiredBeaconAuthorities,
          blockValidators,
          block.feeRecipient, block.height,
        );
      } else if (transaction.type === "validator-equivocation") {
        newlyBurned += this.#applyValidatorEquivocation(
          transaction, balances, nonces, validatorBonds, validatorFaults,
          disabledValidators, validatorEquivocationEvidence, block.feeRecipient, previous,
        );
      } else if (transaction.type === "validator-admission-omission") {
        newlyBurned += this.#applyValidatorAdmissionOmission(
          transaction, balances, nonces, validatorBonds, validatorFaults,
          disabledValidators, validatorAdmissionOmissionEvidence,
          block.feeRecipient, previous, block.height,
        );
      } else if (transaction.type === "validator-recovery-plan") {
        if (validatorRecoveryPlan || this.#pendingValidatorRotation || block.validatorRotation) {
          throw new Error("validator recovery plan conflicts with pending membership state");
        }
        validatorRecoveryPlan = this.#applyValidatorRecoveryPlan(
          transaction, balances, nonces, validatorBonds, registeredValidators,
          block.feeRecipient, block.height,
        );
      } else if (transaction.type === "validator-recovery") {
        newlyBurned += this.#applyValidatorAdmissionOmission(
          transaction.evidenceTransaction, balances, nonces, validatorBonds,
          validatorFaults, disabledValidators, validatorAdmissionOmissionEvidence,
          block.feeRecipient, previous, block.height,
        );
        const remaining = [...this.#validators.keys()]
          .filter((address) => !disabledValidators.has(address)).length;
        if (remaining >= this.#quorum) {
          throw new Error("validator recovery trigger does not destroy the active quorum");
        }
        validatorRecoveryOccurred = true;
      } else if (transaction.type === "beacon-bond") {
        this.#applyBeaconBond(
          transaction, balances, nonces, beaconBonds, block.feeRecipient, epochRandomness,
          registeredBeaconAuthorities, pendingBeaconAdmissions,
          retiredBeaconAuthorities, registeredValidators, evaluatorsAfter, block.height,
        );
      } else if (transaction.type === "beacon-retire") {
        this.#applyBeaconRetirement(
          transaction, nonces, beaconBonds, balances, block.feeRecipient,
          registeredBeaconAuthorities, pendingBeaconRetirements, block.height,
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
      } else if (transaction.type.startsWith("asset-")) {
        if (protocolState.protocolVersion < 25) {
          throw new Error("native assets require protocol version 25");
        }
        this.#applyNativeAssetTransaction(
          transaction, balances, nonces, assets, assetBalances,
          block.feeRecipient, block.timestamp,
        );
      } else {
        throw new Error("unknown transaction type");
      }
      const participants = new Set([transaction.sender, transaction.recipient]
        .filter((address) => typeof address === "string" && /^nir1[0-9a-f]{64}$/.test(address)));
      for (const address of participants) {
        accountHistories.set(address, appendAccountHistory(
          accountHistories.get(address) ?? emptyAccountHistoryAccumulator(), id,
        ));
      }
    }
    if (!beaconBondingActive && [...this.#beaconAuthorities.keys()].every(
      (address) => (beaconBonds.get(address) ?? 0n) >= MIN_BEACON_BOND,
    )) beaconBondingActive = true;

    let beaconAuthoritiesAfter = this.#beaconAuthorities;
    let beaconGenerationAfter = this.#beaconGeneration;
    let pendingBeaconRotationAfter = this.#pendingBeaconRotation;
    let beaconRotationActivated = false;
    if (activatingBeaconRotation?.authorities.some(({ address }) =>
      (beaconBonds.get(address) ?? 0n) < MIN_BEACON_BOND)) {
      pendingBeaconRotationAfter = null;
    } else if (activatingBeaconRotation) {
      for (const member of activatingBeaconRotation.authorities) {
        const admission = pendingBeaconAdmissions.get(member.address);
        if (!admission) continue;
        registeredBeaconAuthorities.set(member.address, structuredClone(member));
        pendingBeaconAdmissions.delete(member.address);
      }
      beaconAuthoritiesAfter = new Map(activatingBeaconRotation.authorities
        .map((member) => [member.address, member]));
      beaconGenerationAfter = activatingBeaconRotation.generation;
      epochRandomness = epochRandomness.rotate({
        committeeSize: Math.floor((beaconAuthoritiesAfter.size * 2) / 3) + 1,
        generation: beaconGenerationAfter,
        nextSetId: activatingBeaconRotation.nextSetId,
        previousSetId: activatingBeaconRotation.previousSetId,
        registry: beaconAuthoritiesAfter,
      });
      pendingBeaconRotationAfter = null;
      beaconRotationActivated = true;
    }
    if (scheduledBeaconRotation) pendingBeaconRotationAfter = scheduledBeaconRotation;
    for (const [address] of registeredBeaconAuthorities) {
      if (!beaconAuthoritiesAfter.has(address) &&
          !pendingBeaconRotationAfter?.authorities.some((member) => member.address === address) &&
          !pendingBeaconRetirements.has(address)) {
        pendingBeaconRetirements.set(address, {
          address, requestedHeight: block.height,
          unlockHeight: block.height + BEACON_RETIREMENT_DELAY_BLOCKS,
        });
      }
    }
    if (beaconRotationActivated) {
      for (const [candidateId, commitment] of progressCommitments) {
        const bond = candidateBonds.get(candidateId);
        if (!bond || bond.purpose !== "progress" || !bond.admissionBound ||
            bond.candidateOwner !== commitment.sender) {
          throw new Error("rotated beacon commitment has no locked candidate bond");
        }
        balances.set(bond.submitter, (balances.get(bond.submitter) ?? 0n) + bond.bond);
        candidateBonds.delete(candidateId);
        progressCommitments.delete(candidateId);
      }
    }

    for (const [address, admission] of pendingBeaconAdmissions) {
      if (block.height < admission.expiryHeight ||
          pendingBeaconRotationAfter?.authorities.some((member) => member.address === address)) {
        continue;
      }
      const bond = beaconBonds.get(address);
      if (bond !== MIN_BEACON_BOND || retiredBeaconAuthorities.has(address)) {
        throw new Error("expiring beacon admission state is inconsistent");
      }
      const penalty = (bond * BigInt(BEACON_ADMISSION_EXPIRY_PENALTY_BPS)) / 10_000n;
      newlyBurned += penalty;
      balances.set(address, (balances.get(address) ?? 0n) + bond - penalty);
      retiredBeaconAuthorities.set(address, retiredBeaconIdentity({
        address: admission.address, algorithm: admission.algorithm,
        operatorId: admission.operatorId, publicKey: admission.publicKey,
      }, block.height));
      beaconBonds.delete(address);
      pendingBeaconAdmissions.delete(address);
    }

    for (const [address, pending] of pendingBeaconRetirements) {
      if (block.height < pending.unlockHeight) continue;
      if (beaconAuthoritiesAfter.has(address) ||
          pendingBeaconRotationAfter?.authorities.some((member) => member.address === address)) {
        throw new Error("maturing beacon retirement is still referenced");
      }
      const member = registeredBeaconAuthorities.get(address);
      const bond = beaconBonds.get(address);
      if (!member || bond === undefined || bond <= 0n || retiredBeaconAuthorities.has(address)) {
        throw new Error("maturing beacon retirement state is inconsistent");
      }
      balances.set(address, (balances.get(address) ?? 0n) + bond);
      retiredBeaconAuthorities.set(address, retiredBeaconIdentity(
        member, block.height, beaconFaults.get(address) ?? 0,
      ));
      beaconBonds.delete(address);
      beaconFaults.delete(address);
      registeredBeaconAuthorities.delete(address);
      pendingBeaconRetirements.delete(address);
    }
    if (registeredBeaconAuthorities.size > MAX_REGISTERED_BEACON_AUTHORITIES) {
      throw new Error("registered beacon authority capacity is exceeded");
    }

    for (const [candidateId, commitment] of progressCommitments) {
      if (block.height > commitment.committedHeight + MAX_PROGRESS_COMMITMENT_AGE) {
        const bond = candidateBonds.get(candidateId);
        if (!bond || bond.purpose !== "progress" || !bond.admissionBound) {
          throw new Error("expired progress commitment has no locked candidate bond");
        }
        newlyBurned += bond.bond;
        candidateBonds.delete(candidateId);
        progressCommitments.delete(candidateId);
      }
    }

    for (const [candidateId, bond] of candidateBonds) {
      if (
        bond.purpose === "progress" && !bond.admissionBound &&
        block.height > bond.committedHeight + PROGRESS_BOND_BINDING_TIMEOUT_BLOCKS
      ) {
        balances.set(bond.submitter, (balances.get(bond.submitter) ?? 0n) + bond.bond);
        candidateBonds.delete(candidateId);
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
            registry: beaconAuthoritiesAfter,
            randomness,
            context: { candidateId, randomnessRound },
            size: Math.floor((beaconAuthoritiesAfter.size * 2) / 3) + 1,
          }).map(({ address }) => address),
          beaconCommitteeHeight: block.height,
          beaconCommitteeSource: randomness,
          beaconGeneration: beaconGenerationAfter,
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
          registry: this.#eligibleEvaluators(
            evaluatorBonds, disabledEvaluators, evaluatorsAfter,
          ),
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
      if (!candidate || candidate.purpose !== "safety" || candidate.committee !== null || block.height !== candidate.committedHeight + 1 ||
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
      if (!candidate || candidate.purpose !== "safety" || candidate.committee !== null || block.height !== candidate.committedHeight + 2 ||
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
      if (!candidate || candidate.purpose !== "safety" || fallbackBeacons.has(claim.candidateId) ||
          block.height !== candidate.committedHeight + 3) throw new Error("fallback beacon target is invalid");
      fallbackBeacons.set(claim.candidateId, this.#verifyFallbackBeacon(claim, claim.candidateId, block.height));
    }

    for (const [candidateId, candidate] of candidateBonds) {
      if (candidate.purpose !== "safety") continue;
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
            registry: this.#eligibleEvaluators(
              evaluatorBonds, disabledEvaluators, evaluatorsAfter,
            ),
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
                registry: this.#eligibleEvaluators(
                  evaluatorBonds, disabledEvaluators, evaluatorsAfter,
                ), randomness,
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
    if (validatorRecoveryOccurred) {
      for (const [candidateId, candidate] of candidateBonds) {
        if (candidate.purpose !== "safety" || candidate.committee !== null) continue;
        balances.set(candidate.submitter,
          (balances.get(candidate.submitter) ?? 0n) + candidate.bond);
        candidateBonds.delete(candidateId);
      }
      validatorsAfter = new Map(validatorRecoveryPlan.reserves
        .map((member) => [member.address, member]));
      validatorOrderAfter = [...validatorsAfter.keys()].sort();
      pendingValidatorRotationAfter = null;
      validatorRecoveryGeneration = validatorRecoveryPlan.generation;
      validatorRecoveryPlan = null;
    } else if (pendingValidatorRotationAfter &&
        block.height >= pendingValidatorRotationAfter.activationHeight) {
      validatorsAfter = new Map(blockValidatorMembers.map((member) => [member.address, member]));
      validatorOrderAfter = blockValidatorMembers.map(({ address }) => address);
      pendingValidatorRotationAfter = null;
    }
    if (scheduledRotation) {
      pendingValidatorRotationAfter = scheduledRotation;
      validatorRecoveryPlan = null;
    }
    if (pendingValidatorRotationAfter?.validators.some(({ address }) =>
      disabledValidators.has(address))) {
      pendingValidatorRotationAfter = null;
    }
    validatorOrderAfter = [...validatorsAfter.keys()].sort();
    const rewardEpochAfter = this.#rewardEpoch + (block.progressRewards.length > 0 ? 1 : 0);
    const lastRewardTimestampAfter = block.progressRewards.length > 0
      ? block.timestamp : this.#lastRewardTimestamp;
    const expectedStateRoot = this.#stateRoot({
      accountHistories,
      assetBalances,
      assets,
      balances,
      beaconBondingActive,
      beaconBonds,
      beaconAuthorities: beaconAuthoritiesAfter,
      beaconFaults,
      beaconGeneration: beaconGenerationAfter,
      burned: this.#burned + newlyBurned,
      candidateBonds,
      capabilityMemoryRoot: capabilityMemory.stateRoot,
      creditDelegations,
      creditStakes,
      creditUnstakes,
      creditUsage,
      disabledValidators,
      disabledEvaluators,
      epochRandomness: epochRandomness.snapshot(),
      evaluatorBonds,
      evaluatorFaults,
      evaluators: evaluatorsAfter,
      lastRewardTimestamp: lastRewardTimestampAfter,
      mined: this.#mined + newlyMined,
      nonces,
      pendingEvaluatorRegistrations,
      pendingBeaconRotation: pendingBeaconRotationAfter,
      pendingBeaconRetirements,
      pendingBeaconAdmissions,
      pendingProtocolUpgrade: protocolState.pendingUpgrade,
      pendingValidatorRotation: pendingValidatorRotationAfter,
      peerRegistry: nextPeerRegistry,
      progressCommitments,
      progressEscrows,
      progressFraudEvidence,
      protocolVersion: protocolState.protocolVersion,
      randomnessFaults,
      registeredBeaconAuthorities,
      retiredBeaconAuthorities,
      registeredValidators,
      rewardEpoch: rewardEpochAfter,
      rewardedProofs,
      safetyEvidence,
      validatorBonds,
      validatorAdmissionOmissionEvidence,
      validatorEquivocationEvidence,
      validatorRecoveryGeneration,
      validatorRecoveryPlan,
      validatorFaults,
      validators: validatorsAfter,
    });
    if (verifyStateRoot && block.stateRoot !== expectedStateRoot) {
      throw new Error("block state root is invalid");
    }
    if (verifyStateRoot) {
      const expectedAccountStateRoot = computeAccountStateRoot(accountStatesFromMaps({
        accountHistories,
        balances,
        creditDelegations,
        creditStakes,
        creditUnstakes,
        creditUsage,
        height: block.height,
        nonces,
        progressEscrows,
      }));
      if (block.accountStateRoot !== expectedAccountStateRoot) {
        throw new Error("block account state root is invalid");
      }
    }
    this.#accountHistories = accountHistories;
    this.#assetBalances = assetBalances;
    this.#assets = assets;
    this.#balances = balances;
    this.#beaconBondingActive = beaconBondingActive;
    this.#beaconBonds = beaconBonds;
    this.#beaconAuthorities = beaconAuthoritiesAfter;
    this.#beaconFaults = beaconFaults;
    this.#beaconGeneration = beaconGenerationAfter;
    this.#beaconQuorum = Math.floor((this.#beaconAuthorities.size * 2) / 3) + 1;
    this.#burned += newlyBurned;
    this.#candidateBonds = candidateBonds;
    this.#creditDelegations = creditDelegations;
    this.#creditStakes = creditStakes;
    this.#creditUnstakes = creditUnstakes;
    this.#creditUsage = creditUsage;
    this.#disabledEvaluators = disabledEvaluators;
    this.#disabledValidators = disabledValidators;
    this.#evaluatorBonds = evaluatorBonds;
    this.#evaluatorFaults = evaluatorFaults;
    this.#evaluators = evaluatorsAfter;
    this.#nonces = nonces;
    this.#pendingEvaluatorRegistrations = pendingEvaluatorRegistrations;
    this.#pendingBeaconRotation = pendingBeaconRotationAfter;
    this.#pendingBeaconRetirements = pendingBeaconRetirements;
    this.#pendingBeaconAdmissions = pendingBeaconAdmissions;
    this.#pendingProtocolUpgrade = protocolState.pendingUpgrade;
    this.#rewardedProofs = rewardedProofs;
    this.#randomnessFaults = randomnessFaults;
    this.#validatorFaults = validatorFaults;
    this.#validatorBonds = validatorBonds;
    this.#validatorAdmissionOmissionEvidence = validatorAdmissionOmissionEvidence;
    this.#validatorEquivocationEvidence = validatorEquivocationEvidence;
    this.#validatorRecoveryGeneration = validatorRecoveryGeneration;
    this.#validatorRecoveryPlan = validatorRecoveryPlan;
    this.#registeredValidators = registeredValidators;
    this.#registeredBeaconAuthorities = registeredBeaconAuthorities;
    this.#retiredBeaconAuthorities = retiredBeaconAuthorities;
    this.#peerRegistry = nextPeerRegistry;
    this.#progressCommitments = progressCommitments;
    this.#progressEscrows = progressEscrows;
    this.#progressFraudEvidence = progressFraudEvidence;
    this.#protocolVersion = protocolState.protocolVersion;
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
