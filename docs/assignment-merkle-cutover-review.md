# Assignment Merkle commitment: cutover review

## Current boundary

The implemented chain supports protocol versions 24 through 27. This review
describes the v26 Merkle cutover; the compact v27 extension is specified in
`protocol-v27-assignment-binding.md`. Versions 24 and 25 retain their exact
prior block/header encodings. Version 26 adds a
consensus-native `evaluationAssignmentRoot`, finality header v3 and finality
proof v4. This proves the smaller consensus assignment projection; it does not
prove the complete external Python `FinalizedEvaluationAssignment`, so
`exactAssignmentIncluded` remains false.

The current Python bridge now rejects a legacy helper that attempts to return
`exactAssignmentIncluded=true`, bounds the finality proof and validator/handoff
collections consistently with the JavaScript light client, and independently
checks that helper result heights and state root repeat the requested assignment
and proof. These checks remain required after a new proof format is added.

## Required protocol cutover

An assignment Merkle root changes consensus encoding and must use a new,
sequential protocol version (currently version 26), not an optional field in a
version 24/25 object.

For version 26 and later, all of these surfaces must change together:

- the exact block field set and `blockHash()` input;
- a new exact finality-header format and its header hash;
- finality-proof format selection and light-client exact schema validation;
- equivocation and validator-admission evidence header schemas;
- the protocol encoding map and conformance manifest;
- state-root input, consensus snapshot export/import, block-store replay and
  snapshot validation;
- genesis/activation tests and old-node rejection tests.

The activation block must compute its assignment root under version-26 rules
from the post-transition state. A version-25 header with an `assignmentRoot`
field must be rejected as an extra field, and a version-26 header without it
must be rejected as incomplete. Checkpoints used to verify version-26 assignment
proofs must state their protocol version explicitly; the current light-client
default to version 24 is safe only for legacy proofs.

## Tree and proof rules

Use a dedicated domain-separated empty root, never 64 zeroes and never the
transaction-tree empty root. The same empty root must appear in an empty
version-26 genesis/activation state, its block header, exported snapshot and a
freshly restored node.

Each leaf commits to the fields actually known to consensus when the challenge
is assigned: candidate and admission hashes, recipient, parents, committed
height, challenge seed/source height and ordered evaluator addresses. It does
not claim environment, adapter, selected safety policy, expiry, authority
attestations or public-key payload inclusion. Those remain separately verified
external receipt bindings. The leaf/index construction and every internal-node
hash use separate domains from transaction and account trees.

Proofs need an exact versioned schema, canonical sibling ordering, an explicit
leaf count/index (or fixed sparse-tree key), and bounds on total bytes, sibling
count and depth before hashing. Reject extra fields, duplicate siblings where
the construction forbids them, impossible count/depth combinations, non-hex
hashes, empty-tree inclusion proofs and roots from another protocol version.

Protocol v26 must never report `exactAssignmentIncluded=true`: its consensus
leaf intentionally contains only the fields known to the chain at assignment
time. A future protocol version may report exact inclusion only when all of the
following are true:

1. the proof uses a new assignment-proof format, never the legacy anchor;
2. the authenticated finality header uses that future protocol version and an
   `assignmentRoot` field in its signed/hash-committed schema;
3. the assignment leaf reconstructed from the exact assignment bytes verifies
   against that header root;
4. the assignment's finalized height/state root, network and genesis match the
   authenticated header chain;
5. validator handoffs through the proof tip have been verified by the existing
   dual-quorum rotation logic;
6. normal assignment authority, expiry, bundle, receipt and replay checks still
   pass. Merkle inclusion does not replace those checks.

The Python API dispatches on proof format. V1 is structurally unable to prove a
chain assignment. V2 may prove the version-26 consensus projection and therefore
return `chainAssignmentIncluded=true`, but it must still return
`exactAssignmentIncluded=false`. A future proof format and consensus leaf are
required for exact inclusion; no boolean supplied by a package or helper may
directly select that result.

Do not add `assignmentProof` and `consensusAssignment` as newly required fields
under the existing V1 envelope: old strict V1 packages did not contain them and
would stop parsing. Keep an exact legacy V1 field set that maps both values to
`None`, and introduce an exact V2 field set for the Merkle extension. A legacy
proof must always report both chain-assignment and exact-assignment inclusion as
false.

## Snapshot, restart and lifecycle

Today derived assignment data lives inside pending progress commitments, and
those entries are deleted on expiry, reward admission and cleanup. A root over
only that mutable map would make proofs disappear and would not define how a
signed assignment survives restart.

Version 26 therefore uses an explicit canonical **active** assignment registry
in consensus state. An entry is inserted when the challenge is assigned and is
removed atomically whenever the corresponding progress commitment leaves active
state: accepted reward admission, expiry, evaluator-fraud cleanup, or beacon-set
rotation cleanup. The registry is capped at 4096 concurrent entries; it is not
a lifetime cap. Capacity exhaustion rejects new assignments until an active
entry is resolved. Snapshot
restore must validate the registry, recompute its root, compare it with both the
state and checkpoint header, and reject missing, duplicated, reordered or
version-inappropriate fields. Block replay and `fork()` must produce the same
root byte-for-byte.

An assignment witness must be captured while the assignment is active. After
resolution, the historical proof remains verifiable forever against the signed
finality header that originally contained its root, but an ordinary current
full node is not required to regenerate it. Clients and archive operators must
retain the witness/header package for their dispute/archive policy. Archival
witness serving is an operator responsibility, not a second trust root.

## Adversarial acceptance cases

- empty tree before and exactly at activation, followed by first insertion;
- snapshot/export/import and block-store restart before/at/after activation;
- old node rejects the activation block; upgraded node rejects assignment root
  fields on old headers;
- missing/extra header field, forged root, wrong leaf/index/depth/count and an
  oversized proof;
- proof from the right network but wrong genesis, height, state root or
  protocol version;
- assignment expiry/deletion/tombstone and proof verification against a retained
  historical finalized header;
- validator rotation on the assignment block and across the proof chain,
  requiring old- and new-set quorum exactly as the existing handoff verifier;
- coordinated snapshot tampering where registry and root are both changed but
  the finalized checkpoint header is not;
- legacy V1 helper returning `exactAssignmentIncluded=true` or a V2 proof
  attached to a version-24/25 header.
