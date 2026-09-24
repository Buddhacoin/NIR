import { MAX_DECIMAL_DIGITS, MIN_TRANSFER_FEE } from "./constants.mjs";
import { consensusEnvelopeBytes } from "./consensus-codec.mjs";
import { createHash } from "node:crypto";

export const MAX_ACTIVE_AGENT_MANDATES_PER_OWNER = 64;
export const MAX_AGENT_MANDATES_GLOBAL = 4_096;
export const MAX_AGENT_MANDATE_PRUNE_BATCH = 64;
export const MAX_AGENT_MANDATE_PAYEES = 64;
export const MAX_AGENT_MANDATE_LIFETIME = 1_000_000;

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_ATOMIC = 10n ** BigInt(MAX_DECIMAL_DIGITS) - 1n;
const MAX_NONCE = Number.MAX_SAFE_INTEGER;
const NETWORK_ID = /^[A-Za-z0-9._:-]{3,128}$/;

function networkId(value) {
  if (typeof value !== "string" || !NETWORK_ID.test(value)) throw new Error("network id is invalid");
  return value;
}

function context(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== "currentHeight\0feeRecipient\0networkId") {
    throw new Error("agent mandate execution context is invalid");
  }
  return { currentHeight: integer(value.currentHeight, "current height"),
    feeRecipient: address(value.feeRecipient, "fee recipient"),
    networkId: networkId(value.networkId) };
}

function pruneContext(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== "currentHeight\0networkId") {
    throw new Error("agent mandate prune context is invalid");
  }
  return { currentHeight: integer(value.currentHeight, "current height"),
    networkId: networkId(value.networkId) };
}

function address(value, field) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function atomic(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_ATOMIC) throw new Error(`${field} is out of range`);
    return value;
  }
  if (typeof value !== "string" || value.length > MAX_DECIMAL_DIGITS || !DECIMAL.test(value)) {
    throw new Error(`${field} is not canonical`);
  }
  return BigInt(value);
}

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function advancingNonce(value, field) {
  integer(value, field);
  if (value >= MAX_NONCE) throw new Error(`${field} cannot advance`);
  return value;
}

function authorization(value, actor, digest, role) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== ["actor", "digest"].sort().join("\0") ||
      value.actor !== actor || value.digest !== digest) {
    throw new Error(`${role} preverified authorization is invalid`);
  }
  return value;
}

function maps(balances, nonces, mandates) {
  if (!(balances instanceof Map) || !(nonces instanceof Map) || !(mandates instanceof Map)) {
    throw new Error("agent mandate state maps are invalid");
  }
}

function balance(balances, account) {
  return atomic(balances.get(account) ?? 0n, "account balance");
}

function nonceMatches(nonces, actor, provided, role) {
  const nonce = advancingNonce(provided, `${role} nonce`);
  const expected = nonces.get(actor) ?? 0;
  if (!Number.isSafeInteger(expected) || expected < 0 || nonce !== expected) {
    throw new Error(`${role} nonce is unexpected`);
  }
  return nonce;
}

function payees(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_AGENT_MANDATE_PAYEES) {
    throw new Error("agent mandate payee capacity is invalid");
  }
  const normalized = values.map((value) => address(value, "allowed payee")).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("agent mandate payees contain duplicates");
  }
  return Object.freeze(normalized);
}

function digest(domain, value) {
  return createHash("sha3-256").update(consensusEnvelopeBytes(domain, value)).digest("hex");
}

export function agentMandateCreateDigest(value) {
  return digest("AGENT_MANDATE_CREATE", value);
}
export function agentMandateTransferDigest(value) {
  return digest("AGENT_MANDATE_TRANSFER", value);
}
export function agentMandateCloseDigest(value) {
  return digest("AGENT_MANDATE_CLOSE", value);
}

