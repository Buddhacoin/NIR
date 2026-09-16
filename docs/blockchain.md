# NIR Blockchain Core — Draft 0.1

The first chain implementation is a deterministic local ledger. It establishes
the state-transition rules that a later peer-to-peer network must execute
identically.

## Implemented

- SHA3-256 content-addressed blocks, full 256-bit account addresses, and
  previous-block linkage;
- account balances, sequential nonces, fees, and atomic block application;
- a consensus-enforced minimum transfer fee of 0.00001000 NIR, paid to the
  block proposer;
- ML-DSA-65 post-quantum signatures for accounts and validators;
- native M-of-N ML-DSA-65 multisignature accounts for treasury custody;
- deterministic round-robin block proposers;
- finality certificates requiring at least `floor(2N/3) + 1` validator votes;
- separate evaluator and consensus registries with disjoint operator identities;
- fixed per-epoch progress-reward budgets and the 21 million NIR hard cap;
- a ten-minute minimum interval between intelligence-reward blocks;
- proportional reward allocation from proof scores;
- ML-DSA-65-signed evaluation receipts bound to network and epoch;
- on-chain recomputation of progress scores;
- a world-capability memory root committed by genesis and every block;
- a complete deterministic state root committed by genesis and every protocol-v7
  block, covering monetary, mining, safety, randomness, validator, and peer state;
- consensus validation of lineage, behavior novelty, and marginal frontier gain;
- permanent rejection of already rewarded proof fingerprints;
- ten-year linear treasury vesting by bounded block timestamps;
- signed candidate-bond transactions and consensus-recomputed critical-safety
  settlements with reporter/evaluator payouts and permanent supply burns;
- deterministic safety-committee assignment from a validator-quorum
  commit/reveal round after a candidate bond, with settlement restricted to
  that exact committee;
- domain-separated signatures and hashes;
- limits on block bytes, transactions, rewards, and numeric inputs.

## Trust boundary

Validators attest identical evaluation metrics and the chain recomputes the
score, world-memory transition, allocation, uniqueness, signatures, and
monetary cap. Empty blocks do not consume issuance epochs. The chain does not
rerun an AI model inside block validation. Production still needs a transport
that creates receipts directly from reproducible evaluator executions.

Validator and evaluator identities in this version are configured at genesis,
and one configured operator cannot occupy both roles. This is not yet
permissionless consensus: operator identifiers are self-asserted, and there is
no consensus-connected external identity attestation, operator rotation,
evaluator-equivocation slashing, fork recovery, or peer-to-peer transport.
Candidate safety bonds, randomness commitments and reveals, committee
assignments, and critical-failure settlements are consensus state. No single
block producer supplies the seed. The current commit/reveal construction still
has a last-revealer liveness and bias risk: a contributor can withhold its reveal
after seeing others. The chain now records each committed non-revealer as an
objective fault and refunds the candidate bond after the deadline, preventing
indefinite candidate-fund lockup. Signed validator-bond transactions lock real
ledger balances; only sufficiently bonded validators may commit randomness, and
one percent of a non-revealer's remaining bond is burned automatically.
When a reveal is missing, independently generated shares require a
greater-than-two-thirds quorum from a separate genesis registry whose identities
cannot overlap validators or evaluators. The chain verifies and combines those
shares with every available reveal while still slashing the non-revealer.
Finality-set rotation is part of block state and certificate verification. A
rotation is certified by the old set, requires bonded registered members, gives
at least five blocks of notice, preserves at least one-third overlap, and switches
proposers and voters exactly at its activation height. The activation block
requires both an old-set quorum and a new-set quorum. Production still needs
validator withdrawal delays and independently operated, monitored and audited
beacon deployments; the runnable service is documented in [beacon.md](beacon.md).

The design review of leading independent networks and the resulting three-lane
NIR architecture are documented in [top-chains-study.md](top-chains-study.md).

## State commitment and snapshots

`stateRoot` binds every validator to the same balances, nonces, issued and
burned supply, reward epoch, rewarded proofs, candidate bonds, randomness
records, safety evidence, validator bonds and faults, active and pending
validator sets, peer registry, and world-capability memory root. Collections are
normalized and sorted before domain-separated hashing, so insertion order cannot
produce different roots.

The root is calculated from the post-block state and included in the immutable
block value before prepare and commit signatures are collected. A validator
recomputes it during execution and rejects a quorum-signed block whose claimed
root is false. Round replacement does not change the state root or execution
value.

