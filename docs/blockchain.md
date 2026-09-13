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
- proportional reward allocation from proof scores;
- permanent rejection of already rewarded proof fingerprints.

## Trust boundary

Validators currently attest that a proof score was produced correctly. The
chain verifies the score allocation, uniqueness, signatures, and monetary cap;
it does not rerun an AI model inside block validation. The evaluator and chain
will be joined through signed evaluation receipts in the next protocol version.

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
