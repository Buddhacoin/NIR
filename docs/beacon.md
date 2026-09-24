# Independent beacon operations

One independently operated service exposes two cryptographically separated
purposes. `progress` is mandatory for assigning an unpredictable AI evaluation
challenge after its candidate commitment is final. `fallback` is used only when
a bonded validator commits a safety-randomness contribution and then withholds
its reveal.

Each authority produces its own unpredictable 32-byte share and signs it with
a separate ML-DSA-65 wallet. Progress and fallback signatures use different
domains, so a share cannot cross purposes. The chain accepts an aggregate only when more
than two thirds of the active beacon generation signed distinct shares for the
same network, candidate, generation, and round. For a progress admission, a later finalized
epoch-randomness round selects one exact committee from its commit/reveal seed
and requires every selected signature.
It deterministically hashes those shares, so an aggregator cannot alter a share,
drop a signer, add a reserve signer, or choose among subsets after disclosure.
The fallback safety path still accepts any valid quorum and therefore retains
limited subset choice; it never supplies intelligence-mining challenges.

## Run one authority

Create a dedicated wallet vault on an offline-controlled machine, then run:

```bash
npm run beacon:serve -- /absolute/path/beacon-wallet.nir nir-testnet 8791 127.0.0.1
```

The password is read interactively and never accepted through command-line
arguments or environment variables. The service exposes:

- `GET /health` — public address, algorithm and network;
- `POST /v1/share` — authenticated JSON containing `candidateId`, non-negative
  beacon `generation`, integer `round`, and `purpose` equal to `progress` or
  `fallback`.

Omitting `purpose` selects `fallback` for backward compatibility. A service
persists an append-only decision file beside its vault and returns
the same signed share when the same purpose, candidate and round are requested again,
including after restart. Back up this `.beacon-state.json` file: deleting or
rolling it back permits equivocation and randomness grinding. Run the service
behind mutually authenticated TLS, request limits and monitoring; never expose
the development HTTP listener directly to the Internet.
The CLI accepts only the numeric loopback addresses `127.0.0.1` and `::1`.
Hostnames such as `localhost` are rejected because local name resolution is not
a sufficient bind-address security boundary.

After collecting at least three shares in separate files, an untrusted
aggregator can construct the claim:

```bash
npm run beacon:aggregate -- nir-testnet CANDIDATE_HASH ROUND a.json b.json c.json
npm run progress-beacon:aggregate -- nir-testnet CANDIDATE_HASH ROUND a.json b.json c.json
```

Each share file must be a private, canonical JSON regular file produced by one
unique authority. Aggregation rejects symbolic or multiply linked files,
group/world-writable files, repeated file identities, duplicate authorities,
oversized inputs, mismatched context, and files changed while they are read.
The aggregate is emitted as canonical JSON so independent operators can compare
the exact same bytes before using it as launch evidence.

The aggregate itself is not trusted: every full node verifies every authority
signature, recomputes the aggregate and enforces the on-chain quorum. For
`progress`, request shares only from the addresses returned by the admission's
`progressBeaconCommittee`; substituting another registered authority fails.

## Independence requirements

Production should begin with at least four authorities. They must be operated
by different legal or community entities, on different hosting providers and
administrative accounts, with separate vault backups and incident contacts.
No authority may also be a finality validator or intelligence evaluator.

Code cannot create organizational independence. Before mainnet, operators must
publish their public keys and deployment attestations, perform a coordinated
failure exercise, and commission an external audit. The repository provides
the service and verification path; it does not claim that those external
operators or the audit already exist.

The admission records the unfinished epoch round and cannot use an already-known
seed. Committee selection waits until every member of that epoch's fixed
committee reveals a previously committed share in a later block. A producer can
censor and delay progress, but its block hash no longer selects the committee.
If a committed member withholds past eight blocks, the chain records and
excludes it, erases the incomplete attempt and rotates the same round. It does
not derive a seed from the surviving subset.

## Native bond

Each genesis authority can lock at least 1,000 NIR with a signed `beacon-bond`
transaction. Bond enforcement activates irreversibly when every authority has
reached that threshold; before that moment the network is explicitly in its
bootstrap phase. After activation, failing to reveal burns one percent of the
operator's current bond. If the remaining balance is below 1,000 NIR, the
operator is disabled from subsequent epoch committees. The burn, remaining
bond, fault counter, disabled set and activation flag are all state-rooted and
recomputed by every node.

## Authority rotation

After bond enforcement activates, a new key may enter a bounded 256-entry
admission queue by locking exactly the fixed minimum bond under a unique address
and operator ID. Paying more cannot improve priority. The candidate becomes
eligible after 64 finalized blocks, but admission alone grants no committee or
live-registry role. A rotation is one canonical, state-rooted proposal containing
the network, monotonically increasing generation, current and next set hashes,
the complete next registry, and an activation height at least 64 finalized blocks
ahead. It requires signatures from more than two thirds of the current set plus
a possession signature from every next key. The next registry has the same
bounded size, at least one third of its addresses overlap the old registry, and
every member must remain fully bonded. A proposal with a stale generation,
foreign network, wrong parent set, insufficient overlap, duplicate identity,
missing possession proof, or reused approval fails closed.

When a handoff needs new members, consensus requires exactly the lowest canonical
admission ranks among candidates that are eligible and remain unexpired through
the proposed activation height. The rank commits the network, submitted height,
address, public key, and operator ID; transaction order and bond size cannot
change it. The old quorum still chooses how many old members remain, but cannot
skip a higher-priority eligible newcomer for a preferred wrapper. An unselected
candidate expires 256 blocks after eligibility: ten percent of its bond burns,
the remainder returns automatically, and its identity becomes a permanent
tombstone. A selected candidate stays locked through its already-scheduled
activation. This bounds queue occupancy and makes repeated flooding costly.

