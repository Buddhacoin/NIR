# Versioned protocol upgrades

NIR protocol changes activate through finalized chain state. A repository edit,
software release, server operator or block proposer cannot change the active
rules by itself.

The genesis execution version is `24`. This implementation knows versions `24`
and `25`; version `25` introduces the delayed upgrade state machine and keeps
the existing economic transition rules unchanged. A later version must ship its
deterministic execution rules before nodes can execute its activation block.

## Schedule object

A scheduling block may contain exactly one object:

```json
{
  "activationHeight": 1200,
  "format": "nir-protocol-upgrade-v1",
  "version": 25
}
```

The object is part of the block body, block hash and compact finality header.
After finalization it is also stored as `pendingProtocolUpgrade` under the
chain's complete `stateRoot`.

The transition is valid only when:

- no earlier protocol upgrade is pending;
- `version` is exactly the active version plus one;
- `activationHeight` is at least 16 blocks after the scheduling block;
- the scheduling block has the normal prepare and commit quorums of the
  validator set active at that height;
- all ordinary block, state-root and finality checks pass.

A proposal alone has no effect. The schedule becomes authoritative only when
the containing block is finalized. There is no single administrator signature,
local configuration switch, cancellation transaction or emergency shortcut.

## Exact activation rule

Let `V` be the active version after height `H`, and let the finalized pending
schedule be `(V + 1, A)`.

- Every block from `H + 1` through `A - 1` must declare `V`.
- Block `A` must declare `V + 1`.
- The pending schedule is removed from state only while block `A` is applied.
- Every later block must continue declaring `V + 1` until another finalized
  delayed schedule activates.

A block declaring either version at the wrong height is rejected before its
state root or certificate can advance local state. Versions cannot decrease and
cannot skip an integer. A second schedule cannot replace a pending schedule.

## Notice and software support

Scheduling an unknown next version is permitted under the current rules because
the notice interval exists to let independent operators inspect and install its
implementation. Nodes continue validating the current version during that
interval.

At activation, a node whose local executable does not list the new version as
supported rejects the activation block with an explicit unsupported-version
error. It does not guess new semantics, silently continue under old rules, or
accept a locally configured override. This can stop an outdated node, but it
cannot make that node accept an unknown state transition.

## Persistence and light verification

The active version and pending schedule are included in:

- full chain state and its `stateRoot`;
- quorum-authenticated state snapshots;
- redundant block-store replay;
- compact finality headers and light-client checkpoints;
- signed account proofs and persistent wallet trust checkpoints;
- the wallet's finalized-header history.

Consequently a restart, snapshot restore, pruning boundary or wallet restart
cannot forget the activation height. Compact clients replay the same version
state machine across headers and reject an unknown active version.

## What an upgrade cannot rewrite

Activation changes the deterministic rules used for the activation block and
later blocks only. It does not mutate earlier blocks or hashes. The transition
does not itself edit balances, issuance, burned value, treasury vesting,
account-history roots, validator bonds or finalized transactions. Those values
remain inputs to the activation block's complete state transition and state-root
check.

Changing supply or balance rules in a future version would therefore require
all of the following: published executable support for a new sequential
version, a finalized quorum schedule, the full notice period, and deterministic
validation by upgraded nodes at activation. Older nodes fail closed rather than
accepting that change. Historical state remains hash-linked and cannot be
rewritten by the scheduling mechanism.

Consensus byte encoding is itself versioned. The active mapping and normative
grammar are specified in [consensus-encoding.md](consensus-encoding.md). A new
serializer cannot be enabled by local preference: its implementation, vectors
and protocol-to-encoding mapping must ship with a sequential delayed protocol
version. Earlier blocks retain their original bytes and hashes.

## Adversarial coverage

Automated tests cover:

- minority scheduling without finality quorum;
- schedules with less than 16 blocks of notice;
- downgrade and skipped-version attempts;
- two conflicting schedules created from the same parent;
- a second schedule while one is pending;
- wrong-version blocks immediately before and at activation;
- old and new nodes processing the same history;
- unknown-version fail-closed behavior;
- snapshot restore and durable block-store replay while an upgrade is pending;
- compact light-client verification before and through activation;
- unchanged issued supply and treasury balance across the transition.

## Remaining operational requirements

Before scheduling a version that changes execution semantics, operators still
need reproducible signed releases, independent source review, public test-network
rehearsal, compatibility measurements, an announced activation height, and a
documented recovery plan for operators that miss the deadline. The on-chain
mechanism enforces authorization, ordering and delay; it cannot prove that new
application logic is free of defects.
