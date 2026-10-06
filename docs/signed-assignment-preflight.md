# Experimental signed assignment preflight

`python3 -m nir.assignment_gate` is an operator-side fail-closed verifier. It
reads an untrusted completed execution package, verifies its assignment,
execution bundle and the complete evaluator receipt set, and records the receipt
replay keys in a local durable store. It never starts an AI application and does not
accept a wallet seed, private key, API token, model credential, or adapter argv.

This is experimental local verification, not public mining. A passing result
does not award NIR. The verifier now requires an exact v27/v28 assignment
chain proof before it verifies receipts or consumes replay state. The operator
must obtain and pin chain trust inputs independently of the submitted package.

## 1. Bootstrap or inspect the local replay checkpoint

```sh
python3 -m nir.assignment_gate checkpoint \
  --replay-store /absolute/operator/path/replay \
  --json
```

The command may initialize an empty replay store. Its output is not evidence
against a rollback that happened before inspection. Pin the returned
`replayCheckpoint` in a trusted location outside the replay directory.

## 2. Prepare the two inputs

The untrusted package has exactly these top-level fields:

```json
{
  "assignment": {},
  "bundle": {},
  "chainProof": {},
  "format": "nir-signed-assignment-package-v2-experimental",
  "receipts": []
}
```

The objects use the exact schemas emitted by `FinalizedEvaluationAssignmentV2`,
`AssignmentChainProofV3` or `AssignmentChainProofV4`, `EvaluationBundle`, and
`SignedExecutionTranscript`. A package must contain a non-empty complete receipt
set. Legacy v1 packages and non-exact assignment proofs are rejected.

Keep operator trust inputs in a separate policy file:

```json
{
  "expectedAdapterProtocol": "nir-application-adapter-v1",
  "expectedGenesisHash": "<64 lowercase hex>",
  "expectedNetworkId": "<network id>",
  "expectedSafetyPolicyHash": "<64 lowercase hex>",
  "format": "nir-assignment-verification-policy-v2-experimental",
  "observedHeight": 123,
  "checkpoint": {},
  "trustedValidators": [{}, {}, {}, {}],
  "handoffs": [],
  "replayCheckpoint": {
    "generation": 0,
    "stateHash": "<64 lowercase hex>"
  }
}
```

The empty objects above stand for full canonical validator records. For a v3
proof, `checkpoint` is the independently pinned genesis checkpoint,
`trustedValidators` contains the four or more trusted validator records, and
`handoffs` contains the verified validator-set history. For a v4 proof,
`trustedValidators` must be empty; add `expectedCheckpointPolicyId`,
`minimumCheckpointHeight`, and `minimumCheckpointSequence` to this policy. The
v4 proof carries its signed checkpoint trust package, which is checked against
these external pins and floors. Never copy a private key, seed, password, API
token, or application credential into either document.

## 3. Verify and consume the completed package

```sh
python3 -m nir.assignment_gate verify \
  --package /absolute/operator/path/signed-package.json \
  --policy /absolute/operator/path/operator-policy.json \
  --replay-store /absolute/operator/path/replay \
  --json
```

Input files are bounded, read without following symlinks, and must be regular
single-link files. Duplicate JSON fields, non-finite numbers, unknown schema
fields, an expired or foreign assignment, an untrusted protocol/policy,
incomplete receipts, invalid signatures, a missing/foreign/non-exact chain proof,
a stale replay checkpoint, or a replay
all fail closed. Failures are machine-readable and do not echo input, paths, or
subprocess diagnostics.

On success, `packageVerified` and `chainInclusionVerified` are `true`;
`adapterLaunchAuthorized` and
`chainMutation` remain `false`, and the local replay store advances once for the
entire receipt set.
Persist the returned `replayCheckpoint` through the same external trusted
channel before using it as the policy checkpoint for another package. This
local mechanism is not distributed exactly-once and cannot detect coordinated
rollback of every local copy without that external checkpoint.

This command consumes a package produced after execution, so it must never be
used as authorization to launch a model. Exact chain inclusion does not by
itself attest that the model physically ran or that energy was measured.
