"""The standalone evaluator must not present simulated rewards as spendable NIR."""

from argparse import Namespace
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from nir.genesis import SIMULATION_WARNING, _evaluate


class GenesisCliWarningTests(unittest.TestCase):
    def test_self_attested_energy_does_not_remove_simulation_warning(self):
        args = Namespace(
            suite="suite.json", salt="salt", commitment="commitment",
            baseline=["baseline.json"], candidate=["candidate.json"],
            contributor="tester", epoch=0, candidate_id="candidate",
            bundle_hash="0" * 64,
        )
        suite = SimpleNamespace(verify_commitment=lambda *_: None)

        for claimed_attestation in (False, True):
            with self.subTest(claimed_attestation=claimed_attestation):
                report = SimpleNamespace(
                    energy_attested=claimed_attestation,
                    to_proof=lambda **_: SimpleNamespace(
                        fingerprint="fingerprint", score=lambda: 1,
                    ),
                    as_dict=lambda: {"energy_attested": claimed_attestation},
                    as_chain_evaluation=lambda **_: {},
                )
                with (
                    patch("nir.genesis.BenchmarkSuite.load", return_value=suite),
                    patch("nir.genesis._load_runs", return_value=[]),
                    patch("nir.genesis.evaluate_progress", return_value=(report, "1" * 64, "2" * 64)),
                    patch("nir.genesis.EmissionLedger") as ledger,
                ):
                    ledger.return_value.settle_epoch.return_value = {"tester": 0}
                    result = _evaluate(args)
                self.assertEqual(result["warning"], SIMULATION_WARNING)
                self.assertIn("local simulation only", result["warning"])


if __name__ == "__main__":
    unittest.main()
