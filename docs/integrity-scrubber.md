# Online integrity scrubber

The integrity scrubber searches a live NIR node for silent storage corruption
without loading the complete data directory into memory or taking the writer
offline for the normal scan. It advances a small deterministic cursor through
checkpoints, block journals, state snapshots, account-history journals and the
serving database.

Detection and repair are deliberately separate. A scan never rewrites node
data. Local repair copies only from an already verified redundant copy. When no
such copy exists, recovery requires a complete independently attested remote
generation and a short exclusive maintenance window.

## Configuration

```json
{
  "format": "nir-integrity-scrubber-config-v1",
  "operatorId": "scrubber-a",
  "nodeDirectory": "/srv/nir/node",
  "stateDirectory": "/srv/nir/integrity-state",
  "genesisPath": "/srv/nir/node/genesis.json",
  "handoffsPath": null,
  "trustedOperatorsPath": "/etc/nir/trusted-backup-operators.json",
  "sources": [
    "https://backup-a.example",
    "https://backup-b.example"
  ],
  "intervalMs": 3600000,
  "jitterMs": 300000,
  "maxBytesPerStep": 67108864,
  "maxFilesPerStep": 64,
  "maxReplayBytes": 4294967296,
  "maxReceiptAgeMs": 2592000000,
  "maxQuarantines": 2
}
```

The configuration rejects unknown fields, URL credentials and fields that can
contain passwords, private keys, recovery phrases or bearer credentials. The
scrubber never opens a wallet or signer vault.

`maxBytesPerStep` is both a memory and ordinary scan-I/O ceiling. It cannot be
below 64 MiB because one bounded step must safely parse the largest supported
checkpoint and journal records. Files are opened with no-follow semantics,
checked before and after reading, and processed sequentially, keeping file
descriptor use constant. `maxReplayBytes` separately caps the periodic
read-only consensus replay and database integrity check. Exceeding either hard
budget is reported as an issue rather than silently skipping validation.

## Commands

Validate configuration and show the next phase without writing a cursor:

```bash
npm run integrity:dry-run -- /etc/nir/integrity-scrubber.json
```

Perform one bounded step:

```bash
npm run integrity:step -- /etc/nir/integrity-scrubber.json
```

Run scheduled steps with deterministic per-operator jitter:

```bash
npm run integrity:daemon -- /etc/nir/integrity-scrubber.json
```

The schedule derives jitter from the public operator identifier and slot. A
restart therefore cannot repeatedly postpone the same deadline. The daemon
will not repeat a slot already recorded in the cursor.

Query JSON health and metrics:

```bash
npm run integrity:health -- /etc/nir/integrity-scrubber.json
```

Exit code `0` means the last sweep completed without issues. Exit code `2`
means the JSON status is valid but unhealthy. Invalid configuration, cursor
conflicts or storage errors exit with `1`.

Health includes the bound checkpoint, phase, sweep number, files and bytes
examined, recent bounded issue details and reasons such as `never-started`,
`sweep-incomplete`, `step-stale`, `sweep-stale`, `clock-anomaly` or
`integrity-issues`.

## Cursor and restart safety

`SCRUB-CURSOR.json` and its redundant copy contain the checkpoint hash, exact
phase and position, account-history chain hash, counters and bounded issues.
Each cursor has a domain-separated checksum and is replaced atomically. A
single missing or corrupt cursor copy is rebuilt from the other only while the
exclusive scrubber lock is held. Two valid but different cursors fail closed.

The cursor is bound to the block-store checkpoint. If the live writer advances
the checkpoint during a long sweep, the next step starts a new sweep rather
than mixing generations. Immutable files already examined are never assumed to
belong to the new checkpoint.

The scrubber lock prevents two scanners or repairs from changing cursor state
simultaneously. A stale lock is reclaimed only when its record is valid and the
recorded process no longer exists. A malformed lock requires investigation.

## What is checked

- Both block-store checkpoints must validate and agree on the selected
  checkpoint generation.
- Every retained block copy is hashed against the digest committed by that
  checkpoint.
- Redundant snapshot bytes are compared; the read-only replay validates the
  selected snapshot and the complete retained journal.
- Every account-history record is self-authenticated, linked to the preceding
  index hash and, where retained, bound to the corresponding block hash.
- The serving database is opened read-only and subjected to a bounded quick
  integrity check.
- The final phase performs consensus replay with repair disabled. Read-only
  verification never regenerates a checkpoint or replaces a damaged copy.

The scan records one of three relevant outcomes: a locally repairable redundant
copy, a rebuildable serving cache, or a complete remote generation requirement.
It never guesses which of two conflicting but unproven values is correct.

## Local repair

Stop the node writer briefly, then run:

```bash
npm run integrity:repair-local -- /etc/nir/integrity-scrubber.json
```

The command acquires both the scrubber lock and the normal node writer lock. If
the node is still running, it fails without changing data. Immediately before
each replacement it reopens the source without following links and verifies
the exact hash recorded by the scan. The target is written, fsynced and renamed
atomically, then read back and hashed. Symbolic-link substitution, source
changes and disk errors fail closed. The only copy is never deleted or
rewritten.

After successful local repairs the cursor is cleared so the next scan verifies
the generation from its checkpoint again.

## Remote generation repair

Use this only when health reports that local redundancy is insufficient:

```bash
npm run integrity:repair-remote -- /etc/nir/integrity-scrubber.json
```

Before acquiring the node writer lock, the command requires fresh matching
receipts from at least two configured independent operators, downloads an
isolated generation, verifies its complete inventory and performs full
checkpoint/state replay. It refuses a generation below the latest locally
verified height or a conflicting generation at the same height.

The verified generation is copied to a sibling staging directory on the same
filesystem. Only then does the command acquire the writer lock. Top-level data
components are moved into a protected quarantine and replaced by atomic
renames. `SCRUB-INSTALLING.json` is checksum-bound to the inventory and records
each completed component. Normal node startup refuses to proceed while this
marker exists.

If power is lost between renames, rerunning the same command obtains the same
independently verified inventory and resumes the recorded component sequence.
The former generation remains quarantined. Retention keeps a bounded number of
quarantines and always protects the generation replaced by the latest repair.

Do not manually remove an installation marker or mix staging generations. If
the agreed remote generation is no longer available, preserve the live,
staging and quarantine directories for analysis rather than forcing startup.

## Operational limits

Online scanning substantially reduces planned downtime, but repair still
requires exclusive ownership of the node directory. Schedule local or remote
activation during a maintenance window. Keep remote operators on genuinely
independent failure domains, monitor scrubber exit codes, test disk-full alarms,
and periodically inspect quarantined generations before retention removes an
older verified replacement.
