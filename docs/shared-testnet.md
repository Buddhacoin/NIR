# Shared test network

Until now every NIR Майнер ran its own private network on its own Mac, so two
people could not send each other NIR. The shared test network is one network
that every NIR Майнер and NIR Wallet connects to.

**Status: developer test network.** It runs on one host that holds all four
validator keys, so it is not decentralized. NIR on it has no value and the
network may be reset. Moving the validators to independent operators follows
the gates in [`public-testnet-gates.md`](public-testnet-gates.md).

## What it does

`blockchain/shared-testnet.mjs` runs the same proof-mining devnet as NIR
Майнер (protocol v38: proof mining and names) behind HTTPS:

- **Reads** for wallets and miners: health, accounts and their proofs,
  finality proofs, proof-mining tasks, names, and `GET /v1/genesis`.
- **Transactions** from anyone: `POST /v1/transactions`. Every transaction is
  checked by the chain rules before it enters a block.
- **Faucet**: `POST /v1/faucet` gives 10 test NIR once to a fresh address,
  at most 3 times a day per client and 120 times an hour in total.
- **No block production on request**: `POST /v1/blocks/produce` is refused.
  The network makes blocks itself while miners ask for tasks and while
  answers, rewards or names still need blocks.

Wallets do not trust the host: they pin the network's genesis by its hash and
verify the validators' finality signatures and account proofs themselves.

## Running it

On a fresh Ubuntu server, with the domain's DNS A record pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/Buddhacoin/NIR/main/deploy/install-shared-testnet.sh \
  | bash -s -- testnet.nircoin.com
```

`deploy/install-shared-testnet.sh` installs Node.js (checked against the
official checksums), Caddy for HTTPS with an automatic certificate, the NIR
code, a `nir` system user and the `nir-testnet` systemd service. On first run
it creates the network and prints its `networkId` and `genesisHash`
(also kept in `/var/lib/nir/NETWORK.json`); the apps pin that hash. Running
the script again updates the code and restarts the service; the network and
its keys in `/var/lib/nir/testnet` are kept. Back up that folder: it holds
the validator keys.

Locally:

```bash
npm run testnet:init -- ~/nir-shared
npm run testnet:serve -- ~/nir-shared 8787
```
