# NIR Blockchain Core — Draft 0.1

The first chain implementation is a deterministic local ledger. It establishes
the state-transition rules that a later peer-to-peer network must execute
identically.

## Implemented

- SHA3-256 content-addressed blocks, full 256-bit account addresses, and
  previous-block linkage;
- account balances, sequential nonces, fees, and atomic block application;
- a consensus-enforced minimum of 0.00001000 NIR for fee-paid transfers, paid
  to the block proposer;
- native fee sponsorship: the sender authorizes the exact payment while a
  distinct post-quantum account authorizes and pays only its exact fee;
- protocol-v19 Transfer Credits: a separate signed stake locks NIR and creates
  a block-epoch quota for zero-fee transfers; the stake owner may consume a
  credit for an exact transfer through the same two-signature sponsorship path,
  and a separate per-block limit bounds credit-paid traffic;
- protocol-v20 compact finality headers: the block hash commits to a small
  header and that header commits to the complete block body, allowing wallets
  to verify the continuous finalized chain and post-quantum validator quorums
  without downloading transaction bodies;
- protocol-v21 sparse account commitments: every header carries an authenticated
  root for balances, nonces and Transfer Credit state; fixed-depth membership
  and absence proofs let a wallet verify one address without downloading the
  account database;
- protocol-v22 ordered transaction commitments: every header carries the exact
  transaction count and Merkle root, while nodes return a logarithmic inclusion
  path for any finalized transaction;
- protocol-v24 indexed account-history accumulators: authenticated account
  leaves commit to the exact count and fixed-depth Merkle root of related
  transaction identifiers, so a wallet verifies a bounded page without trusting
  the node or downloading the complete history; redundant per-height disk
  journals are verified against consensus state, retain transaction inclusion
  envelopes, and rebuild a bounded-cache SQLite transaction locator plus
  disk-backed proof nodes without a block rescan;
- ML-DSA-65 post-quantum signatures for accounts and validators;
- native M-of-N ML-DSA-65 multisignature accounts for treasury custody;
- deterministic round-robin block proposers;
- finality certificates requiring at least `floor(2N/3) + 1` validator votes;
- separate evaluator and consensus registries with disjoint operator identities;
- consensus-native post-quantum epoch randomness with fixed committees,
  commit/reveal separation across block heights, state-root commitments and
  snapshot recovery;
- fixed per-epoch progress-reward budgets and the 21 million NIR hard cap;
- a ten-minute minimum interval between intelligence-reward blocks;
- proportional reward allocation from proof scores;
- ML-DSA-65-signed evaluation receipts bound to network and epoch;
- on-chain recomputation of progress scores;
- a world-capability memory root committed by genesis and every block;
- a complete deterministic state root committed by genesis and every protocol-v7
  block, covering monetary, mining, safety, randomness, validator, and peer state;
- pre-challenge binding of a bounded parent lineage plus consensus validation
  of behavior novelty and marginal frontier gain;
- permanent rejection of already rewarded proof fingerprints and canonical
  content commitments, including replay under a new key or package wrapper;
- ten-year linear treasury vesting by bounded block timestamps;
- signed candidate-bond transactions and consensus-recomputed critical-safety
  settlements with reporter/evaluator payouts and permanent supply burns;
- deterministic safety-committee assignment from a validator-quorum
  commit/reveal round after a candidate bond, with settlement restricted to
  that exact committee;
- domain-separated signatures and hashes;
- limits on block bytes, transactions, rewards, and numeric inputs.

Transfers may name a distinct fee payer. The sender signs the exact payment and
fee-payer identity; the sponsor then signs that complete sender-authorized
transaction under a separate `SPONSORED_TRANSFER` domain. Consensus advances
both nonces, charges the amount only to the sender and the fee only to the
sponsor. This allows wallet providers or merchants to onboard a user without
receiving custody or general signing authority over that user's funds.
Credit stake, usage, revocable allowances and pending exits are committed to the
same state root. Credits are not money and do not increase supply. An exit stops
earning credits immediately and returns after 64 blocks; its fee comes from the
exiting stake. Production pricing and wallet controls remain unfinished.

## Trust boundary

