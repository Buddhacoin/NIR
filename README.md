# NIR Protocol

NIR is a monetary protocol in which new currency is issued for
**verified progress in machine intelligence**, not for raw computation alone.

This repository contains the executable protocol, local network, command-line
tools, and wallet preview. It does not represent a launched public mainnet or a
tradable asset.

NIR is an independent layer-one blockchain, not a token issued by another
network. It requires a native wallet for its addresses, ML-DSA-65 signatures,
network rules, encrypted vaults, and multisignature recovery. The repository
already contains the cryptographic vault core; a reviewed desktop/mobile wallet
and hardware-key integration are still future work.

## Why NIR exists

Ordinary AI markets pay for usage whether an answer is correct, novel, or safe.
NIR is designed to make independently verified intelligence progress a scarce,
publicly auditable economic event. A successful claim must outperform a frozen
baseline on fresh hidden tasks, reproduce across independent evaluators, add a
new capability to the world memory, and clear an approved safety policy before
the protocol can issue a reward.

The intended advantages are:

- **useful issuance:** new NIR is tied to verified capability or efficiency
  progress instead of raw resource consumption;
- **hard scarcity:** consensus enforces a maximum of 21,000,000 NIR;
- **independent base layer:** NIR does not depend on Ethereum, Solana, TON, a
  bridge custodian, or another chain's fee market;
- **post-quantum accounts:** transfers, vaults, validator votes, evaluator
  receipts, and network authentication use ML-DSA-65 signatures;
- **safety as an economic role:** safe progress may earn a reward, while a
  reproducible critical failure can earn a bounded bounty from the candidate's
  bond; an unsafe model cannot mint an intelligence reward;
- **access beyond AI laboratories:** people may contribute fresh challenges,
  independent reproduction, safety research, fraud evidence, or network service;
- **fail-closed finality:** without a two-thirds-plus-one quorum, the network
  stops rather than accepting conflicting histories;
- **one auditable history:** every node can replay monetary, mining, safety,
  randomness, slashing, and validator-rotation rules from genesis.

## What is implemented now

| Capability | Current repository status |
|---|---|
| Independent NIR ledger and 8-decimal balances | Implemented and tested |
| 21 million cap and ten-year treasury vesting | Enforced by consensus |
| Minimum transfer fee and wallet fee quote | Enforced by consensus |
| ML-DSA-65 wallets and signed transfers | Implemented |
| Encrypted wallet files and 2-of-3 recovery vault | Implemented; external audit still required |
| Intelligence evaluation, novelty memory, safety veto, and capped rewards | Executable prototype with deterministic tests |
| Candidate bonds, safety payouts, burns, and validator slashing | Enforced by chain state |
| Independent validator processes and P2P transaction gossip | Implemented for the local devnet |
| P2P finality, leader replacement, durable pacemaker, lock recovery, and catch-up | Implemented for the local devnet |
| Partition and adversarial message testing | `2+2`, `3+1`, plus 512 seeded schedules |
| Installable browser/PWA wallet interface | Interactive local testnet preview |
| Public mainnet or exchange-listed NIR | Not launched |

Nothing in the local faucet, demo mining flow, or wallet preview has monetary
value. Mainnet requires independent operators, external cryptographic and
consensus audits, production networking, remotely attested evaluator execution,
hardware-backed energy evidence, and a public launch process.

## Who uses NIR and how

| Participant | Contribution | Verifiable benefit |
|---|---|---|
| AI developer or laboratory | Submit a committed model or method against a frozen baseline | Independent progress and safety evidence; eligible NIR reward |
| Compute operator | Reproduce an evaluation in the declared environment | Reproduction payment and operator reputation |
| Challenge author | Supply fresh, objectively gradable hidden tasks | Challenge reward when the task is accepted and useful |
| Safety investigator | Prove a new reproducible critical failure | Bounded bounty from bonded funds |
| Fraud challenger | Prove forged evidence, duplicated lineage, or equivocation | Slashed-funds reward |
| Validator | Bond funds, verify state transitions, relay and finalize blocks | Transaction fees and protocol-defined validator incentives |
| Everyday user | Hold, receive, and send NIR with the native wallet | Direct use of the independent currency; no AI training required |

Organizations gain more than a mining payout: a successful NIR proof can become
portable evidence that a system improved, remained safe under a declared policy,
and was reproduced without publishing private model weights. That evidence can
support licensing, procurement, reputation, and access to customers that require
independent verification.

## Planned platform capabilities

NIR is designed to grow without turning its monetary core into an unrestricted
application runtime at genesis:

- **native user-created assets:** a constrained Pay-lane standard for creating,
  minting within a declared cap, transferring, and burning other currencies;
  child assets remain separate from NIR, pay fees in NIR, and receive no mining
  or governance rights;
- **sponsored payments:** a service may pay the network fee so a new user can
  receive and spend funds before acquiring NIR for gas;
- **state proofs and light clients:** wallets verify balances and finalized
  headers without trusting one RPC provider;
- **parallel lanes:** Pay, Proof, and Control operations declare state access so
  independent work can execute concurrently;
