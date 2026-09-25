# Validator join workspace (testnet Slices A and B1)

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

The workspace initially finishes in the explicit state
`awaiting external v31 candidate service / quorum observation`. Slice B1 can then synchronize a
read-only, proof-backed candidate context. It still cannot submit an admission, obtain a readiness
observation, select a validator, or activate it.

## Prepare a private configuration directory

The directory containing the configuration and TLS key must be owned by the current user and mode
`0700`; the private key and configuration must be mode `0600`. Use absolute paths.

```json
{"candidateContextMaxWitnessAgeMs":300000,"candidateContextMinimumCheckpointHeight":1,"candidateContextMinimumSequence":0,"endpoint":"https://validator.example","expectedChainIdentityGenesisHash":"<64 lowercase hex>","expectedCheckpointPolicyId":"sha3-256:<64 lowercase hex>","expectedTlsCertificateSha256":"<64 lowercase hex>","format":"nir-validator-join-config-v2","networkId":"nir-testnet","operatorId":"my-operator","tlsCertificate":"/absolute/private/path/tls-cert.pem","tlsPrivateKey":"/absolute/private/path/tls-key.pem","version":2}
```

The chain identity and checkpoint policy fields are pinned so a later network response cannot
silently switch the workspace to another network. The three `candidateContext...` fields are also
operator-pinned rollback and freshness floors: the checkpoint height and witness sequence cannot
move below them, and witness observations older than the configured maximum are rejected. Choose
these from an independently obtained testnet release/checkpoint notice, not from the nodes being
queried. Original v1 Slice-A workspaces remain readable for `status`, `verify`, and `backup`, but
must be explicitly recreated or migrated to a v2 plan before `sync`; missing anchors are never
invented.

## Commands

```sh
npm run validator:join -- init /absolute/private/path/join-workspace /absolute/private/path/config.json
npm run validator:join -- verify /absolute/private/path/join-workspace
npm run validator:join -- backup /absolute/private/path/join-workspace /absolute/offline/path/join-backup 1
npm run validator:join -- status /absolute/private/path/join-workspace
npm run validator:join -- sync /absolute/private/path/join-workspace /absolute/path/public-sync-input.json
```

Passwords are rejected from ordinary stdin, command-line arguments, and environment variables.
Run `init`, `verify`, and `backup` in an interactive terminal. Keep the two passwords and backup
media separate. Losing either identity can prevent operation or safe recovery.

## Synchronize a read-only candidate context (Slice B1)

Create a public sync-input file. It contains no passwords or private keys. `peers` must cover the
entire validator set named by the checkpoint trust package, exactly once; every URL is an HTTPS
origin with an independently pinned TLS certificate fingerprint.

```json
{"checkpointTrustPackage":{"format":"nir-checkpoint-trust-package-v1","...":"full verified package"},"format":"nir-validator-candidate-sync-v1","peers":[{"tlsCertificateSha256":"<64 lowercase hex>","url":"https://validator-1.example","validatorAddress":"nir1<64 lowercase hex>"}],"version":1}
```

Then run:

```sh
npm run validator:join -- sync /absolute/private/path/join-workspace /absolute/path/public-sync-input.json
npm run validator:join -- status /absolute/private/path/join-workspace
```

The command verifies the pinned checkpoint witness policy and freshness, exact chain identity,
network, protocol v31, validator set, finality certificate, account root, balance/nonce proof, and
candidate-queue proof from a current validator quorum. B1 deliberately accepts only the exact
checkpoint view: it does not infer an unproven continuation. The resulting public context is written
atomically and append-only inside the workspace. Every later read repeats trust-package, floor,
freshness, quorum, and proof verification; a stored hash alone is not treated as trust.

`sync` is observation only. It never signs or broadcasts a transaction and does not mean that the
candidate is admitted, ready, selected, or active.

## Later slices still required

Joining the v31 queue still requires a separately reviewed non-voting candidate service and offline
signing flow. They must submit to multiple peers, prove finalized admission, perform a pinned HTTPS
challenge, collect a fresh current-validator quorum observation, expose proof-backed status, and
bind onboarding to the certified endpoint and transport identity. Only then may an offline
transaction signer be connected to this workspace.

Do not manually fabricate a nonce, admission, readiness quorum, or “active” status from the files in
this directory.