The chain can now serialize that complete state together with the underlying
capability-memory records. A snapshot commits its height, tip, state root,
validator-set identifier, and contents under a separate hash, then requires
`2N/3 + 1` unique ML-DSA approvals from the active finality set. Verification
recomputes the snapshot hash, complete state root, capability-memory root,
validator-set identifier, every signature, and quorum. The trusted validator
set and network identifier must come from a local finalized checkpoint or
genesis; a downloaded snapshot is never allowed to declare its own trust
anchor. When validators have rotated, every step is a domain-separated handoff
signed by `2N/3 + 1` members of both the previous and next sets. Handoffs bind
the network, activation height, activation block hash, state root, complete next
membership, and both set identifiers. Heights must increase and each handoff
must retain the protocol's minimum one-third overlap. Mutation, minority
approval, skipped links, self-signed replacement sets, and duplicate votes fail
closed.

The core importer restores every typed consensus collection (`BigInt`, `Map`,
`Set`, capability memory, validators, bonds, and replay protection), recomputes
the root, and validates the first and every later block after the checkpoint.
The block-store v2 checkpoint records its explicit snapshot base, so a joining
node can start at a quorum snapshot and replay only the journal tail. Accepting
a snapshot merely because its file hash is valid would weaken full replay;
installation always retains the local network and validator trust anchor.

Snapshot selection accepts only unique authenticated source identifiers and
requires matching data from at least two independent sources. Invalid sources
are ignored, while two different valid quorum snapshots at the same height fail
closed because they are evidence of validator equivocation or a broken trust
assumption. The highest sufficiently replicated snapshot is selected.

The staging store installs a selected snapshot with restricted permissions,
`fsync`, atomic rename, and primary plus backup copies. Startup verification can
repair one damaged copy, rejects conflicting copies and symbolic-link storage,
and refuses to install an older height over a newer snapshot. Old journal files
are pruned in two explicit phases: staging moves only blocks at or below the
snapshot height into quarantine; a separate restart verification reconstructs
the tip from snapshot plus tail; only then can finalization delete quarantine.
Portable public backups preserve the snapshot as well as the remaining tail.

The distributed devnet now exposes coordinator-authenticated snapshot RPCs.
One validator supplies the full candidate; every other validator independently
rebuilds the same snapshot and signs only its height-bound hash. Coordinator
responses are already authenticated by the existing replay-resistant peer
channel, while snapshot approvals use the validator consensus keys. The
coordinator retries another full-state source when the first cannot obtain a
quorum.

A validator that is at least 16 blocks behind now requests snapshot candidates
over the replay-protected validator transport from every reachable peer. It
installs only one identical state carrying unique finality signatures from the
normal `2N/3 + 1` quorum, then resumes ordinary certificate verification for
any remaining tail blocks. Minority, stale, malformed, and conflicting
candidates cannot advance its state; when no snapshot quorum exists, the node
falls back to sequential finalized-block replay.

Snapshot trust can advance through multiple ordered validator generations. The
node roots every handoff in genesis, verifies both old- and new-set quorums for
each transition, and uses only the resulting final set for snapshot signatures.
When a snapshot is taken at the exact activation height, its checkpoint hash
and state root must equal the values committed by that handoff. The automated
`A → B → C` test restores the second activation snapshot and replays only one
later journal block; a missing, reordered, or correctly re-signed but
state-mismatched handoff fails closed.

Handoff candidates are now emitted inside the commit phase, after each
validator has persisted its non-equivocating commit decision. The proposer or
coordinator requires both old- and new-set quorums before committing an
activation block, stores the assembled proof with atomic primary and backup
copies, and distributes it only after the matching block is finalized. On
restart, this history advances the genesis trust anchor before any snapshot is
loaded. A damaged copy is repaired; conflicting histories and skipped or
reordered transitions fail closed.

Dynamic P2P membership now has a pre-activation, mutually authenticated
endpoint-registration workflow so new-set commit and handoff votes are
reachable before activation. The local devnet generator still starts only a
static four-validator topology; multi-host deployment, operator ceremonies,
and hostile-network recovery drills remain production work.

Protocol v7 adds the consensus commitment for that workflow. When a chain has
an active peer registry, a validator-rotation proposal must carry a canonical
onboarding certificate for the exact future set. It binds activation height,
old and new set identifiers, HTTPS origins, TLS certificate pins, and separate
ML-DSA transport identities. The current set must approve it with `2N/3 + 1`;
every future validator must accept with its consensus key; and every advertised
transport key must prove possession. Duplicate endpoints, reused transport
identities, public plaintext origins, mutation, missing acceptance, and changes
to an overlapping validator's live endpoint fail closed. The certificate is
stored inside the pending rotation and therefore covered by every subsequent
state root. Its peer registry becomes active atomically in the same block as the
new finality set; intervening peer-registry updates are forbidden. The remaining
live validator service builds an authenticated temporary union transport view
before activation. Future-only operators may synchronize finalized state and
exchange messages for the exact activation height, but cannot gossip
transactions or influence earlier proposals and timeouts. The activation block
requires prepare and commit quorums from both sets; committing it immediately
rebuilds the in-memory topology from the newly active registry.

## Run

```bash
npm run test:chain
npm run demo:chain
```

Node.js 26+ is required because the implementation uses its native ML-DSA-65
support.
