# Wallet read surface for a valueless ceremony testnet

This is a loopback, GET-only wallet read HTTP surface for an existing multi-validator
coordinator. It serves the existing account, history, transaction, asset, and
finality proof formats assembled by `DistributedCoordinator`; the wallet bridge
must still verify those proofs. The `/health` `valueMode` label is an assertion,
not proof that a network is valueless or that a tip is finalized.

Before starting, independently review the v2 valueless genesis ceremony and its
signed external anchor. The coordinator directory must contain that exact compiled
`genesis.json`, an already verified finalized block store, history index, and its
existing coordinator credentials. All validators from the signed peer registry
must be live at the coordinator's local finalized tip. The certificate lifecycle
head anchor must be retained outside the coordinator's writable directory.

```sh
npm run network:wallet-read -- \
  /absolute/ceremony-registry \
  /absolute/ceremony-anchor.json \
  nir1<64-lowercase-hex-release-signer> \
  <64-lowercase-hex-genesis-hash> \
  /absolute/coordinator-state \
  /absolute/certificate-head-anchor.json \
  http://127.0.0.1:8765 \
  8787
```

Replace every placeholder. The command verifies the signed ceremony and local
genesis, derives the exact ordered HTTPS validator URLs and TLS pins from it,
checks the lifecycle anchor, authenticates every validator at the local tip,
and only then listens on `127.0.0.1`. Set the wallet's `nodes.json` read origin
to `http://127.0.0.1:8787`. Transaction submission remains on the separately
gated transaction ingress at port 8789. The read surface accepts one exact
wallet preview origin or the pinned extension origin.

Only the HTTP surface is read-only: every non-GET request and every route outside
the wallet read allowlist is rejected before reaching coordinator methods. The
underlying `DistributedCoordinator` still loads coordinator and treasury private
keys, may update its local history index, and may send blocks to lagging validators
while assembling proofs after startup. Do not run another coordinator against the
same writable state directory. This HTTP launcher does not produce blocks or
advance its loaded chain; once validators move ahead, quorum account and asset
proof requests fail until a reviewed updated coordinator state is loaded in a
new process. This command is for a bounded, reviewed, valueless rehearsal. It
is not a keyless observer, a continuously synchronized read node, or a public
service.