function mandate(value, mandateId) {
  const fields = ["agent", "allowedPayees", "balance", "createdHeight", "expiresHeight",
    "initialEscrow", "maxFee", "maxPerTransfer", "networkId", "owner", "policyHash", "totalFeeLimit",
    "totalFees", "totalLimit", "totalSpent"];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== fields.sort().join("\0")) {
    throw new Error("agent mandate stored fields are invalid");
  }
  if (!HASH.test(mandateId ?? "")) throw new Error("agent mandate identifier is invalid");
  const owner = address(value.owner, "mandate owner");
  const agent = address(value.agent, "mandate agent");
  const network = networkId(value.networkId);
  if (owner === agent) throw new Error("agent mandate actors are invalid");
  if (!HASH.test(value.policyHash ?? "")) throw new Error("agent mandate policy is invalid");
  const allowedPayees = payees(value.allowedPayees);
  if (allowedPayees.some((entry, index) => entry !== value.allowedPayees[index])) {
    throw new Error("agent mandate payees are not canonical");
  }
  const balance = atomic(value.balance, "mandate balance");
  const initialEscrow = atomic(value.initialEscrow, "mandate initial escrow");
  const maxFee = atomic(value.maxFee, "mandate maximum fee");
  const maxPerTransfer = atomic(value.maxPerTransfer, "mandate maximum per transfer");
  const totalLimit = atomic(value.totalLimit, "mandate total limit");
  const totalFeeLimit = atomic(value.totalFeeLimit, "mandate total fee limit");
  const totalFees = atomic(value.totalFees, "mandate total fees");
  const totalSpent = atomic(value.totalSpent, "mandate total spent");
  const createdHeight = integer(value.createdHeight, "mandate creation height");
  const expiresHeight = integer(value.expiresHeight, "mandate expiry height");
  if (maxFee < MIN_TRANSFER_FEE || maxFee > totalFeeLimit ||
      maxPerTransfer === 0n || totalLimit === 0n || maxPerTransfer > totalLimit ||
      totalSpent > totalLimit || totalFees > totalFeeLimit ||
      totalLimit + totalFeeLimit > initialEscrow ||
      balance + totalSpent + totalFees !== initialEscrow ||
      allowedPayees.includes(owner) || allowedPayees.includes(agent) ||
      expiresHeight <= createdHeight ||
      expiresHeight - createdHeight > MAX_AGENT_MANDATE_LIFETIME) {
    throw new Error("agent mandate state is invalid");
  }
  return { owner, agent, allowedPayees, balance, createdHeight, expiresHeight,
    initialEscrow, maxFee, maxPerTransfer, networkId: network, policyHash: value.policyHash,
    totalFeeLimit, totalFees, totalLimit, totalSpent };
}

function conserve(before, after) {
  if (before !== after) throw new Error("agent mandate NIR conservation failed");
}

function validateMandateRegistry(mandates, authoritativeNetworkId) {
  if (!(mandates instanceof Map)) throw new Error("agent mandate registry is invalid");
  if (mandates.size > MAX_AGENT_MANDATES_GLOBAL) throw new Error("global agent mandate capacity exceeded");
  const perOwner = new Map();
  const entries = [...mandates.entries()].map(([id, value]) => mandate(value, id));
  for (const entry of entries) {
    if (entry.networkId !== authoritativeNetworkId) throw new Error("network id mismatch");
    const count = (perOwner.get(entry.owner) ?? 0) + 1;
    if (count > MAX_ACTIVE_AGENT_MANDATES_PER_OWNER) throw new Error("owner agent mandate capacity exceeded");
    perOwner.set(entry.owner, count);
  }
  return entries;
}

