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
auditable release container. Verified wallet and node packages can be installed
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
refuse an existing directory and construct the result in a randomly named,
exclusively created sibling staging directory under a descriptor-verified parent.
Every file is created with no-follow/exclusive flags, mode-set and read back through
the same descriptor, then files and directories are synced before the completed
tree is atomically renamed to the still-new target. A failure removes only that
installer-owned staging generation and preserves any existing target.

The kind-specific `NIR-INSTALL.json` records the verified artifact, source,
release, and signer identities. Reverification opens files with `O_NOFOLLOW`,
checks pre/post-read `fstat` identity, size, timestamps and mode, and rejects
directory replacement, missing, additional, modified, symbolic-link, special,
mode-tampered, or group/world-writable entries. The wallet result is an auditable
web/extension directory and the node result is an auditable Node.js source
installation; they are not yet click-to-install, platform-signed native applications.

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
