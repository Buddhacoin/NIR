# What NIR should learn from leading independent networks

Snapshot date: 2026-09-14. Market order changes continuously. The selection
starts from the [CoinGecko all-assets ranking](https://www.coingecko.com/en/all-cryptocurrencies),
then excludes stablecoins, wrapped/staked representations and application tokens
that do not secure an independent ledger. Avalanche is included because it is a
major independent L1 and especially relevant to NIR's separation of duties.

This is an engineering comparison, not an endorsement and not a promise to copy
twenty protocols. Every borrowed mechanism must have a written threat model,
deterministic tests, an independent audit and a delayed testnet activation.

| Network | Strongest lesson for NIR | Decision |
|---|---|---|
| Bitcoin | A deliberately narrow monetary base, independently replayable history and a capped issuance rule | Keep the narrow, deterministic base and hard cap; NIR uses useful-work issuance instead of competitive hashing |
| Ethereum | State commitments, light-client proofs and a large separation between consensus and execution | Adopt state roots and light clients; do not add a general VM to genesis ([accounts](https://ethereum.org/developers/docs/accounts/), [scaling](https://ethereum.org/developers/docs/scaling/)) |
| BNB Chain | Familiar developer interfaces reduce adoption friction | Offer standard RPC adapters later without making NIR dependent on another chain ([documentation](https://docs.bnbchain.org/)) |
| XRP Ledger | Prefer safety over liveness: if quorum is unsafe, halt instead of finalizing conflicting histories | Adopt fail-closed finality, but avoid operator-curated trust lists ([consensus](https://xrpl.org/docs/concepts/consensus-protocol)) |
| Solana | Parallel execution plus a separately authorized fee payer | Adopt explicit state-access lists and sponsored fees for simple consumer payments ([fees](https://solana.com/docs/core/fees), [fee sponsorship](https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction)) |
| TRON | Cheap, predictable retail transfers and explicit resource accounting | Adopt a clear fee quote; avoid governance concentrated in a small elected set ([documentation](https://developers.tron.network/docs)) |
| Zcash | Selective disclosure and viewing keys can reconcile privacy with audits | Research post-quantum selective privacy; do not ship legacy zero-knowledge cryptography unchanged ([protocol](https://zips.z.cash/protocol/protocol.pdf)) |
| Hyperliquid | A specialized native execution core can outperform a universal VM | Keep intelligence proofs and safety bounties as native state transitions ([HyperCore](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/overview)) |
| Dogecoin | Simple payments, recognizable units and approachable community UX matter | Borrow simplicity and friendliness, not inflation rules ([developer resources](https://dogecoin.com/dogepedia/)) |
| Monero | One-time addresses and view/spend key separation improve fungibility and user control | Research selective, auditable privacy; mandatory opacity creates regulatory and post-quantum migration risks ([stealth addresses](https://www.getmonero.org/resources/moneropedia/stealthaddress.html)) |
| Cardano | Peer-reviewed consensus specifications and staged releases reduce protocol risk | Require formal specifications and property tests before consensus activation ([Ouroboros](https://docs.cardano.org/about-cardano/learn/ouroboros-overview/)) |
| Stellar | Payment-focused operations, path payments and human-scale UX | Add payment requests and sponsored accounts before complex finance ([developers](https://developers.stellar.org/docs)) |
| Bitcoin Cash | Keep ordinary transfers usable when demand rises | Reserve a payment lane and test fee behavior under congestion ([reference](https://documentation.cash/)) |
| Litecoin | Conservative upgrades and long-lived wallet compatibility | Use versioned addresses and long deprecation windows ([documentation](https://litecoin.info/)) |
| Canton | Privacy and authorization across regulated domains | Study scoped data visibility for enterprise AI attestations, without making the public currency permissioned ([documentation](https://docs.digitalasset.com/)) |
| TON | Asynchronous messages and dynamic sharding support horizontal growth | Defer sharding until one deterministic lane is proven; design messages so it remains possible ([architecture](https://docs.ton.org/v3/concepts/dive-into-ton/ton-blockchain/accounts)) |
| Hedera | Consensus timestamps and predictable service fees are valuable to businesses | Add verifiable timestamps and stable fee policy; retain open validator admission as the goal ([documentation](https://docs.hedera.com/)) |
| Avalanche | Separate payment, validator-management and application responsibilities; specialized validator groups | Adopt logical lanes first, not three independent chains at launch ([Primary Network](https://build.avax.network/docs/primary-network), [Snowman](https://build.avax.network/docs/primary-network/avalanche-consensus)) |
| NEAR | Sharding can divide execution while preserving one logical network | Prepare shardable commitments, but only activate after data-availability tests ([Nightshade](https://docs.near.org/assets/files/Nightshade-201ea58f8dd6bc547f457d26ed5e8138.pdf)) |
| Sui | Object ownership allows independent transactions to execute in parallel | Later introduce declared read/write sets for non-conflicting NIR work ([concepts](https://docs.sui.io/concepts)) |

## Proposed NIR architecture

NIR should remain one independent network with three **logical lanes** sharing
one finality certificate and one native NIR balance:

1. **Pay** — transfers, fee sponsorship, multisignature accounts and future
   selective privacy.
2. **Proof** — candidate bonds, fresh challenges, reproducible intelligence
   improvement, safety certification and adversarial bounty evidence.
3. **Control** — validator bonds, beacon authorities, slashing, delayed upgrades
   and validator-set rotation.

This obtains Avalanche's separation of concerns without bridges between NIR's
own core functions. A user sees one address and one balance. Nodes may process
non-conflicting lanes in parallel later, but all results commit to one state root.

## Priority order

1. Finish rotating BFT finality and independently operated randomness beacons.
2. Add a state root, snapshots and a light-client proof format.
3. Add sponsored transactions so a new user can receive and spend NIR without
   first acquiring fee funds.
4. Add declared state-access lists and parallel replay benchmarks.
5. Research post-quantum selective privacy with auditable viewing permissions.
6. Consider application-specific execution only after the monetary and proof
   lanes survive public testnet and independent audits.

## Explicit non-goals for genesis

- no bridge-controlled supply;
- no unrestricted smart-contract VM;
- no opaque default privacy based on cryptography threatened by quantum attack;
- no validator set that only a few AI laboratories can join;
- no advertised TPS number before reproducible public benchmarks.
