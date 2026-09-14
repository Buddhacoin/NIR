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

The consumer wallet should eventually provide receive/send screens, QR and
human-readable payment requests, exact fee and percentage display, transaction
simulation, address-book warnings, chain synchronization, signed updates,
hardware-key support, multisignature recovery, and optional selective privacy.

## Visual preview

`wallet-ui/` contains the first responsive interface and an installable PWA
manifest. It can also be loaded as an unpacked browser-extension preview through
its Manifest V3 file. The preview intentionally has no website permissions and
does not handle secret keys: the audited wallet bridge, chain synchronization,
and transaction broadcast must be implemented before those buttons become live.

Run `npm run wallet:preview` and open `http://localhost:8765` to inspect it. A
packaged desktop download will wrap the same reviewed interface. During
development, Chromium browsers can load `wallet-ui/` as an unpacked extension;
publishing a signed extension package must wait until key isolation and the node
connection have been independently audited.

The interface includes persistent dark and light themes. The orange circular
`N` is the single wallet, extension, application, and listing icon at every
size, preventing competing visual identities.
