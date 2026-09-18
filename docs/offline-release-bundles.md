# Offline-verifiable release bundles

This is an additional release transport for independent offline verification.
It does not replace the existing signed installer, make NIR production-ready,
or authorize an automatic update.

## Supply-chain boundary

The repository currently declares no npm dependencies or dev dependencies and
has no package lock. That is valid only while the dependency maps remain empty.
The bundle builder rejects npm lifecycle hooks (`preinstall`, `install`,
`postinstall`, `prepare`, `prepack`, and `postpack`), version ranges, Git/URL
dependencies, dependencies without `package-lock.json`, lockfiles other than
version 3, packages without registry URL plus SHA-512 integrity, linked packages,
and packages marked as having install scripts. Verification never invokes npm,
an archive tool, or any bundled executable.

Inputs are an explicit allowlist, not an implicit directory walk. `.git`,
`node_modules`, environment files, encrypted vaults, common key containers,
development key files, PEM private keys, and secret-bearing JSON are rejected.
Source files and every parent directory are opened without following symlinks;
inode, size, mode, timestamps, hard-link count and directory identity are
checked around the read.
The CLI additionally requires a clean tracked tree, compares every bundled byte
and executable mode with the exact blob/tree entry at `sourceRevision`, then
rechecks HEAD and tracked status. A clean-tree check alone is not treated as
provenance because a file could change between that check and its read.

## Formats

`nir-offline-release-bundle-v1` is canonical, uncompressed JSON. Entries are
sorted canonical relative paths with canonical base64 contents. Its embedded
manifest commits to every path, byte size, normalized installed mode (`0644` or
`0755`) and SHA3-256 digest, plus:

- release version;
- exact network identifier;
- protocol version;
- source revision;
- previous bundle hash or `null` for the first release;
- total uncompressed byte count.

The manifest hash and bundle hash are domain-separated. The separate
`nir-offline-release-approval-v1` is signed by an ML-DSA-65 release key decrypted
from a private NIR vault. The approval contains no private key or password.
ML-DSA signing is hedged/randomized by the runtime, so the unsigned bundle is
byte-for-byte reproducible while two valid detached approvals need not be
byte-identical.

## Create, sign and verify

Prepare a JSON array containing the exact files to ship, for example:

```json
["README.md", "blockchain/node.mjs", "package.json"]
```

On the build machine, create a new output file. The final argument is the
trusted previous bundle hash, or `none` only for the first release:

```bash
npm run release:bundle-create -- \
  /absolute/source /absolute/release-paths.json \
  0.2.0 nir-testnet 24 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  /absolute/new-release.nirbundle none
```

Move the deterministic bundle to an isolated signing machine. Password input is
interactive and is never accepted through arguments or environment variables:

```bash
npm run release:bundle-sign -- \
  /absolute/new-release.nirbundle \
  /secure/release-key.nirvault.json \
  /absolute/new-release.approval.json
```

An offline verifier must obtain the release-key address, expected version,
network, protocol, previous bundle hash and expected new bundle hash through an
independent trusted channel. Verification requires every value explicitly:

```bash
npm run release:bundle-verify -- \
  new-release.nirbundle new-release.approval.json \
  nir1TRUSTED_RELEASE_ADDRESS \
  0.2.0 nir-testnet 24 none \
  sha3-256:EXPECTED_BUNDLE_HASH
```

The command exits successfully only after canonical-schema, content, package
policy, context and post-quantum signature verification. Outputs are created
with exclusive creation; existing files are never overwritten.

## Safe update use

For every release after the first, set `previousBundleHash` to the exact bundle
hash already accepted by the operator. During verification, pass that same hash
instead of `none`. This creates a locally enforced forward chain and prevents a
valid older bundle from being mistaken for the requested update. Keep the last
accepted hash outside the download location.

This verifier deliberately does not extract, install, execute, or switch a live
node. After verification, use a separately reviewed no-replace generation
installer and retain the previous generation for operator-controlled rollback.
Never pipe bundle contents into a shell or run package lifecycle scripts.

## Residual risks

- The release signer and independently distributed trusted address remain a
  governance and key-custody trust root.
- A compromised source tree can contain malicious but non-secret code; hashes
  prove identity, not safety.
- Reproducibility still requires independent builders to use the same explicit
  allowlist and source revision.
- JSON/base64 is intentionally simple and offline-verifiable but larger than a
  compressed archive. Limits are 20,000 files, 32 MiB per file and 128 MiB total.
- Revocation, multi-party release approval, transparency logs, hardware-backed
  release keys and independent binary reproducibility remain future work.
