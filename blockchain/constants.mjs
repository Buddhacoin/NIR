export const ATOMIC_UNITS = 100_000_000n;
export const MAX_SUPPLY = 21_000_000n * ATOMIC_UNITS;
export const TREASURY_BPS = 1_200n;
export const TREASURY_ALLOCATION = (MAX_SUPPLY * TREASURY_BPS) / 10_000n;
export const MINING_POOL = MAX_SUPPLY - TREASURY_ALLOCATION;
export const INITIAL_EPOCH_REWARD = 50n * ATOMIC_UNITS;
export const HALVING_INTERVAL = 210_000;
export const SIGNATURE_ALGORITHM = "ml-dsa-65";
export const MULTISIG_ALGORITHM = "ml-dsa-65-multisig";
export const MAX_MULTISIG_MEMBERS = 16;
export const PROTOCOL_VERSION = 24;
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([24, 25, 26, 27]);
export const RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION = 25;
export const EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION = 26;
export const EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION = 27;
export const EVALUATION_ASSIGNMENT_LIFETIME_BLOCKS = 256;
export const MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS = 16;
export const SAFETY_POLICY_V1_COMMITMENT =
  "a6907d20040ce104af6f866ec84464e2dd0f2de1d34f53b6c6b2c5ab73d91cff";
export const MAX_TRANSACTIONS_PER_BLOCK = 1_000;
export const MAX_PROGRESS_REWARDS_PER_BLOCK = 256;
export const MAX_PROGRESS_FRAUD_PROOFS_PER_BLOCK = 64;
export const PROGRESS_REWARD_ESCROW_DELAY_BLOCKS = 64;
export const MAX_SAFETY_SETTLEMENTS_PER_BLOCK = 256;
export const MAX_VALIDATORS = 256;
export const MAX_CONSENSUS_ROUND = 31;
export const MAX_BLOCK_BYTES = 2_000_000;
export const MAX_FUTURE_DRIFT_MS = 120_000;
export const EPOCH_REVEAL_TIMEOUT_BLOCKS = 8;
export const MIN_BEACON_BOND = 1_000n * ATOMIC_UNITS;
export const MIN_EVALUATOR_BOND = INITIAL_EPOCH_REWARD;
export const EVALUATOR_ACTIVATION_DELAY_BLOCKS = 64;
export const EVALUATOR_CREDENTIAL_LIFETIME_BLOCKS = 1_024;
export const BEACON_NON_REVEAL_SLASH_BPS = 100n;
export const TRANSFER_CREDIT_EPOCH_BLOCKS = 720;
export const TRANSFER_CREDIT_STAKE_UNIT = 100n * ATOMIC_UNITS;
export const TRANSFER_CREDITS_PER_STAKE_UNIT = 10;
export const MAX_CREDIT_TRANSFERS_PER_BLOCK = 100;
export const MAX_CREDIT_DELEGATIONS_PER_OWNER = 256;
export const CREDIT_UNSTAKE_DELAY_BLOCKS = 64;
export const MAX_NATIVE_ASSETS = 4_096;
export const MAX_NATIVE_ASSET_BALANCES = 65_536;
export const MIN_REWARD_INTERVAL_MS = 600_000;
export const MIN_TRANSFER_FEE = 1_000n;
export const MIN_PROGRESS_CANDIDATE_BOND = 1n * ATOMIC_UNITS;
export const MAX_DECIMAL_DIGITS = 32;
export const TREASURY_VESTING_MS = 315_576_000_000;

export function vestedTreasuryAtTimestamp(genesisTimestamp, timestamp) {
  if (
    !Number.isSafeInteger(genesisTimestamp) ||
    !Number.isSafeInteger(timestamp) ||
    genesisTimestamp < 0 ||
    timestamp < genesisTimestamp
  ) {
    throw new Error("treasury vesting timestamps are invalid");
  }
  const elapsed = timestamp - genesisTimestamp;
  if (elapsed >= TREASURY_VESTING_MS) return TREASURY_ALLOCATION;
  return (
    TREASURY_ALLOCATION * BigInt(elapsed)
  ) / BigInt(TREASURY_VESTING_MS);
}

export function scheduledEpochBudget(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("epoch must be a non-negative safe integer");
  }
  const halvings = Math.floor(epoch / HALVING_INTERVAL);
  return halvings >= 64 ? 0n : INITIAL_EPOCH_REWARD >> BigInt(halvings);
}
