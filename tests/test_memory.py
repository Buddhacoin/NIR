import unittest
from hashlib import sha256

from nir.memory import CapabilityMemory, CapabilitySnapshot
from nir.model import ProtocolError


def digest(label: str, *, prefixed: bool = False) -> str:
    value = sha256(label.encode()).hexdigest()
    return f"sha256:{value}" if prefixed else value


def snapshot(
    artifact: str,
    parent: str,
    behavior: str,
    scores: dict[str, int],
) -> CapabilitySnapshot:
    return CapabilitySnapshot(
        artifact_hash=digest(artifact, prefixed=True),
        content_hash=digest(artifact, prefixed=True),
        parents=(digest(parent, prefixed=True),),
        committed_epoch=10,
        challenge_epoch=11,
        challenge_seed=digest("unpredictable-epoch-seed"),
        behavior_commitment=digest(behavior),
        scores_bps=scores,
    )


def memory() -> CapabilityMemory:
    result = CapabilityMemory()
    result.seed_reference(
        artifact_hash=digest("known-model-a", prefixed=True),
        behavior_commitment=digest("known-behavior-a"),
        scores_bps={"code-v1": 7_000, "reasoning-v1": 8_000},
    )
    result.seed_reference(
        artifact_hash=digest("known-model-b", prefixed=True),
        behavior_commitment=digest("known-behavior-b"),
        scores_bps={"code-v1": 8_000, "reasoning-v1": 7_500},
    )
    result.seal_world_snapshot()
    return result


class CapabilityMemoryTests(unittest.TestCase):
    def test_known_performance_cannot_earn_against_a_weak_parent(self):
        registry = memory()
        candidate = snapshot(
            "repackaged-known-model",
            "known-model-a",
            "new-container-same-capability",
            {"code-v1": 8_000, "reasoning-v1": 8_000},
        )
        with self.assertRaises(ProtocolError):
            registry.accept(candidate)

    def test_identical_behavior_is_rejected_even_if_artifact_hash_changes(self):
        registry = memory()
        candidate = snapshot(
            "renamed-model",
            "known-model-a",
            "known-behavior-a",
            {"code-v1": 8_500, "reasoning-v1": 8_000},
        )
        with self.assertRaises(ProtocolError):
            registry.accept(candidate)

    def test_repackaged_artifact_cannot_reuse_canonical_content(self):
        registry = memory()
        first = snapshot(
            "first-wrapper",
            "known-model-a",
            "first-transcript",
            {"code-v1": 8_400, "reasoning-v1": 8_200},
        )
        registry.accept(first)
        repackaged = CapabilitySnapshot(
            artifact_hash=digest("second-wrapper", prefixed=True),
            content_hash=first.content_hash,
            parents=(digest("known-model-a", prefixed=True),),
            committed_epoch=12,
            challenge_epoch=13,
            challenge_seed=digest("later-challenge"),
            behavior_commitment=digest("second-transcript"),
            scores_bps={"code-v1": 8_600, "reasoning-v1": 8_400},
        )
        with self.assertRaisesRegex(ProtocolError, "canonical content"):
            registry.accept(repackaged)

    def test_new_frontier_delta_is_recorded_once(self):
        registry = memory()
        before = registry.state_root
        candidate = snapshot(
            "new-model",
            "known-model-a",
            "new-behavior",
            {"code-v1": 8_400, "reasoning-v1": 8_200},
        )
        report = registry.accept(candidate)
        self.assertEqual(report.frontier_root_before, before)
        self.assertEqual(
            report.marginal_gains_bps,
            {"code-v1": 400, "reasoning-v1": 200},
        )
        self.assertNotEqual(registry.state_root, before)
        self.assertEqual(registry.state_root, report.frontier_root_after)
        with self.assertRaises(ProtocolError):
            registry.accept(candidate)

    def test_challenge_must_be_created_after_model_commitment(self):
        registry = memory()
        candidate = snapshot(
            "new-model",
            "known-model-a",
            "new-behavior",
            {"code-v1": 8_400, "reasoning-v1": 8_200},
        )
        stale = CapabilitySnapshot(
            artifact_hash=candidate.artifact_hash,
            content_hash=candidate.content_hash,
            parents=candidate.parents,
            committed_epoch=11,
            challenge_epoch=11,
            challenge_seed=candidate.challenge_seed,
            behavior_commitment=candidate.behavior_commitment,
            scores_bps=candidate.scores_bps,
        )
        with self.assertRaises(ProtocolError):
            registry.accept(stale)

    def test_unknown_parent_and_hidden_regression_are_rejected(self):
        registry = memory()
        unknown_parent = snapshot(
            "new-model",
            "missing-model",
            "new-behavior",
            {"code-v1": 8_400, "reasoning-v1": 8_200},
        )
        with self.assertRaises(ProtocolError):
            registry.accept(unknown_parent)

        omitted_skill = snapshot(
            "new-model",
            "known-model-a",
            "other-behavior",
            {"code-v1": 8_400},
        )
        with self.assertRaises(ProtocolError):
            registry.accept(omitted_skill)


if __name__ == "__main__":
    unittest.main()
