# Bounded native assets v1

Protocol version 25 adds a deliberately small user-asset state machine. It does
not add smart contracts, exchange logic, administrator balance edits, or an
upgrade authority.

An asset identifier is the domain-separated hash of the network id, creator
address, and the creator's transaction nonce. The all-zero identifier is
reserved for the system NIR asset and cannot be created or referenced by a user
asset transaction. Creation commits a 32-byte metadata hash, an immutable
maximum supply, an initial supply, and whether the supply is fixed.

Fixed-supply assets must create their complete maximum supply immediately and
have no mint authority. A capped asset starts with its creator as the only mint
authority. Minting tracks both current supply and cumulative minted supply, so
burning does not reopen room under the cap. The authority can be revoked once;
revocation is irreversible. There is no transaction that changes metadata,
maximum supply, creator, or authority.

Holders may transfer or burn positive integer units. Every asset operation uses
the ordinary NIR signature, sequential nonce, minimum fee, proposer fee, and
treasury-vesting rules. Asset units never affect NIR issued supply, burned NIR,
or NIR balances except for that explicit fee.

The number of asset definitions and nonzero asset balances is bounded by
consensus constants. Metadata is represented only by a fixed-size hash; no
unbounded name, symbol, URI, or application payload is stored in consensus
state. Definitions, supplies, balances, and revoked authority are committed in
the protocol-25 chain state root and in verified snapshots. Protocol-24 state
roots remain unchanged, and asset transactions fail before version 25 is
activated through the existing quorum-scheduled protocol-upgrade mechanism.
