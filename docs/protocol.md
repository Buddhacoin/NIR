# NIR Protocol — Draft 0.1

## 1. Purpose

NIR turns independently verified improvements in machine intelligence into a
scarce digital bearer asset. The scarce resource is not computation itself but
the ability to convert computation and energy into reproducible capability.

The protocol has two separate planes:

1. **Money plane:** private, inexpensive, highly divisible peer-to-peer payments.
2. **Progress plane:** submission, challenge, evaluation, and reward of new AI
   capability.

Keeping these planes separate prevents ordinary AI usage or self-generated jobs
from minting currency.

## 2. Monetary constants

| Parameter | Draft value |
| --- | ---: |
| Maximum supply | 21,000,000 NIR |
| Atomic units per NIR | 100,000,000 |
| Intelligence-mining pool | 18,480,000 NIR (88%) |
| Builder/protocol treasury | 2,520,000 NIR (12%) |
| Initial epoch budget | 50 NIR |
| Halving interval | 210,000 epochs |

The treasury allocation is part of the fixed cap and must be time-locked. No
administrator may mint beyond the cap.

The builder/protocol treasury exists at genesis but is linearly spendable over
ten years according to bounded block time, with no cliff and no administrator
override. Intelligence-mining supply does not unlock with ordinary blocks or
elapsed time. The first accepted progress epoch has a 50 NIR budget; after each
210,000 rewarded epochs the budget is divided by two. Empty blocks neither mint
currency nor advance the reduction counter. Rewarded blocks must be separated
by at least ten minutes, so faster hardware or a fast block producer cannot
compress the entire issuance schedule into a short interval.

## 3. Proof of Intelligence Progress

A submission contains a content-addressed artifact, a frozen baseline, an
evaluation family, an energy report, and a bond. The artifact may be a model,
algorithm, training method, dataset transformation, architecture, or other
reproducible contribution.

After a commit/reveal deadline, randomly assigned evaluators test the artifact
against hidden and rotating tasks. Results enter a challenge window. A proof is
accepted only if enough independently selected verifiers reproduce it. The same
verifier set must run the frozen baseline and candidate so a deliberately weak
baseline cannot manufacture progress. Genesis v0.1 requires three distinct
verifier identities; production must additionally make those identities
Sybil-resistant and randomly assign them.

Each verifier signs an evaluation receipt containing the network, epoch,
benchmark commitment, artifact hashes, measured metrics, recipient, and derived
score. A block can issue NIR only when a finality quorum has signed the identical
receipt. Validators recompute the score; submitters cannot choose it.

One verifier key contributes at most one result for each artifact. Energy-based
scoring is eligible only when both baseline and candidate measurements are
attested. The artifact commitment covers the complete runnable package. A
separate `contentHash` is a `sha256:` commitment to a canonical,
metadata-independent representation of the contributed model or method without
publishing its bytes. The admission also commits to 1–32 sorted, unique parent
artifact hashes. For a production evaluation family, assigned evaluators must
recompute that canonical commitment inside the isolated runner; changing a
container label, archive ordering, submitter key, recipient, or wrapper metadata
must not change it. The reference runner implements only the bounded
[`nir-model-content-v1`](model-content.md) directory/tar profile; it is not a
general model canonicalizer.

The bounded runner format makes that boundary explicit. A candidate and known
reference each have a role-bound canonical bundle. `baselineHash` remains the
reference artifact/lineage identity; the separate `baselineContentHash` binds
the reference bytes. The world-memory root and snapshot include the exact
artifact-to-content mapping, and admission rejects any baseline pair that does
not match it. A candidate is content-addressed before the challenge
epoch. Each baseline/candidate transcript then commits to its canonical
content, static entrypoint digest/path, adapter, the same fresh seed and exact environment manifest, and the
final bundle commits to all outputs and the report. A consumed
candidate/challenge pair cannot be submitted twice. Local artifact and
canonical-bundle files can be rehashed during verification, so replacing either
after evaluation invalidates the bundle. The reference adapter reads an
allowlisted JSON entrypoint and never executes model code; it cannot establish
general isolated execution. `executionBundleHash` is mandatory in the chain evaluation and is
therefore covered by every evaluator signature and progress fingerprint. This
format supplies reproducibility and replay protection, not proof of physical
execution by itself; production acceptance additionally requires signatures
from independently operated isolated runners and genuine hardware attestation.

