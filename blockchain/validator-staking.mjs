import { hashObject } from "./crypto.mjs";

export const MIN_VALIDATOR_BOND = 1_000_000_000n;
export const NON_REVEAL_SLASH_BPS = 100n;

export class ValidatorStakeBook {
  #stakes = new Map();
  #evidence = new Set();
  #burned = 0n;

  register(address, amount) {
    const bond = BigInt(amount);
    if (!/^nir1[0-9a-f]{64}$/.test(address ?? "") || bond < MIN_VALIDATOR_BOND || this.#stakes.has(address)) {
      throw new Error("validator bond is invalid, insufficient, or duplicated");
    }
    this.#stakes.set(address, bond);
    return bond;
  }

  balance(address) { return this.#stakes.get(address) ?? 0n; }
  get burned() { return this.#burned; }
  eligible(address) { return this.balance(address) >= MIN_VALIDATOR_BOND; }

  slashNonReveal({ address, candidateId, committedHeight, detectedHeight }) {
    if (!/^nir1[0-9a-f]{64}$/.test(address ?? "") || !/^[0-9a-f]{64}$/.test(candidateId ?? "") ||
        !Number.isSafeInteger(committedHeight) || !Number.isSafeInteger(detectedHeight) ||
        detectedHeight < committedHeight + 3) {
      throw new Error("non-reveal penalty is invalid");
    }
    const evidenceHash = hashObject(
      { address, candidateId, committedHeight, detectedHeight },
      "RANDOMNESS_NON_REVEAL_EVIDENCE",
    );
    if (this.#evidence.has(evidenceHash)) throw new Error("non-reveal evidence was already used");
    if (!this.eligible(address)) throw new Error("non-reveal penalty is invalid");
    const current = this.balance(address);
    const proportional = (current * NON_REVEAL_SLASH_BPS) / 10_000n;
    const penalty = proportional > 0n ? proportional : 1n;
    this.#stakes.set(address, current - penalty);
    this.#burned += penalty;
    this.#evidence.add(evidenceHash);
    return { address, burned: penalty, evidenceHash, remaining: current - penalty };
  }
}
