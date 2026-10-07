# Loopback signed-transaction ingress (local browser rehearsal)

This small gateway accepts only an exact `POST /v1/transactions` with a bounded
JSON body. It forwards that transaction to one already-running validator over
certificate-pinned loopback HTTPS. The validator, not the gateway, checks the
transaction signature and network rules. A successful HTTP 202 means `queued`
or `known` in the validator mempool; it does **not** mean block inclusion or
finality. The gateway cannot produce blocks, invoke administrator routes, or
hold a signing key.
Its success response contains only `status` (`queued` or `known`),
`transactionId`, and `gossipedPeers`; it never relays validator receipts,
inclusion certificates, heights, or other finality-looking fields.

The positional command below is strictly for **local/dev use** and is not an
acceptable production operator launcher. Start a validator
first, using its normal operator procedure. Obtain its network ID and currently
trusted TLS certificate SHA-256 fingerprint from
operator-controlled evidence. Then run:

```bash
npm run network:transaction-ingress -- https://127.0.0.1:8791 <tls-certificate-sha256> <network-id> 8789 127.0.0.1 http://127.0.0.1:8765
```

The **ceremony-bound mode** is separate from local/dev mode. Its single exact,
canonical JSON operator config is an independently controlled, owned mode-`0600`
file (one JSON line followed by a newline; no unknown fields). It pins the v2
ceremony registry, separately distributed signed ceremony anchor, release signer
address, genesis hash, validator address, exact upstream origin/TLS fingerprint
and network ID. It also specifies the witness-policy ID, current checkpoint
package, certificate-history directory and separately retained head anchor,
private floor directory, maximum witness age in milliseconds, loopback listener
and optional exact wallet origin. The file itself is a trusted operator input;
its contents are not self-authenticating. All paths in it are absolute.

Its exact fields are `format` (`nir-transaction-ingress-operator-config-v1`),
`version` (`1`), `registryDirectory`, `ceremonyAnchorPath`,
`trustedReleaseSignerAddress`, `expectedGenesisHash`, `validatorAddress`,
`expectedUpstreamOrigin`, `expectedTlsCertificateSha256`, `expectedNetworkId`,
`expectedPolicyId`, `checkpointPackagePath`, `certificateDirectory`,
`certificateHeadAnchorPath`, `floorDirectory`, `maxWitnessAgeMs` (1–120000),
`listenPort` (1–65535), `listenHost` (`127.0.0.1` or `::1`), and `walletOrigin`
(an exact local preview or pinned extension origin, or `null`). Prepare the
config off-node, independently check its trust pins, and retain a trusted copy.
The old positional `--ceremony` form is refused: it cannot omit this gate.

Start with the non-secret [sample draft](examples/transaction-ingress-operator-config.example.json).
Copy it to a new absolute path, replace every `REPLACE_WITH...` value and
`/ABSOLUTE/...` path, then compare the fields with the signed artifacts and
your own independently recorded pins. The sample is intentionally invalid:
its placeholders cannot be used to initialize a floor or start a listener.
Use `pwd` in your chosen directory to see its absolute path; the literal
`/absolute/...` strings below are placeholders, not folders created by NIR.
The helper accepts readable draft JSON, rejects missing/extra fields, and
writes a new canonical mode-`0600` config without replacing an existing file.
Create the destination directory under your own account with mode `0700`
beforehand; both `prepare` and startup reject a shared or unowned parent.

```bash
cp docs/examples/transaction-ingress-operator-config.example.json /absolute/operator-draft.json
# Edit the draft and independently check every address, hash, path and endpoint.
npm run network:transaction-ingress-config -- prepare /absolute/operator-draft.json /absolute/operator-config.json
npm run network:transaction-ingress-config -- check /absolute/operator-config.json
```

`prepare` validates structure and permissions, **not signatures**. The draft
and prepared file contain only public configuration; never add keys, vault
passwords or seed phrases. If a write fails and leaves an incomplete output,
inspect it and choose a fresh pathname; `prepare` never overwrites it. Do not
put the config or independently retained
anchors inside the validator's writable state. A different pathname on the
same machine does not prove different administration or survive a full-machine
rollback. Keep independent copies and verify their provenance out of band.

Artifact provenance before these commands:

- Obtain the v2 plan, compiled genesis, signed release, registry and signed
  external anchor through the [genesis ceremony](genesis-ceremony.md). Compare
  the expected genesis hash and release signer outside the registry itself.
