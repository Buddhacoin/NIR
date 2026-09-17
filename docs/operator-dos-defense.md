# Hostile-operator denial-of-service defense

Consensus authorization is necessary but does not make a valid request cheap.
An authenticated operator can submit many distinct, correctly signed messages
that require expensive signature, block or proof verification. NIR therefore
applies admission control before starting cryptographic and state validation.

These controls do not change finality quorum, rewards, balances, issuance or
any other monetary rule. They only bound local work and network fanout.

## Authenticated identity, not source address

Peer queues and reputation use the transport or coordinator signer committed by
the active peer registry. Public transaction admission uses the signed sender
claim and is still protected by the global cap. A source network address is not
used as the sole identity: unrelated operators behind one shared proxy do not
share a peer queue, while reconnecting from another address does not erase an
operator's in-process limits.

An unverified signer claim may select a queue, but it cannot create more global
capacity. Invalid signatures do not add strikes to the claimed operator,
because doing so would let an unauthenticated attacker frame an honest peer.
Strikes begin only after authentication succeeds and a deterministic protocol
violation is observed.

## Verification scheduler

The default validator limits are:

- eight expensive requests executing at once globally;
- two executing at once for one authenticated identity;
- 128 queued globally and 16 queued per identity;
- three seconds maximum waiting time before work starts;
- round-robin service between non-empty identity queues.

Queue capacity is reserved by identity and the global limit, so a flood from
one operator cannot occupy every execution slot or starve honest quorum peers.
Full queues and expired queue entries fail before cryptographic work begins.
The request remains counted until its operation actually settles; a timeout
never releases a slot while expensive work is still running.

Consensus and synchronization fanout is processed by at most eight concurrent
outbound messages. Block ranges are already limited to eight blocks and every
protocol object retains its own size and cardinality bounds. Incoming validator
bodies are capped at 2 MiB, connections at 128, headers at 64, request time at
10 seconds and header time at five seconds. Together with fixed certificate,
transaction and proof limits, this bounds CPU and memory attributable to one
admitted message.

## Replay nonce lifecycle

Coordinator and each authenticated transport receive separate nonce caches.
Each cache holds at most 4,096 entries for 60 seconds. Reaching the cap fails
closed instead of evicting a still-live nonce. Cleanup runs from an independent
timer, so an attacker cannot keep stale entries alive by stopping requests or
by continually rotating nonces.

A validator restart begins a new authentication timestamp epoch and rejects a
captured request issued before that epoch. A peer reconnects by signing a fresh
timestamp and nonce. Operators must keep clocks synchronized within the
protocol clock-skew window.

## Strikes and quarantine

Only objective post-authentication violations add strikes, such as malformed
protocol objects, conflicting state, duplicate data where uniqueness is
required, invalid deterministic commitments, or bounded-count violations.
Transport outages, queue pressure, timeouts and local policy rejection do not.

Defaults are four strikes to quarantine, a two-minute quarantine, one strike of
decay per minute, a cap of 16 strikes and 1,024 tracked identities. Quarantine
expires automatically and decayed peers recover without operator intervention.
The bounded identity table prevents reputation state itself from becoming an
unbounded memory target. Restart clears local reputation rather than persisting
an accidental permanent ban; consensus authentication and replay epoch checks
still apply after restart.

## Metrics and operations

`GET /metrics` returns aggregate counters only:

- active and queued verification work and identity counts;
- started, completed, rejected and queue-timeout totals;
- known and quarantined peer counts plus violation/recovery totals;
- aggregate coordinator and peer replay-cache sizes;
- the number of ingress identities.

It does not expose nonces, signatures, keys, peer identifiers, payloads or
network addresses. Alert on sustained queue rejection, queue timeouts, nonce
capacity failures or a reduced honest peer quorum. Raise limits only after CPU
and latency measurements; per-identity concurrency should remain below the
global limit and fanout should remain bounded.

The scheduler accepts injected clocks and timer implementations. Deterministic
tests cover valid expensive floods, rotating nonces, shared-proxy identities,
queue timeout, reconnect/restart, strike decay, quarantine recovery and an evil
peer competing with honest quorum work.
