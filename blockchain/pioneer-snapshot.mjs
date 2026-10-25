// Signed snapshots of pioneer points (docs/pioneer-program.md). Before a test
// network is reset, and at the cut-off before the main network's genesis, the
// node publishes every address's points in one file signed by the network's
// genesis validators. The file carries the genesis it was taken on, so anyone
// can check it offline against NIR's pinned genesis hash, and anyone running a
// node can compare the totals with the ones their own node rebuilt from the
// blocks at the same height.
import { NirChain } from "./chain.mjs";
import { ATOMIC_UNITS } from "./constants.mjs";
import { addressFromPublicKey, signObject, verifyObject } from "./crypto.mjs";

export const PIONEER_SNAPSHOT_FORMAT = "nir-pioneer-snapshot-v1";
export const PIONEER_SNAPSHOT_DOMAIN = "PIONEER_SNAPSHOT_V1";
export const PIONEER_POOL_NIR = "210000";
export const MAX_PIONEER_SNAPSHOT_BYTES = 16 * 1024 * 1024;

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,31})$/;
const PAYLOAD_KEYS = ["excluded", "format", "genesis", "genesisHash", "height", "networkId",
  "pioneers", "poolNir", "tipHash", "tipTimestamp", "totalPoints"];
const SNAPSHOT_KEYS = [...PAYLOAD_KEYS, "signatures"];

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`pioneer snapshot ${label} has unknown or missing fields`);
  }
}

function payloadOf(snapshot) {
  return Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, snapshot[key]]));
}

// `totals` are [address, atomic points] pairs from the node's index, the
// operator's own keys already left out; `excluded` lists those keys.
export function createPioneerSnapshot({ excluded, genesis, height, networkId, tipHash, tipTimestamp,
  totals, validatorWallets }) {
  const pioneers = totals.map(([address, points]) => ({ address, points: String(points) }))
    .filter((entry) => BigInt(entry.points) > 0n)
    .sort((left, right) => left.address.localeCompare(right.address));
  const payload = {
    excluded: [...new Set(excluded)].sort(), format: PIONEER_SNAPSHOT_FORMAT, genesis: structuredClone(genesis),
    genesisHash: new NirChain(genesis).tipHash, height, networkId, pioneers, poolNir: PIONEER_POOL_NIR,
    tipHash, tipTimestamp,
    totalPoints: pioneers.reduce((sum, entry) => sum + BigInt(entry.points), 0n).toString(),
  };
  const signatures = [...validatorWallets].sort((left, right) => left.address.localeCompare(right.address))
    .map((wallet) => ({ address: wallet.address, publicKey: wallet.publicKey,
      signature: signObject(payload, wallet, PIONEER_SNAPSHOT_DOMAIN) }));
  return { ...payload, signatures };
}

// Throws unless the snapshot is well formed, taken on the genesis whose hash
// is `genesisHash` (when given), and signed by more than two thirds of that
// genesis's validators. Returns the checked snapshot's summary.
export function verifyPioneerSnapshot(snapshot, { genesisHash = null } = {}) {
  exactKeys(snapshot, SNAPSHOT_KEYS, "envelope");
  if (snapshot.format !== PIONEER_SNAPSHOT_FORMAT) throw new Error("pioneer snapshot format is unsupported");
  if (snapshot.poolNir !== PIONEER_POOL_NIR) throw new Error("pioneer snapshot pool is invalid");
  let chain;
  try { chain = new NirChain(snapshot.genesis); }
  catch { throw new Error("pioneer snapshot genesis is invalid"); }
  if (chain.tipHash !== snapshot.genesisHash || chain.networkId !== snapshot.networkId) {
    throw new Error("pioneer snapshot genesis does not match its hash or network");
  }
  if (genesisHash !== null && snapshot.genesisHash !== genesisHash) {
    throw new Error("pioneer snapshot was taken on a different network");
  }
  if (!Number.isSafeInteger(snapshot.height) || snapshot.height < 0 || !HASH.test(snapshot.tipHash ?? "") ||
      !Number.isSafeInteger(snapshot.tipTimestamp) || snapshot.tipTimestamp < 0) {
    throw new Error("pioneer snapshot tip is invalid");
  }
  if (!Array.isArray(snapshot.excluded) || snapshot.excluded.some((address, index) =>
    !ADDRESS.test(address ?? "") || (index > 0 && snapshot.excluded[index - 1] >= address))) {
    throw new Error("pioneer snapshot exclusions are invalid");
  }
  const excluded = new Set(snapshot.excluded);
  if (!Array.isArray(snapshot.pioneers)) throw new Error("pioneer snapshot entries are invalid");
  let total = 0n;
  snapshot.pioneers.forEach((entry, index) => {
    exactKeys(entry, ["address", "points"], "entry");
    if (!ADDRESS.test(entry.address ?? "") || !ATOMIC.test(entry.points ?? "") || BigInt(entry.points) === 0n ||
        excluded.has(entry.address) || (index > 0 && snapshot.pioneers[index - 1].address >= entry.address)) {
      throw new Error("pioneer snapshot entries are invalid");
    }
    total += BigInt(entry.points);
  });
  if (!ATOMIC.test(snapshot.totalPoints ?? "") || BigInt(snapshot.totalPoints) !== total) {
    throw new Error("pioneer snapshot total does not add up");
  }
  const validators = new Map(snapshot.genesis.validators.map((member) => [member.address, member.publicKey]));
  if (!Array.isArray(snapshot.signatures)) throw new Error("pioneer snapshot signatures are invalid");
  const payload = payloadOf(snapshot);
  const signers = new Set();
  for (const entry of snapshot.signatures) {
    exactKeys(entry, ["address", "publicKey", "signature"], "signature");
    if (signers.has(entry.address) || validators.get(entry.address) !== entry.publicKey ||
        addressFromPublicKey(entry.publicKey) !== entry.address) {
      throw new Error("pioneer snapshot is signed by a key that is not a genesis validator");
    }
    if (typeof entry.signature !== "string" ||
        !verifyObject(payload, entry.signature, entry.publicKey, PIONEER_SNAPSHOT_DOMAIN)) {
      throw new Error("pioneer snapshot signature does not match its contents");
    }
    signers.add(entry.address);
  }
  if (signers.size < Math.floor((validators.size * 2) / 3) + 1) {
    throw new Error("pioneer snapshot lacks a quorum of genesis validator signatures");
  }
  return { genesisHash: snapshot.genesisHash, height: snapshot.height, networkId: snapshot.networkId,
    pioneers: snapshot.pioneers.length, signers: signers.size, totalPoints: snapshot.totalPoints };
}

// What each address would receive from the pool if this snapshot were the
// last: 210,000 NIR × its points ÷ all points, rounded down to an atomic unit.
// The atomic units rounding leaves over are reported, not handed out.
export function pioneerAllocation(snapshot) {
  const pool = BigInt(PIONEER_POOL_NIR) * ATOMIC_UNITS;
  const total = BigInt(snapshot.totalPoints);
  const entries = snapshot.pioneers.map(({ address, points }) => ({ address, points,
    amount: total === 0n ? "0" : (pool * BigInt(points) / total).toString() }));
  const paid = entries.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  return { entries, pool: pool.toString(), unallocated: (total === 0n ? pool : pool - paid).toString() };
}
