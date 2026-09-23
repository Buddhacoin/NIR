# Verifiable NIR source releases

NIR release manifests bind one clean Git revision to the exact tracked file
set. Each entry commits to its canonical relative path, byte length, SHA3-256
digest, and executable bit. The complete manifest is then signed with ML-DSA-65.
Changing one byte, changing file mode, adding or removing a tracked file, using
a symlink, or presenting another signing identity makes verification fail.

This protects source distribution. NIR also has a deterministic `.nirpkg`
container for the wallet and node source payloads. It is byte-identical when
built from the same signed revision and binds every embedded file back to that
manifest. Native macOS, Windows, Linux, and browser-store packages are not yet
reproducible and remain a separate launch gate.

## Create a dedicated release key

Do not reuse a treasury, validator, beacon, evaluator, or everyday wallet key.
Create an encrypted offline vault and publish its address through multiple
independent project channels:

```bash
npm run wallet:create -- /offline/path/nir-release-key.nir
npm run wallet:address -- /offline/path/nir-release-key.nir
```

The repository does not silently decide which address is trusted. Verifiers
must receive the expected release address from a separately authenticated
policy, future genesis commitment, or well-publicized key ceremony.

## Create and sign

Use a clean checkout. The create command refuses modified tracked files and
derives the revision and version itself:

```bash
npm run release:create -- . /tmp/nir-0.2.0-manifest.json
npm run release:sign -- \
  /tmp/nir-0.2.0-manifest.json \
  /offline/path/nir-release-key.nir \
  /tmp/nir-0.2.0-signed.json
```

The vault password is read from an interactive terminal and never placed in
arguments or environment variables. Signing should happen offline after at
least two people independently compare the revision and manifest hash.

## Verify

Check out the claimed revision, obtain the signed JSON through any channel, and
provide the independently known signer address:

```bash
npm run release:verify -- \
  . /path/to/nir-0.2.0-signed.json nir1TRUSTED_RELEASE_ADDRESS
```

Verification checks the ML-DSA-65 signature, trusted address, Git revision,
complete tracked path set, sizes, modes, and file digests. A valid signature
does not replace code review, independent builds, malware scanning, external
audits, or a multi-party release ceremony.

## Build reproducible NIR packages

After source verification, build either recipe twice on separate clean machines:

```bash
npm run release:build -- \
  wallet . signed-release.json nir1TRUSTED_RELEASE_ADDRESS wallet.nirpkg

npm run release:build -- \
  node . signed-release.json nir1TRUSTED_RELEASE_ADDRESS node.nirpkg
```

Verify a package without trusting the machine that built it:

```bash
npm run release:verify-artifact -- \
  wallet.nirpkg signed-release.json nir1TRUSTED_RELEASE_ADDRESS
```

The wallet recipe includes `wallet-ui/`; the node recipe includes `blockchain/`
and `package.json`. The canonical JSON container has no timestamps, host paths,
file-order ambiguity, compression metadata, or network-fetched dependencies.
Its `artifactHash` must match across independent builders. `.nirpkg` is an
auditable developer/testnet release container; it is deliberately not evidence
of mainnet or production readiness. Verified wallet and node packages can be installed
into new directories without trusting their distributor:

```bash
npm run release:install-wallet -- \
  wallet.nirpkg signed-release.json nir1TRUSTED_RELEASE_ADDRESS \
  /absolute/path/to/new-nir-wallet

npm run release:verify-wallet-install -- \
  /absolute/path/to/new-nir-wallet \
  signed-release.json nir1TRUSTED_RELEASE_ADDRESS

npm run release:install-node -- \
  node.nirpkg signed-release.json nir1TRUSTED_RELEASE_ADDRESS \
  /absolute/path/to/new-nir-node

npm run release:verify-node-install -- \
  /absolute/path/to/new-nir-node \
  signed-release.json nir1TRUSTED_RELEASE_ADDRESS
```

The install commands verify the post-quantum release signature, trusted signer
address, source-manifest binding, artifact hash, complete deterministic file
set, every file digest, and all paths before creating the destination. They
refuse any existing target and construct the result in a randomly named,
exclusively created sibling generation under a descriptor-verified parent.
Every file is created with no-follow/exclusive flags, mode-set and read back through
the same descriptor, then files and directories are synced. Node does not expose a
portable atomic no-replace directory rename, so the exact target is instead an
atomically created relative directory symlink to that completed generation. Symlink
creation fails with `EEXIST` for every pre-existing target type, including an empty
directory created after the initial absence check; it never replaces that target.
A failed activation removes only the installer-owned generation and preserves the
competing target. Operators must treat the target symlink and its same-parent hidden
`.TARGET.nir-generation-*` directory as one installation and must not move either
independently.

Inspect generations without changing them:

```bash
npm run release:inventory-node -- \
  /absolute/path/to/new-nir-node signed-release.json nir1TRUSTED_RELEASE_ADDRESS
```

The wallet equivalent is `release:inventory-wallet`. Inventory resolves only the
strict relative active link, verifies provenance and every file against the signed
release, and lists only strict sibling generation names. Entries are classified as
`active`, `verified-orphan`, `invalid`, or `foreign`; arbitrary sibling names are
ignored.

