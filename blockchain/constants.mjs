export const ATOMIC_UNITS = 100_000_000n;
export const MAX_SUPPLY = 21_000_000n * ATOMIC_UNITS;
export const TREASURY_BPS = 1_200n;
export const TREASURY_ALLOCATION = (MAX_SUPPLY * TREASURY_BPS) / 10_000n;
export const MINING_POOL = MAX_SUPPLY - TREASURY_ALLOCATION;
export const INITIAL_EPOCH_REWARD = 50n * ATOMIC_UNITS;
export const HALVING_INTERVAL = 210_000;
export const SIGNATURE_ALGORITHM = "ml-dsa-65";
export const PROTOCOL_VERSION = 1;

export function scheduledEpochBudget(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("epoch must be a non-negative safe integer");
  }
  const halvings = Math.floor(epoch / HALVING_INTERVAL);
  return halvings >= 64 ? 0n : INITIAL_EPOCH_REWARD >> BigInt(halvings);
}
