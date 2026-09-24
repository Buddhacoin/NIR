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
