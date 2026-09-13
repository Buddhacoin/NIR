"""Deterministic scoring and emission rules for the NIR prototype."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256


ATOMIC_UNITS = 100_000_000
MAX_SUPPLY = 21_000_000 * ATOMIC_UNITS
TREASURY_BPS = 1_200
TREASURY_ALLOCATION = MAX_SUPPLY * TREASURY_BPS // 10_000
MINING_POOL = MAX_SUPPLY - TREASURY_ALLOCATION
INITIAL_EPOCH_REWARD = 50 * ATOMIC_UNITS
HALVING_INTERVAL = 210_000
BPS = 10_000


class ProtocolError(ValueError):
    """Raised when a proof or state transition violates protocol rules."""


@dataclass(frozen=True, slots=True)
class ProgressProof:
    contributor: str
    artifact_hash: str
    baseline_hash: str
    evaluation_family: str
    gain_ppm: int
    generality_bps: int
    reproducibility_bps: int
    safety_bps: int
    novelty_bps: int
    candidate_energy_wh: int
    baseline_energy_wh: int

    def validate(self) -> None:
        if not self.contributor.strip():
            raise ProtocolError("contributor is required")
        if not self.artifact_hash.strip() or not self.baseline_hash.strip():
            raise ProtocolError("artifact and baseline hashes are required")
        if self.artifact_hash == self.baseline_hash:
            raise ProtocolError("candidate must differ from baseline")
        if not self.evaluation_family.strip():
            raise ProtocolError("evaluation family is required")
        if self.gain_ppm <= 0:
            raise ProtocolError("verified gain must be positive")
        for name in (
            "generality_bps",
            "reproducibility_bps",
            "safety_bps",
            "novelty_bps",
        ):
            value = getattr(self, name)
            if not 0 <= value <= BPS:
                raise ProtocolError(f"{name} must be between 0 and {BPS}")
        if self.safety_bps < 8_000:
            raise ProtocolError("proof fails the draft safety floor")
        if self.reproducibility_bps < 6_667:
            raise ProtocolError("proof lacks independent reproducibility")
        if self.candidate_energy_wh <= 0 or self.baseline_energy_wh <= 0:
            raise ProtocolError("energy values must be positive")

    @property
    def fingerprint(self) -> str:
        payload = "|".join(
            (self.artifact_hash, self.baseline_hash, self.evaluation_family)
        )
        return sha256(payload.encode("utf-8")).hexdigest()

    def score(self) -> int:
        """Return a deterministic integer score; larger is better."""
        self.validate()
        quality = self.gain_ppm
        for factor in (
            self.generality_bps,
            self.reproducibility_bps,
            self.safety_bps,
            self.novelty_bps,
        ):
            quality = quality * factor // BPS

        # Efficiency is capped to prevent tiny energy estimates dominating and
        # floored so useful but expensive frontier work is not zeroed out.
        efficiency_bps = self.baseline_energy_wh * BPS // self.candidate_energy_wh
        efficiency_bps = min(20_000, max(5_000, efficiency_bps))
        return quality * efficiency_bps // BPS


class EmissionLedger:
    """Minimal capped ledger for settling intelligence-progress epochs."""

    def __init__(self) -> None:
        self.treasury_locked = TREASURY_ALLOCATION
        self.mined = 0
        self._accepted_fingerprints: set[str] = set()

    @property
    def issued(self) -> int:
        return self.treasury_locked + self.mined

    @property
    def mining_remaining(self) -> int:
        return MINING_POOL - self.mined

    @staticmethod
    def scheduled_epoch_budget(epoch: int) -> int:
        if epoch < 0:
            raise ProtocolError("epoch cannot be negative")
        halvings = epoch // HALVING_INTERVAL
        return INITIAL_EPOCH_REWARD >> halvings

    def settle_epoch(
        self, epoch: int, proofs: list[ProgressProof]
    ) -> dict[str, int]:
        if not proofs:
            return {}

        seen_this_epoch: set[str] = set()
        scored: list[tuple[ProgressProof, int]] = []
        for proof in proofs:
            proof.validate()
            fingerprint = proof.fingerprint
            if fingerprint in seen_this_epoch:
                raise ProtocolError("duplicate proof in epoch")
            if fingerprint in self._accepted_fingerprints:
                raise ProtocolError("proof was already rewarded")
            seen_this_epoch.add(fingerprint)
            score = proof.score()
            if score <= 0:
                raise ProtocolError("proof score must be positive")
            scored.append((proof, score))

        budget = min(self.scheduled_epoch_budget(epoch), self.mining_remaining)
        if budget <= 0:
            return {}

        total_score = sum(score for _, score in scored)
        rewards = {
            proof.contributor: budget * score // total_score
            for proof, score in scored
        }

        # Assign indivisible remainder deterministically by score then identity.
        remainder = budget - sum(rewards.values())
        order = sorted(scored, key=lambda item: (-item[1], item[0].contributor))
        for index in range(remainder):
            contributor = order[index % len(order)][0].contributor
            rewards[contributor] += 1

        self.mined += budget
        self._accepted_fingerprints.update(seen_this_epoch)
        if self.issued > MAX_SUPPLY:
            raise AssertionError("hard supply cap violated")
        return rewards

