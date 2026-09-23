# Delayed progress reward escrow

NIR delays liquidity and capability-memory admission for every Proof-of-Progress
reward by 64 finalized blocks. The reward is allocated and counted in `mined`
immediately, so the hard cap cannot be bypassed while it is pending, but it is
not part of any account balance. The admission-bound candidate bond remains
locked for the same interval. Account proofs expose bounded aggregate pending
reward and bond-refund amounts, counts, and the next unlock height.

Pending evaluations are not in canonical capability memory and cannot be used
as a baseline or parent. Consensus reserves their artifact hash, canonical
content hash, behavior commitment, and marginal capability names. A new pending
claim is assessed only against finalized memory and is rejected if it collides
with a reservation. At maturity, surviving evaluations enter capability memory
in `(createdHeight, fingerprint)` order, the reward becomes liquid, and the
sponsor receives the bond refund. One empty block can mature every escrow at
that height without changing issued supply a second time.

## Objective fraud subset

The only post-reward proof accepted by this version is a second, different
receipt for the same candidate, network and challenge epoch, signed by every
member of the originally assigned evaluator committee. This proves committee
equivocation without a governance vote or a subjective quality judgment. At
`unlockHeight`, proofs are checked before maturity. A valid proof burns the
pending reward and candidate bond and removes the pending evaluation without
changing capability memory. Evidence hashes are replay-protected for the
64-block horizon. Retention is bounded to 4,160 entries; oversized or stale
snapshot replay maps are rejected. After escrow removal, the candidate ID also
makes replay and late evidence inapplicable.

Malformed, forged, partial-quorum, same-receipt, late, replayed, wrong-network,
or wrong-candidate evidence rejects the whole block and changes no balance,
nonce, escrow, or state root. State roots and restart snapshots commit escrows,
pending evaluations, reservations, the replay horizon, issued and burned sums.
As with every chain snapshot, rejecting an otherwise valid older finalized
snapshot requires the operator or light client to retain its latest trusted
checkpoint; escrow state alone is not an external anti-rollback anchor.

## Remaining boundary

This mechanism does not prove honest private execution, real-world company
independence, or semantic equivalence of different canonical bytes. The chain
has no objective public witness for those facts and therefore does not accept
those allegations after reward. Exact canonical-content/frontier duplicates
and protocol-role conflicts remain pre-admission checks. A forged or mismatched
private execution bundle needs a future independently verifiable execution
receipt before it can safely authorize confiscation.
