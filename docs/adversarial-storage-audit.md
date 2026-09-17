# Adversarial storage audit

Date: 2026-09-17

Scope: the redundant account-history journals, rebuildable SQLite serving
database, signed archive download and activation path, archive operator input,
and the node data-directory writer lock.

This is an internal adversarial review backed by automated tests. It is not an
independent security audit and does not certify production readiness.

## Threat model

The tests assume crashes at durable-install boundaries, malformed or oversized
local files, corrupted redundant copies, symbolic-link substitution, stale
process metadata, conflicting lock ownership, and malicious or faulty remote
archive services. Cryptographic private keys and the operating-system account
running the node are assumed not to be compromised.

An attacker with unrestricted access as the same operating-system user remains
outside this storage boundary: that attacker can modify executable code, stop
the process, or continuously rename parent directories. The writer lock prevents
accidental and cooperating-process concurrency; it is not an operating-system
sandbox.

## Findings fixed

### Predictable atomic-write temporary path

History records previously used a predictable process-ID temporary filename and
opened it with truncation. A pre-positioned symbolic link could redirect that
write outside the history directory.

The writer now creates a cryptographically random same-directory temporary file
with exclusive creation and `O_NOFOLLOW`, synchronizes its contents, renames it,
and synchronizes the real parent directory. The destination parent must be a
real directory rather than a symbolic link.

### Size-check/read race

History records, installation markers, downloaded chunks, and archive CLI JSON
used separate pathname-based size checks and reads. Replacement between those
operations could bypass the intended bound or change the verified object.

Each path is now opened once with `O_NOFOLLOW`; regular-file type and size are
checked with `fstat` on that descriptor; bytes are read from the same descriptor
and checked again after reading. Oversized input is rejected before parsing.

### Symbolic-link substitution of persistent state

History directories and SQLite database/sidecar paths did not all reject
symbolic links explicitly. The index now requires real root, primary, backup and
staging directories. Database and sidecar paths must be absent or regular files.
A substituted single journal file or database cache is removed only as a path
entry and recovered from authenticated redundant state; its external target is
not read or modified.

### Stale-lock removal race

Lock ownership was checked before recursive deletion of the fixed lock path. A
path swap in that interval could cause a different lock directory to be deleted.

Release and stale recovery now atomically rename the lock to a random quarantine
name, reopen and revalidate ownership after the rename, and delete only that
verified quarantine. If ownership changed, the operation fails without deleting
the replacement. Stale recovery checks process liveness both before and after
the move.

### Archive operator path substitution

The operator CLI now applies the same descriptor-bound regular-file and size
checks to genesis, operator policy and archive JSON. Symbolic-link input fails
closed.

## Automated adversarial matrix

- 32 deterministic byte-corruption positions in the latest primary history
  record, each repaired from the independently verified backup;
- an 8,000,001-byte history record rejected before JSON parsing and repaired;
- journal-file and SQLite symbolic links aimed at an external sentinel, with the
  sentinel proven unchanged after recovery;
- a symbolic-link history directory rejected before use;
- live-lock exclusion, dead-process recovery, malformed owner rejection,
  symbolic-link owner rejection, and ownership mutation during release;
- activation resumed from a verified staged generation;
- activation resumed from an already installed complete live generation;
- activation refused when no complete verified generation remained;
- damaged remote chunks, excessive declared download size, untrusted signer,
  insufficient independent sources, and conflicting operator content;
- archive CLI symbolic-link input rejection.

Every recovery path finishes by rechecking record hashes, transaction inclusion
paths, the complete account-history commitments, the finalized height and tip,
and the archive content root. A damaged serving cache cannot change consensus
state.

## Remaining risks

- Power-loss testing currently exercises represented crash states, not real
  filesystem fault injection at every individual syscall. A production drill
  should use forced process termination and storage fault injection on every
  supported filesystem.
- A hostile process running as the same operating-system user can still attack
  ancestors of the node directory or alter the program itself. Production nodes
  need a dedicated restricted user, private data directory and host isolation.
- Process identifiers can be reused. The conservative result is denial of stale
  lock recovery, not concurrent ownership; an operator may need to inspect and
  remove that lock manually.
- Native SQLite behavior and filesystem durability semantics require external
  review and sustained large-dataset tests. The database remains disposable and
  rebuildable from verified journals.
- Independent archive operators and transport diversity are deployment
  requirements; local tests cannot create organizational independence.
