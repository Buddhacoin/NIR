# NIR Blockchain Core — Draft 0.1

The first chain implementation is a deterministic local ledger. It establishes
the state-transition rules that a later peer-to-peer network must execute
identically.

## Implemented

- SHA3-256 content-addressed blocks, full 256-bit account addresses, and
  previous-block linkage;
- account balances, sequential nonces, fees, and atomic block application;
- a consensus-enforced minimum transfer fee of 0.00001000 NIR, paid to the
  block proposer;
- ML-DSA-65 post-quantum signatures for accounts and validators;
- native M-of-N ML-DSA-65 multisignature accounts for treasury custody;
- deterministic round-robin block proposers;
- finality certificates requiring at least `floor(2N/3) + 1` validator votes;
- separate evaluator and consensus registries with disjoint operator identities;
- fixed per-epoch progress-reward budgets and the 21 million NIR hard cap;
- a ten-minute minimum interval between intelligence-reward blocks;
- proportional reward allocation from proof scores;
- ML-DSA-65-signed evaluation receipts bound to network and epoch;
- on-chain recomputation of progress scores;
- a world-capability memory root committed by genesis and every block;
- consensus validation of lineage, behavior novelty, and marginal frontier gain;
- permanent rejection of already rewarded proof fingerprints;
- ten-year linear treasury vesting by bounded block timestamps;
- signed candidate-bond transactions and consensus-recomputed critical-safety
  settlements with reporter/evaluator payouts and permanent supply burns;
- deterministic safety-committee assignment from a validator-quorum
  commit/reveal round after a candidate bond, with settlement restricted to
  that exact committee;
- domain-separated signatures and hashes;
- limits on block bytes, transactions, rewards, and numeric inputs.

## Trust boundary

Validators attest identical evaluation metrics and the chain recomputes the
score, world-memory transition, allocation, uniqueness, signatures, and
monetary cap. Empty blocks do not consume issuance epochs. The chain does not
rerun an AI model inside block validation. Production still needs a transport
that creates receipts directly from reproducible evaluator executions.

Validator and evaluator identities in this version are configured at genesis,
and one configured operator cannot occupy both roles. This is not yet
permissionless consensus: operator identifiers are self-asserted, and there is
no consensus-connected external identity attestation, operator rotation,
evaluator-equivocation slashing, fork recovery, or peer-to-peer transport.
Candidate safety bonds, randomness commitments and reveals, committee
assignments, and critical-failure settlements are consensus state. No single
block producer supplies the seed. The current commit/reveal construction still
has a last-revealer liveness and bias risk: a contributor can withhold its reveal
after seeing others. The chain now records each committed non-revealer as an
objective fault and refunds the candidate bond after the deadline, preventing
indefinite candidate-fund lockup. Signed validator-bond transactions lock real
ledger balances; only sufficiently bonded validators may commit randomness, and
one percent of a non-revealer's remaining bond is burned automatically.
Production still needs withdrawal delays, suspension/rotation rules, and an
independently audited fallback randomness beacon.

## Run

```bash
npm run test:chain
npm run demo:chain
```

Node.js 26+ is required because the implementation uses its native ML-DSA-65
support.