- **shard-ready messages:** account and proof messages retain deterministic
  commitments so dynamic split/merge scaling can be considered after the single
  chain is proven under public load;
- **selective privacy:** auditable viewing permissions are a research target,
  contingent on post-quantum security and legal review.

Dynamic sharding and per-account asset storage are lessons worth studying from
TON; explicit account access and standard token mints are useful lessons from
Solana. They are roadmap inputs, not claims that NIR already matches those mature
networks. The engineering comparison and adoption order are in
[`docs/top-chains-study.md`](docs/top-chains-study.md).

## Start using the local prototype

1. Install Python 3.11+ and Node.js 26+.
2. Run all consensus and evaluation tests:

   ```bash
   python3 -m unittest discover -s tests -v
   npm run test:chain
   ```

3. Start the persistent valueless node and wallet preview:

   ```bash
   npm run node:init-dev -- .nir-devnet
   npm run node:serve -- .nir-devnet
   # In another terminal:
   npm run wallet:preview
   ```

4. For four independent validator processes, follow
   [`docs/network.md`](docs/network.md).
5. For contribution roles and the intended mining workflow, read
   [`docs/mining.md`](docs/mining.md). For wallet and transfer commands, read
   [`docs/wallet.md`](docs/wallet.md) and [`docs/node.md`](docs/node.md).

## Core idea

A candidate contribution competes against a frozen baseline on hidden tests.
It may earn an epoch reward only when independent verification shows:

- a positive capability gain;
- breadth beyond one memorized test;
- reproducibility by independent nodes;
- no unacceptable safety regression;
- novelty relative to earlier accepted work;
- declared compute energy backed by future hardware attestations.

Raw compute never creates money by itself. Rewards are shared among accepted
contributions according to their verified progress score, with an efficiency
adjustment for the energy used.

Evaluation and block finality use separate ML-DSA-65 key registries. Their
operator identities must be unique and disjoint in the genesis configuration.

## Why organizations use NIR

An organization does not participate only for newly issued NIR. An accepted
proof can provide:

- independently reproducible evidence that a model or method is better;
- a versioned safety clearance recognized by an open evaluator network;
- a way to license verified capability without publishing private weights;
- reputation and eligibility for customers that require independent evidence;
- NIR for a contribution that moves the measured world frontier.

These benefits have value only if users, AI services, and buyers demand the
verification network. A token cannot manufacture adoption by itself.

## Ways people can earn

NIR must not become money only laboratories can issue. The protocol is being
designed around distinct, measurable contributions:

- authors prove a new capability or a real efficiency improvement;
- independent compute operators reproduce a submitted result;
- challenge authors create fresh, objectively gradable tasks;
- safety evaluators verify that a candidate clears an approved policy;
- safety investigators prove a previously unknown critical failure;
- fraud challengers prove forged evaluation, duplicated lineage, or
  double-signing;
- node operators validate and relay ordinary payments.

Positive capability proofs and vulnerability discoveries are different reward
classes. A laboratory can earn for safe progress. An investigator can earn a
bounded security bounty for a reproducible failure even though the unsafe
model itself receives no progress reward. Bounties must come from a declared
security pool or slashed bonds, not unbounded new issuance, so manufacturing
vulnerabilities cannot become a minting strategy.

## Monetary draft

- Hard cap: **21,000,000 NIR**.
- Precision: **8 decimal places**.
- Intelligence-mining pool: **88%**.
- Builder and protocol treasury: **12%**, locked and intended to vest over ten
  years. This is a draft governance parameter, not a final allocation.
- A successful intelligence epoch starts at 50 NIR and its budget is cut in
  half after every 210,000 rewarded epochs. Empty blocks issue nothing and do
  not advance this counter. Rewarded blocks must be at least ten minutes apart,
  and the hard cap always wins.
- Holding NIR does not automatically grant protocol governance power.

The genesis allocation is assigned to explicit post-quantum NIR addresses; it
does not unlock into an exchange or a wallet from another network. The current demo uses a
temporary key. Before a public network, founder custody and the protocol
treasury must use disclosed, independently recoverable multisignature vaults.

Every transfer pays a consensus-enforced minimum fee of **0.00001000 NIR** to
the block proposer, and a sender may offer more for priority. Dynamic congestion
pricing, fee sponsorship for ordinary users, and whether part of a future base
fee is burned remain consensus decisions.

Wallets must present the fee both as NIR and as a percentage of the transfer.
The consensus fee itself is resource-based rather than value-based: moving a
large balance does not consume proportionally more network capacity.
The wallet quote marks fees above 0.1 percent for explicit confirmation; a one
percent fee is never silently accepted as a normal payment setting.

## Run the prototype

Requires Python 3.11+ and has no third-party dependencies.

```bash
python3 -m unittest discover -s tests -v

COMMITMENT=$(python3 -m nir.genesis commit \
  examples/genesis_suite.json --salt nir-genesis-demo)

python3 -m nir.genesis evaluate examples/genesis_suite.json \
  --salt nir-genesis-demo \
  --commitment "$COMMITMENT" \
  --baseline examples/baseline.json examples/baseline-2.json \
    examples/baseline-3.json \
  --candidate examples/candidate-1.json examples/candidate-2.json \
    examples/candidate-3.json \
  --contributor genesis-lab
```