export function createAgentMandateState({
  agent: agentValue,
  allowedPayees,
  balances,
  escrow: escrowValue,
  expiresHeight: expiresHeightValue,
  fee: feeValue,
  executionContext,
  mandateId,
  mandates,
  maxFee: maxFeeValue,
  maxPerTransfer: maxPerTransferValue,
  networkId: networkIdValue,
  nonce: nonceValue,
  nonces,
  owner: ownerValue,
  policyHash,
  preverifiedOwnerAuthorization,
  totalFeeLimit: totalFeeLimitValue,
  totalLimit: totalLimitValue,
}) {
  maps(balances, nonces, mandates);
  const owner = address(ownerValue, "owner");
  const agent = address(agentValue, "agent");
  const { currentHeight, feeRecipient, networkId: authoritativeNetworkId } = context(executionContext);
  const network = networkId(networkIdValue);
  if (network !== authoritativeNetworkId) throw new Error("network id mismatch");
  if (owner === agent) throw new Error("agent must be independent from owner");
  if (!HASH.test(mandateId ?? "") || !HASH.test(policyHash ?? "")) {
    throw new Error("agent mandate commitment is invalid");
  }
  if (mandates.has(mandateId)) throw new Error("agent mandate already exists");
  const stored = validateMandateRegistry(mandates, authoritativeNetworkId);
  if (stored.length >= MAX_AGENT_MANDATES_GLOBAL) throw new Error("global agent mandate capacity reached");
  const activeForOwner = stored.filter((entry) => entry.owner === owner).length;
  if (activeForOwner >= MAX_ACTIVE_AGENT_MANDATES_PER_OWNER) {
    throw new Error("owner agent mandate capacity reached");
  }
  const ownerNonce = nonceMatches(nonces, owner, nonceValue, "owner");
  const expiresHeight = integer(expiresHeightValue, "expiry height");
  if (expiresHeight <= currentHeight || expiresHeight - currentHeight > MAX_AGENT_MANDATE_LIFETIME) {
    throw new Error("agent mandate expiry is invalid");
  }
  const escrow = atomic(escrowValue, "escrow");
  const maxPerTransfer = atomic(maxPerTransferValue, "maximum per transfer");
  const maxFee = atomic(maxFeeValue, "maximum fee");
  const totalLimit = atomic(totalLimitValue, "total limit");
  const totalFeeLimit = atomic(totalFeeLimitValue, "total fee limit");
  const fee = atomic(feeValue, "fee");
  if (escrow === 0n || maxFee < MIN_TRANSFER_FEE || maxFee > totalFeeLimit ||
      maxPerTransfer === 0n || totalLimit === 0n ||
      maxPerTransfer > totalLimit || totalLimit + totalFeeLimit > escrow) {
    throw new Error("agent mandate monetary limits are invalid");
  }
  if (fee < MIN_TRANSFER_FEE) throw new Error("fee below minimum");
  const ownerBalance = balance(balances, owner);
  if (ownerBalance < escrow + fee) throw new Error("owner has insufficient balance");
  const allowed = payees(allowedPayees);
  if (allowed.includes(owner) || allowed.includes(agent)) throw new Error("agent mandate self-dealing payee is invalid");
  const authorizationDigest = agentMandateCreateDigest({ agent, allowedPayees: allowed,
    escrow: escrow.toString(), expiresHeight, fee: fee.toString(), mandateId,
    maxFee: maxFee.toString(), maxPerTransfer: maxPerTransfer.toString(), networkId: network,
    nonce: ownerNonce, owner, policyHash, totalFeeLimit: totalFeeLimit.toString(),
    totalLimit: totalLimit.toString() });
  authorization(preverifiedOwnerAuthorization, owner, authorizationDigest, "owner");
  const accounts = new Set([owner, feeRecipient]);
  const before = [...accounts].reduce((sum, account) => sum + balance(balances, account), 0n);
  const deltas = new Map();
  deltas.set(owner, (deltas.get(owner) ?? 0n) - escrow - fee);
  deltas.set(feeRecipient, (deltas.get(feeRecipient) ?? 0n) + fee);
  const nextBalances = new Map();
  for (const account of accounts) {
    const next = balance(balances, account) + (deltas.get(account) ?? 0n);
    if (next < 0n || next > MAX_ATOMIC) throw new Error("account balance overflow");
    nextBalances.set(account, next);
  }
  conserve(before, [...nextBalances.values()].reduce((sum, value) => sum + value, 0n) + escrow);
  const nextMandate = Object.freeze({
    agent,
    allowedPayees: allowed,
    balance: escrow,
    createdHeight: currentHeight,
    expiresHeight,
    initialEscrow: escrow,
    maxFee,
    maxPerTransfer,
    networkId: network,
    owner,
    policyHash,
    totalLimit,
    totalFeeLimit,
    totalFees: 0n,
    totalSpent: 0n,
  });
  for (const [account, next] of nextBalances) balances.set(account, next);
  nonces.set(owner, ownerNonce + 1);
  mandates.set(mandateId, nextMandate);
  return nextMandate;
}

