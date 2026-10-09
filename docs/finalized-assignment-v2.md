# Finalized evaluation assignment v2

`nir-finalized-evaluation-assignment-v2` is the first external assignment format
whose semantic payload can be matched field-for-field to the protocol-v27
assignment leaf. It is additive: v1 assignments and v1/v2 chain-proof packages
retain their existing encodings and continue to report
`exactAssignmentIncluded=false`.

V2 removes external authority attestations from the semantic assignment. Finality
comes from the authenticated block certificate. Full evaluator public keys remain
bounded proof witnesses; their identities and domain-separated key commitments
must match the compact values in the v27 leaf. The canonical assignment hash is
the consensus-codec hash of the exact v2 payload under `NIR_EVAL_ASSIGN_V2`.

The `nir-assignment-chain-anchor-v3` package carries three explicit anchors:

- `sourceAnchor`: the finalized state used when the assignment was derived;
- `decisionAnchor`: the block that made the challenge and committee decision;
- `inclusionAnchor`: the finalized header whose assignment root authenticates the
  sparse-Merkle witness.

In protocol v27 the decision is made in the block immediately after the source
state and that same block first includes the leaf. The verifier therefore enforces
`source + 1 == decision == inclusion`; later protocols must introduce a new proof
version before changing that chronology. The finality proof chain must be
continuous from the genesis checkpoint to the inclusion anchor. Exact verification
currently requires a height-zero checkpoint whose hash is the expected genesis
hash, closing replay into a different history with a caller-supplied label.

This v27 profile is deliberately bounded to 512 finality proofs and therefore is
not a scalable long-lived-mainnet synchronization format. Protocol v28 supplies
the additive `nir-assignment-chain-anchor-v4` profile: a quorum-certified recent
checkpoint commits the real genesis hash and active validator-set identity, and
only the bounded suffix containing the candidate transaction and assignment is
replayed. The exact v4 path requires a witness-quorum trust package, an externally
pinned policy ID, and durable minimum sequence/height floors; it does not accept a
validator list supplied beside the proof. This is an explicit weak-subjectivity
checkpoint, not trust-free validator discovery; see
[`protocol-v28-exact-checkpoints.md`](protocol-v28-exact-checkpoints.md).

A quorum-signed state snapshot alone is not an exact assignment proof. It does not
intrinsically reconstruct the historical source header or the genesis-to-inclusion
certificate chain. Operators must retain the v3 package, its bounded finality
proofs, the progress transaction proof, and the assignment membership witness.

`exactAssignmentIncluded=true` is returned only after all semantic fields, the
candidate commitment hash, evaluator key witnesses, all three anchors, transaction
membership, Merkle membership, network identity, genesis ancestry, and continuous
finality have been verified. Any v26 leaf or v1 assignment remains non-exact.

Execution-receipt creation accepts both assignment versions. The public
`verify_finalized_assignment()` and `verify_execution_receipts()` APIs verify
legacy authority-finalized v1 objects only and fail closed for v2: a caller can
construct an `AssignmentChainAnchorResult`, so that result is not a trust input.
V2 package verification is available only through the experimental file-based
assignment gate. It atomically verifies the raw matching V3 or V4 chain proof
with independent operator trust pins, then checks receipt bindings and consumes
replay state. Its result does not authorize adapter launch or award a chain
reward. A future general-purpose V2 API must likewise accept and verify the raw
chain proof rather than a preconstructed result object.

The underscore-prefixed binding and replay helpers inside that gate are
code-organization details, not an in-process security boundary. Code executing
inside the verifier process is trusted; external callers must use the public
atomic package gate.
