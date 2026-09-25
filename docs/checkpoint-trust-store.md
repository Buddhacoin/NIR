# Durable checkpoint trust store

`blockchain/checkpoint-trust-store.mjs` persists the anti-rollback floor used
when accepting protocol-v28 checkpoint trust packages. It records the exact
network, chain-identity genesis hash, pinned witness-policy ID, accepted package
hash, sequence, checkpoint height, and a local revision.

No value from an incoming package becomes durable until
`verifyCheckpointTrustPackage()` has validated its finality proof, witness
quorum, package hash, pinned identity, and the currently persisted sequence and
height floors. A later package must increase the sequence and may not reduce the
height. Replaying the current package is idempotent; a different package at the
same sequence is divergence and fails closed.

## Storage safety

The store keeps two canonical, fsync-backed copies. Every revision commits to
the preceding record hash. Loading accepts identical copies or the one-step
old/new pair left by an interrupted second-copy replacement. Any unrelated
fork, malformed record, non-canonical encoding, oversized file, symlink, or
hard-linked copy is rejected. Store roots and copies must be owned by the
current account and inaccessible to group/other users; newly created objects
use modes `0700` and `0600`. Writes use an exclusive, identity-checked lock,
temporary file, atomic rename, file fsync, and directory fsync.

The exclusive lock contains bounded canonical JSON with a PID and random
256-bit ownership token. A live owner or malformed owner record fails closed.
After a crash, a dead owner's lock is read twice through `O_NOFOLLOW`, its
identity and process liveness are rechecked, and it is moved through a private
hard-link quarantine before deletion. This recovers progress without allowing
one writer to delete another writer's newly acquired lock.

The parent directory is opened with `O_DIRECTORY|O_NOFOLLOW` and its device and
inode are pinned for the process lifetime. Replacing that directory while a
verifier is running poisons the handle. The process also retains its highest
observed local revision, so replacing both copies with an older pair during the
same run is rejected.

These controls protect against application bugs, concurrent writers, partial
writes, and ordinary local file substitution. They do not defeat an attacker
who can roll back the entire filesystem, both copies, and the executable across
a reboot. That stronger threat requires a host TPM/secure element, an external
monotonic counter, or independently retained operator evidence. Backups must
therefore preserve both copy files together and must not be treated as a way to
lower the accepted floor.

## Bounded CLI

The command reads packages with the same 4 MiB bound and canonical-JSON rule as
the offline package verifier. Bootstrap inputs must come from independent,
pinned operator configuration, never from the package being imported.

```sh
npm run checkpoint-trust-store -- init \
  /var/lib/nir/checkpoint-trust \
  ./checkpoint-package.json \
  nir-mainnet <genesis-hash> <policy-id> 0 1

npm run checkpoint-trust-store -- accept \
  /var/lib/nir/checkpoint-trust ./newer-checkpoint-package.json

npm run checkpoint-trust-store -- show /var/lib/nir/checkpoint-trust
```

`init` creates `<path>.primary` and `<path>.secondary` exclusively. `accept`
derives all identity and replay floors from those verified local copies. `show`
performs the complete redundant-copy and filesystem-safety validation before it
prints the current record.

## Witness-policy rotation

A pinned witness policy cannot be replaced by a package signed only by the new
policy. Rotation is a two-phase, hash-linked trust-store transition:

1. `nir-checkpoint-witness-policy-transition-v1` binds the network, genesis,
   current package hash, old/new policy IDs, consecutive generations, activation
   sequence and height, and the exact continuing witness identities.
2. More than two thirds of the currently pinned witnesses sign that transition.
   Every member of the new policy separately proves possession of its new key.
   At least one third of the smaller committee must retain the same operator,
   address, and public key, preventing an abrupt unrelated replacement.
3. `rotate-schedule` records only the authorized pending transition. The old
   policy remains active for at least two checkpoint sequences and ten finalized
   heights.
4. `rotate-activate` requires a fresh package signed by the old policy at or
   beyond both activation floors. It atomically changes the active policy ID and
   generation; after that, only packages signed by the new policy are accepted.

```sh
npm run checkpoint-trust-store -- rotate-schedule \
  /var/lib/nir/checkpoint-trust transition.json old-policy.json new-policy.json

npm run checkpoint-trust-store -- rotate-activate \
  /var/lib/nir/checkpoint-trust transition.json activation-package.json \
  old-policy.json new-policy.json
```

The transition's `createdSequence`, `createdHeight`, and `createdPackageHash`
must equal the locked local head when scheduled. A second, different pending
transition is equivocation and is rejected. Replays, skipped generations,
foreign network/genesis policies, incomplete new-key possession, early
activation, and ordinary `accept` after an activation floor all fail closed.
The redundant-copy reconciler accepts an interrupted schedule or activation
only when the newer record is the exact authorized successor of the older one.

## Verify an exact assignment and advance atomically

Do not copy `policyId`, `minimumCheckpointHeight`, or `minimumSequence` from an
incoming assignment into a verifier command. That would let the untrusted
package choose its own trust root. The production path reads all three values,
plus the network and genesis identity, from the durable store:

```sh
npm run assignment:verify-stored -- \
  /var/lib/nir/checkpoint-trust \
  ./exact-assignment-v4.json
```

The input is canonical JSON with one trailing newline. It contains the exact V4
assignment, its attached checkpoint trust package, the finalized header suffix,
anchors, and inclusion proofs; it contains no private keys or passwords. The
accepted field set and total bytes are bounded.

`verifyAssignmentWithCheckpointTrustStore()` holds the store's exclusive lock
while it verifies the attached package against the pinned policy and current
height/sequence floors, then verifies the *whole* assignment: finality suffix,
handoffs, assignment leaf, transaction inclusion, semantic bindings, and exact
assignment hash. Only after every check succeeds does it replace the redundant
store copies. A forged assignment, replay, rollback, live concurrent writer,
symlinked input, changed input file, or non-canonical JSON fails closed and does
not advance the floor. Re-verifying the identical accepted package is idempotent
and does not create another revision.

The lock is intentionally synchronous: application callbacks cannot defer work
until after the protected compare-and-swap. Operators should run one verifier
per trust-store path and treat a live-lock error as a retryable operational
conflict, never as permission to bypass the store.
