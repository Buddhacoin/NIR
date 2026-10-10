import { FOUNDER_IMMEDIATE_BPS, TESTER_REWARD_RESERVE_BPS } from "./constants.mjs";

// This is a new-deployment gate, not a historical chain verification rule.
export function assertApprovedPublicGenesisRewardPolicy(plan, genesis) {
  if (plan?.format !== "nir-public-genesis-plan-v5" ||
      genesis?.founderImmediateBps !== Number(FOUNDER_IMMEDIATE_BPS) ||
      genesis?.treasuryImmediateBps !== Number(TESTER_REWARD_RESERVE_BPS)) {
    throw new Error("new public validator deployment requires v5 genesis with the 44 NIR reward schedule");
  }
}
