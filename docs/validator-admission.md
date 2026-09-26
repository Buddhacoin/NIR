# Validator candidate queue (protocol v31-v33)

Protocol v31 adds an open candidate queue. It does **not** yet implement automatic validator
churn or fully permissionless active membership: the current finality quorum still authorizes the
size and timing of a rotation. If a rotation adds `k` newcomers, however, it must choose exactly
the first `k` eligible queue entries and cannot skip an earlier candidate.

## Candidate lifecycle

1. Submit `validator-admission` with exactly the provisional testnet minimum validator bond, a
   unique validator identity/operator id, HTTPS origin, SHA-256 TLS certificate pin, and a separate
   transport key possession proof. A larger bond cannot buy priority.
2. Current validators make a pinned-TLS connection outside consensus and sign the domain-separated
   live-observation payload. The candidate submits the sorted 2/3-quorum certificate through
   `validator-admission-readiness`. A self-asserted endpoint or transport proof is not readiness.
   The observation is valid for at most 16 blocks and must remain valid beyond the planned
   activation height; candidates refresh it with a new account nonce without losing queue rank.
3. Readiness becomes eligible after 64 finalized blocks. Entries expire after a further 256 blocks.
   A candidate already selected in a pending rotation does not expire before activation.
4. Queue order is finalized submission height first, then a deterministic hash/address tie-break
   within the same height. The same-height tie-break is not random and key grinding remains a known
   Sybil limitation for a later randomness-based selection release.
5. Expiry refunds the full bond and permanently retires that validator identity. No provisional
   expiry burn is introduced. Fees and capital lock are therefore the only current Sybil costs.

An active validator excluded by a finalized rotation is requeued without stale readiness when its
bond remains sufficient, and must obtain a fresh live-observation certificate. An older inactive
registration with no full bond may enter by submitting the exact v31 admission transaction.

### Live-readiness proof artifacts

The first live-readiness acquisition slice defines canonical, domain-separated artifacts without
changing consensus state or the protocol version. A context binds the exact finalized checkpoint
height, block hash, state root, validator-set ID, admission identity, endpoint, TLS fingerprint,
transport identity, account nonce, and 16-block observation expiry. An active observer signs a
fresh random challenge. The candidate response proves simultaneous control of the admitted
transport and consensus keys: the transport identity signs the response core first, and the
candidate consensus identity separately signs that core together with the transport signature.
The observer then signs the existing consensus live-observation payload and a separate result
commitment over the context, challenge, response, observation, and observer identity. This second
signature pins the result to the exact checkpoint and fresh challenge even though the legacy
consensus observation payload does not contain the checkpoint block hash or state root.

An observation receipt retains all of these proofs. A canonical readiness certificate contains
exactly the current validator quorum of distinct, address-sorted receipts and matching consensus
attestations, and has status `certificate-collected`. Every challenge, receipt, and certificate
path recomputes the validator-set ID from the supplied normalized active validators and requires it
to match the checkpoint commitment. Creating or verifying these artifacts is
read-only: it does not set the queued admission's readiness flag, consume its nonce, submit a
transaction, or claim selection or activation. Network collection and candidate/validator runtime
services are separate slices.

## Protocol v32 admission lifetime

Protocol v32 replaces the v31 admission authorization with a chain- and height-bound envelope. Both
the candidate identity and the separate transport identity sign the exact
`chainIdentityGenesisHash`, `referenceHeight`, and `validUntilHeight`. The reference must be an
already finalized pre-state height, and `validUntilHeight` must equal `referenceHeight + 64`.
Consensus accepts the transaction through that exact height and rejects it starting with the next
block, before changing a balance, nonce, bond, identity registry, or queue entry.

The 64-block transaction lifetime is a provisional testnet replay/mempool parameter, not a
validator eligibility rule or final economics. At v32 activation, a still-pending v31-format
admission is invalid and nodes evict it from their persisted mempool. A user must create a fresh v32
authorization from a proof-backed finalized context. Mempool eviction performs one envelope check
per admission and only discards an expired/wrong-era envelope or a nonce already consumed in
finalized state; it keeps future nonces and funding dependencies for ordered proposal validation.
Readiness certificates and the candidate queue record remain the v31 mechanism.

## Protocol v33 readiness epochs

Protocol v33 prevents a live-observation certificate from becoming valid again after validator
membership or the active peer registry changes. Consensus persists a
`validatorReadinessObservationFloor` alongside the queue. Selection requires both the exact current
`validatorSetId` and an `observedHeight` at or above that floor; matching an older set ID after an
`A -> B -> A` history is insufficient.

The v32-to-v33 activation resets every pending readiness certificate and advances the floor to the
activation height. This deliberately requires one fresh observation because v32 snapshots did not
record a membership-transition floor. Any later peer-registry activation also advances the floor
and clears certificates observed before it. An ordinary validator rotation preserves the selected
entries only until activation (when they leave the queue), clears readiness for every non-selected
entry, and advances the floor to the activation block. Recovery activation does the same for the
entire pending queue. The floor and cleared records are state-rooted and included in snapshots, so
full replay, snapshot restore, forks, and restart cannot disagree about certificate freshness.

## Upgrade migration

At v31 activation, active validators stay active and are not queued. Inactive registrations with a
full minimum bond become legacy pending candidates and must submit readiness. Inactive dust bonds
are refunded in full and their incomplete registrations are removed, preserving supply. Activation
fails closed while a validator rotation or recovery plan is pending. Protocol v24-v30 state schemas
and roots do not contain the queue.

The delay, expiry, capacity (256), and per-block admission cap (16) are provisional testnet safety
parameters and are not final mainnet economics. Permanent retired-validator tombstones are bounded
to 512; consensus reserves room before accepting a new identity, then fails closed at the cap.
A future release needs a compact authenticated accumulator before sustained public churn.
