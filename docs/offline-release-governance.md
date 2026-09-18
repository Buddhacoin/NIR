# Offline threshold release governance

This module adds a local, offline-verifiable governance layer over deterministic
release bundles. It is not a network transparency service and does not make a
release safe or NIR production-ready. Operators must exchange the initial anchor
and later checkpoints through independent channels.

## Trust and formats

The trust anchor is `nir-release-transparency-anchor-v1`. It commits to a
network, log identifier, and generation-one `nir-release-authority-set-v1`.
Every authority has a unique operator ID, ML-DSA-65 public key, and derived NIR
address. A set declares an M-of-N threshold and a rotation delay of at least two
entries. Distinct keys operated on one host do not constitute operationally
independent authorities; the format can enforce unique identities, not human or
organizational independence.

Each canonical `nir-release-transparency-entry-v1` has a monotonically
increasing sequence, previous-entry hash, active-set ID, proposal hash, and
threshold approvals. A release entry binds the complete bundle and manifest
hashes, network, version, protocol, source revision, and previous bundle hash.
Files are named by sequence and entry hash. Gaps, duplicate sequences, alternate
heads, unknown fields, noncanonical JSON, links, unsafe permissions, mutation,
and rollback behind a persisted checkpoint fail closed.

An authority change is authorized by the current threshold and independently
accepted by the next-set threshold over the exact proposal and activation
sequence. The new set must retain threshold overlap and cannot activate earlier
than the configured delay. At the first activation-boundary entry, both the new
active threshold and the previous threshold must approve that exact entry. Thus
new keys cannot self-authorize a set, unavailable keys cannot be silently
scheduled, and a wholly new subgroup cannot alone produce the activation entry.
Revocation uses the same delayed joint transition and must actually remove an
authority.

`nir-release-transparency-checkpoint-v1` is an append-only local anchor for every
accepted head. Copy the newest checkpoint (sequence and entry hash at minimum)
to separately administered, write-once or otherwise durable storage. Verification
detects a local log that is behind or diverges from any retained checkpoint.

## CLI workflow

All JSON is canonical and outputs are exclusive-create. Passwords are read only
from an interactive terminal. Start with `npm run release:governance --` and one
of these commands:

```text
set <config.json> <new-set.json>
anchor <set.json> <network> <log-id> <new-anchor.json>
propose-release <anchor> <log-dir> <checkpoint-dir> <bundle> <new-proposal>
propose-change <anchor> <log-dir> <checkpoint-dir> <next-set> <rotation|revocation> <new-proposal>
approve <anchor> <log-dir> <checkpoint-dir> <proposal> <operator-id> <vault> <new-approval>
accept-change <anchor> <log-dir> <checkpoint-dir> <proposal> <operator-id> <vault> <new-acceptance>
approve-activation <anchor> <log-dir> <checkpoint-dir> <proposal> <operator-id> <vault> <new-approval>
append <anchor> <log-dir> <checkpoint-dir> <proposal> <approval-groups.json>
recover-checkpoint <anchor> <log-dir> <checkpoint-dir>
verify <anchor> <log-dir> <checkpoint-dir> <expected-sequence> <expected-entry-hash>
```

The append input has the exact shape below. Unused groups are empty arrays.

```json
{"activation":[],"active":[],"nextSetAcceptance":[]}
```

For an authority-change entry, `active` contains the old-set scheduling quorum
and `nextSetAcceptance` contains the next-set acceptance quorum. For the first
entry at activation, `active` contains the new-set quorum and `activation`
contains the old-set joint quorum. Other release entries use only `active`.

If a process stops after the log entry is fsynced but before its checkpoint is
written, run `recover-checkpoint`. It validates the complete log against all
existing checkpoints and creates only the missing current checkpoint; repeating
it is idempotent and does not require or append another release entry.

## Residual risks

- A colluding threshold can authorize malicious releases or key changes.
- This is local consistency, not globally witnessed transparency. Two operators
  detect a split only by comparing independently persisted anchors/checkpoints;
  there is no gossip, witness cosigning, or network availability promise.
- Deleting every external checkpoint together with local history defeats local
  rollback detection. Store anchors outside the log host.
- Delayed joint activation reduces key-loss risk but can halt rotation if either
  required quorum becomes unavailable. Recovery is deliberately not unilateral.
- ML-DSA software vaults do not provide hardware isolation, and signatures prove
  key control rather than source review or binary reproducibility.
- Node's path APIs cannot make same-user denial of service impossible. The
  implementation uses no-follow opens, unique regular files, exclusive creation,
  descriptor/inode checks, fsync, and post-write revalidation to fail closed on
  detected filesystem races.
