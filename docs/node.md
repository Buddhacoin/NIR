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
- `GET /v1/fees?amount={atomic-units}`
- `POST /v1/faucet` with `{ "recipient": "nir1..." }`
- `POST /v1/transactions` with a complete signed NIR transaction

The faucet sends at most 10 test NIR once to a fresh address. The HTTP service
binds only to loopback by default and permits browser origins on localhost or
127.0.0.1. It is not a public-network security boundary.

## Wallet-to-wallet flow

Create two native vaults with `npm run wallet:create`, inspect their addresses
with `npm run wallet:address`, and fund the first address through `/v1/faucet`.
Use `/v1/accounts/{address}` to obtain its `nextNonce`, sign with
`npm run wallet:sign`, then POST the resulting JSON to `/v1/transactions`.

The integration suite performs this entire flow automatically and then creates
a new node process state from disk. A modified signature is rejected and both
balances survive replay.

## Storage recovery and backups

Each protocol-v6 block commits a deterministic root covering balances, nonces,
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
journal now detects and repairs several partial-write and corruption cases, but
it is not a production database. Production still requires state snapshots that
avoid replaying the full history, pruning with archival guarantees, multiple
remote backup targets, authenticated snapshot download from several peers,
continuous restore drills, metrics, and independent storage review.
