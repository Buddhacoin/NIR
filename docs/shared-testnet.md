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

## In the apps

NIR Майнер joins the shared network by default. The network at
`https://testnet.nircoin.com` (`nir-shared-testnet-1`) is pinned in
`blockchain/shared-network.mjs` by its genesis hash
`ce1662e5fce66365520d33cf2c770aec20d998fbccf1778f20c9bee7cad0ea16`; a reset
network gets a new hash, which must be pinned again. The mining panel switches between **Общая сеть** and
**Тренировка на этом Mac**, and the choice is kept in
`network-choice.json` in the mining folder.

On the shared network the miner:

1. fetches `GET /v1/genesis` and refuses the network unless it hashes to the
   pinned value;
2. asks the faucet once for its miner key, which pays the answer bonds;
3. relays NIR Wallet's requests from `127.0.0.1:8787` to the network
   (`blockchain/network-relay.mjs`). The relay forwards reads,
   transactions and faucet requests only, and is not trusted: the wallet
   checks finality signatures and account proofs against the genesis the
   miner saved in `shared/genesis.json`, which must also match the pinned
   hash;
4. keeps mining through short outages, retrying every few seconds.

NIR Wallet picks its network from `active-network.json` in the mining
folder when it starts, so after switching networks it must be reopened.
