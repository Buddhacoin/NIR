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
4. On the destination, run `wallet:export-production verify EXPORT TRUSTED_RELEASE_ADDRESS TRUSTED_AUTHORITY_SET_ID NETWORK GENESIS WALLET_PACKAGE_HASH TOOL_PACKAGE_HASH`. The authority-set ID must come from an operator trust channel, not from the archive.
5. Run the same command with `import` and append `TARGET`. For an update, also append the exact current installation, its signed release, and its expected package hash.

Verification rejects noncanonical JSON, extra/missing/ambiguous paths, case collisions, traversal,
changed file bytes, insufficient/duplicate/unknown approvals, a different release signer, mixed
wallet/tool lineage, unexpected package hashes, and rollback/downgrade updates. Import uses the
existing exclusive generation installer and activates only after full verification; it neither copies
a live tree nor replaces an existing target.

The portable archive authenticates NIR wallet/tool bytes and release provenance. It does not attest
to the browser executable, operating system, system Node.js runtime, physical operator independence,
or machine integrity. Those remain deployment trust boundaries.
