# Loopback signed-transaction ingress (local rehearsal)

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
npm run network:transaction-ingress -- https://127.0.0.1:8791 <tls-certificate-sha256> <network-id> 8789
```

The optional fifth argument is the listen address, limited to `127.0.0.1` or
`::1`. The upstream must also be an exact loopback HTTPS origin, with an
explicit port. Only `Content-Type: application/json` is accepted. Browser
`Origin` requests are rejected; there is no CORS policy or browser-facing
deployment contract. A local CLI or an explicitly controlled edge can submit
already-signed transaction JSON to `http://127.0.0.1:8789/v1/transactions`.
Every other route or method is rejected before any upstream HTTP request.

The supplied fingerprint is a static local trust pin. It must be refreshed
under operator control when the validator certificate rotates; this gateway
does not independently verify the signed certificate lifecycle or detect
revocation. Do not expose its plaintext loopback listener on a public interface
or present it as a public-network service. A separately designed TLS edge,
client abuse controls, trusted pin distribution, independent operators, and
multi-host evidence are still required for a public deployment. This command
is only a valueless, resettable developer-testnet integration rehearsal.
