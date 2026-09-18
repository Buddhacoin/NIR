"""Global memory of already demonstrated AI capabilities."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Mapping

from .consensus_codec import consensus_hash
from .model import BPS, ProtocolError


MAX_CAPABILITIES = 256
MIN_FRONTIER_GAIN_BPS = 100
MAX_PARENT_REGRESSION_BPS = 500
CAPABILITY_ID = re.compile(r"^[a-z][a-z0-9._-]{0,110}-v[1-9][0-9]{0,8}$")


def _require_digest(value: str, field: str, *, prefixed: bool = False) -> None:
    digest = value
    if prefixed:
        prefix, separator, digest = value.partition(":")
        if prefix != "sha256" or separator != ":":
            raise ProtocolError(f"{field} must use the sha256 prefix")
    if len(digest) != 64:
        raise ProtocolError(f"{field} must contain a 256-bit digest")
    try:
        int(digest, 16)
    except ValueError as error:
        raise ProtocolError(f"{field} contains non-hexadecimal data") from error


def _validated_scores(scores: Mapping[str, int]) -> dict[str, int]:
    if not scores or len(scores) > MAX_CAPABILITIES:
        raise ProtocolError("capability count is outside protocol limits")
    normalized: dict[str, int] = {}
    for capability, score in scores.items():
        if (
            not CAPABILITY_ID.fullmatch(capability)
            or capability in normalized
        ):
            raise ProtocolError("capability identifier is invalid or duplicated")
        if (
            not isinstance(score, int)
            or isinstance(score, bool)
            or not 0 <= score <= BPS
        ):
            raise ProtocolError("capability score must be an integer from 0 to 10000")
        normalized[capability] = score
    return dict(sorted(normalized.items()))


@dataclass(frozen=True, slots=True)
class CapabilitySnapshot:
    artifact_hash: str
    content_hash: str
    parents: tuple[str, ...]
    committed_epoch: int
    challenge_epoch: int
    challenge_seed: str
    behavior_commitment: str
    scores_bps: Mapping[str, int]

    def validate(self) -> dict[str, int]:
        _require_digest(self.artifact_hash, "artifact hash", prefixed=True)
        _require_digest(self.content_hash, "canonical content", prefixed=True)
        _require_digest(self.challenge_seed, "challenge seed")
        _require_digest(self.behavior_commitment, "behavior commitment")
        if (
            not isinstance(self.committed_epoch, int)
            or isinstance(self.committed_epoch, bool)
            or not isinstance(self.challenge_epoch, int)
            or isinstance(self.challenge_epoch, bool)
            or self.committed_epoch < 0
            or self.challenge_epoch <= self.committed_epoch
        ):
            raise ProtocolError("challenge must be created after artifact commitment")
        if (
            not self.parents
            or len(self.parents) > 32
            or tuple(sorted(set(self.parents))) != self.parents
        ):
            raise ProtocolError("1 to 32 sorted unique parent artifacts are required")
        for parent in self.parents:
            _require_digest(parent, "parent artifact hash", prefixed=True)
        return _validated_scores(self.scores_bps)


@dataclass(frozen=True, slots=True)
class NoveltyReport:
    frontier_root_before: str
    frontier_root_after: str
    previous_frontier_bps: Mapping[str, int]
    marginal_gains_bps: Mapping[str, int]
    novelty_bps: int


class CapabilityMemory:
    """Tracks model lineage and rewards only gains over the world frontier."""

    def __init__(self) -> None:
        self._records: dict[str, dict[str, int]] = {}
        self._behaviors: set[str] = set()
        self._contents: set[str] = set()
        self._sealed = False

    @property
    def frontier(self) -> dict[str, int]:
        frontier: dict[str, int] = {}
        for scores in self._records.values():
            for capability, score in scores.items():
                frontier[capability] = max(frontier.get(capability, 0), score)
        return dict(sorted(frontier.items()))

    @property
    def state_root(self) -> str:
        return self._root(self._records, self._behaviors, self._contents)

    @staticmethod
    def _root(
        records: Mapping[str, Mapping[str, int]],
        behaviors: set[str],
        contents: set[str],
    ) -> str:
        records = {
            artifact: dict(sorted(scores.items()))
            for artifact, scores in sorted(records.items())
        }
        return consensus_hash(
            "CAPABILITY_MEMORY",
            {"behaviors": sorted(behaviors), "contents": sorted(contents), "records": records},
        )

    def seed_reference(
        self,
        *,
        artifact_hash: str,
        content_hash: str | None = None,
        behavior_commitment: str,
        scores_bps: Mapping[str, int],
    ) -> None:
        if self._sealed:
            raise ProtocolError("world capability snapshot is already sealed")
        _require_digest(artifact_hash, "artifact hash", prefixed=True)
        content_hash = content_hash or artifact_hash
        _require_digest(content_hash, "canonical content", prefixed=True)
        _require_digest(behavior_commitment, "behavior commitment")
        if artifact_hash in self._records:
            raise ProtocolError("reference artifact is duplicated")
        if behavior_commitment in self._behaviors:
            raise ProtocolError("reference behavior is duplicated")
        if content_hash in self._contents:
            raise ProtocolError("reference canonical content is duplicated")
        scores = _validated_scores(scores_bps)
        self._records[artifact_hash] = scores
        self._behaviors.add(behavior_commitment)
        self._contents.add(content_hash)

    def seal_world_snapshot(self) -> str:
        if not self._records:
            raise ProtocolError("at least one reference model is required")
        self._sealed = True
        return self.state_root

    def assess(self, snapshot: CapabilitySnapshot) -> NoveltyReport:
        if not self._sealed:
            raise ProtocolError("world capability snapshot is not sealed")
        scores = snapshot.validate()
        if snapshot.artifact_hash in self._records:
            raise ProtocolError("artifact is already known")
        if snapshot.content_hash in self._contents:
            raise ProtocolError("canonical content is already known")
        if snapshot.behavior_commitment in self._behaviors:
            raise ProtocolError("behavior is already known")
        unknown_parents = set(snapshot.parents) - self._records.keys()
        if unknown_parents:
            raise ProtocolError("model lineage contains an unknown parent")

        parent_frontier: dict[str, int] = {}
        for parent in snapshot.parents:
            for capability, score in self._records[parent].items():
                parent_frontier[capability] = max(
                    parent_frontier.get(capability, 0), score
                )
        missing = set(parent_frontier) - scores.keys()
        if missing:
            raise ProtocolError("candidate omitted a capability measured in its parent")
        for capability, parent_score in parent_frontier.items():
            if scores[capability] < parent_score - MAX_PARENT_REGRESSION_BPS:
                raise ProtocolError("candidate regresses too far from its parent")

        before = self.frontier
        gains = {
            capability: score - before.get(capability, 0)
            for capability, score in scores.items()
            if score - before.get(capability, 0) >= MIN_FRONTIER_GAIN_BPS
        }
        if not gains:
            raise ProtocolError("candidate adds no new world-frontier capability")
        denominator = max(1, sum(scores.values()))
        novelty = max(1, min(BPS, sum(gains.values()) * BPS // denominator))

        projected = dict(before)
        for capability, score in scores.items():
            projected[capability] = max(projected.get(capability, 0), score)
        projected_records = dict(self._records)
        projected_records[snapshot.artifact_hash] = scores
        after = self._root(
            projected_records,
            self._behaviors | {snapshot.behavior_commitment},
            self._contents | {snapshot.content_hash},
        )
        return NoveltyReport(
            frontier_root_before=self.state_root,
            frontier_root_after=after,
            previous_frontier_bps=before,
            marginal_gains_bps=dict(sorted(gains.items())),
            novelty_bps=novelty,
        )

    def accept(self, snapshot: CapabilitySnapshot) -> NoveltyReport:
        report = self.assess(snapshot)
        self._records[snapshot.artifact_hash] = _validated_scores(snapshot.scores_bps)
        self._behaviors.add(snapshot.behavior_commitment)
        self._contents.add(snapshot.content_hash)
        return report
