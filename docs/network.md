# Multi-process NIR devnet

This milestone removes consensus private keys from the coordinator. Four
validator replicas run as separate localhost processes, each with one ML-DSA-65
key, its own verified chain journal, and a durable vote record.

## Create the network

The full-state commitment format uses protocol version 6. Recreate any earlier
valueless development network instead of attempting to reuse older blocks.

```bash
npm run network:init-dev -- .nir-network
```

The command creates a coordinator directory and four validator directories.
Every validator receives the same public genesis but only its own private key.
The coordinator receives no validator private key.
It receives a separate operational ML-DSA-65 identity. Validators pin only its
public identity and reject unsigned, altered, stale, or replayed control calls.

Initialization also creates a separate ML-DSA-65 transport identity for each
validator and a quorum-signed `PEER-REGISTRIES.json`. Consensus keys continue to
sign prepare, commit, and timeout votes; transport keys authenticate P2P HTTP
requests and responses only. Compromising a transport key therefore does not
grant authority to finalize a block.

Registry versions are ordered by epoch, activation height, and the hash of the
previous version. Every version must cover the complete validator set and carry
`2N/3 + 1` consensus-validator approvals. A node rejects minority-approved,
modified, premature, skipped, or wrong-network registries. On restart it verifies
the complete history and selects the latest version active at its chain height.
The active registry hash is committed in genesis and every block. A registry
rotation is carried inside its activation block, receives normal prepare and
commit finality, and becomes consensus state. Replacing the local history with
an older valid file therefore prevents the validator from starting rather than
silently redirecting its peers.
Public endpoints must use HTTPS; plaintext HTTP is accepted only for loopback
development addresses. The validator can terminate TLS 1.3 directly. P2P and
coordinator clients compare the live DER-certificate SHA-256 fingerprint and
validity period with either the explicit local-development genesis pin or the
active quorum-authorized certificate lifecycle described below. Independent
certificate issuance infrastructure and a distributed signing ceremony remain
production work.

## Discover peers without trusting a website

The genesis file is the trust anchor. It contains the first quorum-approved peer
registry, transport public keys, and TLS certificate fingerprints. A running
validator exposes `GET /v1/discovery`; the returned registry, height, and tip are
signed with that validator's separate transport key. The client accepts it only
when the signer is a trusted seed and the registry hash matches its local chain
checkpoint.

With validators running at URLs already recorded in genesis, pass one or more
comma-separated seeds. Two responding identities are required automatically
when multiple seeds are supplied:

```bash
npm run network:discover -- \
  .nir-network/validators/validator-0/genesis.json \
  http://127.0.0.1:8791,http://127.0.0.1:8792,http://127.0.0.1:8793
```

The output is a verified peer list, not a list trusted merely because an HTTP
server supplied it. Each response needs a different transport identity. An
offline seed is tolerated when the response threshold is still met; duplicate
origins and keys are rejected. Independently signed different tips at the same
height stop discovery instead of letting response order choose a view. A changed
endpoint, transport key, certificate pin, network identifier, or registry entry
changes the committed hash and is rejected. After an on-chain registry rotation,
a joining node uses the separately verified handoff/topology history described
below; discovery cannot safely invent a new trust root.

The local genesis is also treated as an operator artifact rather than an
ordinary configuration file. Discovery rejects symbolic links, hard links,
group/world-writable files, oversized input, duplicate JSON keys, and a file
whose identity or metadata changes while it is being read.

One seed remains supported for local development and emergency availability,
but it provides no operational redundancy. Production seeds must be hosted by
different organizations, networks, and failure domains; running three processes
on one machine does not make them independent.

## Start an encrypted local network

A self-signed certificate costs nothing and is sufficient for a pinned local
testnet. Generate one development certificate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout .nir-dev-key.pem -out .nir-dev-cert.pem -days 30 \
  -subj "/CN=localhost"
