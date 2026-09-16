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
| Solana | Parallel account execution, sponsored fees, and a standard program for user-created fungible assets | Adopt explicit state-access lists and sponsored payments; add a constrained native asset standard only after NIR payments are stable ([core concepts](https://solana.com/docs/core), [token basics](https://solana.com/docs/tokens/basics)) |
| TRON | Cheap retail transfers, renewable Bandwidth/Energy from staked TRX, and resource delegation | Adopt bounded Transfer Credits from locked NIR plus non-custodial sponsorship; keep ordinary fees as fallback and avoid governance concentrated in a small elected set ([resource model](https://developers.tron.network/docs/resource-model)) |
| Zcash | Selective disclosure and viewing keys can reconcile privacy with audits | Research post-quantum selective privacy; do not ship legacy zero-knowledge cryptography unchanged ([protocol](https://zips.z.cash/protocol/protocol.pdf)) |
| Hyperliquid | A specialized native execution core can outperform a universal VM | Keep intelligence proofs and safety bounties as native state transitions ([HyperCore](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/overview)) |
| Dogecoin | Simple payments, recognizable units and approachable community UX matter | Borrow simplicity and friendliness, not inflation rules ([developer resources](https://dogecoin.com/dogepedia/)) |
| Monero | One-time addresses and view/spend key separation improve fungibility and user control | Research selective, auditable privacy; mandatory opacity creates regulatory and post-quantum migration risks ([stealth addresses](https://www.getmonero.org/resources/moneropedia/stealthaddress.html)) |
| Cardano | Peer-reviewed consensus specifications and staged releases reduce protocol risk | Require formal specifications and property tests before consensus activation ([Ouroboros](https://docs.cardano.org/about-cardano/learn/ouroboros-overview/)) |
| Stellar | Payment-focused operations, path payments and human-scale UX | Add payment requests and sponsored accounts before complex finance ([developers](https://developers.stellar.org/docs)) |
| Bitcoin Cash | Keep ordinary transfers usable when demand rises | Reserve a payment lane and test fee behavior under congestion ([reference](https://documentation.cash/)) |
| Litecoin | Conservative upgrades and long-lived wallet compatibility | Use versioned addresses and long deprecation windows ([documentation](https://litecoin.info/)) |
| Canton | Privacy and authorization across regulated domains | Study scoped data visibility for enterprise AI attestations, without making the public currency permissioned ([documentation](https://docs.digitalasset.com/)) |
| TON | Dynamic split/merge sharding, asynchronous account messages, per-holder Jetton wallets, and unusually direct consumer distribution | Preserve shardable account messages and study per-account asset storage; defer dynamic sharding until one deterministic lane is proven ([sharding](https://docs.ton.org/foundations/shards), [Jettons](https://docs.ton.org/contracts/standard/tokens/jettons/how-it-works)) |
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

## Transfer Credits

NIR should adapt TRON's strongest payment idea without copying its governance.
A separate Pay-lane stake locks native NIR and earns a deterministic quota of
Transfer Credits per block epoch. One ordinary transfer consumes a published
number of credits; more expensive future operations consume more. Credits:

- replenish up to a cap and cannot be sold as a second currency;
- never increase the 21 million NIR supply;
- can be delegated by a signed, revocable allowance without transferring the
  underlying NIR;
- can sponsor only the exact sender-authorized transaction, reusing NIR's
  existing two-signature fee-payer protection;
- fall back to the normal NIR fee when allowance or quota is insufficient;
- use block-height epochs rather than wall-clock time, preventing timestamp
  manipulation from manufacturing quota.

The unresolved economic question is validator compensation for credit-paid
traffic. Mainnet must not call a transfer “free” while silently shifting an
unbounded cost to operators. The safe implementation order is metering and
delegation first, then public load measurements, followed by a capped formula
that divides capacity between fee-paid and credit-paid traffic.

## Future native assets

NIR can support currencies created by users without becoming a token on Solana,
TON, or another network. The safer first design is a native asset registry in
the Pay lane, not an unrestricted smart-contract virtual machine. Consensus
would define a small auditable instruction set:

- create an asset with unique ID, name, symbol, decimals, metadata commitment,
  maximum supply, and explicit authorities;
- mint within the declared cap, transfer, burn, and query balances;
- permanently revoke mint authority for fixed-supply assets;
- make any optional freeze or metadata authority plainly visible to wallets;
- charge execution and storage fees only in NIR, preserving demand for the base
  currency and preventing child assets from paying validators in arbitrary units.

Like TON Jettons and Solana token mints, these assets would be distinct from the
native coin. They would not participate in intelligence issuance, validator
bonding, consensus voting, or the 21 million NIR cap. Wallets must mark unknown
assets as unverified and suppress look-alike symbols by default. Asset support
should follow state roots, light clients, storage accounting, and an external
audit; putting it into genesis now would enlarge the attack surface before the
base monetary chain is mature.

## Priority order

1. Deploy the implemented beacon service with independent operators and audit
   finality rotation, including withdrawal delays and long network partitions.
2. Add a state root, snapshots and a light-client proof format.
3. Add Transfer Credit staking, delegation, and a separately bounded block
   quota; sponsored transactions are already implemented.
4. Add declared state-access lists and parallel replay benchmarks.
5. Research post-quantum selective privacy with auditable viewing permissions.
6. Specify and audit the constrained native asset registry.
7. Consider application-specific execution only after the monetary and proof
   lanes survive public testnet and independent audits.

## Explicit non-goals for genesis

- no bridge-controlled supply;
- no unrestricted smart-contract VM;
- no opaque default privacy based on cryptography threatened by quantum attack;
- no validator set that only a few AI laboratories can join;
- no advertised TPS number before reproducible public benchmarks.
