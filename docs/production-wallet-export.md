# Production wallet export

The production wallet UI and browser-extension snapshot can be moved between machines as a
canonical `nir-production-wallet-export-v1` archive. The archive is built from already verified
production wallet and node/tool packages, never from a live source directory. It contains the exact
wallet package, the exact tool package, the signed source release, an exact lineage binding, and a
second immutable copy of every extension file. Both the outer manifest and the wallet artifact bind
every file digest.

The archive is authorized by the existing release model. Operators sign the generated offline bundle
with `release:bundle-sign`; `wallet:export-production assemble` requires the configured threshold of
unique members of a `nir-release-authority-set-v1`. The release signer remains a separate, explicitly
trusted input. A signer address embedded in the archive is never accepted as its own trust anchor.

Typical offline flow:

1. Run `wallet:export-production build WALLET_PACKAGE TOOL_PACKAGE SIGNED_RELEASE TRUSTED_RELEASE_ADDRESS PREVIOUS_BUNDLE|none BUNDLE` on the verified build machine.
2. Distribute `BUNDLE` to release authorities. Each authority uses `release:bundle-sign BUNDLE ENCRYPTED_VAULT APPROVAL` offline.
3. Run `wallet:export-production assemble BUNDLE AUTHORITY_SET EXPORT APPROVAL...`.
4. Append the assembled export with `wallet:release-transparency append`. Create a checkpoint payload, obtain the configured authority quorum with the offline `sign` command, assemble it, and export the inclusion proof. Publish the compact gossip checkpoint through at least two operator-selected channels.
5. On the destination, run `wallet:export-production verify EXPORT TRUSTED_RELEASE_ADDRESS TRUSTED_AUTHORITY_SET_ID NETWORK GENESIS WALLET_PACKAGE_HASH TOOL_PACKAGE_HASH SIGNED_CHECKPOINT INCLUSION_PROOF TRUSTED_CHECKPOINT_HASH NOW_MS`. The authority-set ID and checkpoint hash must come from operator trust channels, not from the archive.
6. Run the same command with `import` and append `TARGET`. For an update, also append the exact current installation, its signed release, and its expected package hash.

Verification rejects noncanonical JSON, extra/missing/ambiguous paths, case collisions, traversal,
changed file bytes, insufficient/duplicate/unknown approvals, a different release signer, mixed
wallet/tool lineage, unexpected package hashes, and rollback/downgrade updates. Import uses the
existing exclusive generation installer and activates only after full verification; it neither copies
a live tree nor replaces an existing target.

The transparency store is a bounded append-only hash chain with a Merkle root and two crash-safe
copies. Checkpoints bind the latest wallet/tool generations and require the release-authority quorum.
Inclusion proofs bind an export to a fresh trusted checkpoint; logarithmic consistency proofs connect
older and newer roots and reject omission, reordering, truncation, and forks. A same-size gossip
checkpoint with a different root is direct split-view evidence. A larger checkpoint is accepted as a
continuation only with a valid consistency proof. Checkpoint validity is bounded to seven days and
verification rejects both future and expired checkpoints. The local store alone cannot detect a coordinated
rollback of both copies; retain checkpoint hashes outside the machine and compare gossip checkpoints
over independent operator-selected channels.

Authority rotation is an offline ceremony. `transition-create` binds the last old-set checkpoint,
network/genesis, the exact next monotonically numbered set, activation sequence, grace end, and a
unique nonce. `transition-sign` is run separately by old and new operators; `transition-assemble`
requires both thresholds, so the new signatures are also proof of possession. `transition-schedule`
commits the approved transition into both store snapshots. The old set remains active until the
delayed activation sequence, is permanently tombstoned at activation, and cannot be reintroduced.
During the bounded grace window an old release may be checked against the first new-set checkpoint
only when the dual-signed transition and a consistency proof from the last old root are supplied.
Skipped generations, self-authorized takeover, replayed nonce/set IDs, mixed network/genesis,
rollback, and signing outside the activation/grace rules fail closed.

The portable archive authenticates NIR wallet/tool bytes and release provenance. It does not attest
to the browser executable, operating system, system Node.js runtime, physical operator independence,
or machine integrity. Nor does it prove global log availability or physical channel/operator
independence. Those remain deployment trust boundaries.
