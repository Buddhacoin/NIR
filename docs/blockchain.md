# NIR Blockchain Core — Draft 0.1

The first chain implementation is a deterministic local ledger. It establishes
the state-transition rules that a later peer-to-peer network must execute
identically.

## Implemented

- SHA3-256 content-addressed blocks, full 256-bit account addresses, and
  previous-block linkage;
- account balances, sequential nonces, fees, and atomic block application;
- ML-DSA-65 post-quantum signatures for accounts and validators;
- deterministic round-robin block proposers;
- finality certificates requiring at least `floor(2N/3) + 1` validator votes;
- fixed per-epoch progress-reward budgets and the 21 million NIR hard cap;
- a ten-minute minimum interval between intelligence-reward blocks;
- proportional reward allocation from proof scores;
- ML-DSA-65-signed evaluation receipts bound to network and epoch;
- on-chain recomputation of progress scores;
- a world-capability memory root committed by genesis and every block;
- consensus validation of lineage, behavior novelty, and marginal frontier gain;
- permanent rejection of already rewarded proof fingerprints;
- ten-year linear treasury vesting by bounded block timestamps;
- domain-separated signatures and hashes;
- limits on block bytes, transactions, rewards, and numeric inputs.

## Trust boundary

Validators attest identical evaluation metrics and the chain recomputes the
score, world-memory transition, allocation, uniqueness, signatures, and
monetary cap. Empty blocks do not consume issuance epochs. The chain does not
rerun an AI model inside block validation. Production still needs a transport
that creates receipts directly from reproducible evaluator executions.

Validator identities in this version are configured at genesis. This is not yet
permissionless consensus and has no Sybil-resistance, validator rotation,
slashing, fork recovery, or peer-to-peer transport.

## Run

```bash
npm run test:chain
npm run demo:chain
```

Node.js 26+ is required because the implementation uses its native ML-DSA-65
support.