The chain resolves the bundle against a signed admission in finalized state.
It independently checks commit-before-challenge ordering and exact equality of
the candidate artifact/content, baseline artifact/content, parent lineage,
suite and recipient.
A later quorum of the independent
beacon-authority registry supplies domain-separated entropy. Each admission
records the currently unfinished epoch-randomness round. Only completion of
that round in later finalized blocks can fix one exact beacon committee, and
requires every member, preventing the aggregator from grinding across signer
subsets. The canonical aggregate selects the evaluator committee; neither a block proposer nor a
different evaluator quorum can substitute itself. If the beacon quorum is
offline, issuance waits: the protocol does not weaken randomness to preserve
liveness.

An admission is valid only after a separate finalized progress-purpose bond
locks at least 1 NIR against its exact `candidateId` and author. A third party
may sponsor a small participant, but the sponsor signs the lock and is the only
refund address. Merely locking an unbound bond reveals no committee; an unused
lock returns after 64 blocks. Successful evaluation moves a bound bond into the
64-finalized-block reward escrow and refunds it only after that window; an
unrewarded admission burns the full bond after 1,024
blocks. There is no free cancellation after committee assignment, so honest
timeouts also lose the bond. This removes the free multi-key/wrapper sampling
path but does not make the protocol Sybil-proof: capital can still buy multiple
samples. Candidate collateral still requires vested or circulating NIR. Evaluator
eligibility has no circular first-reward dependency: genesis deducts one fixed
minimum bond per evaluator from the existing treasury allocation and commits the
locked balances in state and in the public ceremony plan.

The minimum bond is only an admission floor. A rewarded claim is accepted only
when its exact allocated reward is no larger than its bound bond; otherwise the
whole reward block is invalid. A lone claim in the first issuance epoch must
therefore have 50 NIR locked, while several claims may lock their smaller exact
allocations. The bond and reward remain unavailable through the objective fraud
window. Full assigned-committee equivocation burns both plus every equivocating
committee member's entire evaluator bond, disables those keys exactly once, and
refunds other admissions already assigned to them. A disabled key cannot rebond.
Permissionless replacements lock the same minimum, use a unique address and
self-asserted operator ID, fill only vacant active-set slots, and wait 64 finalized
blocks. This recovers quorum without treating a new key as proof of a new company;
capital can still fund colluding replacements. Private execution dishonesty remains
outside the objectively provable subset.

This removes the block hash and its proposer from committee selection. A
malicious assigned epoch member can stop progress by withholding its reveal,
but cannot make consensus accept another subset or alternate seed. Protocol
v16 limits that stop: after eight later blocks, consensus records every
non-revealer, excludes it, clears partial contributions and retries the same
round with a new deterministic committee. No timeout manufactures randomness.
Protocol v17 adds native beacon bonds. A genesis beacon authority can lock NIR
with a signed transaction. Enforcement activates irreversibly only after every
genesis authority reaches the minimum, avoiding a circular launch dependency.
After activation, a timeout burns one percent of each non-revealer's bond and
increments its consensus fault count. An authority that falls below the minimum
is disabled from later epoch committees; the timeout still never creates a seed.

### Epoch-randomness transition

The operator module now implements the replacement state machine independently
of consensus. The previous epoch seed deterministically fixes one committee.
Every member signs a commitment to a private 32-byte share; reveals are refused
until all commitments exist in an earlier height. The next seed hashes the
previous seed and every ordered reveal, and advances only when the exact
committee is complete. A missing member can stop the round but cannot make the
protocol accept an alternative subset or a forged reveal.
Protocol v14 accepts signed commitments and reveals as separate block
collections, commits their phase transition to the state root, carries them
through network proposals, restores them from snapshots, and refuses reveals in
the commitment height. Protocol v15 binds progress admissions to the unfinished
round and assigns their beacon committees only after its seed is finalized.
Protocol v16 adds deterministic timeout faults and safe same-round rotation.
Protocol v17 turns those state-rooted faults into native bond burns and disables
an under-bonded offender from future epoch committees.

