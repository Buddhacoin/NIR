# Validator onboarding from a genesis ceremony

`validator:ceremony` is a portable operator-onboarding foundation for the
valueless developer testnet ceremony. It replaces the key-distribution part of
the centralized development initializer: every operator creates and encrypts
their own validator and transport wallets locally, then installs evidence for
only that validator. It does not start a node, distribute a secret, configure a
host, or demonstrate that different validators run on independent hosts.

## Required public evidence and local secrets

The operator must obtain the exact compiled `genesis.json`, ceremony plan and
approval envelope, signed source-release manifest, trusted release signer
address, and externally stored ceremony-registry anchor. The plan must contain
an HTTPS endpoint, transport identity, and TLS certificate SHA-256 pin for the
operator's validator.

Locally, create two separately encrypted vaults: one for the validator
consensus identity and one for its authenticated transport identity. Keep the
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

Reverify before using the evidence in a later node-configuration workflow:

```sh
npm run validator:ceremony -- reverify \
  /srv/nir/validator-0 nir1_TRUSTED_RELEASE_SIGNER
```

Reverification requires both vault passwords again and repeats signature,
anchor, topology, TLS pin, encrypted-vault integrity, and local key-possession
checks. It also enforces the exact generation name, exact file set, `0700/0600`
modes, bounded regular files, and no-follow reads.

## Security boundary

- Publish and retain the ceremony anchor outside the validator machine. The
  two local registry copies alone cannot detect their coordinated rollback.
- Provision the TLS private key through a separate hardened mechanism. This
  workflow verifies the committed public certificate but does not copy or
  export its private key.
- The output is not a runnable validator directory and the command never starts
  network services. Runtime configuration, transport TLS key custody, lifecycle
  certificates, monitoring, and host separation remain explicit later steps.
- Never replace the activation link or generation by hand. Create a new target
  through a separately reviewed migration procedure if evidence changes.
