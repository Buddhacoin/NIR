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
  /absolute/path/personal.nirvault.json 8788 http://127.0.0.1:8765
```

At startup it prints a random one-session token. The browser must present that
token to read the public wallet identity or request a signature. The bridge
binds only to `127.0.0.1`, checks the exact `Origin` and loopback `Host`, permits
only one pending confirmation, and rejects reuse of a request ID. Every signing
request is printed in the terminal; the user must type `SIGN` and then enter the
vault password. The password is never accepted through HTTP, command arguments,
or environment variables, and the response contains only the signed transaction.

The bridge deliberately has no broadcast endpoint. The wallet UI can pair with
it, read the public address, show the node balance, calculate a fee, review an
exact transfer, and request a terminal-confirmed signature. It displays the
signed JSON but does not submit it to a node. Review and submission remain
separate actions, limiting the damage from a compromised interface.
The session token is not a recovery secret: it expires when the bridge process
stops, should be pasted only into the intended local UI, and must never be put
in a URL. Close the terminal process when finished.

For an unpacked extension, pass its exact stable
`chrome-extension://<32-character-id>` origin instead. Do not allow a wildcard
origin. This bridge is locally tested but has not received an external security
audit and must not yet protect real-value funds.

Use a randomly generated passphrase of at least six unrelated words and keep
the recovery copies offline in separate places. The software rejects very short
or excessively large passwords and malformed encrypted fields, but a memorable
weak password can still be guessed; the current vault is not a substitute for
a reviewed hardware key.

The consumer wallet should eventually provide receive/send screens, QR and
human-readable payment requests, exact fee and percentage display, transaction
simulation, address-book warnings, chain synchronization, signed updates,
hardware-key support, multisignature recovery, and optional selective privacy.

## Visual preview

`wallet-ui/` contains the first responsive interface and an installable PWA
manifest. It can also be loaded as an unpacked browser-extension preview through
its Manifest V3 file. The preview intentionally has no website permissions and
does not handle secret keys: bridge integration, chain synchronization, and
reviewed transaction broadcast must be completed before those buttons become
live.

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