### Transfer Credits

Protocol v18 added a Pay-lane resource separate from money. A signed
`credit-stake` transaction locks NIR. Every complete 100 NIR unit supplies ten
ordinary-transfer credits per 720-block epoch. A sender can consume its own
credit, or a distinct sponsor can bind one of its credits to the complete
sender-signed transfer with the existing second post-quantum signature and
independent nonce. Credit-paid transfers carry zero NIR fee; all other transfers
still satisfy the minimum fee. Consensus permits at most 100 credit-paid
transfers in one block, so stake cannot purchase unbounded free ingress.

Credits are state-rooted usage rights, cannot be transferred as money, do not
increase supply, and reset lazily by block height rather than validator-chosen
time. Protocol v19 adds per-account standing allowances that the stake owner
can update or revoke, and a two-step exit: active stake stops producing credits
immediately, then returns after 64 blocks. The exit request pays its fee from
the exiting stake, so a fully staked account cannot be trapped for lacking a
liquid fee balance. The present values are test-network parameters. Wallet
controls and validator compensation for credit traffic remain required before
mainnet.

All direct, sponsored and delegated use is charged to one stake owner's common
epoch counter; delegated use also consumes its signed per-delegate limit.
Account-level rounding means splitting fixed stake across Sybil addresses never
increases the aggregate quota. Positive delegation limits cannot be lowered
below current-epoch consumption, keeping live state identical to the snapshot
invariant; limit zero is an explicit revocation. These rules do not provide
fair scheduling: capital can buy more quota, validators can censor, and aligned
epoch renewal permits a bounded two-block boundary burst. The separate
per-block cap remains the final consensus bound on credit-paid ingress.

## Protocol v20 compact finality headers

Every non-genesis block hash is the domain-separated hash of a compact finality
header. The header contains the network, height, previous block hash, timestamp,
protocol version, state root, capability root, peer-registry hash and a
domain-separated commitment to every remaining unsigned block field. Validators
prepare and commit that header hash. A light client can therefore verify the
continuous finalized history and the exact active validator quorum while a full
node retains and executes the committed block body.

## Protocol v21 authenticated account state

Every finalized header also contains `accountStateRoot`, the root of a
fixed-depth sparse Merkle tree keyed by the complete 256-bit NIR address. A
non-empty leaf commits to the canonical balance, nonce, locked Transfer Credit
stake, currently available credits, outbound delegations and pending delayed
exit. The deterministic empty leaf permits proofs that a fresh address has no
state. Membership and absence proofs contain exactly 256 sibling hashes and are
verified locally against the account root from the already verified finality
header. Account attestations remain as an independent quorum signal, but cannot
make a balance pass if its Merkle path is invalid.

## Protocol v22 transaction commitments

Every finalized header commits to the ordered transaction count and Merkle
root. Leaves bind both the complete signed transaction identifier and its exact
index, so reordering, substitution and duplicate-position ambiguity change the
root. Nodes expose a logarithmic inclusion path for a finalized transaction.
The local wallet stores the compact header chain in a checkpoint-anchored,
atomically replaced file. For every displayed operation it independently
reconstructs this root from the complete signed transaction and its inclusion
path. A missing, altered, reordered or unrelated transaction is hidden rather
than presented as wallet history.

## Protocol v24 paginated account history

Each authenticated account leaf also commits to an ordered history count and
fixed-depth indexed Merkle root. Consensus appends a transaction identifier
exactly once for each distinct sender or recipient after that transaction
executes successfully. The compact frontier is part of complete chain state;
only its count, format and root enter the public account leaf.

A node serves bounded pages with the absolute index and a 32-sibling proof for
every identifier. The wallet fixes the expected interval from the authenticated
count, rejects gaps, extra entries and shifted indexes, then verifies every path
against the authenticated root. It therefore downloads only the newest page,
while omission, insertion, substitution or reordering still fails locally.