### Quorum-receipted inclusion

The validator runtime gives a new `beacon-bond` transaction an inclusion receipt
only after validating it by itself against finalized state. It therefore cannot
rely on an unfinalized funding transaction: the exact minimum bond and fee must
already be available under the transaction nonce. A receipt binds the network,
transaction ID, sender, nonce, accepting height, next-block inclusion height,
eight-block forensic expiry, and active validator-set commitment. A client has an
inclusion promise only after independently verifying receipts from more than two
thirds of that exact set. Duplicate signers, mixed transactions, stale receipts,
foreign networks, and forged signatures fail closed.

Each signer durably stores the exact transaction and receipt before acknowledging
it, reloads both after restart, and refuses to prepare, commit, time out, or install
the next-height block if it omits that transaction. Protected admissions are
ordered ahead of ordinary mempool entries and the queue has at most 256 slots,
below the 1,000-transaction block limit. A receipt quorum and any finality quorum
therefore intersect in enough honest validators to prevent omission under the
normal less-than-one-third Byzantine assumption. Validators need not have
identical mempools; only signers of this exact receipt acquire the obligation. A
receipt signer that nevertheless signs the omitting finalized block leaves
objective evidence from its receipt and commit signature. The bounded evidence
carries the receipt quorum, finalized header, ordered transaction IDs, and exact
receipt/commit signer intersection. Consensus reconstructs the transaction root
and compares it with the immediately previous finalized block; evidence is
accepted only in the next block. It consumes only intersection signers' bonds,
pays ten percent of those locked funds to the reporter, and burns the remainder.
No NIR is issued, and offline, non-signing, receipt-only, and commit-only
validators are not penalized. Replay, mixed generations, altered transaction
lists, late reports, and duplicate evidence fail atomically. Snapshot fast-forward
fails closed while an inclusion obligation is outstanding because
the current snapshot format has no exact transaction-inclusion proof; the signer
must replay the promised block, which clears the durable receipt atomically.

The off-chain receipt is not global state and does not make an unseen transaction's
absence globally provable. A submitter must first reach a validator quorum; a
network or finality cartel able to prevent that can still censor the initial
request or refuse a receipt quorum. Receipt-side reservation makes a receipted bond unavoidable while the
honest quorum remains live, but it is not an on-chain lock until the promised block
finalizes. Minority acknowledgements are not a promise. Evidence is deliberately
limited to the previous finalized block, removing reorg/history ambiguity but
requiring prompt reporting. Receipt issuance is refused across a validator-set
activation boundary. Slashing a Byzantine intersection can leave finality without
a quorum; it exposes and prices the violation but cannot restore liveness or prove
operator independence. This is not full censorship or Sybil resistance.

The activation height is a hard generation boundary. No epoch, progress, or
fallback beacon contribution is accepted in that block. The epoch machine drops
the unfinished old-generation attempt, advances the round, and derives a new seed
from the prior seed and both set commitments. All epoch, progress, and fallback
shares include the generation in their signed payload, so an overlapping key's
old signature cannot replay after activation. Any still-pending progress admission
is deterministically cancelled and its candidate bond refunded at activation;
this avoids leaving a committee tied to removed keys. A claim already completed
before the boundary is unaffected. If a proposed member falls below the bond
minimum before activation, the pending rotation is cancelled rather than
installing an under-collateralized registry.

Active and registered registries, generation, pending proposal, bonds, and epoch
machine are included in snapshots and the state root. Restart and fork recovery
therefore reproduce the same boundary. Local real-service rehearsals obtain the
active registry from verified chain state rather than treating the genesis list
as permanently current.

An authority removed at activation automatically enters retirement. Consensus
also starts that transition for any inactive live registration not selected by a
pending rotation; this prevents a legacy standby registration from holding
headroom indefinitely. An inactive authority may request the same transition
explicitly and pay its request fee from the locked bond. After 64 further
finalized blocks, consensus returns the remaining bond, removes the live
registration, and frees one of the 128 registry slots. Any earlier slash
stays burned; only the remaining bond is returned. A disabled authority therefore
must first be rotated out, but is not forced to abandon its unslashed remainder.
Registration, retirement, and rotation cannot be combined in one block. A fixed-delay automatic maturity
prevents a pending retirement from reserving a slot indefinitely.

Retirement preserves a state-rooted historical record containing the exact
address, public key, operator ID, fault count, retirement height, and a canonical
identity commitment. A retired address, public key, or operator ID can never
register again as a beacon, validator, or evaluator. Old snapshots retain their
original registry, while later snapshots retain this tombstone, preventing an
old signed identity from being presented as a fresh operator after restart or
fork. Pending retirement and tombstone state are validated on snapshot restore.

This mechanism proves key possession, old-set authorization, bond, and protocol
continuity. It does not prove that nominally different authorities are controlled
by different companies, nor guarantee that the next operators remain available.
The active set remains capped at 64 and the live registered-key registry at 128,
leaving enough headroom for the least-overlap permitted 64-member handoff before
old keys retire. Queued candidates do not consume this live headroom; only the
deterministically selected candidates enter it, while outgoing members are put
on bounded retirement automatically. Finalized retirements recycle those slots. Historical tombstones deliberately grow with
cumulative churn because exact replay prevention and old-proof auditability are
retained; this version does not claim constant-size historical state. The queue
is an economic anti-spam mechanism, not proof of independent control: a wealthy
coalition can fund many self-asserted operator IDs and may dominate deterministic
priority, while a proposer can censor submissions. Fixed bonds, delayed eligibility,
bounded capacity, expiry loss, and identity tombstones make that attack finite
and costly; they do not prove company independence or eliminate censorship.
