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

An optional **ceremony-bound startup mode** verifies a v2 ceremony registry
against an externally supplied operator-signed anchor, an independently pinned
release signer address, and an independently pinned genesis hash before opening
the loopback listener. Select the validator by its consensus address; the
upstream origin, TLS pin, and network ID on the command line are exact assertions
against that validator's verified ceremony record. The gateway uses the verified
values. The external anchor file must be distributed separately from the
registry and reviewed by the operator.

```bash
npm run network:transaction-ingress -- --ceremony \
  <registry-dir> <external-anchor.json> <trusted-release-signer-address> \
  <pinned-genesis-hash> <validator-address> https://127.0.0.1:8791 \
  <tls-certificate-sha256> <network-id> 8789 127.0.0.1 \
  http://127.0.0.1:8765
```

Missing or mismatched ceremony evidence exits before the listener opens. The
gateway then sends a fresh nonce-bound challenge to the selected validator
before opening its listener. It verifies the response against the validator
consensus public key in the signed ceremony, the pinned genesis and network,
and the TLS certificate presented on that connection. A silent or offline
upstream cannot pass startup; an upstream without the key can pass only by
relaying the challenge to a genuine signer. This is a startup liveness and
key-possession check, not continuing proof of the upstream process. It does
not verify certificate lifecycle, current finality, or economic claims about
the network. The listener remains loopback only.

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
preview to a network representing real value. Signed certificate-lifecycle
evidence remains a separate gate for both modes.

The supplied fingerprint is a static local trust pin. It must be refreshed
under operator control when the validator certificate rotates; this gateway
does not independently verify the signed certificate lifecycle or detect
revocation. Do not expose its plaintext loopback listener on a public interface
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