export function applyAgentMandateTransferState({
  amount: amountValue,
  balances,
  fee: feeValue,
  executionContext,
  mandateId,
  mandates,
  nonce: nonceValue,
  nonces,
  payee: payeeValue,
  preverifiedAgentAuthorization,
}) {
  maps(balances, nonces, mandates);
  const current = mandate(mandates.get(mandateId), mandateId);
  const agent = address(current.agent, "mandate agent");
  const payee = address(payeeValue, "payee");
  const { currentHeight, feeRecipient, networkId: authoritativeNetworkId } = context(executionContext);
  validateMandateRegistry(mandates, authoritativeNetworkId);
  const agentNonce = nonceMatches(nonces, agent, nonceValue, "agent");
  const network = networkId(current.networkId);
  if (network !== authoritativeNetworkId) throw new Error("network id mismatch");
  if (currentHeight < current.createdHeight) throw new Error("current height precedes mandate creation");
  if (currentHeight >= current.expiresHeight) throw new Error("agent mandate expired");
  if (!current.allowedPayees.includes(payee)) throw new Error("payee is not allowed");
  const amount = atomic(amountValue, "amount");
  const fee = atomic(feeValue, "fee");
  const authorizationDigest = agentMandateTransferDigest({ amount: amount.toString(),
    fee: fee.toString(), mandateId, networkId: network, nonce: agentNonce, payee });
  authorization(preverifiedAgentAuthorization, agent, authorizationDigest, "agent");
  if (amount === 0n || amount > current.maxPerTransfer ||
      current.totalSpent + amount > current.totalLimit) {
    throw new Error("agent mandate spending limit exceeded");
  }
  if (fee < MIN_TRANSFER_FEE) throw new Error("fee below minimum");
  if (fee > current.maxFee) throw new Error("fee exceeds agent mandate maximum");
  if (current.totalFees + fee > current.totalFeeLimit) throw new Error("agent mandate fee budget exceeded");
  if (current.balance < amount + fee) throw new Error("agent mandate escrow is insufficient");
  const accounts = new Set([payee, feeRecipient]);
  const beforeBalances = [...accounts].reduce((sum, account) => sum + balance(balances, account), 0n);
  const deltas = new Map();
  deltas.set(payee, (deltas.get(payee) ?? 0n) + amount);
  deltas.set(feeRecipient, (deltas.get(feeRecipient) ?? 0n) + fee);
  const nextBalances = new Map();
  for (const account of accounts) {
    const next = balance(balances, account) + (deltas.get(account) ?? 0n);
    if (next > MAX_ATOMIC) throw new Error("account balance overflow");
    nextBalances.set(account, next);
  }
  const nextEscrow = current.balance - amount - fee;
  const afterBalances = [...nextBalances.values()].reduce((sum, value) => sum + value, 0n);
  conserve(beforeBalances + current.balance, afterBalances + nextEscrow);
  const nextMandate = Object.freeze({
    ...current,
    balance: nextEscrow,
    totalSpent: current.totalSpent + amount,
    totalFees: current.totalFees + fee,
  });
  for (const [account, next] of nextBalances) balances.set(account, next);
  nonces.set(agent, agentNonce + 1);
  mandates.set(mandateId, nextMandate);
  return nextMandate;
}

