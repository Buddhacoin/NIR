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
- **independent base layer:** NIR has its own ledger, addresses, signatures,
  monetary rules and fee market;
- **sponsored payments:** a person may sign an exact transfer while a separate
  account pays its fee; both post-quantum signatures, both nonces, the amount,
  recipient and network are consensus-bound, so the sponsor never controls the
  sender's funds;
- **resource-credit path:** the Pay lane lets locked NIR create
  renewable transfer capacity that the owner can use or sponsor for customers;
  ordinary NIR fees remain the fallback when credits are exhausted;
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
| Sponsored transfer fees | Two-party post-quantum authorization and independent replay protection implemented |
| Transfer Credits from locked NIR | Protocol-v19 stake, block-epoch renewal, exact-payment sponsorship, revocable delegation, delayed unstaking, per-block capacity limit, account RPC state and local wallet controls implemented; production calibration remains |
| ML-DSA-65 wallets and signed transfers | Implemented |
| Encrypted wallet files and 2-of-3 recovery vault | Implemented; external audit still required |
| Local wallet signing bridge and UI pairing | Expiring one-use pairing code, exact-origin in-memory session, multi-node finalized-view selection and failover, fee/transfer/resource review, terminal-confirmed signing without browser key access, and valueless-testnet-only submission; implemented locally |
| Signed payment requests | Exact recipient, amount, network, expiry, memo and request identifier are post-quantum signed; wallet creation, local verification and safe transfer prefill implemented |
| Cryptographic account proofs and light client | Protocol-v21 sparse account proofs bind balance, nonce, stake, credits, delegations and pending exits to the account root in every finalized header; the wallet also verifies every hash link, post-quantum prepare/commit quorum and validator rotation before advancing persisted trust |
| End-to-end wallet transfer test | Real loopback bridge and node HTTP services, post-quantum signature, block finalization, balance verification, and replay rejection; automated |
| Verifiable wallet installation | Signed `.nirpkg` verification, safe extraction into a new directory, and persistent source/artifact/signer provenance; implemented |
| Intelligence evaluation, novelty memory, safety veto, and capped rewards | Executable prototype with deterministic tests |
| Candidate bonds, safety payouts, burns, and validator/beacon slashing | Enforced by chain state; beacon bond enforcement activates only after every genesis authority has locked the minimum |
| Independent validator processes and P2P transaction gossip | Implemented for the local devnet |
| Two-phase P2P finality, leader replacement, durable pacemaker, highest-certificate recovery, and catch-up | Implemented for the local devnet |
| Multi-seed signed peer discovery, on-chain registry anchoring, rotatable transport identities, and pinned TLS 1.3 | Implemented and tested locally; independent hosting remains |
| Pre-activation validator onboarding | A six-process `4 → 4` rehearsal proves dual quorums with one old and one new node offline, paired key/topology history recovery, restart, and retirement |
| Bounded public ingress, request sizes, connections, headers, and timeouts | Implemented locally; production DDoS edge protection remains |
| Fsync-backed block journal, checksummed checkpoints, redundant copies, and public chain backups | Implemented and recovery-tested locally |
| Full consensus-state root covering balances, nonces, issuance, bonds, faults, validators, onboarding, and AI memory | Committed in genesis and every protocol-v7 block |
| Canonical state snapshots with ML-DSA validator quorum | Two ordered rotations, activation-bound snapshot restore, short tail replay, portable backup, and two-stage pruning are tested locally |
| Post-quantum signed releases | Clean Git revision and complete tracked file set are bound; deterministic wallet/node `.nirpkg` artifacts are locally verified; native installers remain |
| Partition and adversarial message testing | `2+2`, `3+1`, split-prepare recovery, 512 message schedules, multi-height fuzzing, and live validator rotation |
| Installable browser/PWA wallet interface | Permission-free Manifest V3 preview plus deterministic verifiable ZIP; real-value signing remains disabled |
| Public mainnet or exchange-listed NIR | Not launched |

Nothing in the local faucet, demo mining flow, or wallet preview has monetary
value. Mainnet requires independent operators, external cryptographic and
consensus audits, production networking, remotely attested evaluator execution,
hardware-backed energy evidence, and a public launch process.
The explicit gates for devnet, public testnet, incentivized testnet, and mainnet
are tracked in [`docs/launch-readiness.md`](docs/launch-readiness.md).
The ordered product and protocol plan is in [`docs/roadmap.md`](docs/roadmap.md),
and resource staking instructions are in [`docs/staking.md`](docs/staking.md).
Signed invoice creation and payment are documented in
[`docs/payment-requests.md`](docs/payment-requests.md).
Quorum balance verification is documented in
[`docs/account-proofs.md`](docs/account-proofs.md).

