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

## Honest security boundary

The v27 leaf proves substantially more than v26, but it deliberately does not set
`exactAssignmentIncluded=true`. `FinalizedEvaluationAssignment` v1 carries separate
authority attestations that are not fields of the consensus leaf. Those signatures
must still be checked by the receipt verifier. A future assignment format can replace
that split authority model with data derived entirely from the finalized certificate;
until then, callers must treat `chainAssignmentIncluded` and
`exactAssignmentIncluded` as different guarantees.