The bundled suite is public and exists only to demonstrate the commit/reveal
flow. A real epoch commits to an unrevealed suite, requires the same three or
more independent verifiers to run both models, and reveals the suite only after
candidate runs are committed.

## Repository map

- `docs/protocol.md` — protocol and threat-model draft.
- `nir/model.py` — deterministic scoring and capped emission model.
- `nir/evaluator.py` — hidden-suite commitment and progress evaluation.
- `nir/memory.py` — world capability frontier, lineage, and novelty registry.
- `nir/genesis.py` — command-line commit/reveal demonstrator.
- `nir/simulation.py` — a small example epoch.
- `blockchain/` — post-quantum signed ledger and local chain demonstration.
- `blockchain/vault.mjs` — encrypted key vault and multisignature recovery manifest.
- `blockchain/wallet-files.mjs` — native encrypted wallet file and transaction signing.
- `blockchain/validator-staking.mjs` — bonded eligibility and replay-protected non-reveal penalties.
- `blockchain/validator-rotation.mjs` — delayed, bonded finality-set rotation safety rules.
- `blockchain/beacon-service.mjs` — separately deployable post-quantum beacon authority.
- `blockchain/node-service.mjs` — localhost RPC for the persistent valueless devnet.
- `blockchain/node-store.mjs` — atomic block files and verified restart replay.
- `blockchain/distributed-node.mjs` — separate validators, mempool, and remote quorum coordinator.
- `blockchain/validator-service.mjs` — one-key validator RPC with durable anti-equivocation votes.
- `wallet-ui/` — installable wallet/PWA and browser-extension interface preview.
- `docs/blockchain.md` — implemented consensus rules and current trust boundary.
- `docs/safety.md` — safety veto, threat domains, and certification limits.
- `docs/participation.md` — roles available to individuals and organizations.
- `docs/mining.md` — plain-language mining roles and intended user flow.
- `docs/privacy.md` — selective disclosure goals and regulatory constraints.
- `docs/value.md` — properties required for durable monetary value.
- `docs/governance.md` — where the ledger lives and how rules can safely evolve.
- `docs/wallet.md` — current native-wallet commands and production requirements.
- `docs/top-chains-study.md` — lessons from leading independent networks and NIR's three-lane architecture.
- `docs/beacon.md` — independent beacon deployment and aggregation runbook.
- `docs/node.md` — local node startup, RPC, and wallet-to-wallet flow.
- `docs/network.md` — multi-process devnet startup and remaining consensus boundary.
- `SECURITY.md` — fixed findings, open blockers, and quantum-attacker review.
- `tests/test_model.py` — invariant tests.
- `tests/network-partition.test.mjs` — real HTTP `2+2` and `3+1` partition recovery tests.
- `tests/adversarial-consensus.test.mjs` — seeded delay, loss, reorder, replay, and equivocation schedules.

## Run the blockchain core

Node.js 26+ is required for native ML-DSA-65 signatures.

```bash
npm run test:chain
npm run demo:chain
```

## Run the persistent local node

Create a new valueless development network once, then start its localhost RPC:

```bash
npm run node:init-dev -- .nir-devnet
npm run node:serve -- .nir-devnet
```

The node stores finalized blocks, verifies the full chain again after restart,
and exposes account, fee, transaction, and faucet endpoints at
`http://127.0.0.1:8787`. Its four development validators currently run inside
one process, so this is a persistence and wallet-integration milestone rather
than a distributed public network. The generated `DEVNET-KEYS.json` contains
unencrypted, valueless test keys and must never be funded or exposed.

Open the wallet preview in a second terminal:

```bash
npm run wallet:preview
```

The complete wallet-to-wallet command flow and RPC reference are in
`docs/node.md`.

For the newer multi-process mode, where the coordinator has no validator keys,
follow `docs/network.md`. It runs four validator replicas, queues transactions
in a mempool, independently executes proposals, and requires a remote
`2N/3 + 1` finality certificate.

To try the current local mining flow:

```bash
npm run mine:demo
```

This command uses valueless local units. It does not mine tradeable NIR or join
a public network. The seven production roles and their intended one-screen user
flow are explained in `docs/mining.md`.

## Offline vault prototype

Run these commands only on a trusted offline machine. The destination directory
must not already exist. Passwords are read without echo and are never accepted
as command-line arguments or environment variables.

```bash
npm run vault:create -- /absolute/path/to/new-founder-vault
npm run vault:verify -- /absolute/path/to/new-founder-vault
```

Creation produces three separately encrypted guardian files and one public-data
recovery manifest for a two-of-three NIR address. Store the three files and
their distinct passwords in separate physical locations. Do not commit them to
Git, cloud-sync the complete set, or use this unaudited prototype for assets of
real value.

## Non-negotiable design constraints

NIR must remain useful to ordinary people as money, while its issuance serves
AI progress. Payments and mining are separate: paying for an AI answer moves
existing NIR; only verified new capability can mint NIR.
