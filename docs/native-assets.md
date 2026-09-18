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

## Tool and offline-signing flow

Asset state is never accepted from an unauthenticated read response. A tool
requests `/v1/assets/<assetId>/proof?holder=<address>` from a coordinator. The
coordinator synchronizes a validator quorum and returns a
`nir-native-asset-proof-v1` statement signed by that quorum. The statement
binds the complete asset definition (or authenticated non-existence), holder
balance, network, height, tip hash, state root, protocol version, and
validator-set id. Consumers reject unknown fields, insufficient or duplicate
signatures, a stale minimum height, and a statement that does not match their
independently verified finality tip.

The wallet bridge accepts the statement only through
`POST /v1/verify-asset-proof`. It keeps the verified result in memory and uses
it with a separately verified account proof for
`POST /v1/simulate-transaction`. Create, mint, transfer, burn, and revoke
previews show the exact NIR fee and nonce change, asset balance/supply changes,
required authority, cap risk, and irreversible burn or revoke consequences.
Sender and recipient proofs must refer to exactly the same finalized state.

Asset operations are excluded from the bridge's direct signing routes. After
reviewing a fresh simulation, a tool may export an offline signing package
through `POST /v1/create-offline-signing-package`. The air-gapped signer
re-runs the proof-bound simulation before signing, and import verification
checks that the signed transaction did not change a reviewed field. Neither
simulation nor package creation broadcasts, and no browser-side signing or
private-key exposure is introduced.

### Wallet UI

The existing wallet exposes native assets from **Resources → User assets**
without adding another navigation destination or a new visual theme. Discovery
uses asset identifiers from the wallet's already verified transaction history
and the current session; every displayed definition and holder balance must
then pass `/v1/verify-asset-proof`. The panel always displays the verified
height and state-root prefix. Loading, proof failure/staleness, and the absence
of discovered proven assets are distinct states; an empty discovery result is
not presented as a proof that no other asset has ever existed.

Create, mint, transfer, burn, and irreversible authority-revoke forms produce
only a proof-backed preview. Create obtains its deterministic identifier from
the authenticated exact-origin loopback bridge and then proves non-existence at
that identifier. Before export, the wallet reloads the account proof, reloads
every required holder proof, repeats simulation, and requires identical
consequences. Asset intents have no browser signing or broadcast action: their
only continuation is export of the versioned offline signing package.
