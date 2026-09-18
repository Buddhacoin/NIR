# Native NIR wallet

NIR is an independent layer-one network, not a token issued by another chain.
Its wallet, addresses, transactions, nodes, and ledger are native to NIR.

The current command-line prototype can create one encrypted ML-DSA-65 account,
show its public address without decrypting it, and sign a network-bound transfer.
It does not synchronize a chain, broadcast transactions, display a live balance,
use QR codes, or protect keys with a hardware device. It must not custody assets
of real value.

```bash
npm run wallet:create -- /absolute/path/personal.nirvault.json
npm run wallet:address -- /absolute/path/personal.nirvault.json
npm run wallet:sign -- /absolute/path/personal.nirvault.json \
  nir-testnet nir1RECIPIENT 250000000 0
```

Amounts passed to the signing command are atomic units: `100000000` equals one
NIR. The command displays the recipient, amount, and network before asking the
user to type `SIGN`. Password input is hidden and is not accepted through an
argument or environment variable. The resulting signed transaction contains no
private key.

## Local browser signing bridge

The optional bridge keeps the encrypted vault and decrypted signing operation
outside the browser. Start it for one exact wallet origin:

```bash
npm run wallet:bridge -- \
  /absolute/path/personal.nirvault.json 8788 http://127.0.0.1:8765 \
  /absolute/path/node/genesis.json \
  /absolute/path/node/handoffs/VALIDATOR-HANDOFFS.json
```

At startup it prints a random eight-digit pairing code that expires after two
minutes. The exact wallet origin can exchange it once for a random session token;
the UI keeps that token only in memory. Five failed attempts disable pairing
until the bridge is restarted. The browser must present the token to read the
public wallet identity or request a signature. The bridge
binds only to `127.0.0.1`, checks the exact `Origin` and loopback `Host`, permits
only one pending confirmation, and rejects reuse of a request ID. Every signing
request is printed in the terminal; the user must type `SIGN` and then enter the
vault password. The password is never accepted through HTTP, command arguments,
or environment variables, and the response contains only the signed transaction.

The browser is treated as hostile. Pairing accepts one exact 128-byte-bounded
JSON shape, serializes concurrent attempts, and activates exactly one in-memory
session; a second tab cannot win the same code race. A restart creates a new
code and token. Disconnect increments a protected session generation, so even
a terminal confirmation that was already waiting cannot produce a signature
after revocation. API paths reject query variants, request bodies are bounded,
responses are non-cacheable and carry restrictive content, framing, referrer
and cross-origin policies.

The UI stores only the selected theme and validated public contacts in
`localStorage`; vault passwords, seeds, private keys, pairing codes, session
tokens, simulations and signed packages are not persisted there. Password input
remains a hidden terminal read and is never an HTTP field, DOM input, command
argument, environment variable or log value. Contact labels, proven history,
asset commitments and memos are rendered with text nodes rather than HTML.
Bidirectional display controls are rejected in labels and signed memos. CSP
blocks inline script and object execution, while a runtime frame refusal
complements the required production `frame-ancestors` and `X-Frame-Options`
headers against clickjacking.

The bridge deliberately has no broadcast endpoint. The wallet UI can pair with
it, read the public address, show balance and Transfer Credits, calculate a fee,
review transfers and resource operations, and request a terminal-confirmed
signature. It displays signed transaction JSON first. A separate button can
submit it only after a fresh node health check reports `valueless-devnet` and
the signed network ID matches the node. Signing never submits automatically.
Review and submission remain separate actions, limiting the damage from a
compromised interface.

The same bridge can sign an expiring payment request and verify a request from
another NIR account. Verification binds the exact address, amount, network,
expiry, identifier and memo before the wallet fills transfer fields. It does not
broadcast anything or authorize the eventual payment.

When started with an explicit genesis file, the bridge also verifies account
statements signed by a validator quorum. The browser then shows a confirmed
height instead of trusting the balance reported by one node. Omitting the
genesis path leaves this check disabled and the interface labels the result as
single-node data. Before checking a balance, the wallet automatically downloads
the handoff history from its node. The bridge accepts only a cryptographically
valid extension rooted in genesis and stores it as `<vault>.handoffs.json`; the
optional command-line history remains an offline recovery input. Every
transition is verified from genesis and only the set active at the proof height
is accepted.
The bridge also writes `<vault>.trust.json`, a non-secret atomic checkpoint that
prevents an older height, conflicting state or truncated rotation history from
being accepted after restart. It should be backed up with the encrypted vault.
It additionally keeps `<vault>.headers.json`. This file contains no private
keys: it is the continuous compact header chain whose hashes are anchored by
the trust checkpoint. The bridge rejects a missing, truncated, mutated,
symlinked or checkpoint-conflicting copy instead of silently trusting RPC data.

