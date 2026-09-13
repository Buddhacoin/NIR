import unittest

from nir.model import (
    ATOMIC_UNITS,
    INITIAL_EPOCH_REWARD,
    MAX_SUPPLY,
    EmissionLedger,
    ProgressProof,
    ProtocolError,
)


def valid_proof(contributor: str = "lab-a", artifact: str = "candidate-a", **changes):
    values = dict(
        contributor=contributor,
        artifact_hash=artifact,
        baseline_hash="baseline-a",
        evaluation_family="reasoning-v1",
        gain_ppm=10_000,
        generality_bps=9_000,
        reproducibility_bps=9_000,
        safety_bps=9_000,
        novelty_bps=9_000,
        candidate_energy_wh=1_000,
        baseline_energy_wh=1_000,
    )
    values.update(changes)
    return ProgressProof(**values)


class ProgressProofTests(unittest.TestCase):
    def test_efficiency_rewards_more_progress_per_energy(self):
        efficient = valid_proof(candidate_energy_wh=500)
        expensive = valid_proof(artifact="candidate-b", candidate_energy_wh=2_000)
        self.assertGreater(efficient.score(), expensive.score())

    def test_unsafe_proof_is_rejected(self):
        with self.assertRaises(ProtocolError):
            valid_proof(safety_bps=7_999).score()

    def test_non_positive_gain_is_rejected(self):
        with self.assertRaises(ProtocolError):
            valid_proof(gain_ppm=0).score()


class EmissionTests(unittest.TestCase):
    def test_epoch_distributes_exact_budget(self):
        ledger = EmissionLedger()
        rewards = ledger.settle_epoch(
            0,
            [valid_proof(), valid_proof("lab-b", "candidate-b")],
        )
        self.assertEqual(sum(rewards.values()), INITIAL_EPOCH_REWARD)

    def test_one_contributor_can_receive_multiple_proof_allocations(self):
        ledger = EmissionLedger()
        rewards = ledger.settle_epoch(
            0,
            [valid_proof(), valid_proof("lab-a", "candidate-b")],
        )
        self.assertEqual(rewards["lab-a"], INITIAL_EPOCH_REWARD)

    def test_duplicate_cannot_be_rewarded_twice(self):
        ledger = EmissionLedger()
        proof = valid_proof()
        ledger.settle_epoch(0, [proof])
        with self.assertRaises(ProtocolError):
            ledger.settle_epoch(1, [proof])

    def test_halving(self):
        self.assertEqual(
            EmissionLedger.scheduled_epoch_budget(210_000),
            INITIAL_EPOCH_REWARD // 2,
        )

    def test_hard_cap_wins(self):
        ledger = EmissionLedger()
        ledger.mined = ledger.mining_remaining - 7
        rewards = ledger.settle_epoch(0, [valid_proof()])
        self.assertEqual(sum(rewards.values()), 7)
        self.assertEqual(ledger.issued, MAX_SUPPLY)
        self.assertEqual(ledger.mining_remaining, 0)

    def test_precision(self):
        self.assertEqual(ATOMIC_UNITS, 100_000_000)


if __name__ == "__main__":
    unittest.main()
