# Persistent local NIR node

The current node is a **valueless localhost devnet**, not mainnet software. It
persists finalized blocks, replays and verifies the complete journal on restart,
and exposes the first wallet-facing RPC.

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

## Production gaps

This node uses one process holding four development validator keys to construct
a quorum certificate. Production still requires peer-to-peer transport,
independent validator processes, a mempool, consensus rounds, fork recovery,
transactional database snapshots, authentication/rate limiting, metrics and
adversarial network testing. The block journal is a persistence prototype, not
a production database.
