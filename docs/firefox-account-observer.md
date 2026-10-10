# Firefox account observer: read-only backend increment

This API targets `browser-wallet/src/`, the extension that owns and derives its
own phrase and address. It **does not** target `blockchain/firefox-wallet-preview.mjs`,
which packages the separate native-vault `wallet-ui`. These two wallet identities
must not be silently interchanged.

`createAccountObserverBridgeServer({ address, nodeBaseUrl, origin, sessionToken, trustAnchor, checkpointPath })`
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
   pinned genesis successor or the next height after a retained checkpoint.
   The response includes `networkId`, `genesisHash`,
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

No account balance is returned from a raw node response. The Firefox extension
checks the echoed address/network/genesis and clears stale reports on account
change or locking. It deliberately keeps its main network balance blank: a
spoofed localhost process can return `verified: true`, and the extension does
not independently check cryptographic proofs. The separate card is labelled a
local observer report, not a verified wallet balance or reward. No secure
operator setup CLI, trusted release binding, or automatic server launch exists.
This is **not** a working network wallet or mining app.

When the caller supplies a private `checkpointPath`, the observer persists a
monotonic verified tip and continues in segments of at most 512 proofs / 32 MiB
after restart. Tests cover a real 513-block signed chain, an invalid next block,
restart, rollback and competing sessions. A crash leaves a lock requiring manual
investigation. Without `checkpointPath`, restart rollback protection is absent;
the API does not silently infer a trusted path. A same-user process can still
replace local state, so this is not an external trust anchor.
The node's `/health` height is not itself independently authenticated. After an
observer restart without a retained checkpoint, a node could replay an older but
valid finalized chain and account proof. Even with a retained checkpoint, one
node does not establish the freshest network height. The response proves the
balance **at the reported height**, not current spendability. The UI shows the
reported height and must not imply network freshness or mining rewards.
