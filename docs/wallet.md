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
single-node data. The optional handoff-history path lets the bridge advance that
trust through independently approved validator rotations. Every transition is
verified from genesis and only the set active at the proof height is accepted.
The bridge also writes `<vault>.trust.json`, a non-secret atomic checkpoint that
prevents an older height, conflicting state or truncated rotation history from
being accepted after restart. It should be backed up with the encrypted vault.
The pairing code and session token are not recovery secrets. Neither belongs in
a URL or persistent browser storage. Close the terminal process when finished.

The automated integration suite repeats the complete valueless path across real
loopback HTTP boundaries: public wallet discovery, faucet funding, account and
fee lookup, bridge signing, separate node submission, final balance checks, and
replay rejection. It uses temporary keys and does not replace a browser security
review or external audit.

For an unpacked extension, pass its exact stable
`chrome-extension://<32-character-id>` origin instead. Do not allow a wildcard
origin. This bridge is locally tested but has not received an external security
audit and must not yet protect real-value funds.

Use a randomly generated passphrase of at least six unrelated words and keep
the recovery copies offline in separate places. The software rejects very short
or excessively large passwords and malformed encrypted fields, but a memorable
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
