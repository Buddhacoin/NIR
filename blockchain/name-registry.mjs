import { ATOMIC_UNITS } from "./constants.mjs";
import { hashObject } from "./crypto.mjs";

// Account names (docs/names.md): `sasha` stands for one NIR address, so people
// can send to `sasha.nir` instead of 68 characters. Pure and deterministic:
// the chain feeds it transactions and block boundaries.
//
// - A name is 3–32 characters: a–z, 0–9 and single hyphens inside. Only
//   these characters, so no two names can look alike.
// - First come, first served, with commit–reveal: the owner first commits to
//   a hidden name, then registers it at least `revealDelayBlocks` later. A
//   name cannot be taken by someone who sees the registration in flight.
// - One name per address. Registering another name frees the old one; the
//   owner can also release it or give it to an address without a name.
// - No renewal: a name is kept until its owner changes it.
// - The one-time price is burned: nobody receives it, the founder included.
// - The address stays the account's identity. Wallets show a name only when
//   the name points to the address and the address points back to the name.

export const NAMES_V1 = Object.freeze({
  minLength: 3,
  maxLength: 32,
  revealDelayBlocks: 2,
  commitLifetimeBlocks: 256,
  maxPendingCommits: 4_096,
  maxNames: 1_000_000,
});

// Short names are rarer, so they cost more. Burned, never paid to anyone.
export function namePrice(name) {
  if (name.length === 3) return 50n * ATOMIC_UNITS;
  if (name.length === 4) return 10n * ATOMIC_UNITS;
  return ATOMIC_UNITS;
}

// Names people could mistake for NIR itself or for staff.
export const RESERVED_NAMES = Object.freeze(new Set([
  "admin", "administrator", "airdrop", "bank", "exchange", "faucet", "founder", "foundation",
  "giveaway", "help", "helpdesk", "mainnet", "miner", "mining", "moderator", "null", "official",
  "owner", "pay", "payment", "payments", "refund", "root", "security", "staff", "support",
  "system", "team", "testnet", "treasury", "undefined", "validator", "validators", "wallet",
]));

const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const ADDRESS = /^nir1[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`account name ${message}`);
}

function height(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
  return value;
}

// Why a name cannot be registered, or null when it can be.
export function nameProblem(name, params = NAMES_V1) {
  if (typeof name !== "string" || name.length < params.minLength || name.length > params.maxLength) {
    return "length";
  }
  if (!NAME.test(name) || name.includes("--")) return "characters";
  // `nir…` looks like an address or like NIR itself.
  if (name.startsWith("nir") || RESERVED_NAMES.has(name)) return "reserved";
  return null;
}

// What people type: `Sasha.nir`, ` sasha `. Returns the bare name.
export function normalizeNameInput(input) {
  if (typeof input !== "string") return null;
  const name = input.trim().toLowerCase().replace(/\.nir$/u, "");
  return nameProblem(name) === null ? name : null;
}

export function nameCommitment({ name, networkId, owner, salt }) {
  return hashObject({ name, networkId, owner, salt }, "NAME_COMMITMENT_V1");
}

export function createNameRegistryState() {
  return { names: new Map(), owners: new Map(), commits: new Map() };
}

export function applyNameCommit(state, { commitment, sender, height: at }, params = NAMES_V1) {
  if (typeof commitment !== "string" || !HEX64.test(commitment)) fail("commitment is invalid");
  if (state.commits.has(commitment)) fail("commitment was already submitted");
  if (state.commits.size >= params.maxPendingCommits) fail("commit queue is full");
  state.commits.set(commitment, { height: height(at, "commit height"), sender });
}

