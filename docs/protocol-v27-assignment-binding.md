# Protocol v27: extended evaluation-assignment binding

Protocol v27 extends the consensus assignment leaf without changing the v24-v26
block, header, proof, or leaf encodings. The v27 leaf additionally commits to:

- the exact runner-environment manifest commitment and adapter protocol fixed
  by the genesis configuration before v27 can activate;
- the selected safety-policy commitment and an explicit expiry height;
- each assigned evaluator identity and a compact commitment to its historical
  public key;
- the finality authority-set hash and authority model;
- a previously finalized source height and state root.

## Why source finality is separate from inclusion finality

An assignment cannot contain the state root that contains that same assignment:
doing so creates an unsatisfiable hash self-reference. NIR therefore uses two
moments. The challenge is derived after a source state is finalized. The extended
assignment names that prior source height and root, then its Merkle leaf is included
in a later block. A light client verifies both the historical source header and the
later assignment-root inclusion proof.

The full ML-DSA public keys remain proof witnesses: a verifier hashes them and
compares the result with the consensus commitments. They are not duplicated in
every active state leaf. Assignment values are bounded to 64 KiB, preventing a
large validator set from multiplying megabytes of key material across thousands
of active candidates.

## Exact external assignment proof

`nir-finalized-evaluation-assignment-v2` removes the separate authority
attestations used by the legacy format. Its complete semantic payload is matched
field-for-field to the v27 consensus leaf, while evaluator public keys are checked
against the compact key commitments stored in that leaf.

`nir-assignment-chain-anchor-v3` authenticates three distinct points: the finalized
source state, the decision block, and the block whose assignment root contains the
leaf. For v27 the verifier requires `source + 1 == decision == inclusion`, a
height-zero checkpoint matching the expected genesis hash, an uninterrupted
finality proof chain, transaction membership, assignment membership, and matching
network/genesis identities. Only this complete path returns
`exactAssignmentIncluded=true`.

Execution receipts for a v2 assignment are accepted only with the matching result
of that exact-chain verification and only from the decision height through the
assignment expiry height, inclusive. The v1 assignment and v1/v2 proof packages
remain supported without changing their encodings, but remain non-exact.

A signed state snapshot by itself is not an exact historical assignment proof: it
does not reconstruct the source header or the genesis-to-inclusion certificate
chain. Operators must retain the bounded v3 proof package. See
[`finalized-assignment-v2.md`](finalized-assignment-v2.md) for the complete boundary.