- Install and reverify the selected validator using
  [validator ceremony onboarding](validator-ceremony-onboarding.md), or use the
  [deployment wizard](validator-deployment.md) for its exact operator checklist.
  The `certificateDirectory` must be that validator's real lifecycle state;
  copying another validator's state does not authorize this address.
- Quorum-authorize certificate issue/renew/revoke records using
  [certificate lifecycle](certificate-lifecycle.md), or perform the explicit
  [one-time bootstrap](certificate-lifecycle.md#one-time-migration-bootstrap)
  when applicable. Obtain the reviewed history head with
  `npm run certificate:lifecycle -- status ...` and retain its external anchor
  separately from `certificateDirectory`; update the anchor after a new
  quorum-verified head. A local JSON file alone is not an independent anchor.
- Assemble a recent, quorum-signed checkpoint package and independently pin
  its policy ID as described in [checkpoint trust packages](checkpoint-trust-packages.md).
  The package is not generated by this gateway. There is currently no single
  public operator CLI that provisions independent checkpoint witnesses and
  refreshes their package automatically; those signed inputs and review are a
  prerequisite, not a hidden step supplied by `--ceremony`.

If those operators or artifacts are unavailable, stop at the local/dev
rehearsal. Do not invent witness identities or treat several local keys as
independent. An old positional ceremony command must be migrated to this
reviewed config and its one-time floor; there is no automatic fallback to an
ungated ceremony listener. The separate positional local/dev command remains
available only for local rehearsal.

```bash
npm run network:transaction-ingress -- --init-floor /absolute/operator-config.json
npm run network:transaction-ingress -- --ceremony /absolute/operator-config.json
```

Initialization verifies the ceremony identity and a fresh witness package
against the pinned policy before creating the floor exactly once; a policy typo
therefore fails before initialization. It does not contact the upstream or open
a port and never silently recreates lost state. Normal launch
verifies the ceremony and checkpoint/certificate gate, advances the floor,
then sends a nonce-bound validator-key challenge over pinned TLS
**before** opening a loopback listener. Each signed transaction is gated again
before forwarding. A challenge can be relayed to a real signer; it does not
prove the same process will handle a later transaction. Checkpoint witnesses
must actually be independently operated and their policy must be distributed
out of band; the local gate cannot establish either fact.

In local/dev mode, the optional fifth argument is the listen address, limited
to `127.0.0.1` or `::1`. The optional sixth argument enables browser submission for one exact
`http://127.0.0.1:<port>` wallet preview origin or the pinned unpacked wallet
extension origin, `chrome-extension://ojfgigpdjamebbiiihianbcjpabgdhnm`.
Run a separate gateway instance if both browser surfaces are needed; each
instance accepts only one origin. Omit the argument to reject all browser
`Origin` requests as before. The upstream must be an exact loopback HTTPS
origin with an explicit port. Only `Content-Type: application/json` is
accepted. Browser preflight permits only `OPTIONS /v1/transactions` asking
for `POST` with the `content-type` header from that configured origin. The
unpacked Chrome extension can send its JSON `POST` directly without a preflight;
the gateway checks its exact `Origin` before forwarding either form. The
gateway responds to the configured origin only, never `*`. A local CLI without
`Origin` can still submit already-signed JSON. Every other route or method is rejected
before any upstream HTTP request.
The CORS check controls browser access, not client authentication: a local
non-browser process can set an `Origin` header, and the validator must still
verify every transaction signature and network rule.

For the local wallet preview, `wallet-ui/nodes.json` has an explicit
`submissionOrigin` of `http://127.0.0.1:8789`; read nodes are selected
separately. Start `npm run wallet:preview` at `http://127.0.0.1:8765` and the
gateway command above. The wallet checks the current read node's valueless
network ID against the signed transaction before either explicit submit
action. Missing or invalid `submissionOrigin` disables submission; it never
falls back to the read-only RPC. Restart the page after changing its signed
policy. The service worker fetches `nodes.json` from the network without a
cached fallback. To rehearse the unpacked extension, pass its pinned origin as
the sixth argument:

```bash
npm run network:transaction-ingress -- https://127.0.0.1:8791 <tls-certificate-sha256> <network-id> 8789 127.0.0.1 chrome-extension://ojfgigpdjamebbiiihianbcjpabgdhnm
```

Its existing `127.0.0.1` host permission and CSP remain
unchanged. Current Chrome versions may ask the user to permit local or loopback
network access before the extension can connect; this runtime browser grant is
separate from the extension manifest permissions.

The local/dev mode verifies the configured network ID and pinned upstream certificate,
but it does **not** prove that the network is valueless. A read node's
`valueMode` label is not independent genesis evidence. Operators must use only
their reviewed valueless developer-testnet ceremony and must not connect this
preview to a network representing real value. Local/dev mode has no signed
certificate-lifecycle gate; ceremony mode requires one.

In local/dev mode the fingerprint is a static local pin without lifecycle
verification. Ceremony mode checks the signed certificate lifecycle at every
POST. Its current startup code also requires the serving fingerprint to equal
the original immutable ceremony pin, so it **cannot follow a legitimate TLS
renewal by editing this config alone**. Stop this ingress on rotation; a
separately reviewed migration design is still required. Do not
expose its plaintext loopback listener on a public interface
or present it as a public-network service. A separately designed TLS edge,
client abuse controls, trusted pin distribution, independent operators, and
multi-host evidence are still required for a public deployment. This command
is only a valueless, resettable developer-testnet integration rehearsal.

The validator also has a loopback-only, TLS-protected live-identity challenge.
The caller supplies a fresh random nonce; the response binds it to the
validator's consensus key, local genesis hash, network ID and serving TLS
certificate fingerprint from that exact connection, including after a TLS
context reload. A caller must compare the signature with the
validator public key from an independently verified ceremony, not with a key
reported by the endpoint. This check can reject a substitute process that
reuses the certificate but lacks that key. It does **not** prove that a
transaction will be accepted by the same process: a malicious gateway could
proxy the challenge to a genuine validator while routing the transaction
elsewhere. It also does not prove the current tip is finalized, establish a
certificate's lifecycle, or make this local service publicly deployable.
Only the ceremony-bound startup mode requires this challenge; positional
local/dev mode remains unchanged. The challenge is not repeated for each
transfer, so a later upstream replacement is not detected by this startup
check alone.

## Mandatory checkpoint and certificate admission in ceremony mode

Every signed-transaction `POST` in ceremony mode must pass a
fresh witness-signed finalized checkpoint package under an independently pinned
genesis hash and witness-policy ID. The selected validator must belong to that
checkpoint's validator set, and its upstream TLS fingerprint must be active in
the signed certificate history at that height. A checkpoint predating the
latest signed certificate change cannot authorize an old fingerprint. Missing,
stale, revoked, conflicting, or unreadable evidence returns HTTP 503 before
the upstream validator receives the transaction. This still does not prove
that the witnesses are independently operated or that the checkpoint is the
network's newest tip.

Before the gate can start, an operator must explicitly initialize its private
floor directory with the pinned network, genesis, witness policy, and validator
identity. Ordinary startup never recreates a missing directory or resets a
missing floor. The floor saves the highest verified checkpoint height and tip,
witness sequence and package hash, certificate-history head and count, and the
last verified observation time. Two mode-`0600` copies in an owned mode-`0700`
directory are updated through a short writer lock, temporary-file fsync,
atomic rename, and directory fsync. A restart accepts identical copies or an
exactly linked one-revision old/new pair left by an interrupted write. An
unrelated split, invalid copy, or lost directory fails closed. In-memory checks
also reject replacing the floor with an older revision during one process run.
Before a new revision, a torn pair is repaired to the newer verified record;
otherwise a second interruption could leave copies two revisions apart. The
lock becomes visible only after its complete owner record has been fsynced, so
a crash while preparing that record cannot leave an empty active lock. A crash
after publication can leave a valid lock behind. The runtime never removes an
existing lock automatically, even if its recorded process appears dead:
concurrent attempts to reclaim it could delete a new writer's lock. An
operator must first verify that no writer is running and that both floor
copies form a valid current or one-step linked pair before removing that
specific lock and any linked temporary name. If ownership or copy state is
unclear, keep the gateway closed.

An interruption during one-time initialization may leave just the first copy.
The gate refuses to start and initialization refuses to run again over it.
Recovery then requires an operator to establish from independent evidence
whether any floor had ever been accepted. If that cannot be established, do
not delete or recreate the directory: restore an externally retained trusted
floor instead.

This local floor survives ordinary crashes, but it is **not** an external trust
anchor. An attacker controlling the directory owner or a full filesystem
snapshot can replace both copies with an older valid pair after restart. An
independently retained checkpoint/history anchor or hardware monotonic counter
is required to close that threat. The gate and local floor alone do not make
the ingress suitable for public deployment or real-value transfers.
