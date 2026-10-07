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

Start a validator first, using its normal operator procedure. Obtain its
network ID and currently trusted TLS certificate SHA-256 fingerprint from
operator-controlled evidence. Then run:

```bash
npm run network:transaction-ingress -- https://127.0.0.1:8791 <tls-certificate-sha256> <network-id> 8789 127.0.0.1 http://127.0.0.1:8765
```

The optional fifth argument is the listen address, limited to `127.0.0.1` or
`::1`. The optional sixth argument enables browser submission for one exact
`http://127.0.0.1:<port>` wallet origin; omit it to reject all browser
`Origin` requests as before. The upstream must be an exact loopback HTTPS
origin with an explicit port. Only `Content-Type: application/json` is
accepted. Browser preflight permits only `OPTIONS /v1/transactions` asking
for `POST` with the `content-type` header from that configured origin. The
gateway responds to that origin only, never `*`. A local CLI without `Origin`
can still submit already-signed JSON. Every other route or method is rejected
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
cached fallback. The production extension package keeps its narrower
`127.0.0.1` host-permission and CSP boundary; this rehearsal does not enable
extension-origin CORS.

The supplied fingerprint is a static local trust pin. It must be refreshed
under operator control when the validator certificate rotates; this gateway
does not independently verify the signed certificate lifecycle or detect
revocation. Do not expose its plaintext loopback listener on a public interface
or present it as a public-network service. A separately designed TLS edge,
client abuse controls, trusted pin distribution, independent operators, and
multi-host evidence are still required for a public deployment. This command
is only a valueless, resettable developer-testnet integration rehearsal.
