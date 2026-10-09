"""Local NIR adapter for a real, tiny trained classifier (not a reward-eligible miner).

The baseline learns class centroids from sepal measurements. The candidate is
a 3-NN classifier using all four measurements on the same Iris rows. Every
fifth row is held out by the
test harness. This example is deliberately dependency-free and not sandboxed.
"""

from collections import Counter
import csv
from hashlib import sha256
import json
from math import isfinite
from pathlib import Path
import sys


DATA_SHA256 = "596ffd580471ca4d4880f8e439c7281f3b50d8249a5960353cb200b1490f63a0"
LABELS = {"Iris-setosa", "Iris-versicolor", "Iris-virginica"}


def load_training_rows(path: Path) -> list[tuple[tuple[float, ...], str]]:
    contents = path.read_bytes()
    if sha256(contents).hexdigest() != DATA_SHA256:
        raise ValueError("Iris dataset digest does not match the pinned example")
    rows = []
    for index, record in enumerate(csv.reader(contents.decode("ascii").splitlines())):
        if len(record) != 5 or record[4] not in LABELS:
            raise ValueError("Iris row is invalid")
        features = tuple(float(value) for value in record[:4])
        if not all(isfinite(value) for value in features):
            raise ValueError("Iris feature is not finite")
        if index % 5 != 0:
            rows.append((features, record[4]))
    if len(rows) != 120:
        raise ValueError("Iris training split is incomplete")
    return rows


def classify(features: tuple[float, ...], training: list, role: str) -> str:
    if role == "baseline":
        labels = sorted({label for _, label in training})
        centroids = {
            label: tuple(
                sum(row[index] for row, row_label in training if row_label == label) /
                sum(row_label == label for _, row_label in training)
                for index in range(2)
            ) for label in labels
        }
        return min(labels, key=lambda label: sum(
            (features[index] - centroids[label][index]) ** 2 for index in range(2)
        ))
    nearest = sorted(training, key=lambda row: (
        sum((left - right) ** 2 for left, right in zip(features, row[0])), row[1],
    ))[:3]
    counts = Counter(label for _, label in nearest)
    return sorted(counts, key=lambda label: (-counts[label], label))[0]


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] not in {"baseline", "candidate"}:
        raise SystemExit("usage: iris_model_adapter.py baseline|candidate DATASET MODEL_IDENTITY")
    role, dataset, identity = sys.argv[1:]
    training = load_training_rows(Path(dataset))
    for line in sys.stdin:
        request = json.loads(line)
        if request["method"] == "describe":
            result = {
                "capabilities": ["text"],
                "determinism": "seeded",
                "maxInputBytes": 1024,
                "modelIdentity": identity,
                "statePolicy": "reset-per-case",
            }
        elif request["method"] == "evaluate":
            params = request["params"]
            value = params["input"]["value"]
            if params["input"]["mediaType"] != "application/json" or not isinstance(value, list) or len(value) != 4:
                raise ValueError("expected exactly four numeric Iris features")
            features = tuple(float(item) for item in value)
            if not all(isfinite(item) for item in features):
                raise ValueError("Iris feature is not finite")
            result = {
                "caseId": params["caseId"],
                "output": {"mediaType": "text/plain", "value": classify(features, training, role)},
                "usage": {"inputTokens": 4, "outputTokens": 1},
            }
        else:
            raise ValueError("unsupported adapter method")
        print(json.dumps({
            "format": "nir-application-adapter-v1",
            "requestId": request["requestId"],
            "result": result,
        }, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
