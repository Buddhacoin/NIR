# Validator candidate queue (protocol v31, v32 authorization envelope)

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