Run the complete JavaScript and Python verification locally without any hosted
service or payment:

```bash
npm run verify
```

The hosted workflow invokes the same command, so a local green result exercises
the same repository test entry point even when an external runner is unavailable.

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
  minting within a declared cap, transferring, and burning custom assets;
  child assets remain separate from NIR, pay fees in NIR, and receive no mining
  or governance rights;
- **sponsored payments:** a service may pay the network fee so a new user can
  receive and spend funds before acquiring NIR for fees;
- **Transfer Credits:** locked NIR produces a bounded, renewable Pay-lane
  quota. Credits are usage rights, not transferable money and not new NIR;
  a merchant or wallet service can sponsor an exact user-signed transfer with
  its own second signature without gaining custody of the user's balance;
- **state proofs and light clients:** wallets verify balances and finalized
  headers without trusting one RPC provider. Nodes supply compact headers rather
  than transaction bodies; each header commits to the complete block body, and
  the local bridge checks continuity, protocol version, both finality
  certificates and the validator set active at that height. A 256-level sparse
  proof then binds the requested account—or proves that a fresh address is
  absent—to the account root carried by that verified header;
- **parallel lanes:** Pay, Proof, and Control operations declare state access so
  independent work can execute concurrently;
- **programmable applications:** a future deterministic, metered runtime with
  declared permissions, bounded storage and transaction simulation, isolated
  from the monetary cap and the payment lane;
- **shard-ready messages:** account and proof messages retain deterministic
  commitments so dynamic split/merge scaling can be considered after the single
  chain is proven under public load;
- **selective privacy:** auditable viewing permissions are a research target,
  contingent on post-quantum security and legal review.

These capabilities are introduced only in the dependency order defined by the
[`NIR roadmap`](docs/roadmap.md). They are not claims about the current local
prototype.

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

The evaluator runner now builds a deterministic, content-addressed proof bundle
before a reward can be proposed. A signed `progress-commitment` transaction
first fixes the baseline, candidate, benchmark and recipient in finalized chain
state and records the currently unfinished randomness round. It cannot receive
a beacon committee until that exact round completes through on-chain
post-quantum commit/reveal in later blocks. The final epoch seed selects one
beacon committee without using a block-producer-controlled hash. Only then does
a post-quantum quorum from the separate beacon-authority registry supply fresh entropy. Every assigned member
must sign, so an aggregator cannot choose a favorable signer subset after seeing shares. The chain commits
the aggregate, derives the challenge seed and deterministically assigns the
evaluator committee. Beacon shares use a progress-only signature domain, so a
safety-fallback signature cannot be replayed as an intelligence challenge. The
bundle binds those committed files to the challenge, the revealed benchmark,
an exact runtime manifest, every independent output, measured resources, and
the derived report. Artifact substitution, environment substitution, a task
revealed before commitment, and reuse of the same finalized challenge all fail
closed. The included data-only adapter is safe for local demonstrations; it
does not execute untrusted model code. A public network still requires isolated
remote runners and hardware-backed execution and energy attestations.
The commitment is balance-free so the first NIR can be mined, but it consumes
the submitter nonce, is limited to one pending request per address, expires
after 1,024 blocks, and shares the block transaction limit.

Evaluation, randomness and block finality use three separate ML-DSA-65 key
registries. Their operator identities must be unique and pairwise disjoint in
the genesis configuration. A block proposer cannot choose a progress challenge
alone; fewer than the configured beacon quorum cannot create one.

The operator layer also contains the next randomness upgrade as an executable
state machine: a seed-derived fixed committee first signs commitments to secret
shares and may reveal only in a later height. The seed advances only after every
assigned reveal matches its commitment. This removes last-revealer grinding at
the cost of deliberately halting that randomness round when a member withholds.
Its signatures and adversarial tests are implemented. Protocol v13 commits the
complete round, committee, phase height, commitments, reveals and seed to every
state root and validates them during snapshot restoration. Protocol v14 also
includes signed `epochRandomnessCommits` and `epochRandomnessReveals` in blocks,
hashes and network proposals. Reveals are accepted only at a later height and a
completed round atomically rotates its seed and committee. Protocol v15 makes
every progress admission wait for that later finalized seed before any beacon
or evaluator committee can be assigned.

Protocol v16 also handles deliberate withholding. Eight blocks after a complete
commit phase, any assigned member that still has not revealed is recorded in
the randomness state and excluded. Partial data is discarded and the same
round rotates to a new fixed committee without producing a seed. Payments keep
finalizing, while intelligence issuance remains safely paused until a complete
unbiased round succeeds.

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