The index is a recoverable serving layer, not a second source of consensus.
Every record is chained to the previous index record and finalized block; after
loading it, the node recomputes every account commitment and compares it with
verified chain state. Deleting or rewriting the index cannot change balances or
history roots. It can only make that node temporarily unable to serve history,
at which point recovery must come from retained verified blocks or a separately
verified archive copy.

Storage format `nir-account-history-index-v2` additionally retains each
transaction body, its ordered block position and inclusion path. On load, every
identifier is recomputed and every path must reach the recorded transaction
root. The node rebuilds a SQLite serving database containing a direct identifier
locator, account positions and per-level Merkle nodes as it replays the
append-only index. Pages and proof siblings are read from disk with bounded
queries. This database alters query cost only; clients still verify returned
paths against finalized headers and authenticated account roots. Its account
counts and roots must match chain state. A versioned database checkpoint also
binds the cache to the network, finalized height, tip and latest redundant
journal record. Matching caches pass an integrity check and are reused directly;
missing, corrupt or unknown schema versions are deterministically rebuilt rather
than migrated in place.

### Multi-source archive recovery

Long-term history recovery uses `nir-history-archive-manifest-v1`. A manifest
commits to one exact finalized checkpoint, the complete history-index content
root, record count, and a continuous list of bounded chunk hashes. The manifest
is signed with ML-DSA-65 under a dedicated archive-approval domain.

A receiver has an explicit local set of trusted archive identities and requires
matching verified content from at least two distinct signers reached through
distinct source identifiers. One signer presented through several addresses is
counted once and rejected as false independence. Every chunk is size-bounded,
canonically encoded and hash-checked before parsing. The reconstructed records
then pass the same complete index-chain, transaction-inclusion, account-history
and finalized-checkpoint verification used for local storage. Thus archive
operators can restore availability but cannot rewrite monetary or transaction
history.

The receiver verifies two complete staged journals before persisting an
installation marker. That marker makes activation resumable: it remains present
while live copies are replaced and is synchronized away only after both new
copies pass full checkpoint verification. An interruption therefore leaves
either the prior live generation or a verified staged generation from which
startup can finish; it never makes a partial journal authoritative.

Remote exchange separates the small signed manifest from immutable chunk
responses. A receiver authenticates the configured operator, signature and its
own finalized checkpoint before requesting any chunk. Remote redirects are
disabled; URLs cannot contain credentials; production sources require HTTPS;
response bytes, time and concurrent requests are bounded. After all committed
chunks arrive, the receiver repeats complete archive verification before the
operator can count toward multi-source agreement. Transport confidentiality and
availability complement these checks but do not replace content signatures or
local consensus roots.

Multi-source agreement is manifest-first. Two or more independent configured
signers must attest the same history content root, but the receiver need not
download duplicate copies of that content. It streams one agreed operator's
bounded chunks to a private temporary directory, rechecks every chunk while
iterating records into the staged redundant index, and falls back to another
agreed operator on failure. Only compact `{height, blockHash, indexHash}` tuples
are fed into an incremental content-root hash; neither those tuples nor
transaction bodies are retained as a second in-memory archive during
installation.

Operator membership is not currently selected by consensus. Production must
distribute operators across independent organizations and failure domains,
publish rotation policy, deploy authenticated transports, and rehearse total
loss and interrupted-installation recovery.

### Draft score

For an accepted proof `p`:

```text
quality(p) = positive_gain
             × generality
             × reproducibility
             × safety
             × novelty

efficiency(p) = clamp(baseline_energy / candidate_energy, 0.5, 2.0)

score(p) = quality(p) × efficiency(p)
```

An epoch has a fixed issuance budget. Accepted proofs split it proportionally:

```text
reward(p) = epoch_budget × score(p) / sum(score(all accepted proofs))
```

Consensus computes this allocation over the fingerprint-sorted accepted set,
uses integer atomic units, and assigns any rounding remainder by score and then
fingerprint. Thus claim order, recipient-key count, and candidate count
cannot increase the epoch budget. A non-empty rewarded block consumes exactly
`min(scheduled_epoch_budget, remaining_mining_pool)`; an empty block consumes no
issuance epoch. The ten-minute consensus interval still applies between
rewarded blocks, and the 21 million NIR cap truncates the last budget.

