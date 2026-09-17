# NIR roadmap

This roadmap is ordered by security dependencies, not marketing dates. A stage
advances only after its tests, public specification, independent review and
operational rehearsal are complete.

## Stage 1 — deterministic monetary core (implemented locally)

- independent ledger, 21 million NIR cap and treasury vesting;
- post-quantum accounts, multisignature custody and encrypted recovery vaults;
- fees, sponsored payments, candidate and validator bonds, burns and slashing;
- two-phase finality, durable storage, snapshots, peer recovery and validator
  rotation;
- committed AI candidates, fresh challenges, independent evaluation, safety
  vetoes and world capability memory;
- bonded epoch-randomness authorities with timeout rotation and penalties.

Exit gate: the complete automated suite stays deterministic across clean
replays, restarts, message faults and state restoration.

## Stage 2 — usable payment network (in progress)

- Transfer Credit stake, renewal, exact-payment sponsorship, revocable
  delegation and delayed exit;
- wallet screens for available balance, locked stake, credits, delegations and
  pending unlocks;
- payment requests, address book, human-readable fee and resource quote;
- compact light-client headers with block-body commitments, continuous hash
  links, post-quantum certificates, validator handoffs and rollback-protected
  wallet checkpoints (implemented locally; independent audit remains);
- sparse account membership and absence proofs bound directly to every verified
  finality header (implemented locally; independent audit remains);
- ordered transaction roots, node-side inclusion proofs, checkpoint-anchored
  wallet header persistence and proof-gated history rendering (implemented
  locally; independent audit and long-term header compaction remain);
- per-account indexed history accumulators and proof-verified newest-page wallet
  loading against authenticated account leaves (implemented locally; persistent
  archival indexes and independently operated archive services remain);
- congestion measurements and a sustainable validator-compensation formula;
- public test network with independent seed, validator, beacon and evaluator
  operators.

Exit gate: an ordinary user can install a verified wallet, recover it, receive
NIR and make a payment without operating a node or understanding resource accounting.

## Stage 3 — native assets and developer tools

- small consensus-native asset instruction set: create, capped mint, transfer,
  burn and permanent revocation of mint authority;
- explicit metadata, freeze and administration indicators in every wallet;
- NIR-only resource payment so child assets cannot replace the base currency;
- stable RPC, typed SDKs, local sandbox, indexer and explorer;
- signed application permissions and transaction simulation before approval.

Exit gate: the asset rules have bounded storage, deterministic execution,
property tests and an external audit. No unrestricted application runtime is
required for this stage.

## Stage 4 — programmable applications

- deterministic, metered contract runtime with no ambient filesystem, network
  or clock access;
- declared read/write sets so independent operations can execute in parallel;
- capability-based permissions, storage rent and strict compute/memory limits;
- versioned contracts, delayed upgrades and visible administrator powers;
- composable payments, escrow, marketplaces and AI-service licensing;
- formal contract interfaces and wallet simulation of every state change.

Exit gate: adversarial contracts cannot violate the NIR cap, bypass signatures,
starve the Pay lane or make honest nodes disagree.

## Stage 5 — scalable execution

- parallel Pay, Proof and Control lanes under one finality certificate;
- reproducible throughput and latency benchmarks;
- data-availability sampling and shard-ready cross-lane messages;
- dynamic partitioning only after single-chain state proofs and recovery are
  proven under sustained public load.

Exit gate: partitions, delayed messages and unavailable data fail closed
without splitting monetary history.

## Stage 6 — production launch

- independent cryptographic, consensus, economic and wallet audits;
- long-running incentivized test network and public bug bounty;
- reproducible native installers and hardware-backed signing;
- finalized genesis ceremony, treasury vault and operator diversity evidence;
- published incident response, upgrade procedure and emergency limitations.

There is no mainnet date until every production gate in
[`launch-readiness.md`](launch-readiness.md) is independently satisfied.
