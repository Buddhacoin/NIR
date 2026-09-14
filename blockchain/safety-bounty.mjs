import { signObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;

export const SAFETY_BOUNTY_REPORTER_BPS = 7_000n;
export const SAFETY_BOUNTY_EVALUATOR_BPS = 1_000n;
export const SAFETY_BOUNTY_BURN_BPS = 2_000n;

function atomic(value, field) {
  if (typeof value !== "string" || value.length > 32 || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} must be a positive atomic-unit string`);
  }
  return BigInt(value);
}

export function safetyFailurePayload({ networkId, epoch, candidateId, evidenceHash, reporter, safetyPolicyHash }) {
  if (
    typeof networkId !== "string" || networkId.length < 1 ||
    !Number.isSafeInteger(epoch) || epoch < 1 || !HASH.test(candidateId ?? "") ||
    !HASH.test(evidenceHash ?? "") || !ADDRESS.test(reporter ?? "") ||
    !HASH.test(safetyPolicyHash ?? "")
  ) throw new Error("safety failure receipt payload is invalid");
  return { candidateId, epoch, evidenceHash, networkId, reporter, safetyPolicyHash };
}

export function createSafetyFailureClaim({ networkId, epoch, candidateId, evidenceHash, reporter, safetyPolicyHash, evaluatorWallets }) {
  const payload = safetyFailurePayload({ networkId, epoch, candidateId, evidenceHash, reporter, safetyPolicyHash });
  if (!Array.isArray(evaluatorWallets)) throw new Error("safety evaluator wallets are required");
  return {
    ...payload,
    attestations: evaluatorWallets.map((wallet) => ({
      evaluator: wallet.address,
      signature: signObject(payload, wallet, "SAFETY_FAILURE_RECEIPT"),
    })),
  };
}

export function calculateSafetySettlement({ candidateId, evidenceHash, reporter, evaluatorAddresses, candidate }) {
  if (!candidate || !HASH.test(candidateId ?? "") || !HASH.test(evidenceHash ?? "")) {
    throw new Error("candidate or safety evidence is invalid");
  }
  if (!ADDRESS.test(reporter ?? "") || reporter === candidate.submitter) {
    throw new Error("submitter cannot claim its own safety bounty");
  }
  if (
    !Array.isArray(evaluatorAddresses) || evaluatorAddresses.length < 3 ||
    evaluatorAddresses.some((address) => !ADDRESS.test(address)) ||
    new Set(evaluatorAddresses).size !== evaluatorAddresses.length ||
    evaluatorAddresses.includes(candidate.submitter) || evaluatorAddresses.includes(reporter)
  ) throw new Error("independent safety evaluator set is invalid");
  const bond = typeof candidate.bond === "bigint" ? candidate.bond : atomic(candidate.bond, "candidate bond");
  const reporterReward = (bond * SAFETY_BOUNTY_REPORTER_BPS) / 10_000n;
  const evaluatorPool = (bond * SAFETY_BOUNTY_EVALUATOR_BPS) / 10_000n;
  const eachEvaluator = evaluatorPool / BigInt(evaluatorAddresses.length);
  const evaluatorRewards = [...evaluatorAddresses].sort().map((recipient) => ({
    amount: eachEvaluator.toString(), recipient,
  }));
  const paidEvaluators = eachEvaluator * BigInt(evaluatorAddresses.length);
  const burned = bond - reporterReward - paidEvaluators;
  if (burned * 10_000n < bond * SAFETY_BOUNTY_BURN_BPS) {
    throw new Error("safety penalty burn invariant failed");
  }
  return {
    burned: burned.toString(), candidateId, evaluatorRewards, evidenceHash,
    progressReward: "0",
    reporterReward: { amount: reporterReward.toString(), recipient: reporter },
    slashed: bond.toString(),
  };
}

export class SafetyBountyBook {
  #candidates = new Map();
  #evidence = new Set();

  lockCandidate({ candidateId, submitter, bond }) {
    if (!HASH.test(candidateId ?? "") || !ADDRESS.test(submitter ?? "") || this.#candidates.has(candidateId)) {
      throw new Error("candidate bond identity is invalid or duplicated");
    }
    this.#candidates.set(candidateId, {
      bond: atomic(bond, "candidate bond"),
      settled: false,
      submitter,
    });
  }

  settleCriticalFailure({ candidateId, evidenceHash, reporter, evaluatorAddresses }) {
    const candidate = this.#candidates.get(candidateId);
    if (!candidate || candidate.settled || !HASH.test(evidenceHash ?? "") || this.#evidence.has(evidenceHash)) {
      throw new Error("candidate or safety evidence is invalid, settled, or duplicated");
    }
    const settlement = calculateSafetySettlement({
      candidate, candidateId, evidenceHash, evaluatorAddresses, reporter,
    });
    candidate.settled = true;
    this.#evidence.add(evidenceHash);
    return settlement;
  }
}
