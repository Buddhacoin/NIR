# Public developer-testnet genesis ceremony

This tooling creates reproducible genesis material for a **valueless developer
testnet only**. It is not a mainnet ceremony, production-readiness claim, token
launch, custody service, or key generator.

The input is public JSON containing:

- network ID, genesis timestamp, current protocol version, and signed source-release
  manifest hash;
- four or more disjoint validator, evaluator, and beacon public ML-DSA-65 identities,
  operator IDs, and HTTPS endpoints (loopback HTTP is allowed for local drills).
  Every validator also supplies a separate public transport identity and the required
  TLS certificate pin for HTTPS;
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

Genesis validators separately sign the exact epoch-zero peer-registry payload in its
existing consensus domain:

```bash
npm run genesis:ceremony -- sign-peer-registry \
  genesis-plan.json validator-vault.json peer-registry-approval.json
```

This second quorum is necessary because `NirChain` already requires peer-registry
signatures from the consensus validator keys. The plan contains explicit
`validatorSetCommitment` and `peerRegistryCommitment` values; compilation checks both.

Collect approvals into an object with `approvals` and `peerRegistryApprovals` arrays,
assemble an envelope, and verify both greater-than-two-thirds quorums:

```bash
npm run genesis:ceremony -- assemble genesis-plan.json approvals.json envelope.json
npm run genesis:ceremony -- verify genesis-plan.json envelope.json prior-plans.json
```

`prior-plans.json` remains a portable optional JSON array. For durable local reuse
protection, append each accepted ceremony to the fsync-backed registry:

```bash
npm run genesis:ceremony -- registry-append \
  ceremony-registry genesis-plan.json envelope.json
npm run genesis:ceremony -- registry-verify ceremony-registry
```

The registry is an append-only hash chain stored in primary and backup copies. A
normal read fails closed if either copy is missing, invalid, rolled back, divergent,
or a symlink. The operator root is pinned with `O_DIRECTORY|O_NOFOLLOW` and its
descriptor identity is rechecked around lock, read, rename, and repair operations;
platforms without those flags are unsupported. It never silently chooses a copy.
After investigating an interrupted write, repair exactly one invalid or strict-prefix
copy under the exclusive writer lock:

```bash
npm run genesis:ceremony -- registry-repair-one-copy ceremony-registry
```

Conflicting valid histories are ambiguous and cannot be repaired by this command.
Registry append automatically rejects reused network IDs, plan commitments, and
operator contributions against every archived record.

Compile only after verification:

```bash
npm run genesis:ceremony -- compile \
  genesis-plan.json envelope.json genesis.json prior-plans.json
```

Compilation emits the existing `NirChain` genesis configuration, including the
quorum-signed epoch-zero `peerRegistry`, constructs the chain twice through canonical
JSON, and requires the genesis block hash and validator/topology commitments to
round-trip exactly. Evaluator and beacon endpoints and ceremony entropy remain bound
by the public plan because the chain genesis schema has no fields for them. The
mandatory capability reference is an explicit
zero-score developer-test placeholder derived from the source release and plan—it is
not evidence of model uniqueness or production capability.

Archive the plan, approval envelope, prior-plan registry, compiled genesis, reported
genesis hash, and signed source release together. Do not describe this workflow as a
mainnet or production ceremony.
