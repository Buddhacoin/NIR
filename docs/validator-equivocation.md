# Native validator prepare-equivocation transition

NIR accepts a narrowly objective `validator-equivocation` transaction for a
validator that signs two conflicting prepare values for the same network,
height, parent and round. Prepare signatures bind
`{blockHash,height,round}`. Protocol-v24 finality proofs retain the exact v2
envelope/v1-header pair; protocol v25 uses the exact v3/v2 pair with the
recovery-state commitment. Cross-version shapes are rejected rather than being
interpreted under another signature domain.

The signed prepare round is carried by each prepare vote. A value prepared in
round 0 may be recovered and finalized by an outer round-1 block; adjudication
uses the uniform round recorded by the finalized prepare certificate, not the
outer block round. This preserves recovery while preventing an attacker from
relabeling a signature as belonging to another round.

## Compact evidence

The offline proof builder receives both full proposals and executes each with
`NirChain.validateProposal` against the same pre-height state. It then discards
their bodies and emits `nir-validator-prepare-equivocation-v2` evidence with
only two exact finality headers, their block-header hashes and prepare
signatures. Evidence is limited to `MAX_EQUIVOCATION_EVIDENCE_BYTES` (32 KiB),
so two near-limit proposal bodies do not make the penalty transaction
unincludable.

Consensus adjudication does not re-execute or download the alternate body. In
block H+1 it requires exactly one evidence header to equal finalized block H's
header, requires the alternate header to commit to a different block hash with
the same parent/network/height, verifies both round-bound signatures against
the active H validator identity, and requires its remaining native validator
bond to be at least `MIN_VALIDATOR_BOND`. Evidence for another head, including
stale or future evidence, fails closed. Unknown fields, replayed evidence,
wrong-network signatures and inactive or unbonded signers also fail without
changing balances, nonce or state root.

On acceptance the chain burns the validator's entire remaining bond, records
the evidence hash once, increments its fault count and permanently records the
identity as disabled. There is no reporter bounty. A disabled identity cannot
bond again or appear in a future proposed validator set.

Genesis ceremony membership does not create an economic bond. Equivocation by
an active but unbonded genesis validator is therefore forensic evidence only;
the native transaction neither burns value nor disables that identity. Native
penalties become available only after an on-chain validator bond exists.

## Membership and recovery boundary

Slashing does **not** silently change the active finality set or its
`validatorSetId`. Doing so would leave light clients and wallets on a different
trust set. Until a normal delayed, dual-quorum `ValidatorHandoff` activates,
full nodes and the version-matched compact finality proof continue to use the old
set. The local `ValidatorReplica` for a disabled identity refuses to propose,
prepare, commit or issue round timeouts. If that identity is the scheduled
proposer, the normal round-timeout path selects another proposer.

Operators recover capacity by registering and bonding a replacement, then
scheduling a delayed rotation that excludes every disabled identity. The
activation block needs the existing old-set and proposed new-set quorums, and
light clients must receive the matching signed handoff. Intermediate proofs,
the activation proof and subsequent new-set proofs then form one continuous
verifiable chain.

The chain rejects a block that tries to combine the slash transaction with a
validator rotation. This avoids calculating a handoff commitment from a
pre-transaction membership/bond view while committing a different disabled
state.
