import json
from pathlib import Path
import unittest

from nir.consensus_codec import (
    ConsensusEncodingError,
    consensus_envelope_bytes,
    consensus_hash,
    consensus_value_bytes,
)


VECTORS = json.loads(
    (Path(__file__).parent / "vectors" / "consensus-codec-v1.json").read_text(
        encoding="utf-8"
    )
)


class ConsensusCodecTests(unittest.TestCase):
    def test_language_neutral_vectors(self) -> None:
        self.assertEqual(VECTORS["format"], "nir-consensus-codec-vectors-v1")
        for vector in VECTORS["vectors"]:
            with self.subTest(vector=vector["name"]):
                self.assertEqual(
                    consensus_value_bytes(vector["value"]).hex(), vector["valueHex"]
                )
                self.assertEqual(
                    consensus_envelope_bytes(vector["domain"], vector["value"]).hex(),
                    vector["envelopeHex"],
                )
                self.assertEqual(
                    consensus_hash(vector["domain"], vector["value"]), vector["hash"]
                )

    def test_invalid_python_values_fail_closed(self) -> None:
        cyclic: list[object] = []
        cyclic.append(cyclic)
        for value in (
            1.0,
            9_007_199_254_740_992,
            -9_007_199_254_740_992,
            (1, 2),
            {1: "not a string key"},
            {"e\u0301": 1},
            "\ud800",
            cyclic,
        ):
            with self.subTest(value=type(value).__name__):
                with self.assertRaises(ConsensusEncodingError):
                    consensus_value_bytes(value)
        with self.assertRaises(ConsensusEncodingError):
            consensus_value_bytes([None] * 100_001)


if __name__ == "__main__":
    unittest.main()
