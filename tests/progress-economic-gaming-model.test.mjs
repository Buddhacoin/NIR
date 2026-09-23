import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { allocateProgressRewards } from "../blockchain/chain.mjs";
import { ATOMIC_UNITS, scheduledEpochBudget } from "../blockchain/constants.mjs";
import { calculateSafetySettlement } from "../blockchain/safety-bounty.mjs";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function address(value) { return `nir1${digest(value)}`; }
function randomSource(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0);
}

function referenceAllocation(epoch, claims) {
  const budget = scheduledEpochBudget(epoch);
  const total = claims.reduce((sum, claim) => sum + BigInt(claim.score), 0n);
  const amounts = claims.map((claim) => (budget * BigInt(claim.score)) / total);
  let remainder = budget - amounts.reduce((sum, amount) => sum + amount, 0n);
  const rank = claims.map((claim, index) => ({ claim, index })).sort((left, right) => {
    const leftScore = BigInt(left.claim.score); const rightScore = BigInt(right.claim.score);
    if (leftScore !== rightScore) return leftScore > rightScore ? -1 : 1;
    return left.claim.fingerprint < right.claim.fingerprint ? -1 : 1;
  });
  for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) {
    amounts[rank[index % rank.length].index] += 1n;
  }
  return claims.map((claim, index) => ({ ...claim, amount: amounts[index].toString() }))
    .sort((left, right) => left.fingerprint < right.fingerprint ? -1 : 1);
}

class ReferenceProgressEconomy {
  constructor(initial) {
    this.initial = initial; this.liquid = initial; this.locked = 0n;
    this.burned = 0n; this.mined = 0n; this.epoch = 0;
    this.candidates = new Map(); this.contents = new Set(); this.lineageDeltas = new Set();
    this.rewarded = new Set();
  }

  bond(candidate) {
    if (this.candidates.has(candidate.id) || candidate.bond <= 0n || candidate.bond > this.liquid) return false;
    this.liquid -= candidate.bond; this.locked += candidate.bond;
    this.candidates.set(candidate.id, { ...candidate, state: "bonded" }); return true;
  }

  admit(id) {
    const candidate = this.candidates.get(id);
    if (!candidate || candidate.state !== "bonded" || candidate.protocolRole ||
        this.contents.has(candidate.content) || this.lineageDeltas.has(candidate.lineageDelta)) return false;
    candidate.state = "admitted"; this.contents.add(candidate.content);
    this.lineageDeltas.add(candidate.lineageDelta); return true;
  }

  refundUnbound(id) {
    const candidate = this.candidates.get(id);
    if (!candidate || candidate.state !== "bonded") return false;
    this.locked -= candidate.bond; this.liquid += candidate.bond; this.candidates.delete(id); return true;
  }

  reward(claims) {
    const fingerprints = new Set(claims.map(({ fingerprint }) => fingerprint));
    if (claims.length === 0 || fingerprints.size !== claims.length ||
        claims.some(({ fingerprint }) => this.rewarded.has(fingerprint))) return false;
    const rewards = referenceAllocation(this.epoch, claims);
    if (rewards.some((reward) => {
      const candidate = this.candidates.get(reward.candidateId);
      return !candidate || candidate.state !== "admitted" || BigInt(reward.amount) > candidate.bond;
    })) return false;
    for (const reward of rewards) {
      const candidate = this.candidates.get(reward.candidateId);
      this.locked -= candidate.bond; this.liquid += candidate.bond + BigInt(reward.amount);
      this.mined += BigInt(reward.amount); this.rewarded.add(reward.fingerprint);
      this.candidates.delete(reward.candidateId);
    }
    this.epoch += 1; return true;
  }

  expire(id) {
    const candidate = this.candidates.get(id);
    if (!candidate || candidate.state !== "admitted") return false;
    this.locked -= candidate.bond; this.burned += candidate.bond; this.candidates.delete(id); return true;
  }

  assertConservation() {
    assert.equal(this.liquid + this.locked + this.burned, this.initial + this.mined);
  }

  restart() {
    const copy = new ReferenceProgressEconomy(this.initial);
    Object.assign(copy, { liquid: this.liquid, locked: this.locked, burned: this.burned,
      mined: this.mined, epoch: this.epoch });
    copy.candidates = new Map([...this.candidates].map(([id, value]) => [id, { ...value }]));
    copy.contents = new Set(this.contents); copy.lineageDeltas = new Set(this.lineageDeltas);
    copy.rewarded = new Set(this.rewarded); return copy;
  }
}

test("256 seeded coalition schedules preserve collateral, replay, uniqueness, and conservation", () => {
  for (let seed = 0; seed < 256; seed += 1) {
    const random = randomSource(seed ^ 0x4e4952);
    let model = new ReferenceProgressEconomy(2_000n * ATOMIC_UNITS);
    const claims = [];
    for (let index = 0; index < 12; index += 1) {
      const candidate = { id: digest(`${seed}:candidate:${index}`),
        bond: BigInt(1 + random() % 50) * ATOMIC_UNITS,
        content: digest(`${seed}:content:${index % 9}`),
        lineageDelta: digest(`${seed}:delta:${index % 10}`),
        protocolRole: index % 11 === 0 };
      assert.equal(model.bond(candidate), true);
      if (model.admit(candidate.id)) claims.push({ candidateId: candidate.id,
        fingerprint: digest(`${seed}:claim:${index}`), recipient: address(`${seed}:owner:${index % 3}`),
        score: String(1 + random() % 1_000_000) });
      else assert.equal(model.refundUnbound(candidate.id), true);
      model.assertConservation();
    }
    const production = allocateProgressRewards(model.epoch, claims);
    assert.deepEqual(production, referenceAllocation(model.epoch, claims));
    const expectedAccept = production.every((reward) =>
      BigInt(reward.amount) <= model.candidates.get(reward.candidateId).bond);
    assert.equal(model.reward(claims), expectedAccept);
    model.assertConservation();
    const beforeReplay = { liquid: model.liquid, locked: model.locked, mined: model.mined };
    if (expectedAccept) assert.equal(model.reward(claims), false, "reward replay crossed an epoch boundary");
    assert.deepEqual({ liquid: model.liquid, locked: model.locked, mined: model.mined }, beforeReplay);
    for (const id of [...model.candidates.keys()]) model.expire(id);
    model.assertConservation();
    model = model.restart(); model.assertConservation();
  }
});

test("self-funded vulnerable-candidate bounty remains a loss even under address collusion", () => {
  for (let index = 1; index <= 128; index += 1) {
    const bond = BigInt(index) * 10_003n;
    const evaluators = Array.from({ length: 3 + (index % 7) }, (_, evaluator) =>
      address(`coalition-evaluator:${index}:${evaluator}`));
    const settlement = calculateSafetySettlement({ candidateId: digest(`candidate:${index}`),
      evidenceHash: digest(`evidence:${index}`), reporter: address(`reporter:${index}`),
      evaluatorAddresses: evaluators,
      candidate: { bond, submitter: address(`submitter:${index}`) } });
    const recovered = BigInt(settlement.reporterReward.amount) + settlement.evaluatorRewards
      .reduce((sum, reward) => sum + BigInt(reward.amount), 0n);
    assert.equal(recovered + BigInt(settlement.burned), bond);
    assert.ok(BigInt(settlement.burned) * 10_000n >= bond * 2_000n);
    assert.ok(recovered < bond, "a same-operator address coalition profited from its own bond");
    assert.equal(settlement.progressReward, "0");
  }
});
