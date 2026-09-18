# Public developer-testnet genesis ceremony

This tooling creates reproducible genesis material for a **valueless developer
testnet only**. It is not a mainnet ceremony, production-readiness claim, token
launch, custody service, or key generator.

The input is public JSON containing:

- network ID, genesis timestamp, current protocol version, and signed source-release
  manifest hash;
- four or more disjoint validator, evaluator, and beacon public ML-DSA-65 identities,
  operator IDs, and HTTPS endpoints (loopback HTTP is allowed for local drills);
- a public treasury descriptor whose address is exactly the protocol 2-of-3
  multisignature address and whose policy is the protocol's 12% allocation with
  linear vesting from genesis over `TREASURY_VESTING_MS`;
- three or more public ceremony-operator identities, unique 256-bit contributions,
  and unique public nonces.

Every object has an exact schema. Unknown fields and fields named like private keys,
secrets, seeds, passwords, or mnemonics are rejected. The tool never generates an
address or private key. Contributions and nonces must be generated independently by
operators and must not be reused.

## Workflow

Create the canonical plan and its domain-separated commitment:

```bash
npm run genesis:ceremony -- plan public-input.json genesis-plan.json
```

Each listed ceremony operator reviews the same canonical plan and signs it offline
using an existing encrypted NIR vault:

```bash
npm run genesis:ceremony -- sign genesis-plan.json operator-vault.json approval.json
```

Collect the individual approval JSON objects into a JSON array, assemble an envelope,
and verify the greater-than-two-thirds quorum:

```bash
npm run genesis:ceremony -- assemble genesis-plan.json approvals.json envelope.json
npm run genesis:ceremony -- verify genesis-plan.json envelope.json prior-plans.json
```

`prior-plans.json` is an optional JSON array of previously accepted public plans.
Supplying it makes verification reject a reused network ID, plan commitment, or
operator contribution. The registry is explicit because a standalone offline tool
cannot infer ceremonies performed elsewhere.

Compile only after verification:

```bash
npm run genesis:ceremony -- compile \
  genesis-plan.json envelope.json genesis.json prior-plans.json
```

Compilation emits the existing `NirChain` genesis configuration, constructs the
chain twice through canonical JSON, and requires the genesis block hash to round-trip
exactly. Public endpoints and ceremony entropy remain committed by the plan but are
not inserted into fields that the current chain genesis schema does not contain.
Consequently the initial `peerRegistry` is `null`; authenticated peer-registry setup
is a separate reviewed operation. The mandatory capability reference is an explicit
zero-score developer-test placeholder derived from the source release and plan—it is
not evidence of model uniqueness or production capability.

Archive the plan, approval envelope, prior-plan registry, compiled genesis, reported
genesis hash, and signed source release together. Do not describe this workflow as a
mainnet or production ceremony.
