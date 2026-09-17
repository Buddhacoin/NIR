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
  /absolute/path/node/genesis.json \
  /absolute/path/node/handoffs/VALIDATOR-HANDOFFS.json
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

## Independent validator flow

In distributed mode, no coordinator holds validator signing keys. It first
synchronizes the replicas, requests a candidate statement from one authenticated
validator and asks the others to attest that exact address, height and statement
hash. Each validator reconstructs the account view from its own finalized state
and refuses to sign a mismatch. The coordinator returns a proof only after an
independent two-thirds-plus-one quorum agrees. One of four validators may be
offline; two signatures are never enough.

The final argument may be omitted. Before checking a balance, the wallet now
requests the current handoff history from its node and gives it to the isolated
bridge. The bridge accepts only an extension rooted in its pinned genesis and
stores the verified result as `<vault>.handoffs.json`. A node can withhold the
history and cause a safe verification failure, but it cannot forge a transition.
An explicitly supplied history remains useful for offline recovery. A new set
cannot appoint itself, an old set cannot sign balances after its replacement,
and a future rotation is not applied early.

The bridge atomically stores a public checkpoint beside the encrypted vault as
`<vault>.trust.json`. It contains no signing key. Once a newer finalized height
or validator transition has been accepted, restarting the bridge cannot make it
accept an older height, a conflicting state at the same height, or a handoff
history that omits the already accepted transition. Back up this file together
with the vault; deleting it deliberately resets rollback memory.

## Remaining production work

Production distribution should add redundant discovery sources for availability.
Authenticity already comes from old-and-new quorum signatures and the genesis
trust anchor, never from the server delivering the history or a validator list
inside the same untrusted proof response.
