# Validator join workspace (testnet Slices A through B2b2b)

`validator:join` prepares local validator identities on macOS or Linux. B2a can prepare and sign a
protocol-v32 admission transaction offline. The separate, explicit B2b1 command can submit those
exact bytes to authenticated peers, and B2b2a can verify a supplied finalized inclusion proof.
None of these slices claims that an address is ready, selected, or active.

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
npm run validator:admission-finality -- verify-file /absolute/path/canonical-finality-evidence.json /absolute/private/path/new-finality-receipt.json
npm run validator:admission-proof-fetch -- fetch-file /absolute/path/canonical-fetch-input.json /absolute/private/path/new-evidence.json /absolute/private/path/new-finality-receipt.json
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

## Verify finalized admission inclusion offline (Slice B2b2a)

`validator:admission-finality verify-file` verifies a canonical evidence file without network
access and without opening either vault. The evidence binds the exact public plan, signing package,
signed artifact, byte-identical signing journal, authenticated B2b1 receipt, candidate checkpoint,
finality chain, validator handoffs, and transaction-tree proof.

The finality chain must begin immediately after the candidate checkpoint and end at the exact block
containing the signed protocol-v32 admission. The verifier checks block hash, height, transaction
root and count, transaction ID and bytes, network, genesis identity, validator certificates and the
admission lifetime. B2b1 acknowledgements are reverified but never treated as finality. Because the
candidate checkpoint does not carry the complete upgrade authorization state, B2b2a rejects a
pending or encountered protocol-upgrade boundary instead of inventing one. All handoffs must occur
strictly after the checkpoint.

A successful run atomically creates a new immutable mode-`0600` receipt and never replaces an
existing path. A genuine partial B2b1 transport receipt is sufficient when the independent finality
chain proves exact inclusion: transport acknowledgements and consensus finality are deliberately
not conflated. The local finality receipt is evidence retained by this workspace, not an external
rollback anchor; deleting the workspace and every backup cannot be detected from that receipt alone.
This slice does not download evidence or expose a proof endpoint; authenticated
multi-peer acquisition is a later slice. Finalized admission also does not prove readiness,
selection, rotation, or activation.

## Fetch finalized admission evidence (Slice B2b2b)

`validator:admission-proof-fetch fetch-file` contacts the exact active validator set committed by
the authenticated B2b1 checkpoint. Its canonical public input contains the six B2b2a base artifacts
plus the complete certificate histories used for the peer registry; it contains no vault, password,
or private key. Each HTTPS request is pinned through that checkpoint-verified certificate history.

```json
{"candidateCheckpoint":{"...":"exact B1 checkpoint"},"certificateHistories":[{"history":["..."],"validatorAddress":"nir1<64 lowercase hex>"}],"format":"nir-validator-admission-proof-fetch-v1","publicPlan":{"...":"B2a public plan"},"signedArtifact":{"...":"exact signed admission"},"signedJournal":{"...":"byte-identical signed journal"},"signingPackage":{"...":"exact B2a package"},"submissionReceipt":{"...":"authenticated B2b1 receipt"},"version":1}
```

The public endpoint returns one bounded atomic bundle containing the transaction proof, contiguous
finality proofs, and the relevant validator handoffs. It signs the exact request, client nonce,
method, path, network, result hash, and validator identity with the validator consensus identity.

One independently authenticated bundle that passes the existing B2b2a verifier is sufficient.
Malformed responses, timeouts, HTTP 404 responses, and even authenticated `not-found` responses are
not evidence of absence and are ignored.
If two authenticated sources provide different bundles that each verify cryptographically, fetching
fails closed instead of selecting one. Peers, validator identities, URLs, TLS bindings, response
size, proof-chain length, concurrency, and timeouts are all bounded. The full active registry and
all certificate histories are verified first. Validators are queried in canonical address order,
two at a time, continuing through later batches when earlier validators withhold or fail. After the
first valid proof, the bounded walk still checks every later validator so a different independently
valid proof fails closed; only the first evidence object/hash and source identifiers are retained.
Each response may use the protocol's
40 MiB proof limit, each request is limited to two seconds, the entire operation to five minutes,
and a bundle to 64 finalized blocks. In-flight HTTP requests are actively aborted on timeout. On success the
command creates both the canonical evidence and finality receipt at mode-`0600` paths. A retry after
a crash between the two writes accepts only byte-identical existing evidence/receipt and rejects a
conflicting file.

B2b2b is public-only network acquisition. It never imports vault/signing code, never signs an
admission, and still does not prove readiness, selection, rotation, or activation. Its local files
are not external rollback anchors.

## Later slices still required

Joining the queue still requires a separately reviewed non-voting candidate service and finalized
inclusion acquisition flow. It must obtain the proof from independent pinned peers, perform a pinned HTTPS
challenge, collect a fresh current-validator quorum observation, expose proof-backed status, and
bind onboarding to the certified endpoint and transport identity. B2b2a verifies a supplied finalized
inclusion bundle but deliberately implements none of proof downloading, readiness, selection,
rotation, or activation.

Do not manually fabricate a nonce, admission, readiness quorum, or “active” status from the files in
this directory.