Consensus additionally caps evaluator-reported positive gain at
`100 × novelty_bps`, where `novelty_bps` is recomputed from the state-rooted
world-frontier transition. Choosing an old or weak but known baseline therefore
cannot inflate the score beyond the candidate's measured marginal frontier
movement. The submitter and reward recipient addresses must not be registered
validator, beacon, or evaluator keys.

This prevents a submitter from choosing the number of minted coins, but it does
not make allocation independent of censorship. A proposer or finality cartel
can omit otherwise valid claims; the claims that remain in the block then split
the same epoch budget. Canonical content, behavior and frontier memory prevent
an exact accepted contribution from being paid again across restart, replay or
fork, but do not prove broad semantic equivalence. A wealthy organization can
fund many genuinely distinct bonded candidates and can capture an epoch if all
included valid progress is its own. The rules bound the issuance rate; they do
not promise company-neutral reward distribution or monopoly resistance.

### What the score does not claim

NIR does not claim that intelligence has a universal physical unit comparable
to a joule. The score is a protocol-defined accounting measure produced by a
published evaluation constitution. Different evaluation families must not be
silently combined without calibration.

The current evaluator uses exact-answer tasks to make the state transition
deterministic. It is not a universal intelligence test. A production family
needs its own frozen grader, minimum sample size, confidence threshold,
contamination probes, adversarial cases, and human review rules where automatic
grading is not reliable.

## 4. Required defenses

- **Benchmark secrecy:** hidden tasks are committed before submissions and
  revealed after the epoch.
- **Evaluator capture:** random selection, heterogeneous operators, bonds, and
  conflicting-result slashing.
- **Role capture:** evaluation and block-finality keys belong to disjoint
  operator registries, and those exact keys cannot submit a progress candidate
  or receive its issuance. Distinct keys and operator IDs do not prove that the
  people or companies controlling them are independent.
- **Duplicate work:** the canonical content commitment is permanently recorded
  in the capability-memory root, and lineage is fixed before challenge. Exact
  commitment replay under a new key, wrapper or transcript is rejected.
- **Benchmark gaming:** rotating task families and out-of-distribution tests.
- **Energy fraud:** signed hardware telemetry plus statistical and spot audits.
- **Safety regression:** a safety floor can reject a proof regardless of gain.
- **Critical danger:** one critical failure in any independent run vetoes
  issuance; only safety policies committed in genesis are valid.
- **Deliberate vulnerability farming:** a confirmed unsafe candidate receives
  no issuance; its bond funds a bounded bounty and at least 20 percent is burned,
  so a submitter/reporter/evaluator coalition cannot profit from its own defect.
- **Tiny-test farming:** minimum absolute gain and breadth thresholds.
- **Whale control:** asset ownership does not equal evaluator or governance
  control; selection must not be purely stake-weighted.
- **Quantum migration:** addresses and signatures need crypto-agility from
  genesis, with versioned post-quantum signature suites and migration paths.

The operator-security prototype requires two independently signed external
credentials for every operator, a minimum bond, deterministic committee
selection, and replay-protected evidence that can confiscate a bond when one
operator signs two incompatible statements for the same slot. Committee
randomness is safe only when it becomes available after the complete candidate
commitment is final. Consequently this component must not authorize issuance
until an on-chain commit/future-randomness/evaluate state machine is connected.

The chain enforces this ordering as an admission state machine: an artifact,
canonical content digest, bounded parent lineage, baseline, suite, recipient,
and epoch are committed first; only a later
post-quantum beacon quorum can assign the complete evaluator committee; the
assignment cannot be replaced, shortened, duplicated, or synthesized from the
safety-fallback signature domain. Admissions and assignments are consensus
state and therefore replay identically on every validating node.

Identical incorrect votes do not, by themselves, cryptographically prove
collusion. Penalizing coordinated fraud needs an objective fraud proof or an
explicit dispute process; a simple majority accusation is not sufficient.

