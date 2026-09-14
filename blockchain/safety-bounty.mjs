const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;

export const SAFETY_BOUNTY_REPORTER_BPS = 7_000n;
export const SAFETY_BOUNTY_EVALUATOR_BPS = 1_000n;
export const SAFETY_BOUNTY_BURN_BPS = 2_000n;

function atomic(value, field) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} must be a positive atomic-unit string`);
  }
  return BigInt(value);
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
    if (!ADDRESS.test(reporter ?? "") || reporter === candidate.submitter) {
      throw new Error("submitter cannot claim its own safety bounty");
    }
    if (
      !Array.isArray(evaluatorAddresses) || evaluatorAddresses.length < 3 ||
      evaluatorAddresses.some((address) => !ADDRESS.test(address)) ||
      new Set(evaluatorAddresses).size !== evaluatorAddresses.length ||
      evaluatorAddresses.includes(candidate.submitter) || evaluatorAddresses.includes(reporter)
    ) throw new Error("independent safety evaluator set is invalid");

    const reporterReward = (candidate.bond * SAFETY_BOUNTY_REPORTER_BPS) / 10_000n;
    const evaluatorPool = (candidate.bond * SAFETY_BOUNTY_EVALUATOR_BPS) / 10_000n;
    const eachEvaluator = evaluatorPool / BigInt(evaluatorAddresses.length);
    const evaluatorRewards = [...evaluatorAddresses].sort().map((recipient) => ({
      amount: eachEvaluator.toString(),
      recipient,
    }));
    const paidEvaluators = eachEvaluator * BigInt(evaluatorAddresses.length);
    const burned = candidate.bond - reporterReward - paidEvaluators;
    if (burned * 10_000n < candidate.bond * SAFETY_BOUNTY_BURN_BPS) {
      throw new Error("safety penalty burn invariant failed");
    }
    candidate.settled = true;
    this.#evidence.add(evidenceHash);
    return {
      burned: burned.toString(),
      candidateId,
      evaluatorRewards,
      evidenceHash,
      progressReward: "0",
      reporterReward: { amount: reporterReward.toString(), recipient: reporter },
      slashed: candidate.bond.toString(),
    };
  }
}
