# Authorized protocol upgrades

Protocol versions through v28 retain the original delayed scheduling format for
historical replay. Every schedule targeting protocol v29 or later uses
`nir-protocol-upgrade-v2` and fails closed unless it carries a
`nir-protocol-upgrade-authorization-v1` certificate.

The trust root is not supplied by the proposed block. Genesis must pin a valid
release-transparency anchor in `protocolUpgradeReleaseAnchor`. The anchor fixes
the network, log, initial threshold authority set and initial log head. A future
upgrade certificate must then prove all of the following:

- a threshold-authorized, hash-linked next release-log entry;
- the exact bundle and manifest hashes, source revision and release version;
- the current and target protocol versions;
- the scheduling block's parent height and hash;
- the chain-identity genesis hash and network ID;
- the exact activation height; and
- a second threshold of release-authority signatures over that complete
  transition commitment.

The accepted release sequence and entry hash become consensus state. They are
included in the state root and snapshots, so an old entry, same-sequence fork,
foreign-network certificate, altered activation, altered artifact, or restart
rollback is rejected by every full node. Light clients must receive the same
genesis-pinned anchor and checkpoint release head; absence of that context makes
an authorized-upgrade header fail closed.

The full release bundle stays off-chain. Its exact hash and manifest provenance
are authorized on-chain; operators still obtain and verify the corresponding
bundle before installing it.

## Remaining launch blocker

The first implementation deliberately pins one authority generation. It does
not accept an authority set embedded by an upgrade and therefore cannot be
self-authorized, but release-authority rotation is not yet connected to this
consensus head. Before mainnet, the existing delayed, dual-accepted release-set
rotation must be made an on-chain, hash-linked governance transition and covered
by migration and recovery drills. Until then, losing the pinned threshold is a
liveness failure, not permission to bypass authorization.
