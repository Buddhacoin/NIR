# Validator join workspace (testnet Slices A, B1, B2a, and B2b1)

`validator:join` prepares local validator identities on macOS or Linux. B2a can prepare and sign a
protocol-v32 admission transaction offline, but it is not a network join, never broadcasts or
submits that transaction, and does not claim that an address is queued, eligible, selected, or
active.

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
npm run validator:join -- prepare-admission /absolute/private/path/join-workspace /absolute/private/path/admission-package.json
npm run validator:join -- sign-admission /absolute/private/path/join-workspace /absolute/private/path/admission-package.json /absolute/private/path/signed-admission.json
npm run validator:join -- resolve-expired-admission /absolute/private/path/join-workspace
npm run validator:join -- submit-admission /absolute/private/path/join-workspace /absolute/private/path/signed-admission.json /absolute/path/fresh-public-sync-input.json
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

## Prepare and sign an admission offline (Slice B2a)

`prepare-admission` works only with a v2 workspace and the newest fully reverified protocol-v32
context. The context must prove that the consensus address is absent from the candidate queue, has
the exact next nonce, and can cover the fixed minimum validator bond plus minimum fee. The package
binds the pinned network, genesis, checkpoint policy, context hash, operator, HTTPS origin, TLS pin,
both public identities, and the exact `referenceHeight`/`validUntilHeight = referenceHeight + 64`.
The 64-block interval is a consensus expiry bound, not a guarantee that 64 blocks remain when an
offline operator signs.

`sign-admission` rechecks the plan, trust package, candidate context, package, both vault identities,
and the completed dual-signed transaction. It reads passwords from an interactive terminal or
restricted inherited descriptors 3 and 4, writes an exclusive mode-`0600` artifact, and records an
append-only unresolved intent. Exact retries reuse the already verified journaled transaction bytes;
they do not create a second post-quantum signature for the same intent. A bounded owner lock prevents
concurrent signers and permits safe recovery after a dead or expired signer lease.

An unresolved intent prevents signing a different transaction with the same nonce. If it expires
without submission, first synchronize a newer proof-backed context. Only
`resolve-expired-admission` can append a resolution, and only when the newer witness sequence is
monotonic, its finalized height is past the old `validUntilHeight`, the nonce is unchanged, and the
address is still absent from the queue. A fresh package may then be prepared. No manual deletion or
editing of intent, resolution, lock, or signed files is safe.

## Submit the exact signed bytes (Slice B2b1)

`submit-admission` runs through a separate public-only network module: it does not import the vault
or signing modules, does not open either vault, and never asks for a password. It first requires a
fresh proof-backed protocol-v32 candidate context from the complete active validator set. That
context must prove the same network, genesis, identity and nonce, continued queue absence,
sufficient balance, and a finalized height inside the signed transaction's exact validity window.
The command also requires the signed artifact to match its immutable package, unresolved intent,
and local signed journal byte-for-byte.

The third argument is a `nir-validator-admission-submission-input-v1` envelope. It contains the
ordinary fresh `candidateSyncInput`, the exact peer registry committed by that finalized checkpoint,
and one quorum-authorized certificate history per active validator. User-supplied URLs or TLS pins
alone are never authority. The peer registry must cover the exact active set, and the histories must
authenticate the TLS pin at the preflight height.

Only then does it POST the exact canonical transaction to every committed validator endpoint.
Requests use certificate-history-derived TLS pins and at most eight run concurrently. A response
counts only when the expected validator signs a domain-separated acknowledgement binding network,
genesis, transaction ID, status, fresh context hash, and a new attempt nonce. A
two-thirds-plus-one acknowledgement quorum is recorded as `submitted-to-quorum`; this is only a
transport acknowledgement, never a finalized inclusion claim.

Every attempt is written as an immutable, secret-free receipt containing its full verified context,
committed peer registry, signed acknowledgements, and a hash link to the previous attempt. An
independent atomic head detects a missing tail, rollback, or fork on restart. The operation is
serialized by a bounded crash-recoverable transaction lock; the ten-minute lease exceeds the
worst-case bounded 256-peer GET-plus-POST timeout budget. A partial or timed-out attempt is
`partial-retryable`: rerun with the same signed artifact and a new fresh proof input. Never re-sign
or replace the transaction merely because peers were unavailable. Once a quorum receipt exists,
restart is idempotent and does not resend after the mandatory fresh preflight.

The local head is rollback detection within the retained workspace, not an external transparency
anchor. Deleting the entire workspace, all receipts, and the head together cannot be detected
locally; backups or a later external receipt anchor remain an operational requirement.

## Later slices still required

Joining the queue still requires a separately reviewed non-voting candidate service and finalized
inclusion flow. It must prove finalized admission, perform a pinned HTTPS
challenge, collect a fresh current-validator quorum observation, expose proof-backed status, and
bind onboarding to the certified endpoint and transport identity. B2b1 deliberately implements none
of finalized inclusion proofs, readiness, selection, rotation, or activation.

Do not manually fabricate a nonce, admission, readiness quorum, or “active” status from the files in
this directory.