Pruning requires the exact generation basename and its expected artifact hash. It
is a dry run unless `--execute` is explicitly present:

```bash
npm run release:prune-node-generation -- \
  /absolute/path/to/new-nir-node \
  .new-nir-node.nir-generation-0123456789abcdef0123456789abcdef \
  EXPECTED_ARTIFACT_HASH signed-release.json nir1TRUSTED_RELEASE_ADDRESS

npm run release:prune-node-generation -- \
  /absolute/path/to/new-nir-node \
  .new-nir-node.nir-generation-0123456789abcdef0123456789abcdef \
  EXPECTED_ARTIFACT_HASH signed-release.json nir1TRUSTED_RELEASE_ADDRESS --execute
```

The wallet command is `release:prune-wallet-generation`. Prune refuses active,
foreign, symbolic-link, invalid, signer-mismatched, hash-mismatched, or concurrently
replaced generations. The installation parent must remain operator-controlled for
the duration of the explicit operation; the tool rechecks descriptor identities
immediately before deletion and fails closed when it observes replacement.

The kind-specific `NIR-INSTALL.json` records the verified artifact, source,
release, and signer identities. Reverification accepts only the exact relative
same-parent generation-link form, pins that activation link's inode and destination,
and opens generation files with `O_NOFOLLOW`,
checks pre/post-read `fstat` identity, size, timestamps and mode, and rejects
directory replacement, missing, additional, modified, symbolic-link, special,
mode-tampered, or group/world-writable entries. The wallet result is an auditable
web/extension directory and the node result is an auditable Node.js source
installation; they are not yet click-to-install, platform-signed native applications.

## Production release gate

Production packaging uses a distinct `nir-production-release-package-v1` wrapper.
It cannot be created by `release:build`. The wrapper commits to the ordinary
reproducible artifact, the canonical external-evidence production preflight, and
an exact reviewed target:

```json
{"finalizedTip":"HEX_OR_SHA3_HASH","format":"nir-production-release-target-v1","genesisHash":"HEX_OR_SHA3_HASH","maxFutureSkewMs":300000,"maxPreflightAgeMs":3600000,"networkId":"nir-mainnet-reviewed-id","releaseManifestHash":"64_HEX","releaseVersion":"1.2.3","sourceRevision":"GIT_COMMIT_HEX","version":1}
```

The target and production report files must be canonical JSON with one trailing
newline. `sourceRevision`, `releaseVersion`, and `releaseManifestHash` must exactly
match the trusted post-quantum signed release. Network ID, genesis, finalized tip,
and manifest hash must also exactly match both the report and its independently
signed rehearsal quorum statement. The report must reproduce from its embedded
external evidence, have `EXTERNAL-EVIDENCE-PASS`, remain inside the target's bounded
freshness window, and contain an unexpired attestation at the operator-supplied
current time.

```bash
npm run release:build-production -- \
  node . signed-release.json nir1TRUSTED_RELEASE_ADDRESS \
  production-target.json production-preflight.json CURRENT_UNIX_TIME_MS node.nirprod

npm run release:verify-production-artifact -- \
  node.nirprod signed-release.json nir1TRUSTED_RELEASE_ADDRESS CURRENT_UNIX_TIME_MS

npm run release:install-production-node -- \
  node.nirprod signed-release.json nir1TRUSTED_RELEASE_ADDRESS \
  CURRENT_UNIX_TIME_MS /absolute/path/to/new-nir-node
```

Wallet commands use the same flow with `wallet` and
`release:install-production-wallet`. A missing, failed, stale, future, expired, or
mixed-context preflight is rejected before an output package or installation target
is created. Inputs are read through pinned no-follow descriptors and canonical
reports reject alternate byte encodings. Output activation is exclusive and
no-replace; parent, temporary, and target identities are checked around activation,
and cleanup removes only inodes created by that attempt. The output parent remains
an operator-controlled local security boundary.

This gate authenticates reviewed release and external rehearsal evidence. It does
not deploy hosts, embed secrets, prove physical operator independence by itself, or
turn the current developer testnet tooling into a production-ready network.

## Build the browser extension ZIP

The extension recipe uses the same signed source release and produces an
uncompressed deterministic ZIP with fixed timestamps, canonical file ordering,
stable Unix modes, and an embedded `NIR-RELEASE.json` provenance record:

```bash
npm run release:build-extension -- \
  . signed-release.json nir1TRUSTED_RELEASE_ADDRESS nir-wallet-extension.zip

npm run release:verify-extension -- \
  . signed-release.json nir1TRUSTED_RELEASE_ADDRESS nir-wallet-extension.zip
```

Independent builders must obtain the same extension hash. The archive contains
a Manifest V3 wallet with no requested browser permissions. It is still a
valueless developer preview: transaction signing remains in the native
encrypted-vault process, and store publication must wait for the security audit.
Chrome/Chromium can load the extracted directory through developer mode. Safari
requires conversion and signing through Xcode; that platform package is not yet
implemented.