Validators attest identical evaluation metrics and the chain recomputes the
score, world-memory transition, allocation, uniqueness, signatures, and
monetary cap. Empty blocks do not consume issuance epochs. The chain does not
rerun an AI model inside block validation. `nir/runner.py` now creates a
deterministic proof bundle that binds artifact bytes, a later challenge, the
runtime manifest, complete independent outputs, resource measurements, and the
derived report. Its reference adapter reads data only and is not an isolation
boundary. Production still needs remotely isolated runners whose hardware
attestations sign these bundle commitments before they become evaluator
receipts.

`executionBundleHash` is consensus-required and covered by evaluator
signatures. A reward must also reference a signed candidate admission from an
earlier finalized block. The chain matches its candidate artifact/content,
baseline artifact and separate baseline canonical content commitment, parent
lineage, suite, recipient and height. After
finalization, more than two thirds of a separate
post-quantum beacon registry must sign domain-separated fresh shares. A
strictly later finalized epoch first assigns their exact committee from a
post-quantum commit/reveal seed that was unknown at admission time. Their
canonical aggregate derives the challenge and deterministic evaluator
committee. Successful and expired admissions are removed from state.

Canonical content uniqueness is deliberately narrower than semantic novelty.
The commitment is intended to hide artifact bytes and ignore packaging metadata
under an evaluation family's published canonicalization profile, but validators
cannot detect a false commitment or recognize transformed copies by themselves.
The reference runner implements the bounded
[`nir-model-content-v1`](model-content.md) directory/tar profile and recomputes
it before creating a bundle; it does not canonicalize arbitrary model formats.
Production families must restrict execution to the allowlisted content and run
the same check in independently administered environments. Exact commitment
history survives state snapshots, forks and replay through the
capability-memory root.

Admission requires a prior candidate-id-specific progress bond of at least 1
NIR. It may be paid by the author or a consenting sponsor, but binds one exact
author and cannot be reused. An unbound bond is never assigned a safety,
beacon, or evaluator committee and is reclaimed after 64 blocks if unused.
Successful evaluation refunds only the payer;
expiry after 1,024 blocks burns the entire bond rather than returning the cost
of an abandoned committee sample. The same burn applies to an honest timeout,
which is an explicit availability/economic tradeoff. Treasury sponsorship still
obeys vesting. This bounds rather than eliminates Sybil grinding: a wealthy
attacker can buy several independent attempts, and NIR must first vest or
circulate before the first bonded admission. Block limits, one pending
admission per author, and the 4,096-entry state cap remain additional bounds.
Production must deploy beacon authorities under genuinely independent control.
If their quorum is unavailable, new challenges pause safely instead of falling
back to proposer-controlled randomness.

Validator and initial evaluator identities in this version are configured at genesis,
and one configured operator cannot occupy both roles. This is not yet
permissionless consensus: operator identifiers are self-asserted, and there is
no consensus-connected external identity attestation. Genesis locks one fixed
minimum evaluator bond per identity by deducting it from the existing treasury
allocation. An objectively conflicting full-committee progress receipt burns
the reward, candidate collateral, and each guilty evaluator bond exactly once,
then disables those keys. Bonded replacements can fill only disabled vacancies
after a 64-block activation delay; old keys cannot rebond. This restores protocol
liveness without claiming that a new key or operator ID proves a different
company. Fork recovery and peer-to-peer transport remain separate mechanisms.
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

The ordered development and three-lane NIR architecture are documented in
[roadmap.md](roadmap.md).

## State commitment and snapshots

`stateRoot` binds every validator to the same balances, nonces, issued and
burned supply, reward epoch, rewarded proofs, progress commitments, candidate
bonds, randomness
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

The corresponding onboarding certificates are kept in a second redundant,
atomic journal and verified in lockstep with those handoffs. Each generation
therefore binds both the finality keys and the exact HTTPS origins, certificate
pins, and transport keys authorized for the next set. A recovering validator
can authenticate an old reachable peer, verify the complete paired history
from genesis, and use the newest verified topology for snapshot or block
catch-up. Shorter histories cannot roll back a topology already trusted on
disk. The node compares all authenticated responses it receives: stale prefixes
are harmless, malformed histories are ignored, and two cryptographically valid
but divergent branches fail closed instead of letting response order select a
network.

Dynamic P2P membership now has a pre-activation, mutually authenticated
endpoint-registration workflow so new-set commit and handoff votes are
reachable before activation. The local devnet generator still starts only a
static four-validator topology; multi-host deployment, operator ceremonies,
independent stable bootstrap services, and hostile-network recovery drills
remain production work.

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
