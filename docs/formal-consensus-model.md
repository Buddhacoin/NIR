# Executable bounded consensus model

NIR includes an executable, bounded state-space model for selected consensus
safety rules. Run it with:

```sh
npm run --silent formal:consensus
```

The command writes one deterministic JSON report. Exit code `0` means no
counterexample was found inside the printed bounds, `1` means an invariant was
violated, and `2` means the checker could not complete. This is not an
unbounded proof of consensus safety or liveness.

## Finality state model

The default model has four validators, a quorum of three, one Byzantine
validator, two values, two rounds, and the search depth printed in `bounds`.
Each validator has its own local round. Honest prepare decisions are durable but
only prevent equivocation in that same round, matching the per-height/per-round
prepare journal. A height-wide value lock is created only by an honest commit,
matching the height-scoped commit journal.

Moving to a later local round requires a quorum timeout certificate for that
exact value. Timeout votes and certificates are indexed by destination round
and value. An honest committed validator does not sign or follow a timeout for
a conflicting value. Prepare certificates are delivered to every validator by
separate actions; the model does not assume that honest validators remain
symmetric after different deliveries. A quorum-commit action is also retained
as an explicit batching abstraction for one complete quorum response.

The search checks:

- two values do not both finalize at the modeled height;
- an honest height-wide commit lock never changes value;
- honest validators do not prepare or time out two values in one round;
- a later-round prepare is authorized by a value-bound timeout certificate;
- restart clears volatile certificate observations while preserving durable
  prepares, commits, locks, rounds, and timeout decisions.

An enabled action that is not selected before `maxDepth` represents omission
inside that bounded trace. The checker reports the number of explored states
and transitions, individual certificate deliveries, states with different
validator rounds, timeout-certificate states, and finalized states. It does not
claim to cover executions longer than `maxDepth` or every ordering outside the
reported state graph.

## Validator-set transition model

The transition checker uses overlapping old `[0,1,2,3]` and new `[2,3,4,5]`
sets with quorum three and one shared Byzantine validator. It enumerates all
972 two-value vote assignments to check that two conflicting joint certificates
cannot both exist when honest validators do not equivocate.

It also executes an explicit history through `old`, `joint`, and `active-new`
phases at the modeled activation height. Certificates carry height, epoch, and
phase. After activation, certificates from the previous epoch, wrong height, or
old phase are rejected rather than being reinterpreted under the new set.

## Scenario smoke checks

The normal-round and replacement-round traces are deliberately labelled
`scenario-smoke-check-only` in JSON. They confirm that one expected normal path
and one value-bound timeout/replacement path remain executable. They are not a
liveness model and make no fairness, scheduling, eventual-synchrony, or
unbounded-progress claim.

## Mutation check and boundaries

The regression suite disables the honest commit-lock rule and replays a concrete
trace that finalizes `A`, obtains a conflicting timeout certificate, advances
validators, and finalizes `B`. The required result is an actual
`no-conflicting-finality` counterexample with final state `CONFLICT`, not a
synthetic rejection marker.

The model does not verify serialization, signatures, cryptographic primitives,
filesystem durability, HTTP behavior, arbitrary validator counts, multiple
heights, or executions beyond its printed bounds. Those remain the responsibility
of implementation tests, review, and broader verification.
