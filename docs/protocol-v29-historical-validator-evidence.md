# Protocol v29: historical validator evidence at rotation boundaries

Protocol v29 fixes validator-slashing membership at a delayed validator-set
activation boundary. Earlier protocol versions checked evidence against the
currently active set. That is insufficient for the activation block itself:
its finality certificate is intentionally authorized by both the previous and
next quorums.

The consensus state now commits `recentValidatorTransition` for exactly one
finalized head. It is non-null only when that head is a validator activation
block and contains the canonical, address-sorted previous and next validator
sets, both set commitments, and the activation height. The field is included
in the state root, snapshots, forks and deterministic replay. It is cleared by
the following finalized block.

Equivocation evidence is already limited to the immediately preceding
finalized height. At a v29 activation head, either an old-only or a new-only
validator is therefore recognized as a valid signer; an identity outside both
sets is rejected. Outside that one-block boundary the active set remains the
only membership source.

Admission-omission evidence is not widened to the union. Admission receipts
must not cross a validator rotation, so an omission claim against an activation
head fails closed. This prevents signatures from two generations being mixed
into an artificial omission quorum.

V24-v28 state roots and snapshots are unchanged. A v29 snapshot must contain
the new field (including explicit `null` away from a boundary), while an older
snapshot must not contain it. Deployment therefore requires a versioned v29
release and normal protocol-upgrade activation. No public compatibility promise
should be made until that release and its snapshot migration procedure have
passed independent review.
