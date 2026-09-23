# Independent rehearsal attestations

This developer-testnet tool turns one validated real-service rehearsal report into a portable,
offline-verifiable operator attestation package. It does not make the rehearsal a production test,
prove that machines or operators are independent, or prove that a physical fault was injected.
Those claims require the configured external operators to inspect the retained report and sign it.

## Trust and signed statement

An exact `nir-rehearsal-attestor-set-v1` lists 2–64 unique ML-DSA-65 public identities and an
explicit M-of-N threshold. `createRehearsalStatement` first revalidates the complete real
validator/beacon/archive report, then commits to:

- the exact report hash;
- network ID, NIR genesis hash, finalized validator tip;
- signed source-release manifest and witnessed release-checkpoint hashes;
- the attestor-set ID;
- observation time, expiry of at most 24 hours, and a 256-bit run nonce.

Every operator signs the identical statement in the `REHEARSAL_REPORT_ATTESTATION_V1` domain.
Aggregation rejects unauthorized or duplicate identities, insufficient quorum, stale/future
signatures, mutation, equivocation, and any mixture of run nonce, report, network, release, genesis,
tip, time, or policy. The resulting `nir-production-preflight-rehearsal-input-v1` is signed-free as
a wrapper but contains the complete verified M-of-N package. Its
`physicalIndependenceClaimed` field is always `false`; downstream preflight must treat the package as
operator-authenticated evidence, not as a production-readiness verdict.

## Offline workflow

Canonical public JSON files must not be group/world-writable. Vaults must be owner-only `0600`.
All CLI reads are bounded, descriptor-bound, single-link, and `O_NOFOLLOW`.

```text
node blockchain/rehearsal-attestation-cli.mjs statement REPORT.json SET.json RUN_NONCE OBSERVED_MS EXPIRES_MS
```

Each operator independently reviews that statement and signs with an encrypted vault. The password
is accepted only through an already-open restricted inherited descriptor, never argv or an
environment value:

```text
NIR_REHEARSAL_PASSWORD_FD=3 node blockchain/rehearsal-attestation-cli.mjs \
  sign STATEMENT.json SET.json OPERATOR.nirvault.json operator-a 3<password-file
```

Collect the canonical attestation envelopes into one JSON array, then atomically accept the quorum:

```text
node blockchain/rehearsal-attestation-cli.mjs accept STORE SET.json ATTESTATIONS.json NOW_MS
node blockchain/rehearsal-attestation-cli.mjs verify PREFLIGHT-INPUT.json SET.json NOW_MS
```

The verifier must receive the expected attestor set out of band. Trusting only the set embedded in a
package would let an attacker substitute its own operators.

## Durable replay boundary

The acceptance store is an owner-only directory with a bounded 4096-record append-only hash chain,
exclusive writer lock, fsynced exclusive records, and two independently rewritten head copies.
Restart replays every record and requires both heads to agree with the complete chain. Reused run
nonces, accepted-package replay, per-operator observed-time rollback, missing records, single-copy
rollback, divergent heads, symlinks, hard links, concurrent writers, root replacement, and ambiguous
crash windows fail closed. The tool never deletes accepted records or automatically repairs an
ambiguous store.

Like every purely local two-copy store, it cannot detect an attacker who atomically rolls back the
entire directory and both heads to one older consistent snapshot. Operators that need that threat
model must publish the latest record hash/count outside the node (for example in an independently
retained incident record) and compare it before accepting another run.
