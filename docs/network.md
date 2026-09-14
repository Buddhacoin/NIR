# Multi-process NIR devnet

This milestone removes consensus private keys from the coordinator. Four
validator replicas run as separate localhost processes, each with one ML-DSA-65
key, its own verified chain journal, and a durable vote record.

## Create the network

The multi-round certificate format uses protocol version 3. Recreate any earlier
valueless development network instead of attempting to reuse older blocks.

```bash
npm run network:init-dev -- .nir-network
```

The command creates a coordinator directory and four validator directories.
Every validator receives the same public genesis but only its own private key.
The coordinator receives no validator private key.
It receives a separate operational ML-DSA-65 identity. Validators pin only its
public identity and reject unsigned, altered, stale, or replayed control calls.

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

Every proposal and finalized-block request is signed by the coordinator and
bound to its network, HTTP route, body hash, timestamp, and one-time nonce.
Every validator response is independently signed and checked against the public
validator identity in genesis. Before asking for a new vote, the coordinator
checks each replica's height and streams any missing quorum-finalized blocks in
order. A conflicting tip or a peer claiming a future height is rejected.

If the deterministic proposer is unreachable before anyone votes, the remaining
validators persistently sign a height- and tip-bound timeout. A `2N/3 + 1`
timeout certificate advances the block to the next round and selects the next
validator as proposer. Consensus verifies every certificate inside the block.
A timeout is bound to the immutable block-value hash. A validator that already
voted may advance rounds only for that same value and refuses to unlock a
different one.

Round metadata and finality evidence do not change that value hash. Transaction
fees use the deterministic round-zero fee recipient for the height, so replacing
a failed proposer cannot alter balances or create a competing execution result.

The development faucet both queues and finalizes its transfer so the wallet can
still use it as one action.

## Faults covered by the integration test

- validator keys never enter coordinator memory;
- one non-proposer validator may be offline while the remaining three finalize;
- a forged transaction is rejected before a validator signs the proposal;
- a validator stores its vote before returning it and refuses a conflicting
  block at the same height, including after restart;
- coordinator balances and blocks survive restart and verified replay.
- a validator that misses a finalized block catches up after restart before it
  votes at the next height;
- request mutation, stale requests, nonce replay, and forged peer responses are
  rejected cryptographically.
- an offline or non-responsive proposer is replaced only after a signed quorum
  timeout, while an existing vote remains locked to the same block value.

## Remaining production boundary

This is a multi-process localhost consensus prototype, not production BFT.
Application-layer control messages now have pinned mutual signatures, but the
coordinator is still the only proposal and transaction ingress. Transport is
not confidential, coordinator-key rotation is not governed on-chain, peer URLs
are static, and catch-up has no snapshot or fork-choice protocol. The mempool is
not persisted or gossiped. Repeated rounds preserve the same execution value and
rotate the proposer through quorum timeout certificates, but lock discovery
between competing coordinators is not implemented. There is no decentralized
transaction ingress, fork recovery, peer discovery, or network-partition
simulation yet. Test keys are plaintext and have no monetary value.
