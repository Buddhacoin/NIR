# Independent beacon operations

One independently operated service exposes two cryptographically separated
purposes. `progress` is mandatory for assigning an unpredictable AI evaluation
challenge after its candidate commitment is final. `fallback` is used only when
a bonded validator commits a safety-randomness contribution and then withholds
its reveal.

Each authority produces its own unpredictable 32-byte share and signs it with
a separate ML-DSA-65 wallet. Progress and fallback signatures use different
domains, so a share cannot cross purposes. The chain accepts an aggregate only when more
than two thirds of the active beacon generation signed distinct shares for the
same network, candidate, generation, and round. For a progress admission, a later finalized
epoch-randomness round selects one exact committee from its commit/reveal seed
and requires every selected signature.
It deterministically hashes those shares, so an aggregator cannot alter a share,
drop a signer, add a reserve signer, or choose among subsets after disclosure.
The fallback safety path still accepts any valid quorum and therefore retains
limited subset choice; it never supplies intelligence-mining challenges.

## Run one authority

Create a dedicated wallet vault on an offline-controlled machine, then run:

```bash
npm run beacon:serve -- /absolute/path/beacon-wallet.nir nir-testnet 8791 127.0.0.1
```

The password is read interactively and never accepted through command-line
arguments or environment variables. The service exposes:

- `GET /health` — public address, algorithm and network;
- `POST /v1/share` — authenticated JSON containing `candidateId`, non-negative
  beacon `generation`, integer `round`, and `purpose` equal to `progress` or
  `fallback`.

Omitting `purpose` selects `fallback` for backward compatibility. A service
persists an append-only decision file beside its vault and returns
the same signed share when the same purpose, candidate and round are requested again,
including after restart. Back up this `.beacon-state.json` file: deleting or
rolling it back permits equivocation and randomness grinding. Run the service
behind mutually authenticated TLS, request limits and monitoring; never expose
the development HTTP listener directly to the Internet.

After collecting at least three shares in separate files, an untrusted
aggregator can construct the claim:

```bash
npm run beacon:aggregate -- nir-testnet CANDIDATE_HASH ROUND a.json b.json c.json
npm run progress-beacon:aggregate -- nir-testnet CANDIDATE_HASH ROUND a.json b.json c.json
```

The aggregate itself is not trusted: every full node verifies every authority
signature, recomputes the aggregate and enforces the on-chain quorum. For
`progress`, request shares only from the addresses returned by the admission's
`progressBeaconCommittee`; substituting another registered authority fails.

## Independence requirements

Production should begin with at least four authorities. They must be operated
by different legal or community entities, on different hosting providers and
administrative accounts, with separate vault backups and incident contacts.
No authority may also be a finality validator or intelligence evaluator.

Code cannot create organizational independence. Before mainnet, operators must
publish their public keys and deployment attestations, perform a coordinated
failure exercise, and commission an external audit. The repository provides
the service and verification path; it does not claim that those external
operators or the audit already exist.

The admission records the unfinished epoch round and cannot use an already-known
seed. Committee selection waits until every member of that epoch's fixed
committee reveals a previously committed share in a later block. A producer can
censor and delay progress, but its block hash no longer selects the committee.
If a committed member withholds past eight blocks, the chain records and
excludes it, erases the incomplete attempt and rotates the same round. It does
not derive a seed from the surviving subset.

## Native bond

Each genesis authority can lock at least 1,000 NIR with a signed `beacon-bond`
transaction. Bond enforcement activates irreversibly when every authority has
reached that threshold; before that moment the network is explicitly in its
bootstrap phase. After activation, failing to reveal burns one percent of the
operator's current bond. If the remaining balance is below 1,000 NIR, the
operator is disabled from subsequent epoch committees. The burn, remaining
bond, fault counter, disabled set and activation flag are all state-rooted and
recomputed by every node. Withdrawal remains deliberately absent.

## Authority rotation

After bond enforcement activates, a new key may register by locking the same
minimum bond under a unique address and operator ID. Registration alone grants
no committee role. A rotation is one canonical, state-rooted proposal containing
the network, monotonically increasing generation, current and next set hashes,
the complete next registry, and an activation height at least 64 finalized blocks
ahead. It requires signatures from more than two thirds of the current set plus
a possession signature from every next key. The next registry has the same
bounded size, at least one third of its addresses overlap the old registry, and
every member must remain fully bonded. A proposal with a stale generation,
foreign network, wrong parent set, insufficient overlap, duplicate identity,
missing possession proof, or reused approval fails closed.

The activation height is a hard generation boundary. No epoch, progress, or
fallback beacon contribution is accepted in that block. The epoch machine drops
the unfinished old-generation attempt, advances the round, and derives a new seed
from the prior seed and both set commitments. All epoch, progress, and fallback
shares include the generation in their signed payload, so an overlapping key's
old signature cannot replay after activation. Any still-pending progress admission
is deterministically cancelled and its candidate bond refunded at activation;
this avoids leaving a committee tied to removed keys. A claim already completed
before the boundary is unaffected. If a proposed member falls below the bond
minimum before activation, the pending rotation is cancelled rather than
installing an under-collateralized registry.

Active and registered registries, generation, pending proposal, bonds, and epoch
machine are included in snapshots and the state root. Restart and fork recovery
therefore reproduce the same boundary. Local real-service rehearsals obtain the
active registry from verified chain state rather than treating the genesis list
as permanently current.

This mechanism proves key possession, old-set authorization, bond, and protocol
continuity. It does not prove that nominally different authorities are controlled
by different companies, nor guarantee that the next operators remain available.
The v1 registered-key registry is capped at 64 identities and has no bond exit or
identity recycling, so operators must budget replacements within that bound; a
later protocol change is required for indefinite churn without unbounded state.
