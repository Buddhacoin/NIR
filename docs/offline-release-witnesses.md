# Offline release transparency witnesses

This is an offline checkpoint-exchange primitive layered over the release
transparency log. It does not operate a public service, guarantee global
availability, or automatically punish a witness. Its purpose is narrower: an
operator can require M independently administered ML-DSA-65 witness receipts
for one exact checkpoint view and retain signed evidence when a witness reports
two views at the same sequence.

## Trust model and formats

`nir-release-witness-set-v1` declares a configurable M-of-N policy. Every entry
has a unique operator ID, public key, and derived NIR address. The schema cannot
prove that nominally different keys belong to independent organizations; that
separation remains an operational responsibility.

`nir-release-witness-receipt-v1` signs all of:

- transparency anchor hash, network ID, and log ID;
- sequence, entry hash, and checkpoint hash;
- witness-set ID, operator identity, and observation time.

Verification requires one explicit trusted anchor and witness set, an exact
sequence, current time, maximum age, and future-clock-skew allowance. It rejects
unknown fields, invalid signatures, duplicate identities, replay into the local
store, stale or future observations, mixed contexts, and a minority view. A
3-of-4 policy selects a 3/1 view; a 2/2 split does not produce a result.

Two valid receipts from one witness for different hashes at the same sequence
form canonical `nir-release-witness-equivocation-v1` evidence. The proof carries
both original signatures and is independently verifiable. It is forensic input
only: there is no automatic monetary penalty, validator removal, or network
broadcast.

## Bounded local store

The head store is append-only and limited to 4,096 receipt files. It accepts
only canonical private regular files, rejects symlinks, hardlinks, unexpected
filenames, mutation and directory replacement, and uses exclusive creation plus
file and directory fsync. Per-witness sequence rollback is rejected. Exact
receipt replay is rejected. An equivocation is retained, exported as evidence,
and disqualifies that witness from store-based quorum selection.

The store retains history to make restart checks deterministic. It is not a
substitute for copying selected receipts and checkpoints to independent durable
storage.

## CLI

Use `npm run release:witness --` with one command:

```text
set <config.json> <new-set.json>
export <anchor.json> <checkpoint.json> <new-checkpoint.json>
sign <anchor.json> <set.json> <checkpoint.json> <operator-id> <vault> <observedAt-ms> <new-receipt.json>
import <anchor.json> <set.json> <store-dir> <receipt.json> <now-ms> <max-age-ms> <future-skew-ms>
select <anchor.json> <set.json> <store-dir> <sequence> <now-ms> <max-age-ms> <future-skew-ms> <new-selection.json>
evidence <anchor.json> <set.json> <receipt-a.json> <receipt-b.json> <new-evidence.json>
```

Outputs are exclusive-create. Witness vault passwords are accepted only from an
interactive terminal and private keys are cleared after signing. Exported
checkpoint, receipt, evidence, and selection files should be transferred over
independent channels and compared by hash before use.

## Residual risks

- A colluding witness threshold can endorse the same false view.
- Witnesses can be unavailable or censor observations; the verifier fails
  closed and makes no liveness promise.
- Two partitions remain unaware of each other until checkpoint or receipt
  exchange. This module has no gossip, global registry, or public monitor.
- Local clock policy can reject honest delayed receipts or accept them longer
  than desired if configured poorly.
- Evidence proves control of a signing key, not the real-world operator behind
  it. Response and removal remain manual governance decisions.
- Same-user filesystem denial of service remains possible even though detected
  link, identity, mutation, rollback, and replacement races fail closed.