export function closeAgentMandateState({
  balances,
  fee: feeValue,
  executionContext,
  mandateId,
  mandates,
  mode,
  nonce: nonceValue,
  nonces,
  preverifiedOwnerAuthorization,
}) {
  maps(balances, nonces, mandates);
  const current = mandate(mandates.get(mandateId), mandateId);
  const owner = address(current.owner, "mandate owner");
  const { currentHeight, feeRecipient, networkId: authoritativeNetworkId } = context(executionContext);
  validateMandateRegistry(mandates, authoritativeNetworkId);
  if (current.networkId !== authoritativeNetworkId) throw new Error("network id mismatch");
  if (currentHeight < current.createdHeight) throw new Error("current height precedes mandate creation");
  const ownerNonce = nonceMatches(nonces, owner, nonceValue, "owner");
  if (mode !== "revoke" && mode !== "expiry") throw new Error("mandate close mode is invalid");
  if (mode === "expiry" && currentHeight < current.expiresHeight) {
    throw new Error("agent mandate has not expired");
  }
  const fee = atomic(feeValue, "fee");
  const authorizationDigest = agentMandateCloseDigest({ fee: fee.toString(), mandateId,
    mode, networkId: current.networkId, nonce: ownerNonce });
  authorization(preverifiedOwnerAuthorization, owner, authorizationDigest, "owner");
  if (fee < MIN_TRANSFER_FEE) throw new Error("fee below minimum");
  const ownerBalance = balance(balances, owner);
  if (ownerBalance + current.balance < fee) {
    throw new Error("owner and escrow cannot cover close fee");
  }
  const deltas = new Map();
  deltas.set(owner, (deltas.get(owner) ?? 0n) + current.balance - fee);
  deltas.set(feeRecipient, (deltas.get(feeRecipient) ?? 0n) + fee);
  const accounts = new Set([owner, feeRecipient]);
  const before = [...accounts].reduce((sum, account) => sum + balance(balances, account), 0n) + current.balance;
  const nextBalances = new Map();
  for (const account of accounts) {
    const next = balance(balances, account) + (deltas.get(account) ?? 0n);
    if (next < 0n || next > MAX_ATOMIC) throw new Error("account balance overflow");
    nextBalances.set(account, next);
  }
  const after = [...nextBalances.values()].reduce((sum, value) => sum + value, 0n);
  conserve(before, after);
  for (const [account, next] of nextBalances) balances.set(account, next);
  nonces.set(owner, ownerNonce + 1);
  mandates.delete(mandateId);
  return Object.freeze({ fee, mode, ownerBalanceDelta: nextBalances.get(owner) - ownerBalance,
    releasedEscrow: current.balance });
}

export function pruneExpiredAgentMandatesState({ balances, executionContext,
  limit: limitValue, mandates }) {
  if (!(balances instanceof Map) || !(mandates instanceof Map)) throw new Error("agent mandate state maps are invalid");
  const { currentHeight, networkId: authoritativeNetworkId } = pruneContext(executionContext);
  validateMandateRegistry(mandates, authoritativeNetworkId);
  const limit = integer(limitValue, "prune limit");
  if (limit < 1 || limit > MAX_AGENT_MANDATE_PRUNE_BATCH) throw new Error("prune limit is invalid");
  const candidates = [...mandates.entries()].map(([id, entry]) => [id, mandate(entry, id)])
    .filter(([, entry]) => entry.expiresHeight <= currentHeight)
    .sort(([leftId, left], [rightId, right]) =>
      left.expiresHeight - right.expiresHeight || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0))
    .slice(0, limit);
  const refunds = new Map();
  for (const [, entry] of candidates) refunds.set(entry.owner,
    (refunds.get(entry.owner) ?? 0n) + entry.balance);
  const next = new Map();
  for (const [owner, refund] of refunds) {
    const value = balance(balances, owner) + refund;
    if (value > MAX_ATOMIC) throw new Error("account balance overflow");
    next.set(owner, value);
  }
  for (const [owner, value] of next) balances.set(owner, value);
  for (const [id] of candidates) mandates.delete(id);
  return Object.freeze({ prunedMandateIds: Object.freeze(candidates.map(([id]) => id)) });
}