Candidate safety bonds are now locked by signed ledger transactions. A later
validator-quorum commit/reveal round assigns the complete safety committee, and
only that committee may sign a critical-failure claim under a genesis-approved
policy. Every validator recomputes the assignment and the 70/10/20
reporter/evaluator/burn allocation; supplied committee members and payout
amounts are not trusted. Settled evidence and consumed candidate bonds cannot
be replayed. The current multi-party seed is unpredictable when at least one
contributor is honest, but a last revealer can still withhold. At the timeout,
the chain combines available reveals with independently generated shares signed
by more than two thirds of a separate genesis beacon-authority registry. Every
node verifies the shares and hashes them into one deterministic fallback value,
so the aggregator cannot choose it. Beacon identities
must be disjoint from validators and evaluators. This prevents one wealthy
validator from predicting the fallback committee before deciding to withhold;
the missing reveal is still slashed. A separately deployable service and
aggregation tool now provide the transport boundary. Production still needs
operators on independent infrastructure, monitoring, failure exercises and an
external audit.

The chain now accepts signed validator-bond transactions, locks their balance,
and requires the draft 10 NIR minimum before accepting a randomness commitment.
For a proven non-reveal, every validator burns one percent of the offender's
remaining bond, records the fault, and refunds the candidate bond. Falling below
the minimum removes eligibility for later randomness rounds. These are test
parameters, not final economics. Finality membership can now rotate through an
old-quorum-certified schedule: every member must be registered and bonded,
activation is delayed by at least five blocks, and at least one third of the old
set must remain. From the activation height, only the new set can propose and
certify blocks; the first such block needs quorum certificates from both sets.
Validator exits and bond-withdrawal delays remain unfinished.

## 5. World capability memory

NIR does not reward possession of knowledge already demonstrated by existing
models. Before issuance starts, reference models form a sealed, unrewarded
world-capability snapshot. For each evaluation family the ledger remembers the
best verified score, model lineage, artifact commitment, canonical content
commitment, and behavioral-output commitment.

A renamed model, a bot repeatedly calling an existing API, or a known model
compared with a deliberately weak baseline earns nothing because it does not
move the world frontier. A candidate is novel only for the measured marginal
delta above the previous best. Its challenge is derived after the complete
artifact is committed, so stored answers cannot be prepared for the exact test.
Every challenge-free matured change produces a new deterministic memory root;
pending escrow evaluations are reservations and are not valid baselines.
That root is committed by genesis and every block, so all validators must apply
the same history before they can finalize another intelligence reward.

This is exact commitment replay protection, not semantic plagiarism detection.
Consensus cannot tell whether two genuinely different byte commitments embody
the same idea, share unreported training data, or differ only through an
adversarial transformation. It also cannot prove that a claimed `contentHash`
was honestly derived from private weights; independent isolated runners must
recompute it and the assigned evaluator quorum must attest it. A captured
evaluator quorum can still lie, as described in SR-01 of the security review.
No model weights or private artifact bytes are placed on chain.

This defines two different things:

- **knowledge** is information or an answer that can be copied;
- **intelligence progress** is a reproducible increase in capability on fresh,
  procedurally generated tasks, including transfer to unseen variations.

The memory stores commitments and capability measurements, not private model
weights or the world's conversations.

## 6. Open research questions

Before any public testnet, the project must specify:

1. the first narrow evaluation family;
2. reproducible execution environments;
3. energy attestation hardware and audit rules;
4. evaluator selection without stake capture;
5. post-quantum selective-privacy architecture, viewing keys, and payment
   disclosures for payments and model submissions;
6. post-quantum signature and zero-knowledge proof choices;
7. treasury vesting, spending transparency, and founder allocation;
8. applicable securities, payments, sanctions, tax, and privacy law.

## 7. First realistic milestone

The first testnet should reward progress on one open, inexpensive benchmark
family. It should use valueless test units. Only after adversarial trials show
that duplicate submissions, evaluator collusion, energy falsification, and
benchmark overfitting are controlled should monetary deployment be considered.
