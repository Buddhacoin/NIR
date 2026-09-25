# Protocol v30: validator exit lifecycle

Protocol v30 introduces a consensus-controlled path for a bonded validator to
leave without making its bond unavailable to safety enforcement too early.
The lifecycle is deliberately one-way: a validator identity that completes a
withdrawal is permanently retired and cannot be registered for another
protocol role.

## Lifecycle

1. The validator signs a `validator-exit-request` for the exact network and
   current account nonce and pays the normal minimum transaction fee.
2. An inactive registered candidate starts its withdrawal cooldown when that
   request is finalized. An active validator remains active and fully liable;
   its cooldown starts only in the finalized block that excludes it from the
   validator set.
3. During the cooldown the entire remaining bond stays in consensus state and
   remains slashable. A penalty therefore reduces the amount ultimately
   returned; the transaction never supplies its own withdrawal amount.
4. After maturity, the validator signs one
   `validator-withdrawal-claim`. Consensus returns exactly the bond then left,
   removes the registration, and records a permanent identity tombstone. A
   fully slashed validator may complete the same lifecycle with a zero-value
   claim so that its registration cannot remain stuck forever.

There is no partial withdrawal, cancellation, or identity reuse. An exiting
identity cannot top up its bond, join a proposed validator set, serve as a
recovery reserve, create a new randomness obligation, or register for another
protocol role. A request or claim also fails closed in a block that schedules
or activates a validator rotation or recovery transition.

## Testnet parameter

`VALIDATOR_WITHDRAWAL_DELAY_BLOCKS` is **64 blocks for the testnet only**. This
is a provisional safety parameter, not final mainnet economics. Changing it
after a public compatibility commitment requires a separately authorized,
versioned protocol release and migration.

## Compatibility and recovery

The pending-exit registry and retired-identity registry are committed into the
v30 state root and exact snapshot schema. Nodes reject snapshots that omit the
registries, invent impossible cooldowns, reuse retired identities, or place an
exiting identity in a pending rotation or recovery plan. Protocol v24-v29
state roots and snapshots omit both fields and remain byte-compatible.

Operators must upgrade through the normal sequential, delayed and authorized
protocol-upgrade process. Restarting from a verified v30 snapshot preserves
the request height, finalized exclusion height, maturity height, remaining
bond, and permanent retirement record.
