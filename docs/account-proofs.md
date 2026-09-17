# Quorum-verified account proofs

A plain account RPC response comes from one node and can be wrong even when its
transport is encrypted. NIR account proof version 1 makes the active validator
quorum attest one exact account view at a finalized chain height.

The signed statement binds:

- network, height, finalized block hash and complete consensus state root;
- validator-set identifier;
- account address, atomic balance and next nonce;
- locked Transfer Credit stake, remaining credits, delegations and pending exit.

The verifier needs an external trust anchor: the expected network identifier
and validator public keys from the accepted genesis or verified handoff history.
Validator keys included only inside an untrusted response can never establish
their own authority.

## Local wallet setup

Pass the local network's explicit genesis file as the fourth bridge argument:

```bash
npm run wallet:bridge -- \
  /absolute/path/personal.nirvault.json \
  8788 \
  http://127.0.0.1:8765 \
  /absolute/path/node/genesis.json
```

The bridge prints which network is pinned. The wallet asks the node for an
account proof, sends it to the key-isolated bridge and displays
`Quorum confirmed balance` only after all of these checks succeed:

1. the proof address equals the connected wallet address;
2. the proof network equals the pinned genesis network;
3. its height is not older than the latest node height already observed;
4. its validator-set identifier equals the trusted set;
5. at least two-thirds plus one distinct trusted validators signed the exact
   statement hash.

If no trust anchor is configured or verification fails, the wallet clearly
labels the balance as `single-node data`. The valueless development interface
may still be used, but that label must not be treated as proof of funds.

## Remaining production work

The local development node can assemble a quorum proof because it owns temporary
test validator keys. Production validators must instead sign independently and
the requesting node must merge their matching statements. Trust must advance
through already verified validator handoffs, never through a validator list
supplied by the same untrusted node.
