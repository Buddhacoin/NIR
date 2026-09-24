import { MAX_DECIMAL_DIGITS, MIN_TRANSFER_FEE } from "./constants.mjs";

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
