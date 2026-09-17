# Automated backup and recovery drills

The backup automation runner creates a new portable local backup, restores an
independently attested remote backup into an isolated workspace, and records the
outcome in a signed hash-linked journal. It does not modify the live node, send
notifications, or require a paid service.

This runner is an operational safety mechanism. A successful record means that
the configured sources could restore their agreed checkpoint at that time. It
does not turn two directories on one machine into independent storage.

## Configuration

Create a private operator directory and a configuration file such as:

```json
{
  "format": "nir-backup-automation-config-v1",
  "operatorId": "backup-monitor-a",
  "liveDirectory": "/srv/nir/node",
  "backupRoot": "/srv/nir/local-backups",
  "drillRoot": "/srv/nir/restore-drills",
  "stateDirectory": "/srv/nir/backup-monitor",
  "genesisPath": "/srv/nir/node/genesis.json",
  "trustedOperatorsPath": "/etc/nir/trusted-backup-operators.json",
  "sources": [
    "https://backup-a.example",
    "https://backup-b.example"
  ],
  "intervalMs": 86400000,
  "jitterMs": 1800000,
  "maxReceiptAgeMs": 2592000000,
  "maxSuccessAgeMs": 172800000,
  "maxBackups": 7,
  "maxDrillWorkspaces": 3,
  "resultSigner": {
    "address": "nir1...",
    "algorithm": "ML-DSA-65",
    "publicKey": "..."
  }
}
```

Only the public result-signing identity belongs in this file. Passwords,
private keys, recovery phrases, bearer credentials and URL credentials are
rejected. The encrypted signer vault is supplied as a separate command-line
path, and its password is requested from an interactive terminal without echo.
The private key remains in memory only while the runner is active.

Run validation without creating directories or touching the journal:

```bash
npm run backup:auto-dry-run -- /etc/nir/backup-automation.json
```

The output includes the deterministic next scheduled time and
`"writesPerformed": false`. Jitter is capped at one quarter of the interval and
is derived from the public operator identity and schedule slot, so restarts do
not keep moving the same deadline.

## Running one cycle or the scheduler

Run one complete cycle:

```bash
npm run backup:auto-run -- \
  /etc/nir/backup-automation.json \
  /secure/backup-monitor.nirvault
```

The command exits with `0` only for a successful backup and restore drill. A
verified operational failure is written to the signed journal and exits with
`2`. Configuration, journal, lock or signer failures exit with `1`.

Start the long-running scheduler:

```bash
npm run backup:auto-daemon -- \
  /etc/nir/backup-automation.json \
  /secure/backup-monitor.nirvault
```

Unlock the vault once at startup. The process then sleeps until each
interval-plus-jitter deadline and runs serially. `SIGINT` or `SIGTERM` stops it
after the active operation returns. Run only one scheduler for a state
directory.

The state lock is a private directory created atomically. A second live process
fails immediately. After an unclean stop, a lock is reclaimed only when its
record is structurally valid and its recorded process no longer exists. A
malformed lock fails closed and requires operator investigation.

## Signed journal and rollback anchor

Each line in `BACKUP-DRILLS.jsonl` is signed under the dedicated
`BACKUP_AUTOMATION_RESULT` domain. A result commits to its sequence, previous
result hash, times, status, network, the local backup height/tip and the remote
drill hashes. Failure
records contain a bounded category such as `stale-receipt`, `restore-incomplete`
or `storage-error`; raw exception text and filesystem paths are not persisted.

Two atomic head files commit to the complete ordered list of result hashes. A
signed pending-append marker is written before the journal append. It commits to
the exact signed result, prior head and prior byte offset. A valid journal that
is one signed record ahead of either head is therefore a recognizable crash
between the journal fsync and head replacement; the next runner repairs only
that authenticated direction. A partial final write can be truncated only to
the authenticated prior offset. A head ahead of the journal, a modified line,
two incompatible heads, an unauthenticated pending marker or an invalid
signature fails closed.

The journal is capped at 100,000 records and 32 MiB. It is never silently
compacted because doing so would erase its append-only evidence. Before that
limit, retain the latest head externally, archive the complete state directory,
and begin a new explicitly provisioned state directory.

Copy the latest `resultHash` and `sequence` to the independent monitoring system
after every successful health check. Supply them back on later checks. This is
the external rollback anchor: an attacker who rolls the entire local disk back
cannot also roll back a value retained elsewhere.

## Health monitoring

Basic check:

```bash
npm run backup:auto-health -- /etc/nir/backup-automation.json
```

Anchored check after an external monitor has retained sequence `42` and its
head hash:

```bash
npm run backup:auto-health -- \
  /etc/nir/backup-automation.json \
  42 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Output is one JSON object. Exit code `0` means `healthy: true`; exit code `2`
means monitoring should alert. Reasons distinguish:

- a failed latest run;
- a missed schedule;
- a stale or absent successful drill;
- a missing confirmed local backup or isolated drill workspace;
- an externally anchored sequence/hash rollback.

Corrupt journals and configuration errors fail with exit code `1` instead of
returning a healthy status.

## Retention and recovery

Local backups and drill workspaces are separate roots. Retention deletes only
recognized directories inside those roots, rejects symbolic links and keeps at
least the newest configured generations. The backup and workspace named by the
latest confirmed success are protected even when they fall outside the normal
age order. `maxBackups` cannot be below two.

A local export first writes to a private `.staging-*` directory and is renamed
only after export completes. A later run holding the exclusive lock removes
abandoned staging directories from a crashed predecessor. Remote restore drills
retain their own inventory-root staging and completion rules.

Do not manually edit the journal or either head. If health reports corruption,
preserve the entire state directory for analysis, compare its last known head
with the externally retained anchor, and initialize a new state directory only
after the discrepancy is understood. Never copy a newer head onto an older
journal.

## Operational boundaries

- Keep the live node, local backup root, drill root and remote sources on the
  failure domains required by the deployment plan.
- Restrict the state directory and encrypted signer vault to the operator
  account.
- Monitor free space before the interval deadline; a storage failure is recorded
  but cannot create a valid backup.
- Periodically restore on hardware equivalent to the intended recovery host.
- Preserve externally anchored head hashes. Hash chaining alone cannot detect a
  coordinated rollback of every file on the same disk.