The genesis allocation is assigned to explicit post-quantum NIR addresses. The
current demo uses a temporary key. Before a public network, founder custody and the protocol
treasury must use disclosed, independently recoverable multisignature vaults.

Every fee-paid transfer pays a consensus-enforced minimum of **0.00001000 NIR**
to the block proposer, and a sender may offer more for priority. Protocol v19
also permits a bounded number of zero-fee transfers to consume renewable
Transfer Credits backed by locked NIR. Dynamic congestion pricing, validator
compensation for credit traffic, and whether part of a future base fee is burned
remain consensus decisions.

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

# The legacy JSON examples contain neither a real runner bundle nor a finalized
# chain admission. These fixed values label the output simulation-only; public
# claims must use the verified bundle hash and on-chain candidate id.
BUNDLE_HASH=$(python3 -c \
  'import hashlib; print(hashlib.sha256(b"local-demo-only").hexdigest())')
CANDIDATE_ID=$(python3 -c \
  'import hashlib; print(hashlib.sha256(b"finalized-demo-admission").hexdigest())')

python3 -m nir.genesis evaluate examples/genesis_suite.json \
  --salt nir-genesis-demo \
  --commitment "$COMMITMENT" \
  --bundle-hash "$BUNDLE_HASH" \
  --candidate-id "$CANDIDATE_ID" \
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
- `nir/runner.py` — content-addressed execution transcripts, proof bundles, and
  replay protection for evaluator runners.
- `nir/memory.py` — world capability frontier, lineage, and novelty registry.
- `nir/genesis.py` — command-line commit/reveal demonstrator.
- `nir/simulation.py` — a small example epoch.
- `blockchain/` — post-quantum signed ledger and local chain demonstration.
- `blockchain/vault.mjs` — encrypted key vault and multisignature recovery manifest.
- `blockchain/wallet-files.mjs` — native encrypted wallet file and transaction signing.
- `blockchain/validator-staking.mjs` — bonded eligibility and replay-protected non-reveal penalties.
- `blockchain/validator-rotation.mjs` — delayed, bonded finality-set rotation safety rules.
- `blockchain/validator-handoff.mjs` — old/new quorum trust handoffs for verifying snapshots across rotations.
- `blockchain/validator-topology-history.mjs` — genesis-rooted pairing of each handoff with its mutually signed endpoints, TLS pins, and transport identities.
- `blockchain/release-manifest.mjs` — deterministic source manifests and ML-DSA-65 release verification.
- `blockchain/release-artifact.mjs` — byte-reproducible wallet and node package containers bound to signed sources.
- `blockchain/beacon-service.mjs` — separately deployable post-quantum beacon authority.
- `blockchain/node-service.mjs` — localhost RPC for the persistent valueless devnet.
- `blockchain/node-store.mjs` — atomic block files and verified restart replay.
- `blockchain/block-store.mjs` — fsync-backed redundant journals, checkpoints, and public backups.
- `blockchain/distributed-node.mjs` — separate validators, mempool, and remote quorum coordinator.
- `blockchain/validator-service.mjs` — one-key validator RPC with durable anti-equivocation votes.
- `blockchain/consensus-view.mjs` — fail-closed highest-certificate selection for validator view changes.
- `wallet-ui/` — installable wallet/PWA and browser-extension interface preview.
- `docs/blockchain.md` — implemented consensus rules and current trust boundary.
- `docs/safety.md` — safety veto, threat domains, and certification limits.
- `docs/participation.md` — roles available to individuals and organizations.
- `docs/mining.md` — plain-language mining roles and intended user flow.
- `docs/privacy.md` — selective disclosure goals and regulatory constraints.
- `docs/value.md` — properties required for durable monetary value.
- `docs/governance.md` — where the ledger lives and how rules can safely evolve.
- `docs/wallet.md` — current native-wallet commands and production requirements.
- `docs/roadmap.md` — ordered development stages and their measurable exit gates.
- `docs/staking.md` — resource staking, credit delegation and delayed exit guide.
- `docs/payment-requests.md` — signed expiring invoice creation and verification.
- `docs/account-proofs.md` — validator-quorum balance and resource verification.
- `docs/beacon.md` — independent beacon deployment and aggregation runbook.
- `docs/releases.md` — offline release signing, trust-anchor publication, and source verification.
- `docs/node.md` — local node startup, RPC, and wallet-to-wallet flow.
- `docs/network.md` — multi-process devnet startup and remaining consensus boundary.
- `docs/quantum-security.md` — exact post-quantum guarantees, attack surfaces, and migration plan.
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
