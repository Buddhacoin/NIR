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

The accepted release sequence and entry hash become consensus state. The head
also carries the complete authenticated active authority set, its generation,
the old activation set at a joint-signature boundary, and any pending next set.
They are included in the state root and snapshots, so an old entry, same-sequence
fork, foreign-network certificate, altered activation, altered artifact, or
restart rollback is rejected by every full node. Light clients must receive the
same genesis-pinned anchor and complete checkpoint release head; absence of that
context makes an authorized-upgrade header fail closed.

Authority rotation uses the same hash-linked release log. The current set must
authorize the change and the next set must separately accept it by threshold.
The sets must overlap by the required threshold, only one change may be pending,
and activation cannot be replaced or skipped. In addition to the release-log
entry delay, consensus requires at least 64 finalized block heights between the
change entry and activation. At the exact activation entry both the old and new
sets sign; subsequent releases and protocol certificates require the new set.
Loss of either required quorum fails closed.

The full release bundle stays off-chain. Its exact hash and manifest provenance
are authorized on-chain; operators still obtain and verify the corresponding
bundle before installing it.

## State migration

The expanded release head is a consensus schema boundary. A node must obtain it
from genesis, uninterrupted replay, or a quorum-authenticated snapshot containing
the full active/pending authority state. Legacy four-field heads are rejected;
operators must not synthesize the missing authority set from a proposed upgrade.
For a pre-mainnet chain, regenerate the ceremony-approved genesis or replay from
its pinned anchor. A future live-network migration requires an explicitly
versioned, old-quorum-authorized migration certificate and cannot be inferred
locally.
