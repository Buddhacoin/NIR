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
auditable release container, not yet a click-to-install desktop application.
