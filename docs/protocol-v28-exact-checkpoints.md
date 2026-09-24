# Protocol v28: bounded exact-assignment checkpoints

Protocol v28 adds two immutable commitments to every post-activation block and
finality header: `chainIdentityGenesisHash` and `validatorSetId`. The former is
the actual genesis block hash retained by full nodes across snapshot restore; the
latter is the deterministic identity of the validator set required to finalize
that block. V24-v27 block, header and proof encodings are unchanged. V28 uses
finality header v4 and finality proof v5, and must activate after genesis to avoid
a self-referential genesis hash.

An assignment-chain-anchor v4 package may carry a v5 checkpoint finality proof.
The verifier checks its prepare and commit quorum against an explicitly trusted
validator set, requires the header's validator-set commitment to match that set,
and requires its chain identity to equal the expected genesis hash. Only the
bounded suffix after that checkpoint is replayed, including any authenticated
validator handoffs. Every suffix v28 header must repeat the same chain identity.
The checkpoint must precede the candidate commitment transaction; transaction,
source, decision and inclusion proofs therefore remain inside the verified suffix.

This is an explicit weak-subjectivity checkpoint, not trust-free discovery of the
current validator set. An operator must obtain and pin the checkpoint hash and
validator set through an independent trusted channel. A state snapshot alone is
not sufficient. A foreign history with the same network name, an arbitrary
self-signed validator set, a changed genesis identity, or a missing rotation is
rejected. Retaining recent checkpoint proofs makes verification cost depend on the
bounded suffix rather than total chain age.

The optional offline trust package described in
`checkpoint-trust-packages.md` reduces that manual trust input to one pinned
M-of-N witness-policy ID. It binds an exact v5 proof and validator set to the
network, genesis, checkpoint view, monotonic sequence, and post-quantum witness
quorum, with canonical bounded parsing and portable equivocation evidence. It
does not prove that configured operators are independent or remain uncompromised.
