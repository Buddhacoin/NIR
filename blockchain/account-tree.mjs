import { canonicalJson, hashObject } from "./crypto.mjs";
import { emptyAccountHistory, normalizeAccountHistory } from "./account-history.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,31})$/;
const DEPTH = 256;
const FORMAT = "nir-account-state-proof-v1";
export const MAX_ACCOUNT_STATE_PROOF_BYTES = 32 * 1024;

const emptyHashes = Array(DEPTH + 1);
emptyHashes[DEPTH] = hashObject(null, "ACCOUNT_TREE_EMPTY_LEAF");
for (let depth = DEPTH - 1; depth >= 0; depth -= 1) {
  emptyHashes[depth] = hashObject({
    left: emptyHashes[depth + 1], right: emptyHashes[depth + 1],
  }, "ACCOUNT_TREE_NODE");
}

function addressBits(address) {
  if (!ADDRESS.test(address ?? "")) throw new Error("account tree address is invalid");
  return [...address.slice(4)].map((digit) =>
    Number.parseInt(digit, 16).toString(2).padStart(4, "0")).join("");
}

export function normalizeAccountState(account) {
  if (!account || !ADDRESS.test(account.address ?? "") ||
      !ATOMIC.test(account.atomicBalance ?? "") ||
      !Number.isSafeInteger(account.nextNonce) || account.nextNonce < 0 ||
      !account.history ||
      !account.resources || !ATOMIC.test(account.resources.atomicStake ?? "") ||
      !ATOMIC.test(account.resources.availableTransferCredits ?? "") ||
      !Array.isArray(account.resources.delegations) || account.resources.delegations.length > 256) {
    throw new Error("account tree state is invalid");
  }
  const pending = account.resources.pendingUnstake;
  if (pending !== null && (!pending || !ATOMIC.test(pending.amount ?? "") ||
      !Number.isSafeInteger(pending.unlockHeight) || pending.unlockHeight < 1)) {
    throw new Error("account tree pending unstake is invalid");
  }
  const delegations = account.resources.delegations.map((delegation) => {
    if (!delegation || delegation.owner !== account.address ||
        !ADDRESS.test(delegation.delegate ?? "") || delegation.delegate === account.address ||
        !Number.isSafeInteger(delegation.epoch) || delegation.epoch < 0 ||
        !Number.isSafeInteger(delegation.limit) || delegation.limit < 1 ||
        delegation.limit > 1_000_000 || !Number.isSafeInteger(delegation.spent) ||
        delegation.spent < 0 || delegation.spent > delegation.limit) {
      throw new Error("account tree delegation is invalid");
    }
    return structuredClone(delegation);
  }).sort((a, b) => a.delegate.localeCompare(b.delegate));
  if (new Set(delegations.map(({ delegate }) => delegate)).size !== delegations.length) {
    throw new Error("account tree delegations contain duplicates");
  }
  return {
    address: account.address,
    atomicBalance: account.atomicBalance,
    history: normalizeAccountHistory(account.history),
    nextNonce: account.nextNonce,
    resources: {
      atomicStake: account.resources.atomicStake,
      availableTransferCredits: account.resources.availableTransferCredits,
      delegations,
      pendingUnstake: pending === null ? null : {
        amount: pending.amount, unlockHeight: pending.unlockHeight,
      },
    },
  };
}

export function emptyAccountState(address) {
  return {
    address,
    atomicBalance: "0",
    history: emptyAccountHistory(),
    nextNonce: 0,
    resources: {
      atomicStake: "0", availableTransferCredits: "0", delegations: [], pendingUnstake: null,
    },
  };
}

function leafHash(account, exists) {
  return exists
    ? hashObject(normalizeAccountState(account), "ACCOUNT_TREE_LEAF")
    : emptyHashes[DEPTH];
}

function buildLevels(accounts) {
  if (!Array.isArray(accounts)) throw new Error("account tree entries are invalid");
  const leaves = new Map();
  for (const value of accounts) {
    const account = normalizeAccountState(value);
    const path = addressBits(account.address);
    if (leaves.has(path)) throw new Error("account tree contains a duplicate address");
    leaves.set(path, leafHash(account, true));
  }
  const levels = Array(DEPTH + 1);
  levels[DEPTH] = leaves;
  for (let depth = DEPTH - 1; depth >= 0; depth -= 1) {
    const parents = new Set([...levels[depth + 1].keys()].map((path) => path.slice(0, depth)));
    const nodes = new Map();
    for (const parent of parents) {
      const left = levels[depth + 1].get(`${parent}0`) ?? emptyHashes[depth + 1];
      const right = levels[depth + 1].get(`${parent}1`) ?? emptyHashes[depth + 1];
      nodes.set(parent, hashObject({ left, right }, "ACCOUNT_TREE_NODE"));
    }
    levels[depth] = nodes;
  }
  return levels;
}

export function accountStateRoot(accounts) {
  return buildLevels(accounts)[0].get("") ?? emptyHashes[0];
}

function proofFromLevels(accounts, address, levels) {
  const path = addressBits(address);
  const found = accounts.find((account) => account.address === address);
  const siblings = [];
  for (let depth = DEPTH; depth > 0; depth -= 1) {
    const prefix = path.slice(0, depth);
    const sibling = `${prefix.slice(0, -1)}${prefix.endsWith("0") ? "1" : "0"}`;
    siblings.push(levels[depth].get(sibling) ?? emptyHashes[depth]);
  }
  return {
    exists: Boolean(found),
    format: FORMAT,
    siblings,
  };
}

export function createAccountStateProof(accounts, address) {
  return proofFromLevels(accounts, address, buildLevels(accounts));
}

export function createAccountStateWitness(accounts, address) {
  const levels = buildLevels(accounts);
  return {
    accountStateRoot: levels[0].get("") ?? emptyHashes[0],
    inclusionProof: proofFromLevels(accounts, address, levels),
  };
}

export function verifyAccountStateProof(account, proof, expectedRoot) {
  const normalized = normalizeAccountState(account);
  if (!proof || proof.format !== FORMAT || typeof proof.exists !== "boolean" ||
      !Array.isArray(proof.siblings) || proof.siblings.length !== DEPTH ||
      proof.siblings.some((hash) => !HASH.test(hash ?? "")) ||
      !HASH.test(expectedRoot ?? "") ||
      Buffer.byteLength(canonicalJson(proof)) > MAX_ACCOUNT_STATE_PROOF_BYTES ||
      (!proof.exists && canonicalJson(normalized) !== canonicalJson(emptyAccountState(account.address)))) {
    throw new Error("account state inclusion proof is invalid");
  }
  const path = addressBits(account.address);
  let current = leafHash(normalized, proof.exists);
  for (let index = 0; index < DEPTH; index += 1) {
    const bit = path[DEPTH - 1 - index];
    const sibling = proof.siblings[index];
    current = bit === "0"
      ? hashObject({ left: current, right: sibling }, "ACCOUNT_TREE_NODE")
      : hashObject({ left: sibling, right: current }, "ACCOUNT_TREE_NODE");
  }
  if (current !== expectedRoot) throw new Error("account state root does not match");
  return normalized;
}
