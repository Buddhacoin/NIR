import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { SafetyBountyBook } from "../blockchain/safety-bounty.mjs";

const fingerprint = (label) => createHash("sha256").update(label).digest("hex");

test("a critical failure pays only from the candidate bond and burns at least twenty percent", () => {
  const submitter = generateWallet();
  const reporter = generateWallet();
  const evaluators = Array.from({ length: 3 }, generateWallet);
  const book = new SafetyBountyBook();
  const candidateId = fingerprint("unsafe-candidate");
  book.lockCandidate({ candidateId, submitter: submitter.address, bond: "1000000" });
  const settlement = book.settleCriticalFailure({
    candidateId,
    evidenceHash: fingerprint("critical-evidence"),
    reporter: reporter.address,
    evaluatorAddresses: evaluators.map(({ address }) => address),
  });
  assert.equal(settlement.progressReward, "0");
  assert.equal(settlement.reporterReward.amount, "700000");
  assert.equal(settlement.evaluatorRewards.reduce((sum, reward) => sum + BigInt(reward.amount), 0n), 99999n);
  assert.equal(settlement.burned, "200001");
  assert.equal(
    BigInt(settlement.reporterReward.amount) +
      settlement.evaluatorRewards.reduce((sum, reward) => sum + BigInt(reward.amount), 0n) +
      BigInt(settlement.burned),
    BigInt(settlement.slashed),
  );
});

test("the submitter cannot collect its own bounty and evidence cannot be paid twice", () => {
  const submitter = generateWallet();
  const reporter = generateWallet();
  const evaluators = Array.from({ length: 3 }, generateWallet);
  const book = new SafetyBountyBook();
  const candidateId = fingerprint("candidate");
  const evidenceHash = fingerprint("evidence");
  book.lockCandidate({ candidateId, submitter: submitter.address, bond: "1000000" });
  assert.throws(() => book.settleCriticalFailure({
    candidateId, evidenceHash, reporter: submitter.address,
    evaluatorAddresses: evaluators.map(({ address }) => address),
  }), /own safety bounty/);
  book.settleCriticalFailure({
    candidateId, evidenceHash, reporter: reporter.address,
    evaluatorAddresses: evaluators.map(({ address }) => address),
  });
  assert.throws(() => book.settleCriticalFailure({
    candidateId, evidenceHash, reporter: reporter.address,
    evaluatorAddresses: evaluators.map(({ address }) => address),
  }), /settled, or duplicated/);
});

test("a Sybil coalition cannot recover the burned share of its own candidate bond", () => {
  const coalition = Array.from({ length: 5 }, generateWallet);
  const book = new SafetyBountyBook();
  const candidateId = fingerprint("coalition-candidate");
  book.lockCandidate({ candidateId, submitter: coalition[0].address, bond: "1000000" });
  const settlement = book.settleCriticalFailure({
    candidateId,
    evidenceHash: fingerprint("coalition-evidence"),
    reporter: coalition[1].address,
    evaluatorAddresses: coalition.slice(2).map(({ address }) => address),
  });
  const coalitionRecovery = BigInt(settlement.reporterReward.amount) +
    settlement.evaluatorRewards.reduce((sum, reward) => sum + BigInt(reward.amount), 0n);
  assert.ok(coalitionRecovery <= 800000n);
  assert.ok(BigInt(settlement.burned) >= 200000n);
});
