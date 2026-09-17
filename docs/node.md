# Persistent local NIR node

The current node is a **valueless localhost devnet**, not mainnet software. It
persists finalized blocks in two local copies, synchronizes writes to disk,
maintains checksummed checkpoints, replays every consensus transition on
restart, and exposes the first wallet-facing RPC.

## Start a fresh devnet

Choose a new directory outside the repository:

```bash
npm run node:init-dev -- /absolute/path/nir-local-node
npm run node:serve -- /absolute/path/nir-local-node
```

The server listens on `http://127.0.0.1:8787` by default. Creating a devnet
writes `DEVNET-KEYS.json` with unencrypted, valueless test keys and mode `0600`.
Never reuse these keys, fund their addresses, publish this server, or treat its
balances as real NIR.

## RPC

- `GET /health`
- `GET /v1/accounts/{nir-address}`
- `GET /v1/accounts/{nir-address}/proof`
- `GET /v1/validator-handoffs`
- `GET /v1/finality-proofs?fromHeight={height}&limit={1..512}`
- `GET /v1/transactions/{transaction-id}/proof`
- `GET /v1/fees?amount={atomic-units}`
- `POST /v1/faucet` with `{ "recipient": "nir1..." }`
- `POST /v1/transactions` with a complete signed NIR transaction

The faucet sends at most 10 test NIR once to a fresh address. The HTTP service
binds only to loopback by default and permits browser origins on localhost or
127.0.0.1. It is not a public-network security boundary.

The transaction-proof response contains the complete signed transaction, its
finalized block height and hash, ordered inclusion path, transaction count and
root. Clients must compare those values with a header chain they verified
independently; receiving the proof and header from the same untrusted node is
not sufficient by itself.

The account response includes a protocol-v24 `history` commitment but no
unbounded transaction list. `GET /v1/accounts/{address}/history?before=N&limit=L`
returns a bounded descending page interval in ascending index order, with an
exact-position Merkle proof for every identifier. A client must first verify the
account proof, then verify the page interval and every path before displaying
the referenced transactions.

The node serves these pages from two append-only history-index journals rather
than rescanning every block for every request. Each per-height record binds the
network, finalized block hash, previous index-record hash, ordered account
updates, transaction bodies and their inclusion proofs. A direct identifier
map therefore serves `/v1/transactions/{id}/proof` without scanning blocks.
Incrementally maintained Merkle-node maps serve account pages without rebuilding
the complete account tree for every request.
At startup the node checks the complete hash chain and compares the rebuilt
per-account histories with the commitments in verified consensus state. One
damaged copy is repaired from the other; if both copies of a retained height are
damaged, the record is deterministically rebuilt from the already verified
block. A mismatch that cannot be recovered fails closed.

`node:backup` copies and re-verifies both index journals. Operators must create
and verify this archive before finalizing deletion of old block bodies: a compact
state snapshot contains history roots, not the transaction identifiers needed
to serve old pages.

The archive-recovery core can export those records as bounded canonical chunks.
Each operator signs a manifest that commits to the network, finalized height,
tip, state roots, complete index content and every chunk digest. A recovering
node accepts only configured post-quantum operator identities and requires the
same content from at least two different signing operators and source
identifiers. Different chunk layouts may agree because selection is based on
the verified record content, not transport packaging.

After selection, the node verifies every index-record hash link, every retained
transaction proof, and every account-history root against its own independently
verified chain checkpoint before writing either redundant journal. Archive
signatures authenticate delivery; they cannot create consensus history or
override a local finalized header. An invalid, stale, oversized, duplicated, or
insufficiently corroborated archive fails closed. The API is currently in
`blockchain/archive-sync.mjs`; authenticated download services and an operator
CLI remain production work.

Installation is a recoverable transaction. The node writes and verifies two
complete staged journals before synchronizing an installation marker. It then
replaces both live copies while retaining the staged source. The marker is
removed only after both live copies independently pass complete verification.
After a crash at any earlier point, startup resumes from a valid staged or live
copy; if none matches the chain checkpoint, it stops rather than accepting a
partial generation.

## Wallet-to-wallet flow

Create two native vaults with `npm run wallet:create`, inspect their addresses
with `npm run wallet:address`, and fund the first address through `/v1/faucet`.
Use `/v1/accounts/{address}` to obtain its `nextNonce`, sign with
`npm run wallet:sign`, then POST the resulting JSON to `/v1/transactions`.

The integration suite performs this entire flow automatically and then creates
a new node process state from disk. A modified signature is rejected and both
balances survive replay.

## Storage recovery and backups

Each protocol-v7 block commits a deterministic root covering balances, nonces,
issuance, burns, candidate and validator bonds, recorded faults, validator-set
transitions, the peer registry, safety evidence, and world capability memory.
This is the trust anchor required for future fast state snapshots; the current
node still performs full replay and does not import snapshots yet.

Each accepted block is first verified on an isolated chain copy. The node then
writes and `fsync`s a redundant block copy, the primary block, and two copies of
`STORE-CHECKPOINT.json` before replacing its live in-memory state. Each
checkpoint commits to the network, height, tip, block hashes, and exact SHA-256
digest of every journal file.

At startup the node compares both checkpoints and both copies of every block,
then replays the selected data through normal consensus validation. A corrupt or
missing primary file is repaired only from a redundant copy that passes that
replay. A checkpoint left behind by a crash is advanced from later valid journal
entries. If both copies of a committed height are unavailable or invalid, the
node stops instead of silently rolling back.

Create a portable public-chain backup in a new directory:

```bash
npm run node:backup -- /absolute/path/nir-local-node /separate/disk/nir-backup
npm run node:verify-backup -- /separate/disk/nir-backup
```

The export contains genesis, blocks, redundant copies, and checkpoints. It
deliberately excludes `DEVNET-KEYS.json` and cannot spend funds. The destination
must not already exist, preventing an accidental overwrite. For real operation,
store copies on a different device and test restoration regularly; two folders
on one disk do not protect against loss of that disk.

## Production gaps

The simple node uses one process holding four development validator keys; the
separate multi-process network is documented in `docs/network.md`. The durable
block and history journals detect and repair several partial-write and
corruption cases, but they are not a production database. Production still
requires independently operated archive services, multiple remote backup
targets, authenticated transport for the implemented signed multi-source archive
format, continuous restore drills, metrics, and independent storage review.
