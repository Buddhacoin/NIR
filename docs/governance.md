# NIR ledger permanence and protocol evolution

## GitHub is not the ledger

GitHub distributes source code and records its development history. It is not
the authoritative copy of balances or transactions. On a public network, each
full node stores and verifies its own chain. Removing the repository, changing
its default branch, or a maintainer publishing different code does not erase
copies already held by nodes.

The current NIR program is still a single-process prototype. It does not yet
have that permanence because there is no peer-to-peer network, durable node
database, reproducible release process, or independent population of nodes.

## What makes a rule real

A source-code edit becomes a network rule only when node operators deliberately
install software that enforces it. Nodes running incompatible rules reject one
another's blocks or form separate chains. Repository ownership must therefore
confer no ability to rewrite finalized history, replace balances, mint past the
cap, or force an upgrade.

Every release must have reproducible binaries, signed release manifests, a
protocol version, an activation condition, and enough public notice for users
to inspect it. Historical blocks remain immutable inputs to the new version.

## Constitutional rules

The following rules should be exceptionally difficult to change:

- the 21,000,000 NIR maximum supply;
- no unilateral administrator mint or balance rewrite;
- genesis allocations and their vesting commitments;
- separation between asset ownership and evaluator control;
- critical safety failures cannot earn progress issuance;
- users may remain on the old rules or reject an upgrade.

No technical mechanism can prevent every community from publishing a fork. The
defense is that a fork is visibly a different network and cannot silently alter
the rules accepted by existing nodes.

## Upgradeable components

Cryptography, networking, execution attestations, benchmark families, safety
policies, and denial-of-service defenses must be upgradeable. Freezing them
would make the network unable to repair defects or migrate after a future
cryptographic break.

A production activation design should require all of the following:

1. a published proposal and reference implementation;
2. independent security review and deterministic test vectors;
3. a delayed activation height;
4. a high threshold of independently controlled validators signalling support;
5. voluntary adoption by full-node operators;
6. an explicit new protocol version, with no hidden automatic update.

Validator signalling alone is not governance: a small validator cartel must
not be able to redefine money for everyone. The exact activation thresholds
and operator-independence proofs remain open before testnet.

## Creator custody

The current code assigns the combined 12 percent builder/protocol allocation to
one genesis `treasuryAddress` and enforces ten-year linear vesting. The demo
address is temporary. A production genesis must name permanent post-quantum NIR
vault addresses and publish their allocation before launch.

An Ethereum/MetaMask address is not compatible with the current native NIR
ML-DSA address format. Founder custody should use an offline threshold vault;
the protocol treasury should use a separate transparent multisignature with
published spending records. No private key or recovery phrase belongs in the
repository.

The prototype now supports native M-of-N ML-DSA-65 accounts. Each member key can
be stored in a separate AES-256-GCM encrypted vault whose key is derived with
scrypt. A public recovery manifest commits to the expected encrypted backups
without containing their ciphertext or private keys. A recommended founder
layout is two signatures out of three independently stored vaults. This is not
yet a substitute for audited hardware-wallet integration, secure password
entry, tested inheritance procedures, or an offline signing application.

## Transaction fees

Every transfer now pays a consensus-enforced minimum of 0.00001000 NIR to the
block proposer. A sender may offer more for priority. This establishes an
anti-spam floor, but it is not yet dynamic congestion pricing. Before a public
network, load tests must determine whether the floor should adjust gradually
with block demand and how users without NIR can use sponsored transactions.
Burning or routing a future base component to a security pool is a
monetary-policy decision and is not implemented.
