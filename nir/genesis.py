"""Command-line interface for the NIR Genesis evaluator."""

from __future__ import annotations

import argparse
import json

from .evaluator import BenchmarkSuite, RunRecord, evaluate_progress
from .model import ATOMIC_UNITS, EmissionLedger, ProtocolError


def _load_runs(paths: list[str]) -> list[RunRecord]:
    return [RunRecord.load(path) for path in paths]


def _evaluate(args: argparse.Namespace) -> dict:
    suite = BenchmarkSuite.load(args.suite)
    suite.verify_commitment(args.salt, args.commitment)
    baseline_runs = _load_runs(args.baseline)
    candidate_runs = _load_runs(args.candidate)
    report, baseline_hash, candidate_hash = evaluate_progress(
        suite, baseline_runs, candidate_runs
    )
    proof = report.to_proof(
        contributor=args.contributor,
        artifact_hash=candidate_hash,
        baseline_hash=baseline_hash,
    )
    rewards = EmissionLedger().settle_epoch(args.epoch, [proof])
    result = report.as_dict()
    result.update(
        {
            "proof_fingerprint": proof.fingerprint,
            "proof_score": proof.score(),
            "test_reward_nir": rewards[args.contributor] / ATOMIC_UNITS,
            "warning": (
                "Energy is not hardware-attested; reward is simulation-only."
                if not report.energy_attested
                else None
            ),
        }
    )
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="NIR Genesis Evaluator v0.1")
    commands = parser.add_subparsers(dest="command", required=True)

    commit = commands.add_parser("commit", help="commit to an unrevealed suite")
    commit.add_argument("suite")
    commit.add_argument("--salt", required=True)

    evaluate = commands.add_parser("evaluate", help="reveal and evaluate runs")
    evaluate.add_argument("suite")
    evaluate.add_argument("--salt", required=True)
    evaluate.add_argument("--commitment", required=True)
    evaluate.add_argument("--baseline", nargs="+", required=True)
    evaluate.add_argument("--candidate", nargs="+", required=True)
    evaluate.add_argument("--contributor", default="genesis-lab")
    evaluate.add_argument("--epoch", type=int, default=0)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "commit":
            print(BenchmarkSuite.load(args.suite).commitment(args.salt))
        else:
            print(json.dumps(_evaluate(args), indent=2, sort_keys=True))
    except (OSError, json.JSONDecodeError, ProtocolError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()

