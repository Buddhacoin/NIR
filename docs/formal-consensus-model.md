# Executable bounded consensus model

NIR includes an executable state-space model for the safety-critical parts of
two-phase finality, round changes, durable validator decisions, and validator-set
activation. Run it with:

```sh
npm run --silent formal:consensus
```

The command writes one JSON report to standard output. It exits with code `0`
when all modeled invariants hold, `1` when it finds a counterexample, and `2`
when the checker itself cannot run. A counterexample contains the invariant,
final model state, and a deterministic action trace that can be replayed with
`executeModelTrace`.

## What is modeled

The finality model uses four validators, a three-validator quorum, at most one
Byzantine validator, two competing values, and two rounds by default. Its actions
cover prepare votes, prepare-certificate delivery, commit votes, quorum commit
delivery, round changes, duplicate delivery, omission, arbitrary delivery order,
and one honest-process restart. Omitted enabled actions represent dropped
messages; different action orderings represent delays and reordering; repeating
an action represents replay.

The model checks these invariants:

- conflicting values cannot both become final at one height;
- an honest validator cannot abandon its durable value lock without a valid
  higher-round justification;
- restart clears only volatile certificate observations, never durable votes or
  locks;
- a joint validator-set activation requires quorums from both the old and new
  sets;
- after activation, an old-set-only certificate cannot finalize a value.

The transition checker enumerates all 972 vote assignments for overlapping
four-member old and new sets. The shared Byzantine member may equivocate; honest
members may vote for one value or abstain. The liveness scenarios separately
show progress in a normal round and after replacement of a faulty proposer.
They make an explicit conditional claim only: messages eventually arrive, at
least three of four validators are online, at most one is Byzantine, and an
honest proposer appears within the bounded rounds. Permanent quorum loss is
correctly reported as a stall, not a safety failure.

## Correspondence with the implementation

The durable prepare lock corresponds to the prepare decision written before a
validator returns its signed vote. The one-value commit rule corresponds to the
height-scoped durable commit decision. The highest-certificate rule corresponds
to certified-lock recovery during proposer replacement. Joint old/new quorum
checks correspond to the validator handoff window and active-set certificate
validation.

The model intentionally permits more network disorder than the normal service
path. This makes it useful for finding missing persistence or validation rules,
while the targeted implementation tests remain responsible for serialization,
signatures, storage I/O, and HTTP behavior.

## Boundary of the result

This is bounded model checking, not a mathematical proof of every possible NIR
execution. The default result covers the exact validator count, fault threshold,
values, rounds, restart count, and search depth printed in its JSON `bounds`.
It does not prove cryptographic primitives, operating-system durability,
unbounded liveness, arbitrary validator-set sizes, or correctness outside the
modeled transition rules. Increasing bounds expands coverage but can grow the
state space exponentially.

The regression suite also runs an intentionally unsafe unlock mutant. The model
must produce a machine-readable `locked-value-preservation` counterexample for
that mutant; this guards against a checker that passes because it stopped
exploring meaningful unsafe behavior.
