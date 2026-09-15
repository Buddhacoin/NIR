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
validity period with the value committed by consensus. Automated certificate
renewal and a distributed registry-signing ceremony remain production work.

## Discover peers without trusting a website

The genesis file is the trust anchor. It contains the first quorum-approved peer
registry, transport public keys, and TLS certificate fingerprints. A running
validator exposes `GET /v1/discovery`; the returned registry, height, and tip are
signed with that validator's separate transport key. The client accepts it only
when the signer is a trusted seed and the registry hash matches its local chain
checkpoint.

With a validator running at the URL already recorded in genesis:

```bash
npm run network:discover -- \
  .nir-network/validators/validator-0/genesis.json \
  http://127.0.0.1:8791
```

The output is a verified peer list, not a list trusted merely because an HTTP
server supplied it. A changed endpoint, transport key, certificate pin, network
identifier, or registry entry changes the committed hash and is rejected. After
an on-chain registry rotation, a joining node must first synchronize finalized
blocks from a checkpoint it already trusts; discovery cannot safely invent a
new trust root.

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

## Start the coordinator

```bash
npm run network:coordinator -- \
  .nir-network/coordinator \
  http://127.0.0.1:8791,http://127.0.0.1:8792,http://127.0.0.1:8793,http://127.0.0.1:8794 \
  8787
```

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

## Remaining production boundary

This is a multi-process localhost consensus prototype, not production BFT.
Application-layer control messages now have pinned mutual signatures using
separate rotatable transport identities and optional pinned TLS 1.3, and
round-zero blocks can be assembled by the elected validator. Transport is
remain plaintext only when the loopback development mode is deliberately used.
Automated certificate lifecycle and coordinator-key rotation are not governed
on-chain, validator-set/peer-registry rotation is not yet one atomic transition, and
catch-up is sequential with no snapshot or fork-choice protocol.
Validator mempools are disk-backed and gossiped over a static full mesh. Repeated
rounds preserve the same execution value and rotate the proposer through
validator-to-validator quorum timeout certificates. Consensus now has distinct
prepare and commit phases. Commit signatures bind the exact prepare certificate;
signed lock discovery transfers that certificate to a replacement proposer and
applies a deterministic highest-certificate rule. Split prepare votes remain
round-local and do not deadlock a later certified round. The durable exponential
localhost pacemaker still lacks
latency sampling, authenticated transport sessions, clock discipline, and
production-calibrated timeout governance.
There is no fork recovery, checkpoint/snapshot synchronization,
production-grade adaptive denial-of-service defense, coverage-guided or
unbounded randomized fault testing, or formal consensus proof yet. Test keys are plaintext and have no
monetary value.
