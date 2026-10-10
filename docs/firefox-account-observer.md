# Firefox account observer: read-only backend increment

This API targets `browser-wallet/src/`, the extension that owns and derives its
own phrase and address. It **does not** target `blockchain/firefox-wallet-preview.mjs`,
which packages the separate native-vault `wallet-ui`. These two wallet identities
must not be silently interchanged.

`createAccountObserverBridgeServer({ address, nodeBaseUrl, origin, sessionToken, trustAnchor })`
creates a loopback HTTP server. A caller must supply the unlocked extension's exact
address, its exact `moz-extension://<uuid>` origin, a random 32-byte hex bearer token,
and an operator-reviewed trust anchor (`expectedNetworkId`, genesis checkpoint,
initial trusted validators and any authenticated handoffs). The server has **no**
vault path, signing route, account switch, pairing route or access to secret keys.
The token authorizes only reading/verifying public evidence for the single fixed
address and chain. Never reuse a native wallet-bridge session token here.
`nodeBaseUrl`, when configured, must be an exact `http://127.0.0.1:<port>` URL
set on the server, not taken from an extension request. The node's responses
remain untrusted until cryptographically checked against the pinned anchor.

With `Origin: <bound origin>`, `x-nir-observer-token: <bound token>` and
`Content-Type: application/json`:

1. `POST /v1/verify-finality-chain` with `{ "proofs": [...] }`, starting at the
   pinned genesis successor. The response includes `networkId`, `genesisHash`,
   `tip` and `verified: true`. A chain that rolls back or conflicts with a tip
   already verified in this process is rejected.
2. `POST /v1/verify-account-proof` with `{ "proof": {...} }`. This accepts only
   the bound address and a proof exactly matching the latest verified finality
   tip. The response includes `address`, `networkId`, `genesisHash`, `statement`
   and `verified: true`.
3. `POST /v1/refresh-account` with `{}` when `nodeBaseUrl` is configured. The
   observer fetches the local node's health, complete bounded finality chain and
   only the bound address's account proof; it rejects a mismatched network, tip,
   address, genesis identity or conflicting chain and returns only the verified
   account response. The extension never has to fetch raw node balances.

No account balance is returned from a raw node response. The caller must check
the echoed address/network/genesis before displaying a balance and clear stale
results on account change or locking. No extension UI, secure token handoff,
operator setup CLI or persistence is wired to this backend yet. After restart
the full finality chain must be presented again; no balance should be shown until
fresh evidence verifies. This is **not** a working network wallet or mining app.
The underlying verifier limits one chain submission to 512 proofs / 32 MiB;
because this increment requires a full genesis-to-tip submission, it cannot
follow a chain past that bound. A durable authenticated checkpoint/header store
and incremental continuity checks are required before treating this as a
long-running balance source.
