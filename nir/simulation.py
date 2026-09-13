"""Example NIR intelligence-mining epoch."""

from .model import ATOMIC_UNITS, EmissionLedger, ProgressProof


def proof(
    contributor: str,
    artifact: str,
    gain_ppm: int,
    energy_wh: int,
) -> ProgressProof:
    return ProgressProof(
        contributor=contributor,
        artifact_hash=artifact,
        baseline_hash="baseline-v1",
        evaluation_family="reasoning-v1",
        gain_ppm=gain_ppm,
        generality_bps=9_000,
        reproducibility_bps=9_500,
        safety_bps=9_200,
        novelty_bps=9_000,
        candidate_energy_wh=energy_wh,
        baseline_energy_wh=1_000_000,
    )


def main() -> None:
    ledger = EmissionLedger()
    rewards = ledger.settle_epoch(
        0,
        [
            proof("efficient-lab", "artifact-a", 24_000, 600_000),
            proof("frontier-lab", "artifact-b", 31_000, 1_400_000),
        ],
    )
    for contributor, atomic_reward in sorted(rewards.items()):
        print(f"{contributor}: {atomic_reward / ATOMIC_UNITS:.8f} NIR")
    print(
        "total issued (including locked treasury): "
        f"{ledger.issued / ATOMIC_UNITS:,.8f} NIR"
    )


if __name__ == "__main__":
    main()
