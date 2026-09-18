# Canonical model content v1

`nir-model-content-v1` is a bounded commitment format for the reference
evaluation runner. It detects exact reuse of the same declared model content
across different submitter keys and package wrappers. It is not a semantic
model, plagiarism detector, or proof that two different commitments represent
independent ideas.

## Manifest and supported containers

The input is either a directory or a tar archive readable as uncompressed,
gzip, bzip2, or xz. An archive may contain one arbitrary top-level wrapper
directory. The content root contains exactly one `nir-model-content.json`:

```json
{
  "entrypoint": {
    "adapter": "nir-static-eval-adapter-v1",
    "path": "model/answers.json"
  },
  "files": [
    { "executable": false, "path": "model/answers.json" },
    { "executable": false, "path": "model/weights.bin" }
  ],
  "format": "nir-model-content-v1",
  "role": "candidate"
}
```

The four top-level fields are exact; `role` is exactly `baseline` or
`candidate`. The only v1 adapter is `nir-static-eval-adapter-v1`. Its entrypoint
must be an allowlisted, non-executable regular file of at most 16 MiB containing
an exact JSON answer map. It is data, not a command: no shell, subprocess,
dynamic import, arbitrary executable or network operation is accepted.

The manifest and each file entry reject unknown or duplicate fields. Paths are relative,
ASCII, slash-separated canonical paths with at most 16 components and 240
bytes. Empty, dot, parent, absolute, backslash, duplicate, case-colliding and
Unicode paths fail closed. The manifest contains 1–256 sorted-or-unsorted file
entries; the canonicalizer sorts them itself. Every non-directory entry in the
container must be the manifest or an allowlisted regular file.

Symbolic links, hard links, devices, FIFOs and other special files are rejected.
The executable flag must match whether any executable bit is set on the regular
file. A container has at most 4,096 total directory/archive entries. Each file
is at most 512 MiB, total declared content is at most 1 GiB, the manifest is at
most 64 KiB, and the outer tar is at most 1 GiB plus 2 MiB.

## Commitment

The canonicalizer initializes SHA-256 with `NIR_MODEL_CONTENT_V1` followed by a
zero byte. It length-prefixes and hashes the role, adapter name and entrypoint
path, then for every allowlisted file in bytewise path order hashes:

1. the four-byte big-endian path length and ASCII path;
2. one byte for the executable bit;
3. the eight-byte big-endian content length; and
4. the exact file bytes, read in chunks of at most 1 MiB.

The result is encoded as `sha256:<64 lowercase hex>`. The manifest serialization,
archive entry order, optional outer directory name, tar owner/group names,
timestamps, and compression do not enter this digest. A content byte, canonical
path, executable-bit, role, adapter, or entrypoint change does. It also returns
the descriptor-bound `sha256:` digest of the entrypoint bytes used by the
data-only adapter.

Directory traversal is descriptor-relative. The root and every intermediate
directory are opened with no-follow semantics, file identity and metadata are
checked before and after streaming, and the original root inode must still be
present at the supplied path when hashing completes. Archives are also opened
no-follow and checked for mutation before and after parsing.
Platforms without nonzero `O_NOFOLLOW` and `O_DIRECTORY`, descriptor-relative
`open`/`stat`, no-follow `stat`, and descriptor-based directory scanning are
rejected; the canonicalizer does not silently weaken this boundary.

## Consensus binding and limits

The submitter places the candidate digest in `contentHash` and the known
reference digest in the separate `baselineContentHash` of the finalized
progress admission. `baselineHash` remains the baseline artifact/lineage
identity; these domains are not interchangeable. Capability memory commits an
artifact-to-content map in its root and snapshots, and admission requires
`baselineContentHash` to equal the content already recorded for
`baselineHash`; a submitter cannot nominate weaker bytes for a known baseline.
Both content commitments are
covered by `candidateId`, the later evaluator receipt, progress fingerprint,
runner bundle and complete chain state root; accepted candidate content also
enters capability memory. The reference adapter recomputes both local bundles,
enforces their manifest roles, and reads answers only from each committed
entrypoint. A separate artifact path cannot supply execution answers. Reusing the same digest under another artifact package,
metadata wrapper, challenge transcript, recipient, or key cannot create a
second admission or reward.

The bundle report records each side's canonical content commitment, entrypoint
digest/path, adapter and environment digest. Serialized bundles can verify
these commitments, but a plain `verifier_id` is not a cryptographic attestation.
The static adapter is a deterministic local conformance fixture, not a sandbox
or proof that a general model executed. Production receipts still require
independent signatures and attested isolation.

Validators see the digest, not private model bytes. They cannot tell whether a
submitter and captured evaluator quorum falsely labeled different bytes, nor
whether different byte commitments are semantically equivalent, derived from
the same training run, or partially copied. Production evaluation families
must specify which exact files constitute executable model content and run this
canonicalizer inside independently administered isolated environments.