chmod 600 .nir-dev-key.pem
export NIR_TLS_KEY_PATH="$PWD/.nir-dev-key.pem"
export NIR_TLS_CERT_PATH="$PWD/.nir-dev-cert.pem"
npm run network:init-dev -- .nir-network
```

Keep both environment variables set when starting each validator. Initialization
derives the certificate fingerprint and commits it to the genesis peer registry;
the private key itself is never written into genesis or a block. The single
shared certificate above is only for localhost development. Independent public
operators must use separate keys and approve their registry entries before the
activation block is finalized.

## Start four validators

Run each command in a separate terminal:

```bash
npm run network:validator -- .nir-network/validators/validator-0 8791
npm run network:validator -- .nir-network/validators/validator-1 8792
npm run network:validator -- .nir-network/validators/validator-2 8793
npm run network:validator -- .nir-network/validators/validator-3 8794
```

These commands default to `NIR_CERTIFICATE_MODE=dev-genesis`, which preserves
the static-pin behavior of an initialized localhost devnet. A production-like
testnet must first install the verified lifecycle history under each validator's
`certificates/` directory and then start with the mode stated explicitly:

```bash
export NIR_CERTIFICATE_MODE=lifecycle
npm run network:validator -- .nir-network/validators/validator-0 8791
```

In lifecycle mode a missing, revoked, expired-overlap, corrupt, or
topology-detached record fails closed. The process does not retry with the stale
pin from genesis.

## Start the coordinator

```bash
npm run network:coordinator -- \
  .nir-network/coordinator \
  http://127.0.0.1:8791,http://127.0.0.1:8792,http://127.0.0.1:8793,http://127.0.0.1:8794 \
  8787
