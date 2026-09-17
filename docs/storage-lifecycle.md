# Block and snapshot storage lifecycle

NIR keeps two synchronized block-journal copies and two independently readable
copies of the latest quorum-authenticated state snapshot. A snapshot changes the
replay base only after its network, validator quorum, checkpoint, state root and
complete state have been verified. Pruning never changes consensus state.

## Operator procedure

All maintenance commands take the node data-directory writer lock. Stop the node
before maintenance; if another live process owns the directory, the command
fails before moving data.

Install a verified snapshot, inspect the non-mutating plan, stage old journals,
restart-verify, and only then finalize:

```bash
npm run node:snapshot-install -- /absolute/node /absolute/snapshot.json
npm run node:prune-plan -- /absolute/node
npm run node:prune-stage -- /absolute/node
npm run node:prune-verify -- /absolute/node
npm run node:prune-finalize -- /absolute/node
```

`prune-plan` reports the authenticated snapshot base and current tip, unique
prunable block count, exact bytes in both journal copies, retained-tail bytes,
snapshot bytes, projected live bytes, policy limits, eligibility and rejection
reasons. It does not move journal files or create a quarantine. The projected
number covers block journals plus snapshot copies, not account history,
checkpoints, logs or operating-system allocation overhead.

The default policy requires at least one prunable block and one byte. It rejects
a plan whose post-snapshot tail exceeds either 100,000 blocks or 64 GiB. Such a
rejection means the installed snapshot is too old; the operator must install a
newer independently authenticated snapshot rather than delete an unrepresented
part of the journal. Library users may provide stricter non-negative integer
maximum limits and positive minimum limits through `pruningPolicy`.

## Crash and corruption behavior

Staging writes and synchronizes a manifest before moving any journal. Manifest
version 2 commits to the sorted, duplicate-free file set, byte length and SHA-256
digest of every redundant block copy. Re-running verification completes
interrupted moves and rejects missing, substituted, symbolic-link or conflicting
files.

Verification then starts from the installed state snapshot, replays the retained
tail through ordinary consensus validation and records the exact resulting
block-store checkpoint plus the manifest hash. Finalization refuses a stale
verification if another block was persisted after verification.

Before deletion, finalization verifies every quarantined digest and durably
writes `PRUNE-FINALIZING.json`. Files are removed individually. If power is lost
after only some removals, the marker authenticates the same manifest and
checkpoint, missing already-deleted files are tolerated, remaining files are
rechecked, and finalization resumes. The quarantine directory is removed only
after all listed files have been processed and its directories synchronized.

At every point before finalization, both old journal copies remain in the
quarantine. After finalization, two verified snapshot copies represent the
pruned state and both retained journal copies represent the tail. Account-history
journals remain separate and are verified before the operator CLI stages block
pruning.

## Reproducible benchmark

Run:

```bash
npm run benchmark:storage-lifecycle -- --blocks 100 --snapshot-height 80
```

The benchmark creates a private temporary chain, persists redundant journals,
captures and installs a signed snapshot, runs plan/stage/verify/finalize, restarts
from disk, checks the original finalized tip and removes the temporary directory.

Reference environment on 2026-09-17: Apple M1, 8 GiB RAM, macOS 26.5.2,
Node.js 26.0.0.

| Measurement | 100 blocks, snapshot at 80 |
| --- | ---: |
| Build and redundant persistence | 12.70 s |
| Bytes before maintenance | 5,756,936 |
| Exact prunable bytes | 4,571,804 |
| Projected journal + snapshot bytes | 1,275,862 |
| Bytes after maintenance | 1,284,930 |
| Snapshot installation | 697.91 ms |
| Dry-run planning | 755.43 ms |
| Staging | 908.76 ms |
| Restart verification | 510.06 ms |
| Finalization | 991.27 ms |
| Final restart and replay | 904.73 ms |

The measured directory shrank by about 77.7%. Planning is intentionally not a
constant-time estimate: it first verifies the current block store and hashes
every proposed file so the byte report is also the future deletion commitment.

## Remaining work

- million-block measurements on production filesystems;
- forced power loss at every filesystem synchronization boundary;
- remote backup receipts and automated restore drills before local retention is
  reduced;
- monitoring and alerts before a tail approaches either configured maximum;
- lifecycle rules for multiple historical snapshots once retaining more than
  the current verified pair is implemented.