// Returns the burned price. A name the sender already had is freed.
export function applyNameRegister(state, { name, networkId, salt, sender, height: at }, params = NAMES_V1) {
  const problem = nameProblem(name, params);
  if (problem !== null) fail(`is not allowed (${problem})`);
  if (typeof salt !== "string" || !HEX64.test(salt)) fail("salt is invalid");
  const commitment = nameCommitment({ name, networkId, owner: sender, salt });
  const commit = state.commits.get(commitment);
  if (!commit || commit.sender !== sender) fail("registration has no commit");
  if (at < commit.height + params.revealDelayBlocks || at > commit.height + params.commitLifetimeBlocks) {
    fail("registration is outside its window");
  }
  if (state.names.has(name)) fail("is already taken");
  if (state.names.size >= params.maxNames) fail("registry is full");
  state.commits.delete(commitment);
  const previous = state.owners.get(sender);
  if (previous !== undefined) state.names.delete(previous);
  state.names.set(name, { height: height(at, "registration height"), owner: sender });
  state.owners.set(sender, name);
  return namePrice(name);
}

export function applyNameRelease(state, { sender }) {
  const name = state.owners.get(sender);
  if (name === undefined) fail("release has no name");
  state.owners.delete(sender);
  state.names.delete(name);
}

// The receiver must have no name yet: one name per address.
export function applyNameTransfer(state, { sender, recipient, height: at }) {
  if (typeof recipient !== "string" || !ADDRESS.test(recipient) || recipient === sender) {
    fail("recipient is invalid");
  }
  const name = state.owners.get(sender);
  if (name === undefined) fail("transfer has no name");
  if (state.owners.has(recipient)) fail("recipient already has a name");
  state.owners.delete(sender);
  state.owners.set(recipient, name);
  state.names.set(name, { height: height(at, "transfer height"), owner: recipient });
}

// Called after a block's transactions: unused commits expire.
export function endNameRegistryBlock(state, { height: at }, params = NAMES_V1) {
  for (const [commitment, commit] of state.commits) {
    if (at > commit.height + params.commitLifetimeBlocks) state.commits.delete(commitment);
  }
}

export function lookupName(state, name) {
  const entry = state?.names.get(name);
  return entry ? { name, owner: entry.owner, height: entry.height } : null;
}

export function nameOfAddress(state, address) {
  return state?.owners.get(address) ?? null;
}

// Rebuilds the state from a consensus snapshot (maps as sorted [key, value]
// lists). Rejects anything the state machine itself could not have produced.
export function parseNameRegistrySnapshot(value, params = NAMES_V1) {
  const object = (v, keys, label) => {
    if (!v || typeof v !== "object" || Array.isArray(v) ||
        Object.keys(v).sort().join("\0") !== [...keys].sort().join("\0")) {
      fail(`snapshot ${label} is malformed`);
    }
    return v;
  };
  const entries = (v, label, max) => {
    if (!Array.isArray(v) || v.length > max) fail(`snapshot ${label} is malformed`);
    return v.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) fail(`snapshot ${label} is malformed`);
      return entry;
    });
  };
  const address = (v, label) => {
    if (typeof v !== "string" || !ADDRESS.test(v)) fail(`snapshot ${label} is invalid`);
    return v;
  };
  object(value, ["commits", "names", "owners"], "name registry");
  const names = new Map(entries(value.names, "names", params.maxNames).map(([name, entry]) => {
    object(entry, ["height", "owner"], "name");
    if (nameProblem(name, params) !== null) fail("snapshot name is invalid");
    return [name, { height: height(entry.height, "snapshot name height"), owner: address(entry.owner, "name owner") }];
  }));
  const owners = new Map(entries(value.owners, "owners", params.maxNames).map(([owner, name]) =>
    [address(owner, "owner"), name]));
  if (owners.size !== names.size ||
      [...owners].some(([owner, name]) => names.get(name)?.owner !== owner)) {
    fail("snapshot owners do not match names");
  }
  const commits = new Map(entries(value.commits, "commits", params.maxPendingCommits).map(([commitment, commit]) => {
    object(commit, ["height", "sender"], "commit");
    if (typeof commitment !== "string" || !HEX64.test(commitment)) fail("snapshot commitment is invalid");
    return [commitment, { height: height(commit.height, "snapshot commit height"),
      sender: address(commit.sender, "commit sender") }];
  }));
  return { names, owners, commits };
}