```

The coordinator uses the same `NIR_CERTIFICATE_MODE`. Its verified lifecycle
store belongs at `.nir-network/coordinator/certificates`; every request selects
pins at the coordinator's current finalized height, including after restart.

Signed transactions submitted to `POST /v1/transactions` are executed on an
isolated chain copy before entering the bounded in-memory mempool; a malformed
or conflicting transaction is rejected immediately. `POST /v1/blocks/produce`
creates a proposal. Each validator rebuilds
the deterministic proposal, independently executes all state transitions on an
isolated chain copy, and signs only if the result is valid. The coordinator
first requires `2N/3 + 1` unique prepare votes, then asks validators to sign the
exact prepare-certificate hash. Only a second `2N/3 + 1` commit quorum finalizes
the block, which is then broadcast to validator replicas.

Every proposal and finalized-block request is signed by the coordinator and
bound to its network, HTTP route, body hash, timestamp, and one-time nonce.
Every validator response is independently signed and checked against the public
validator identity in genesis. Before asking for a new vote, the coordinator
checks each replica's height and streams any missing quorum-finalized blocks in
order. A conflicting tip or a peer claiming a future height is rejected.
The coordinator obtains that height and tip through signed `POST /v1/health`;
validators use the separately authorized signed `POST /v1/p2p/health`. The
public `GET /health` endpoint is only for human and monitoring diagnostics and
must never drive synchronization, proposer selection, or finality.

If the deterministic proposer is unreachable before anyone votes, the remaining
validators persistently sign a height- and tip-bound timeout. A `2N/3 + 1`
timeout certificate advances the block to the next round and selects the next
validator as proposer. Consensus verifies every certificate inside the block.
A timeout is bound to the immutable block-value hash. An isolated prepare vote
prevents equivocation only within its round. A commit vote is a durable lock:
later proposers must recover its complete prepare certificate and may advance
only the same value to a newer round.

Round metadata and finality evidence do not change that value hash. Transaction
fees use the deterministic round-zero fee recipient for the height, so replacing
a failed proposer cannot alter balances or create a competing execution result.

The development faucet both queues and finalizes its transfer so the wallet can
still use it as one action.

## Transaction ingress and gossip

A signed transaction may be sent to `POST /v1/transactions` on any validator,
not only to the coordinator. The receiving validator executes it against its
current state and pending queue, writes it to its private disk journal, and
gossips it to the other configured validators with validator-authenticated
requests. Duplicate transactions are idempotent. Invalid signatures, conflicting
nonces, a full pool, an aggregate proposal over the block-size limit, and public
traffic that exhausts the per-source token bucket are rejected before gossip.
The default bucket permits a burst of 20 requests and continuously refills at 20
requests per minute. Discovery, transaction submission, manual synchronization,
and manual block-production requests share that budget. The identity table is
bounded, so fabricated source addresses cannot grow validator memory without
limit.

Validator servers also cap simultaneous connections, header count, body and
response size, request duration, and keep-alive time. These application limits
reduce inexpensive resource-exhaustion attacks. Public operators still need
independent rate limiting, monitoring, and network-level denial-of-service
protection in front of geographically separate nodes.

Coordinator ingress also requires a validator durability quorum. A fresh
coordinator process starts with an empty in-memory pool, queries the signed
validator pools, deterministically orders recovered transactions, executes them
again, and ignores invalid data supplied by a Byzantine peer. Finalized
transactions are removed from every validator's durable pool.

## Validator-led block production

The round-zero proposer can assemble a block directly from its durable pool:

```bash
curl -X POST http://127.0.0.1:8791/v1/blocks/produce
```

Use the URL of the validator reported as the expected proposer. A non-proposer
refuses the request. The proposer independently builds the deterministic block,
votes for it, sends a validator-authenticated proposal to its peers, collects a
`2N/3 + 1` certificate including its own vote, commits locally, and broadcasts
the finalized block. Peers independently execute both the proposal and final
certificate. The coordinator is not involved in this normal block path.

If that proposer is unreachable, any live validator can initiate the same
endpoint. Every timeout signer independently probes the elected proposer and
refuses to sign while it is reachable. Once `2N/3 + 1` validators sign the
height-, tip-, round-, and value-bound timeout, the initiating validator builds
the next-round form of that exact value and hands it to the newly elected
proposer over an authenticated P2P request. The replacement proposer gathers
the finality votes and broadcasts the block without coordinator participation.

The localhost pacemaker does not sign immediately after one failed probe. Each
validator durably records when it first observed the failed round, waits for an
exponentially increasing round window, and probes the proposer again before
signing. The observation survives validator restart, preventing a process
restart from resetting or bypassing the timer. Development defaults start at
250 ms and double by round up to 2 seconds; these are test-network timings, not
production network parameters.

Before building a fresh value, a validator asks every peer for its persisted
vote lock. Each report contains the original proposal and its validator's
ML-DSA vote; the receiver verifies the signer, value hash, round certificate,
deterministic block fields, height, and parent locally. Invalid reports are
ignored. Reports are grouped by immutable value hash. A group must contain at
least `N - quorum + 1` distinct validator votes, guaranteeing an honest signer
under the fault model; one Byzantine validator cannot dictate the recovered
value. The most reported eligible value is selected deterministically. This lets
a replacement leader recover a partially voted value even when its own mempool
differs. Pending transactions outside that value remain queued for a later block.

View change now applies one explicit highest-certificate rule. Eligible values
are ordered by their certified consensus round, never by arrival time or local
mempool preference. A later-round proposal outranks any round-zero lock because
its embedded timeout certificate already proves a validator quorum. Two
different values claiming the same highest certified round cause a fail-closed
error. For round zero, which has no embedded timeout certificate, recovery still
requires `N - quorum + 1` independent lock proofs.

## Validator catch-up

A validator that was offline can synchronize directly from the other validators:

```bash
curl -X POST http://127.0.0.1:8791/v1/sync
```

It compares peer heights, requests missing blocks in bounded batches over the
mutually authenticated validator channel, and replays every block through the
normal consensus-certificate and state-transition checks before storing it. A
bad or unavailable source is abandoned in favor of another authenticated peer.
Block production performs this catch-up automatically before creating a new
proposal. Transactions finalized while a validator was offline are removed
from its durable pool during replay.

## Network partition behavior

The integration suite runs real validator HTTP servers with per-validator peer
views. In a `2+2` split, neither side reaches three-of-four finality or timeout
quorum, so all replicas remain on the last common block. After the link heals,
an existing certified lock is recovered; when neither side formed one, the
original proposer replays its persisted round proposal and one common value
finalizes.

In a `3+1` split, the three-validator side can finalize exactly one value. The
isolated validator cannot create a conflicting certificate; after reconnection
it downloads the missing block, verifies the certificate and state transition,
and converges to the same tip. These deterministic schedules test the quorum
invariants but are not a formal proof over every asynchronous message schedule.

A second deterministic fault test explores 512 seeded schedules in which a
Byzantine elected proposer signs two different values while honest prepare messages
are delayed, reordered, dropped, and replayed. Honest validators persist their
per-round prepare decisions, commit only after a prepare quorum, duplicate
deliveries never add voting weight, and every candidate certificate is checked
by a fresh chain instance. No explored schedule can
finalize both values. The seed makes every failure exactly reproducible.

## Faults covered by the integration test

- validator keys never enter coordinator memory;
- one non-proposer validator may be offline while the remaining three finalize;
- a forged transaction is rejected before a validator signs the proposal;
- a validator stores its vote before returning it and refuses a conflicting
  block at the same height, including after restart;
- coordinator balances and blocks survive restart and verified replay.
- a validator that misses a finalized block catches up after restart before it
  votes at the next height;
- request mutation, stale requests, nonce replay, and forged peer responses are
  rejected cryptographically.
- an offline or non-responsive proposer is replaced only after a signed quorum
  timeout, while an existing vote remains locked to the same block value.
- one-validator transaction ingress reaches the other replicas, survives a
  replica and coordinator restart, and is independently revalidated before use.
- the elected validator assembles, certifies, and broadcasts a normal block
  while a non-proposer is unable to initiate one.
- a restarted validator catches up from another validator without coordinator
  participation and independently verifies the missing finality certificate.
- three live validators independently detect an offline proposer, certify the
  timeout, and delegate the unchanged value to the next elected proposer.
- timeout observations survive restart, increase by round, and require a second
  failed reachability check after the waiting window.
- a replacement leader recovers a cryptographically proven peer lock instead of
  replacing it with a different value from its local mempool.
- highest-certificate selection prefers the greatest proven round and rejects
  ambiguous same-round certificates instead of depending on message order.
- split prepare votes do not become durable locks and cannot deadlock the next
  quorum-certified round;
- a `2+2` partition produces no block on either side and converges after healing;
- a `3+1` partition permits one majority block while the isolated validator
  cannot fork and later catches up from the verified chain.
- 512 reproducible adversarial schedules cannot turn delayed, lost, reordered,
  or replayed votes into two conflicting finality certificates.
- stateful seeded schedules repeatedly finalize across eight heights while
  mixing split prepares, delivery loss, replay, signature corruption, and real
  validator-process reconstruction from durable journals.
- randomized validator-set histories exercise delayed activation, joint old/new
  certificates, stale-set rejection, corrupted commits, and full chain replay.

## Create a quorum snapshot

With the four validators and coordinator running, request a snapshot from the
localhost coordinator:

```bash
curl -X POST http://127.0.0.1:8787/v1/snapshots/create
```

The coordinator first synchronizes a finality quorum. It downloads the full
state from one authenticated validator, then sends only that height and
`snapshotHash` to the remaining validators. Each validator independently
rebuilds the candidate from its own finalized state and returns one ML-DSA
attestation only if both values match. This avoids transferring a potentially
large snapshot from every validator. A Byzantine first source is discarded if
it cannot collect the normal `2N/3 + 1` quorum; another authenticated validator
is tried instead.

The assembled snapshot is fully verified and atomically staged in
`<coordinator>/snapshots/STATE-SNAPSHOT.json` with a redundant backup. The HTTP
response contains only its height, hashes, and signature counts, never private
keys. The block store can install that snapshot as an explicit base, replay
later journal blocks, survive restart, and prune older blocks through quarantine
plus a separate restart-verification marker. These library operations are not
yet exposed as an unauthenticated public administration endpoint.

### Install and prune from the operator CLI

Stop the target node before changing its checkpoint. Copy a quorum snapshot to
the machine through the operator's authenticated administration channel, then
install it locally:

```bash
npm run node:snapshot-install -- /srv/nir-node /secure/incoming/STATE-SNAPSHOT.json
```

If the snapshot crosses validator rotations, pass the ordered handoff array as
the final argument. The file is rooted in the validators from the node's local
`genesis.json`; the downloaded snapshot cannot choose its own trust anchor.
The node CLI applies the same bounded, link-resistant and race-resistant read to
the local genesis, incoming snapshot, and optional handoff list. Ambiguous JSON
or a file changed during the read stops the command before installation.
The same path is tested across two consecutive validator generations. A
snapshot taken on an activation block must match that handoff's exact block
hash and state root, after which only the post-snapshot journal tail is replayed.

Old blocks are never deleted by installation. Pruning requires three separate
commands, with a real node stop/start and health check between the first two:

```bash
npm run node:prune-stage -- /srv/nir-node
# restart the node and verify its height, tip hash, and application health
npm run node:prune-verify -- /srv/nir-node
npm run node:prune-finalize -- /srv/nir-node
```

`prune-stage` moves eligible files into quarantine. `prune-verify` reconstructs
the state from the snapshot and remaining journal before writing a verification
marker. `prune-finalize` refuses to remove quarantine without that marker.
These commands read bounded JSON and never accept private key files.

## Remaining production boundary

This is a multi-process localhost consensus prototype, not production BFT.
Application-layer control messages now have pinned mutual signatures using
separate rotatable transport identities and optional pinned TLS 1.3, and
round-zero blocks can be assembled by the elected validator. Transport remains
plaintext only when the loopback development mode is deliberately used.
Certificate lifecycle histories are quorum-authorized against verified topology,
propagated across authenticated peers, and enforced by runtime pin selection;
they are not consensus-state records and do not issue certificates or protect
private keys. Coordinator-key rotation remains outside consensus. Validator-set
and peer-registry rotation is atomic, with a restricted
pre-activation union transport and old/new finality quorums. A quorum-authenticated snapshot format, signed RPC,
authenticated source collection, typed restore, and atomic redundant staging
now exist. Dual-quorum rotation handoff verification, journal-tail replay,
joining-node installation, portable pruned backups, and two-stage pruning are
implemented locally. Validators more than 16 blocks behind also collect
authenticated snapshot candidates from peers, require matching finality quorum,
install the checkpoint, and replay the remaining tail; failed quorum safely
falls back to block-by-block replay. Commit-bound handoff candidates are now
assembled into old/new quorums, durably replicated, distributed after the
activation block, and reloaded on restart. Every handoff is also paired with its
mutually signed onboarding certificate in an atomic redundant topology journal.
Catch-up first verifies that genesis-rooted key/topology chain and may then use
the latest authenticated endpoints for snapshots and block replay. Responses
from reachable peers are compared before installation; a valid longer history
may extend a stale prefix, while divergent valid histories stop recovery.
Independent-host operator ceremonies, stable public bootstrap operation, and
externally reviewed multi-host recovery drills remain; there is no automatic
fork-choice protocol.

The automated live-rotation rehearsal starts six authenticated HTTP validator
processes: four current operators and two future-only operators joining a
four-member next set with two-member overlap. It gossips a transaction across
the union topology, then takes one old-only and one future-only process offline.
The four remaining processes still satisfy both quorums and finalize the same
activation block. The missed newcomer later authenticates to a reachable peer,
downloads and independently verifies the paired topology and handoff history,
uses that recovered trust to replay the block, restarts, and joins the
four-member topology. A retired finality key
cannot vote at the next height. This verifies the local protocol path, but does
not substitute for independent machines, organizations, networks, or an
external audit.

Protocol v7 also requires a pre-activation onboarding certificate in any
validator rotation on a network with an active peer registry. This prevents a
rotation from naming unreachable or unconsenting operators: all future
consensus keys and transport keys prove possession, while the current validator
quorum authorizes the exact endpoint set. Before activation the live service
admits future-only transports only for state synchronization and messages bound
to the exact activation height. Both validator sets must prepare and commit that
block; afterward the service immediately drops retired peers and uses the new
registry. Existing protocol-v6 development
state must be recreated; this repository has no public mainnet history requiring
a migration.

Validator mempools are disk-backed and gossiped over a static full mesh. Repeated
rounds preserve the same execution value and rotate the proposer through
validator-to-validator quorum timeout certificates. Consensus now has distinct
prepare and commit phases. Commit signatures bind the exact prepare certificate;
signed lock discovery transfers that certificate to a replacement proposer and
applies a deterministic highest-certificate rule. Split prepare votes remain
round-local and do not deadlock a later certified round. The durable exponential
localhost pacemaker still lacks latency sampling, clock discipline, and
production-calibrated timeout governance. Authenticated snapshot synchronization,
journal-tail replay, and topology-handoff recovery are implemented. There is no
automatic fork choice between conflicting valid finalized histories, external
process isolation for cryptographic workers, coverage-guided or unbounded
randomized fault testing, or formal consensus proof yet. Bounded
operator-identity queues, replay lifecycle, objective quarantine, fanout
backpressure and safe aggregate metrics are specified in
[operator-dos-defense.md](operator-dos-defense.md). Test keys are plaintext and have no
monetary value.
