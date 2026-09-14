# Multi-process NIR devnet

This milestone removes consensus private keys from the coordinator. Four
validator replicas run as separate localhost processes, each with one ML-DSA-65
key, its own verified chain journal, and a durable vote record.

## Create the network

```bash
npm run network:init-dev -- .nir-network
```

The command creates a coordinator directory and four validator directories.
Every validator receives the same public genesis but only its own private key.
The coordinator receives no validator private key.

## Start four validators

Run each command in a separate terminal:

```bash
npm run network:validator -- .nir-network/validators/validator-0 8791
npm run network:validator -- .nir-network/validators/validator-1 8792
npm run network:validator -- .nir-network/validators/validator-2 8793
npm run network:validator -- .nir-network/validators/validator-3 8794
```

## Start the coordinator

```bash
npm run network:coordinator -- \
  .nir-network/coordinator \
  http://127.0.0.1:8791,http://127.0.0.1:8792,http://127.0.0.1:8793,http://127.0.0.1:8794 \
  8787
```

Signed transactions submitted to `POST /v1/transactions` are executed on an
isolated chain copy before entering the bounded in-memory mempool; a malformed
or conflicting transaction is rejected immediately. `POST /v1/blocks/produce`
creates a proposal. Each validator rebuilds
the deterministic proposal, independently executes all state transitions on an
isolated chain copy, and signs only if the result is valid. The coordinator
requires `2N/3 + 1` unique votes including the expected proposer, appends the
finalized block, and broadcasts it to validator replicas.

The development faucet both queues and finalizes its transfer so the wallet can
still use it as one action.

## Faults covered by the integration test

- validator keys never enter coordinator memory;
- one non-proposer validator may be offline while the remaining three finalize;
- a forged transaction is rejected before a validator signs the proposal;
- a validator stores its vote before returning it and refuses a conflicting
  block at the same height, including after restart;
- coordinator balances and blocks survive restart and verified replay.

## Remaining production boundary

This is a multi-process localhost consensus prototype, not production BFT.
Peer connections are not mutually authenticated, the coordinator is still the
only proposal and transaction ingress, the mempool is not persisted or gossiped,
and an offline validator has no catch-up protocol. There are no locked consensus
rounds, timeouts, view changes, fork recovery, peer discovery, or network
partition simulation yet. Test keys are plaintext and have no monetary value.
