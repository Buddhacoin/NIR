# Remote backup receipts and recovery drills

A backup is useful only if an independent operator can prove what it stores and
another machine can restore it. NIR remote backup receipts bind one portable
public backup to its finalized checkpoint, complete file inventory, state
snapshot and account-history archive without including spending keys.

These artifacts satisfy the machine-verifiable part of gate 10 in the canonical
[public-testnet gate matrix](public-testnet-gates.md). Independent storage,
retention, alerting, and operator response remain manual criteria.

## Receipt contents

`nir-remote-backup-receipt-v1` is signed with ML-DSA-65 under a dedicated
`REMOTE_BACKUP_RECEIPT` domain. Its signed payload commits to:

- network identifier, finalized height, tip and complete state root;
- block-store checkpoint hash;
- optional authenticated state-snapshot hash;
- account-history archive content root and latest index-chain hash;
- the root, exact byte count and file count of a canonical backup inventory;
- independent operator identifier, signing address and canonical source URL;
- creation time and the explicit assertion `privateKeysIncluded: false`.

The inventory contains only the portable public backup allowlist: genesis,
redundant block journals and checkpoints, redundant state snapshots, redundant
account-history journals and their rebuildable database. Unknown top-level
files, private development keys, wallet vaults, symbolic links and special files
are rejected before a receipt is signed or content is served.

Every inventory entry commits to its canonical relative path, byte length and
SHA-256 digest. The inventory root itself uses NIR domain-separated SHA3-256.
The receipt never contains a private key, wallet password or encrypted vault.

## Operator workflow

First create a portable backup using the normal node command. On each independent
storage operator, create a receipt with that operator's separate encrypted vault:

```bash
npm run node:backup -- /absolute/live-node /separate/storage/nir-backup

npm run backup:receipt -- \
  /separate/storage/nir-backup \
  /separate/storage/nir-backup/genesis.json \
  /secure/operator.nirvault \
  backup-operator-a \
  https://backup-a.example \
  /separate/storage/receipt.json
```

Password input requires an interactive terminal and is never accepted as a
command-line argument. Serve the immutable backup and matching receipt behind a
TLS reverse proxy:

```bash
npm run backup:serve -- \
  /separate/storage/nir-backup \
  /separate/storage/receipt.json \
  8791 127.0.0.1
```

The built-in service deliberately binds only to the numeric loopback addresses
`127.0.0.1` and `::1`; resolvable hostnames are not accepted as a bind-address
security boundary. Public TLS, rate limiting and operational access control
belong at the reverse proxy.

Create `trusted-backup-operators.json` containing at least two entries with
distinct `operatorId`, address, algorithm and public key. Then run an isolated
remote drill against at least two HTTPS sources:

```bash
npm run backup:drill-remote -- \
  /separate/drill-workspaces \
  /secure/trusted-backup-operators.json \
  /secure/genesis.json \
  https://backup-a.example \
  https://backup-b.example
```

Loopback HTTP is accepted only for local integration drills. Redirects,
credentials in URLs, URL queries and fragments are rejected.

## Agreement and stale-backup rules

The drill verifies receipts before downloading large files. By default, a
receipt older than 30 days is stale; a timestamp more than five minutes in the
future is invalid. Operators, signing addresses and source URLs must all be
distinct. At least two fresh trusted receipts must agree on every checkpoint,
state, snapshot, history and inventory hash. Two valid trusted receipts that
disagree fail closed rather than selecting the newest or largest backup.

An invalid, missing or stale source does not count toward the threshold. Once
agreement is established, the drill downloads from one agreed source and falls
back to the next if a file is missing, changed or corrupt. A copied receipt from
another URL cannot create independence because the signed `sourceId` must equal
the canonical requested source.

## Bounded transport

Current hard ceilings are:

| Resource | Limit |
| --- | ---: |
| Trusted/candidate sources | 128 |
| Receipt JSON | 128 KiB |
| Inventory JSON | 32 MiB |
| Inventory files | 200,000 |
| One backup file | 512 MiB |
| Complete portable backup | 4 GiB |
| Source URL | 256 bytes |
| Request timeout | 15 seconds by default; configurable up to 120 seconds |

The client checks declared and streamed response sizes, hashes every downloaded
file before installation and downloads sequentially to keep memory and open-file
use bounded. The service rechecks size and hash immediately before serving each
file, detecting storage that changed after its receipt was issued.

## Crash-safe isolated workspace

The deterministic workspace name is derived from the agreed inventory root.
Downloads first enter a private `.staging` directory. A failed provider removes
only that staging generation before the next agreed provider is tried. After the
complete inventory root verifies, the generation is atomically renamed into the
drill workspace.

Inside that isolated copy, the drill performs normal block-store replay,
snapshot authentication and account-history index verification. It then compares
the restored checkpoint, state, history and snapshot hashes with the receipts.
Only after all checks pass is `DRILL-COMPLETE.json` written atomically. A crash
without that marker causes only the deterministic drill workspace to be rebuilt.
On a repeated drill the marker is not trusted by itself: the block store,
snapshot and history are replayed and compared with the fresh independent
receipts again. A damaged completed workspace is discarded and restored anew.

The command never writes to the live node directory and never submits a
transaction. The completion record contains public hashes, sources and timings,
not secrets.

## Failure interpretation

- **Not enough receipts:** independent fresh storage coverage is below policy.
- **Conflicting receipts:** trusted operators claim different backups for the
  same drill; investigate before accepting either.
- **No source completed download:** receipts agreed, but every serving copy was
  missing, changed, corrupt or outside resource limits.
- **Restored hashes differ:** downloaded bytes formed a valid inventory but did
  not restore the checkpoint claimed by the operators.

These checks demonstrate recoverability at the time of the drill. They do not
replace geographically independent storage, access-control review, monitoring,
regular scheduling, or restoration on production-equivalent hardware.