With an explicit genesis file, the bridge deterministically derives block zero
and its validator-set checkpoint. Even the first higher balance is not accepted
merely because RPC servers report it. The wallet downloads bounded pages from
`/v1/finality-proofs` and asks the local bridge to check every
protocol-v22 compact header, previous-hash link, block-body commitment, prepare
quorum, commit quorum and dual-quorum validator activation. Only an account
proof matching the resulting height, block hash, state root and validator-set
identifier can replace the atomic checkpoint. The proof must also reconstruct
the header's sparse account root from the exact balance, nonce and resource
state plus its 256 sibling hashes. This supports both membership and fresh-address
absence proofs. Full transaction bodies and the complete account database are
not downloaded by the wallet.

The account proof supplies the authenticated history count and indexed Merkle
root. Protocol v24 lets the wallet request only the 20 newest identifiers. The
bridge requires the exact expected interval and verifies every absolute index
and 32-level Merkle path; omission, insertion, substitution or reordering fails
before any row is displayed. The wallet then requests
`/v1/transactions/{id}/proof`. The bridge requires the exact block hash,
transaction count and ordered Merkle root from its persisted verified header,
recomputes the identifier from the complete signed transaction, verifies the
Merkle path, and confirms that the local wallet is sender or recipient. Only
then does the interface render the operation. Failed or unavailable proofs are
counted and hidden.

## Multiple node policy

The signed wallet package contains `wallet-ui/nodes.json`. It lists exact node
origins and the minimum number that must report the same network, finalized
height and block hash. The wallet probes every origin, rejects same-height hash
conflicts, ignores a lone node claiming a higher height, and automatically uses
another member of the accepted group when one endpoint is unavailable. The
local valueless profile permits one of three loopback endpoints. A public
profile must list independently operated HTTPS origins and require at least two
matching responses. The bridge supplies the pinned network identifier and the
minimum previously accepted height, so a foreign network or rollback is not a
candidate even before the account proof is checked.
The pairing code and session token are not recovery secrets. Neither belongs in
a URL or persistent browser storage. Close the terminal process when finished.

The automated integration suite repeats the complete valueless path across real
loopback HTTP boundaries: public wallet discovery, faucet funding, account and
fee lookup, bridge signing, separate node submission, final balance checks, and
replay rejection. A real headless Chromium regression additionally checks CSP,
inert hostile contact rendering, absence of persisted secrets and refusal to run
inside a frame. HTTP tests exercise concurrent pairing, origin/host confusion,
oversized bodies, session revocation during confirmation, restart and stale
tokens. These tests use temporary keys and do not replace an external audit.

A same-origin script compromise remains able to read the active public UI state,
session token and signed results displayed during that session, initiate review
requests and deny service. It still cannot obtain the vault password or private
key from the bridge, bypass exact simulation binding, silently sign without the
separate terminal confirmation, or auto-submit. Users must verify the terminal
summary and close the bridge when finished. Clipboard and QR contents are
untrusted transport: imported payment requests are accepted only after their
post-quantum signature and exact network, recipient, amount, expiry and memo are
verified again.

For an unpacked extension, pass its exact stable
`chrome-extension://<32-character-id>` origin instead. Do not allow a wildcard
origin. This bridge is locally tested but has not received an external security
audit and must not yet protect real-value funds.

Use a randomly generated passphrase of at least six unrelated words and keep
the recovery copies offline in separate places. New passwords must contain at
least 16 Unicode scalar values, use canonical NFKC representation, avoid display
controls and contain non-trivial character variety. The serialized vault accepts
only the fixed scrypt and AES-256-GCM parameters and exact bounded schema. Wrong
passwords and malformed contents share one public error and both pay the fixed
KDF cost; this reduces simple local oracles but does not promise constant-time
behaviour from JavaScript, OpenSSL or the operating system. Derived keys and
temporary plaintext buffers are overwritten best-effort, while immutable
JavaScript strings and process memory cannot be guaranteed zeroized. A memorable
weak password can still be guessed; the current vault is not a substitute for
a reviewed hardware key.

The consumer wallet should eventually add compact multi-frame transfer for the
large post-quantum payment-request payload, transaction simulation,
address-book warnings, chain synchronization, signed updates,
hardware-key support, multisignature recovery, and optional selective privacy.

## Visual preview

`wallet-ui/` contains the first responsive interface and an installable PWA
manifest. It can also be loaded as an unpacked browser-extension preview through
its Manifest V3 file. The preview intentionally has no website permissions and
does not handle secret keys. Local bridge signing and valueless-node submission
are active; real-value operation, independent synchronization and audited
distribution remain disabled.

Run `npm run wallet:preview` and open `http://localhost:8765` to inspect it. A
packaged desktop download will wrap the same reviewed interface. During
development, Chromium browsers can load `wallet-ui/` as an unpacked extension.
A deterministic ZIP can be built and independently checked with the commands in
[`releases.md`](releases.md); publishing it in a browser store must wait until
key isolation and the node
connection have been independently audited.

The interface includes persistent dark and light themes. The orange circular
`N` is the single wallet, extension, application, and listing icon at every
size, preventing competing visual identities.
