# Validator join workspace (testnet Slice A)

`validator:join` prepares local validator identities on macOS or Linux. It is not a network join,
does not build or broadcast a transaction, and does not claim that an address is queued, eligible,
selected, or active.

## What this slice does

- validates an HTTPS endpoint against a currently valid X.509 certificate, hostname, pinned
  SHA-256 fingerprint, and matching private key;
- creates separate post-quantum consensus and transport identities;
- encrypts both identities under different passwords entered only in an interactive terminal;
- writes a private, restart-verifiable workspace and verified encrypted backups;
- stores only public identity data and encrypted vaults. The TLS private key is validated in memory
  and is not copied into the workspace.

The workspace finishes in the explicit state
`awaiting external v31 candidate service / quorum observation`.

## Prepare a private configuration directory

The directory containing the configuration and TLS key must be owned by the current user and mode
`0700`; the private key and configuration must be mode `0600`. Use absolute paths.

```json
{"endpoint":"https://validator.example","expectedChainIdentityGenesisHash":"<64 lowercase hex>","expectedCheckpointPolicyId":"sha3-256:<64 lowercase hex>","expectedTlsCertificateSha256":"<64 lowercase hex>","format":"nir-validator-join-config-v1","networkId":"nir-testnet","operatorId":"my-operator","tlsCertificate":"/absolute/private/path/tls-cert.pem","tlsPrivateKey":"/absolute/private/path/tls-key.pem","version":1}
```

The chain identity and checkpoint policy fields are pinned now so that a later proof-backed network
step cannot silently switch the workspace to another network. Slice A does not itself consume a
checkpoint package.

## Commands

```sh
npm run validator:join -- init /absolute/private/path/join-workspace /absolute/private/path/config.json
npm run validator:join -- verify /absolute/private/path/join-workspace
npm run validator:join -- backup /absolute/private/path/join-workspace /absolute/offline/path/join-backup 1
npm run validator:join -- status /absolute/private/path/join-workspace
```

Passwords are rejected from ordinary stdin, command-line arguments, and environment variables.
Run `init`, `verify`, and `backup` in an interactive terminal. Keep the two passwords and backup
media separate. Losing either identity can prevent operation or safe recovery.

## Slice B still required

Joining the v31 queue still requires a separately reviewed non-voting candidate service. That
service must supply a finalized, proof-backed balance/nonce/network context; submit to multiple
peers; prove finalized admission; perform a pinned HTTPS challenge; collect a fresh current-validator
quorum observation; expose proof-backed status; and bind onboarding to the certified endpoint and
transport identity. Only then may an offline transaction signer be connected to this workspace.

Until Slice B exists, do not manually fabricate a nonce, readiness quorum, or “active” status from
the files in this directory.
