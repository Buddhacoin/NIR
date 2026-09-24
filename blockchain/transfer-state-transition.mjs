import {
  MAX_DECIMAL_DIGITS,
  MAX_MULTISIG_MEMBERS,
  MIN_TRANSFER_FEE,
  MULTISIG_ALGORITHM,
  SIGNATURE_ALGORITHM,
  TRANSFER_CREDIT_EPOCH_BLOCKS,
  TRANSFER_CREDIT_STAKE_UNIT,
  TRANSFER_CREDITS_PER_STAKE_UNIT,
} from "./constants.mjs";
import { hashObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_SAFE_NONCE = Number.MAX_SAFE_INTEGER;
const MAX_ATOMIC_VALUE = 10n ** BigInt(MAX_DECIMAL_DIGITS) - 1n;

function address(value, field) {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new Error(`${field} is not a canonical NIR address`);
  }
  return value;
}

function atomic(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_ATOMIC_VALUE) throw new Error(`${field} is out of range`);
    return value;
  }
  if (typeof value !== "string" || value.length > MAX_DECIMAL_DIGITS ||
      !DECIMAL.test(value)) {
    throw new Error(`${field} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function nonce(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_SAFE_NONCE) {
    throw new Error(`${field} is invalid or cannot advance safely`);
  }
  return value;
}

function currentBalance(balances, account) {
  return atomic(balances.get(account) ?? 0n, "account balance");
}

function totalFor(balances, accounts) {
  return [...accounts].reduce((total, account) => total + currentBalance(balances, account), 0n);
}

export function transferCreditAllowance(stake) {
  if (typeof stake !== "bigint" || stake < 0n || stake > MAX_ATOMIC_VALUE) {
    throw new Error("credit stake must be a bounded non-negative bigint");
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

function multisigDescriptor(memberPublicKeys, threshold) {
  if (!Array.isArray(memberPublicKeys) || memberPublicKeys.length < 2 ||
      memberPublicKeys.length > MAX_MULTISIG_MEMBERS ||
      !Number.isSafeInteger(threshold) || threshold < 2 || threshold > memberPublicKeys.length ||
      memberPublicKeys.some((key) => typeof key !== "string" || key.length > 4_000) ||
      new Set(memberPublicKeys).size !== memberPublicKeys.length) {
    throw new Error("multisignature descriptor is invalid");
  }
  return Object.freeze({
    algorithm: SIGNATURE_ALGORITHM,
    memberPublicKeys: Object.freeze([...memberPublicKeys].sort()),
    threshold,
  });
}

export function multisigStateAddress(memberPublicKeys, threshold) {
  return `nir1${hashObject(multisigDescriptor(memberPublicKeys, threshold), "MULTISIG_ADDRESS")}`;
}

export function transferAuthorizationDigest(unsignedTransaction) {
  if (!unsignedTransaction || Object.getPrototypeOf(unsignedTransaction) !== Object.prototype) {
    throw new Error("unsigned transaction is invalid");
  }
  return hashObject(unsignedTransaction, "TRANSFER");
}

export function validateTransferAuthorizationEnvelope({
  envelope,
  expectedAlgorithm,
  unsignedTransaction,
}) {
  if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype ||
      Object.keys(envelope).sort().join("\0") !==
        ["algorithm", "approvals", "transactionDigest"].sort().join("\0") ||
      !Array.isArray(envelope.approvals) || envelope.approvals.length === 0 ||
      envelope.approvals.length > MAX_MULTISIG_MEMBERS) {
    throw new Error("transfer authorization envelope is invalid");
  }
  if (envelope.algorithm !== expectedAlgorithm) {
    throw new Error("transfer authorization algorithm mismatch");
  }
  if (!/^[0-9a-f]{64}$/.test(envelope.transactionDigest ?? "") ||
      envelope.transactionDigest !== transferAuthorizationDigest(unsignedTransaction)) {
    throw new Error("transfer authorization digest mismatch");
  }
  const signers = new Set();
  for (const approval of envelope.approvals) {
    if (!approval || Object.getPrototypeOf(approval) !== Object.prototype ||
        Object.keys(approval).sort().join("\0") !== ["publicKey", "signature"].sort().join("\0") ||
        typeof approval.publicKey !== "string" || approval.publicKey.length === 0 ||
        approval.publicKey.length > 4_000 ||
        typeof approval.signature !== "string" || approval.signature.length === 0 ||
        approval.signature.length > 7_000) {
      throw new Error("transfer authorization approval is invalid");
    }
    if (signers.has(approval.publicKey)) {
      throw new Error("transfer authorization approval is duplicated");
    }
    signers.add(approval.publicKey);
  }
  return Object.freeze({
    algorithm: envelope.algorithm,
    transactionDigest: envelope.transactionDigest,
    preverifiedSigners: Object.freeze([...signers]),
  });
}

export function applyAuthorizedOrdinaryTransferState({
  authorizationEnvelope,
  balances,
  feeRecipient,
  nonces,
  unsignedTransaction,
}) {
  const authorization = validateTransferAuthorizationEnvelope({
    envelope: authorizationEnvelope,
    expectedAlgorithm: SIGNATURE_ALGORITHM,
    unsignedTransaction,
  });
  if (authorization.preverifiedSigners.length !== 1 ||
      authorization.preverifiedSigners[0] !== unsignedTransaction.publicKey ||
      unsignedTransaction.algorithm !== SIGNATURE_ALGORITHM) {
    throw new Error("ordinary transfer authorization signer is invalid");
  }
  return applyOrdinaryTransferState({
    amount: unsignedTransaction.amount,
    balances,
    fee: unsignedTransaction.fee,
    feeRecipient,
    nonce: unsignedTransaction.nonce,
    nonces,
    recipient: unsignedTransaction.recipient,
    sender: unsignedTransaction.sender,
  });
}

export function applyAuthorizedMultisigTransferState({
  authorizationEnvelope,
  balances,
  feeRecipient,
  nonces,
  unsignedTransaction,
}) {
  const authorization = validateTransferAuthorizationEnvelope({
    envelope: authorizationEnvelope,
    expectedAlgorithm: MULTISIG_ALGORITHM,
    unsignedTransaction,
  });
  if (unsignedTransaction.algorithm !== MULTISIG_ALGORITHM) {
    throw new Error("multisignature authorization algorithm is invalid");
  }
  return applyMultisigTransferState({
    amount: unsignedTransaction.amount,
    balances,
    fee: unsignedTransaction.fee,
    feeRecipient,
    memberPublicKeys: unsignedTransaction.memberPublicKeys,
    nonce: unsignedTransaction.nonce,
    nonces,
    recipient: unsignedTransaction.recipient,
    sender: unsignedTransaction.sender,
    threshold: unsignedTransaction.threshold,
    verifiedSigners: authorization.preverifiedSigners,
  });
}

export function applyMultisigTransferState({
  amount,
  balances,
  fee,
  feeRecipient,
  memberPublicKeys,
  nonce: transactionNonce,
  nonces,
  recipient,
  sender,
  threshold,
  verifiedSigners,
}) {
  const descriptor = multisigDescriptor(memberPublicKeys, threshold);
  if (multisigStateAddress(descriptor.memberPublicKeys, descriptor.threshold) !== sender) {
    throw new Error("sender address does not match multisignature descriptor");
  }
  if (!Array.isArray(verifiedSigners) || verifiedSigners.length > descriptor.memberPublicKeys.length) {
    throw new Error("multisignature signer collection is invalid");
  }
  const allowed = new Set(descriptor.memberPublicKeys);
  const signers = new Set();
  for (const signer of verifiedSigners) {
    if (typeof signer !== "string" || !allowed.has(signer)) {
      throw new Error("multisignature signer is unknown");
    }
    if (signers.has(signer)) throw new Error("multisignature signer is duplicated");
    signers.add(signer);
  }
  if (signers.size < descriptor.threshold) {
    throw new Error("multisignature threshold not reached");
  }
  return applyOrdinaryTransferState({
    amount,
    balances,
    fee,
    feeRecipient,
    nonce: transactionNonce,
    nonces,
    recipient,
    sender,
  });
}

/**
 * Applies only the monetary state change of a normal, non-sponsored,
 * fee-paying NIR transfer. Signature, network, schema and treasury-vesting
 * checks stay with the caller. The mutation is atomic: validation and all
 * arithmetic complete before either map is changed.
 */
export function applyOrdinaryTransferState({
  amount: amountValue,
  balances,
  fee: feeValue,
  feeRecipient: feeRecipientValue,
  nonce: nonceValue,
  nonces,
  recipient: recipientValue,
  sender: senderValue,
}) {
  if (!(balances instanceof Map) || !(nonces instanceof Map)) {
    throw new Error("transfer state maps are invalid");
  }
  const sender = address(senderValue, "sender");
  const recipient = address(recipientValue, "recipient");
  const feeRecipient = address(feeRecipientValue, "fee recipient");
  const amount = atomic(amountValue, "amount");
  const fee = atomic(feeValue, "fee");
  const transactionNonce = nonce(nonceValue, "transaction nonce");
  if (amount === 0n) throw new Error("transfer amount must be positive");
  if (fee < MIN_TRANSFER_FEE) throw new Error("transfer fee is below the protocol minimum");
  const expectedNonce = nonces.get(sender) ?? 0;
  if (!Number.isSafeInteger(expectedNonce) || expectedNonce < 0 ||
      transactionNonce !== expectedNonce) {
    throw new Error("unexpected nonce");
  }

  const accounts = new Set([sender, recipient, feeRecipient]);
  const before = totalFor(balances, accounts);
  const deltas = new Map();
  const addDelta = (account, delta) => deltas.set(account, (deltas.get(account) ?? 0n) + delta);
  addDelta(sender, -amount - fee);
  addDelta(recipient, amount);
  addDelta(feeRecipient, fee);

  const next = new Map();
  for (const account of accounts) {
    const balance = currentBalance(balances, account);
    const updated = balance + (deltas.get(account) ?? 0n);
    if (updated < 0n) throw new Error("insufficient balance");
    if (updated > MAX_ATOMIC_VALUE) throw new Error("account balance is out of range");
    next.set(account, updated);
  }
  const after = [...next.values()].reduce((total, balance) => total + balance, 0n);
  if (after !== before || [...deltas.values()].reduce((total, delta) => total + delta, 0n) !== 0n) {
    throw new Error("ordinary transfer conservation invariant failed");
  }

  for (const [account, balance] of next) balances.set(account, balance);
  nonces.set(sender, transactionNonce + 1);
  return Object.freeze({ amount, fee, nextNonce: transactionNonce + 1 });
}

/**
 * Applies the monetary state change of a sponsored, fee-paying transfer.
 * The sender pays only the amount and a distinct fee payer pays the fee.
 * Both nonces advance atomically. Transfer Credits and multisignature
 * authorization are deliberately outside this transition.
 */
export function applySponsoredTransferState({
  amount: amountValue,
  balances,
  fee: feeValue,
  feePayer: feePayerValue,
  feePayerNonce: feePayerNonceValue,
  feeRecipient: feeRecipientValue,
  nonce: nonceValue,
  nonces,
  recipient: recipientValue,
  sender: senderValue,
}) {
  if (!(balances instanceof Map) || !(nonces instanceof Map)) {
    throw new Error("transfer state maps are invalid");
  }
  const sender = address(senderValue, "sender");
  const recipient = address(recipientValue, "recipient");
  const feePayer = address(feePayerValue, "fee payer");
  const feeRecipient = address(feeRecipientValue, "fee recipient");
  if (feePayer === sender) throw new Error("fee payer must be distinct from sender");
  const amount = atomic(amountValue, "amount");
  const fee = atomic(feeValue, "fee");
  const transactionNonce = nonce(nonceValue, "transaction nonce");
  const sponsorNonce = nonce(feePayerNonceValue, "fee payer nonce");
  if (amount === 0n) throw new Error("transfer amount must be positive");
  if (fee < MIN_TRANSFER_FEE) throw new Error("transfer fee is below the protocol minimum");
  const expectedNonce = nonces.get(sender) ?? 0;
  if (!Number.isSafeInteger(expectedNonce) || expectedNonce < 0 ||
      transactionNonce !== expectedNonce) {
    throw new Error("unexpected nonce");
  }
  const expectedFeePayerNonce = nonces.get(feePayer) ?? 0;
  if (!Number.isSafeInteger(expectedFeePayerNonce) || expectedFeePayerNonce < 0 ||
      sponsorNonce !== expectedFeePayerNonce) {
    throw new Error("unexpected fee payer nonce");
  }
  if (currentBalance(balances, sender) < amount) {
    throw new Error("sender has insufficient balance");
  }
  if (currentBalance(balances, feePayer) < fee) {
    throw new Error("fee payer has insufficient balance");
  }

  const accounts = new Set([sender, recipient, feePayer, feeRecipient]);
  const before = totalFor(balances, accounts);
  const deltas = new Map();
  const addDelta = (account, delta) => deltas.set(account, (deltas.get(account) ?? 0n) + delta);
  addDelta(sender, -amount);
  addDelta(recipient, amount);
  addDelta(feePayer, -fee);
  addDelta(feeRecipient, fee);

  const next = new Map();
  for (const account of accounts) {
    const balance = currentBalance(balances, account);
    const updated = balance + (deltas.get(account) ?? 0n);
    if (updated < 0n) throw new Error("sponsored transfer balance underflow");
    if (updated > MAX_ATOMIC_VALUE) throw new Error("account balance is out of range");
    next.set(account, updated);
  }
  const after = [...next.values()].reduce((total, balance) => total + balance, 0n);
  if (after !== before || [...deltas.values()].reduce((total, delta) => total + delta, 0n) !== 0n) {
    throw new Error("sponsored transfer conservation invariant failed");
  }

  for (const [account, balance] of next) balances.set(account, balance);
  nonces.set(sender, transactionNonce + 1);
  nonces.set(feePayer, sponsorNonce + 1);
  return Object.freeze({
    amount,
    fee,
    nextFeePayerNonce: sponsorNonce + 1,
    nextNonce: transactionNonce + 1,
  });
}

/**
 * Applies a zero-fee transfer paid from the owner's renewable Transfer Credit
 * allowance. A delegated transfer additionally consumes one unit of the
 * owner-to-sender delegation. All monetary and resource changes are atomic.
 */
export function applyCreditTransferState({
  amount: amountValue,
  balances,
  creditDelegations,
  creditOwner: creditOwnerValue,
  creditStakes,
  creditUsage,
  fee: feeValue,
  feePayer: feePayerValue,
  feePayerNonce: feePayerNonceValue,
  height: heightValue,
  nonce: nonceValue,
  nonces,
  recipient: recipientValue,
  sender: senderValue,
}) {
  if (!(balances instanceof Map) || !(nonces instanceof Map) ||
      !(creditStakes instanceof Map) || !(creditUsage instanceof Map) ||
      !(creditDelegations instanceof Map)) {
    throw new Error("credit transfer state maps are invalid");
  }
  const sender = address(senderValue, "sender");
  const recipient = address(recipientValue, "recipient");
  const sponsored = feePayerValue !== undefined || feePayerNonceValue !== undefined;
  if (sponsored && (feePayerValue === undefined || feePayerNonceValue === undefined)) {
    throw new Error("sponsored credit fields are incomplete");
  }
  if (sponsored && creditOwnerValue !== undefined) {
    throw new Error("sponsored credit cannot be delegated");
  }
  const feePayer = sponsored ? address(feePayerValue, "fee payer") : null;
  if (feePayer === sender) throw new Error("fee payer must be distinct from sender");
  const owner = sponsored ? feePayer :
    creditOwnerValue === undefined ? sender : address(creditOwnerValue, "credit owner");
  const delegated = !sponsored && owner !== sender;
  if (creditOwnerValue !== undefined && !delegated) {
    throw new Error("delegated credit owner must be distinct from sender");
  }
  const amount = atomic(amountValue, "amount");
  const fee = atomic(feeValue, "fee");
  const transactionNonce = nonce(nonceValue, "transaction nonce");
  const sponsorNonce = sponsored ? nonce(feePayerNonceValue, "fee payer nonce") : null;
  const epoch = transferCreditEpoch(heightValue);
  if (amount === 0n) throw new Error("transfer amount must be positive");
  if (fee !== 0n) throw new Error("credit-paid transfer fee must be zero");
  const expectedNonce = nonces.get(sender) ?? 0;
  if (!Number.isSafeInteger(expectedNonce) || expectedNonce < 0 ||
      transactionNonce !== expectedNonce) {
    throw new Error("unexpected nonce");
  }
  if (sponsored) {
    const expectedFeePayerNonce = nonces.get(feePayer) ?? 0;
    if (!Number.isSafeInteger(expectedFeePayerNonce) || expectedFeePayerNonce < 0 ||
        sponsorNonce !== expectedFeePayerNonce) {
      throw new Error("unexpected fee payer nonce");
    }
  }
  if (currentBalance(balances, sender) < amount) {
    throw new Error("sender has insufficient balance");
  }

  const allowance = transferCreditAllowance(creditStakes.get(owner) ?? 0n);
  const previous = creditUsage.get(owner);
  const spent = previous?.epoch === epoch ? previous.spent : 0;
  if (!Number.isSafeInteger(spent) || spent < 0) throw new Error("credit usage is invalid");
  if (allowance <= BigInt(spent)) throw new Error("transfer credit quota is exhausted");
  const nextUsage = Object.freeze({ epoch, spent: spent + 1 });

  let delegationKey = null;
  let nextDelegation = null;
  if (delegated) {
    delegationKey = `${owner}:${sender}`;
    const delegation = creditDelegations.get(delegationKey);
    if (!delegation) throw new Error("transfer credit delegation is missing");
    const delegationSpent = delegation.epoch === epoch ? delegation.spent : 0;
    if (!Number.isSafeInteger(delegationSpent) || delegationSpent < 0 ||
        !Number.isSafeInteger(delegation.limit) || delegation.limit < 0) {
      throw new Error("transfer credit delegation is invalid");
    }
    if (delegationSpent >= delegation.limit) {
      throw new Error("transfer credit delegation is exhausted");
    }
    nextDelegation = Object.freeze({ ...delegation, epoch, spent: delegationSpent + 1 });
  }

  const accounts = new Set([sender, recipient]);
  const before = totalFor(balances, accounts);
  const deltas = new Map();
  const addDelta = (account, delta) => deltas.set(account, (deltas.get(account) ?? 0n) + delta);
  addDelta(sender, -amount);
  addDelta(recipient, amount);
  const nextBalances = new Map();
  for (const account of accounts) {
    const updated = currentBalance(balances, account) + (deltas.get(account) ?? 0n);
    if (updated < 0n) throw new Error("credit transfer balance underflow");
    if (updated > MAX_ATOMIC_VALUE) throw new Error("account balance is out of range");
    nextBalances.set(account, updated);
  }
  const after = [...nextBalances.values()].reduce((total, balance) => total + balance, 0n);
  if (after !== before || [...deltas.values()].reduce((total, delta) => total + delta, 0n) !== 0n) {
    throw new Error("credit transfer conservation invariant failed");
  }

  for (const [account, balance] of nextBalances) balances.set(account, balance);
  nonces.set(sender, transactionNonce + 1);
  if (sponsored) nonces.set(feePayer, sponsorNonce + 1);
  creditUsage.set(owner, nextUsage);
  if (delegationKey !== null) creditDelegations.set(delegationKey, nextDelegation);
  return Object.freeze({
    amount,
    epoch,
    ...(sponsored ? { nextFeePayerNonce: sponsorNonce + 1 } : {}),
    nextNonce: transactionNonce + 1,
    owner,
  });
}
