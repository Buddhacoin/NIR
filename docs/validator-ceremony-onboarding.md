# Validator onboarding from a genesis ceremony

`validator:ceremony` is a portable operator-onboarding foundation for the
valueless developer testnet ceremony. It replaces the key-distribution part of
the centralized development initializer: every operator creates and encrypts
their own validator and transport wallets locally, then installs evidence for
only that validator. It does not start a node, distribute a secret, configure a
host, or demonstrate that different validators run on independent hosts.

This runbook implements gate 4 in the canonical
[public-testnet gate matrix](public-testnet-gates.md); the separate multi-host
evidence gate is what records operator attestations from distinct endpoints.

## Required public evidence and local secrets

The operator must obtain the exact compiled `genesis.json`, ceremony plan and
approval envelope, signed source-release manifest, trusted release signer
address, and externally stored ceremony-registry anchor. The plan must contain
an HTTPS endpoint, transport identity, and TLS certificate SHA-256 pin for the
operator's validator.

Locally, create two separately encrypted vaults: one for the validator
finality/consensus identity and one for its authenticated transport identity. Keep the
vault passwords outside the command line. Supply the public TLS certificate
whose DER fingerprint is committed by the ceremony. The tool decrypts each
vault only in memory, signs and verifies domain-separated possession challenges,
and stores only the original encrypted vaults. It never prints or writes a
private key.

Initialize a target name that does not exist:

```sh
npm run validator:ceremony -- init-from-ceremony \
  /srv/nir/validator-0 \
  genesis.json plan.json approvals.json signed-release.json \
  nir1_TRUSTED_RELEASE_SIGNER anchor.json \
  validator-vault.json transport-vault.json validator-cert.pem
```

The command verifies all ceremony and release signatures, the external anchor,
the compiled genesis hash, validator-set and peer-registry commitments, local
validator/transport public identities, endpoint, and TLS pin before writing.
It creates a random sibling generation directory with mode `0700`, writes the
fixed evidence set with mode `0600`, fsyncs it, and activates it with a new
relative symlink. Symlink creation has no replace semantics, so a concurrently
created target is preserved. On failure, cleanup is limited to the random
generation whose filesystem identity the process created.

Reverify before startup:

```sh
npm run validator:ceremony -- reverify \
  /srv/nir/validator-0 nir1_TRUSTED_RELEASE_SIGNER
```

Reverification requires both vault passwords again and repeats signature,
anchor, topology, TLS pin, encrypted-vault integrity, and local key-possession
checks. It also enforces the exact generation name, exact file set, `0700/0600`
modes, bounded regular files, and no-follow reads.

## Start the validator without plaintext wallet files

`serve-validator` recognizes the ceremony activation link, requires the trusted
release signer address again, reverifies the complete evidence, decrypts the
validator and transport wallets into process memory, and passes them directly
to `ValidatorReplica`. Ceremony mode rejects `VALIDATOR-KEY.json` and
`TRANSPORT-KEY.json`; it never falls back to the development plaintext layout.
The finality and transport private keys remain in memory only for the lifetime
of the validator process.

For an attended start, run the command in a real terminal. Both prompts disable
terminal echo and the passwords are not accepted through arguments,
environment variables, or configuration files:

```sh
NIR_TLS_KEY_PATH=/secure/runtime/validator-tls-key.pem \
  npm run network:validator -- \
  /srv/nir/validator-0 9443 nir1_TRUSTED_RELEASE_SIGNER
```

For a supervisor, inherit two already-opened private pipes or owner-only regular
file descriptors. Descriptor 3 carries the validator-vault password and
descriptor 4 carries the transport-vault password; each contains one password
with an optional final newline. Regular-file descriptors must be owned by the
current uid with no group/world permissions. The implementation reads each
descriptor once, bounds it to 1024 bytes, and best-effort zeros the password
buffers after vault loading. Example shell descriptor wiring (the referenced
files must already be `0600` and should preferably be replaced by a supervisor's
anonymous credential pipes):

```sh
NIR_TLS_KEY_PATH=/secure/runtime/validator-tls-key.pem \
  npm run network:validator -- \
  /srv/nir/validator-0 9443 nir1_TRUSTED_RELEASE_SIGNER \
  3</run/credentials/nir-validator-password \
  4</run/credentials/nir-transport-password
```

The public TLS certificate is loaded from the verified ceremony generation by
default. `NIR_TLS_KEY_PATH` names the separately provisioned TLS private key;
the existing TLS loader verifies that it matches the certificate. The trusted
release signer and filesystem paths are public configuration, not passwords.

Ceremony genesis has no centralized coordinator identity. Therefore this mode
serves public health/discovery and validator-authenticated P2P routes, while all
coordinator-authenticated routes fail closed. It is suitable for the validator
transport path without recreating the centralized development coordinator.

## Security boundary

- Publish and retain the ceremony anchor outside the validator machine. The
  two local registry copies alone cannot detect their coordinated rollback.
- Provision the TLS private key through a separate hardened mechanism. This
  workflow verifies the committed public certificate but does not copy or
  export its private key.
- `init-from-ceremony` itself never starts network services. `serve-validator`
  explicitly starts the initialized validator after fresh verification. Runtime
  TLS key custody, lifecycle certificates, monitoring, and host separation
  remain explicit operator responsibilities.
- Never replace the activation link or generation by hand. Create a new target
  through a separately reviewed migration procedure if evidence changes.
