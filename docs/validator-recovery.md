# Precommitted validator recovery

`RecoveryPlanV1` is a narrow finality-recovery mechanism for one objective
failure: a finalized validator-admission omission proof whose deterministic
slashing leaves fewer than the old-set quorum enabled. It is not a timeout
takeover, an operator override, or a general fork-choice rule.

A normal finalized block schedules `nir-validator-recovery-plan-v1` at least
64 heights before it can be used. The plan binds the network, current validator
set, next recovery generation, equally sized reserve set, and (when peer
discovery is active) an exact replacement transport registry. Every reserve
must already be registered, independently identified, disjoint from the active
set, and backed by the normal validator bond. Every reserve consensus key signs
the plan; every declared transport key separately proves possession. This is a
cryptographic role-separation check, not proof that operators are independent
companies.

Recovery requires the next block at exactly `H+1`, where `H` is the finalized
omitting block. A reserve quorum first prepares and commits an exact checkpoint
over the old tip, then prepares and commits the sole recovery proposal. Reserve
software persists one checkpoint and proposal lock per generation, so restart
cannot authorize a split view. A generation is globally single-use:
height changes and competing forks do not release its lock. The production
signer API re-reads the journal while holding an exclusive filesystem lock,
fsyncs the value, and only then releases a signature; raw wallet signing is not
an accepted recovery-finalization API. The recovery block contains only the
recovery transition: no ordinary transaction, reward, randomness contribution,
membership rotation, peer update, or protocol upgrade can share it.

The transition re-verifies the finalized omission evidence, burns the guilty
old-validator bonds and pays the already-defined non-inflationary reporter
share. It activates the precommitted reserve set and transport registry,
increments the recovery generation, clears a pending validator rotation, and
refunds unresolved safety-candidate bonds whose validator-generation randomness
cannot complete. Local admission receipts are discarded after commit. Plan,
generation, locks, peer-registry lineage, slashing state, and balances are
covered by snapshots/state roots; the light verifier checks the old finality
proof, exact checkpoint, reserve certificate, and `H+1` continuity. Every v2
finality header also commits to `networkId`, completed recovery generation, and
the active plan hash (or `null`) under `VALIDATOR_RECOVERY_STATE_V1`. Scheduling,
normal validator rotation, and recovery therefore change an authenticated
header value rather than relying on a post-event manual pin. Legacy v1 headers
and v2 finality-proof envelopes fail closed.

The light verifier recomputes this commitment from the supplied plan and the
previously authenticated `H` header. An unproved plan supplied alongside the
recovery block is not a trust anchor. It rechecks the complete plan and
reserve acceptance certificate, the omission evidence against the authenticated
old header/certificates/transaction root, and the deterministic peer-registry
transition against the previous authenticated registry. The bounded durable
recovery trust store rejects lower heights or generations, conflicting views at
one height, and reused plan/evidence hashes; it advances a generation only from
the verified recovery result. A recovery block is
rejected at a scheduled protocol-version
activation boundary rather than combining two exceptional transitions.

Limits are deliberate. Wall-clock delay cannot activate reserves while chain
height is stalled. Lost reserve quorum cannot be replaced after a halt. A normal
validator rotation invalidates the old plan and creates an availability window
until a new plan has aged 64 blocks. Equal active/reserve sizing means the
current 256-entry validator registry can precommit recovery only for active sets
of at most 128 members. These constraints avoid a post-halt administrator and a
quietly weaker recovery quorum; they are operational risks, not solved Sybil or
availability guarantees.
