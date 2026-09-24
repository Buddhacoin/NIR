# Experimental signed assignment preflight

`python3 -m nir.assignment_gate` is an operator-side fail-closed verifier. It
reads an untrusted completed execution package, verifies its assignment,
execution bundle and the complete evaluator receipt set, and records the receipt
replay keys in a local durable store. It never starts an AI application and does not
accept a wallet seed, private key, API token, model credential, or adapter argv.

This is experimental local verification, not public mining. A passing result
does not award NIR and currently does not prove that the exact evaluator
assignment was included in a finalized chain state. The available light-client
anchor can prove the candidate commitment transaction, but the current state
root has no membership proof for the derived assignment/committee.

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
  "format": "nir-signed-assignment-package-v1-experimental",
  "receipts": []
}
```

The objects use the exact schemas emitted by `FinalizedEvaluationAssignment`,
`EvaluationBundle`, and `SignedExecutionTranscript`. A package must contain a
non-empty complete receipt set.

Keep operator trust inputs in a separate policy file:

```json
{
  "expectedAdapterProtocol": "nir-application-adapter-v1",
  "expectedGenesisHash": "<64 lowercase hex>",
  "expectedNetworkId": "<network id>",
  "expectedSafetyPolicyHash": "<64 lowercase hex>",
  "format": "nir-assignment-verification-policy-v1-experimental",
  "observedHeight": 123,
  "replayCheckpoint": {
    "generation": 0,
    "stateHash": "<64 lowercase hex>"
  },
  "trustedAuthorities": {
    "nir1<authority id>": "<ML-DSA public key in canonical base64>"
  }
}
```

Only public verification keys belong here. Never copy a private key, seed,
password, API token, or application credential into either document.

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
incomplete receipts, invalid signatures, a stale replay checkpoint, or a replay
all fail closed. Failures are machine-readable and do not echo input, paths, or
subprocess diagnostics.

On success, `packageVerified` is `true`; `adapterLaunchAuthorized` and
`chainMutation` remain `false`, and the local replay store advances once for the
entire receipt set.
Persist the returned `replayCheckpoint` through the same external trusted
channel before using it as the policy checkpoint for another package. This
local mechanism is not distributed exactly-once and cannot detect coordinated
rollback of every local copy without that external checkpoint.

This command consumes a package produced after execution, so it must never be
used as authorization to launch a model. A separate pre-execution gate will
remain fail-closed until the exact assignment/committee receives a verifiable
membership proof from finalized consensus state.
