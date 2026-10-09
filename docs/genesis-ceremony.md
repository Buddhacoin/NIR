# Public developer-testnet genesis ceremony

This tooling creates reproducible genesis material for a **valueless developer
testnet only**. It is not a mainnet ceremony, production-readiness claim, token
launch, custody service, or key generator.

This is gate 2 in the canonical
[public-testnet gate matrix](public-testnet-gates.md). Publication of the plan,
contributions, approvals, registry anchor, and compiled genesis is an external
operator responsibility.

For a new ceremony, use the **v5** public input schema: set
`"format": "nir-public-genesis-plan-v5"` and include a complete
`evaluationEnvironment` object. The exact environment schema is
`nir-evaluation-environment-v1`: `adapter_protocol`, `cpu_limit`, `image_digest`,
`memory_limit_bytes`, `runner_digest`, and `timeout_seconds` alongside `format`.
Both digests are `sha256:`-prefixed 64-character lowercase hex. The plan,
ceremony approvals, and genesis commit this same environment; v27 activation
requires its genesis commitment. Operators must review the actual runner/image
artifacts behind the digests independently. The other input is public JSON containing:

- network ID, genesis timestamp, current protocol version, and signed source-release
  manifest hash;
- `protocolUpgradeReleaseAnchor`, the canonical release-transparency anchor for
  the same network. It pins the log ID and initial threshold release-authority
  set that must authorize every protocol version from v29 onward;
- four or more disjoint validator, evaluator, and beacon public ML-DSA-65 identities,
  operator IDs, and HTTPS endpoints (loopback HTTP is allowed for local drills).
  Every validator also supplies a separate public transport identity and the required
  TLS certificate pin for HTTPS;
- `evaluatorBondAmount`, exactly the protocol bootstrap minimum for every listed
  evaluator. Compilation deducts the aggregate from the existing treasury
  allocation and commits the locked bonds in genesis, so this creates no supply;
- separate public `founder` and `treasury` descriptors. Each address must be
  the 2-of-3 multisignature derived from its own three member public keys.
  `founder` commits 7% of total supply with `vestingPolicy` fields
  `allocationBps: 700`, `immediateBps: 100`,
  `model: "genesis-release-plus-linear"`, and
  `durationMs: TREASURY_VESTING_MS`: 1% of total supply is spendable at
  genesis, the other 6% vests linearly. `treasury` commits 5% with
  `allocationBps: 500`, `immediateBps: 10`,
  `model: "genesis-release-plus-linear"`, and the same duration: 0.1% of
  total supply is available from genesis as a possible tester reserve, while 4.9%
  vests linearly. This is one treasury address; consensus does not restrict
  the liquid tranche to tester payments. They must be distinct from
  each other and from genesis operator addresses. Evaluator bootstrap bonds
  come from the 5% protocol treasury, never the founder allocation, and cannot
  consume the 0.1% genesis-liquid tranche;
- three or more public ceremony-operator identities, unique 256-bit contributions,
  and unique public nonces.

Every object has an exact schema. Unknown fields and fields named like private keys,
secrets, seeds, passwords, or mnemonics are rejected. The tool never generates an
address or private key. Contributions and nonces must be generated independently by
operators and must not be reused.

The v5 plan, ceremony approvals, peer-registry approvals and approval envelope
use separate versioned domains/formats, so signatures cannot be replayed from
v1/v2/v3/v4. Earlier plan formats retain their exact signed schedules. A real-value
founder address is **not** created by running this ceremony;
create and recover-test each guardian vault offline before inserting only its
public address and member keys into the plan. Two independent vault sets are
needed: one for the founder and one for the protocol treasury. Do not place
passwords, private keys, or complete backup sets in this repository.

The v1 plan and approval formats remain verifiable with their original hash and
signature domains, including in mixed-version registries and `prior-plans.json`.
They do **not** carry an evaluation environment: a chain already launched from a
v1 ceremony cannot add one to its genesis without changing chain identity, and
the current sequential upgrade rules cannot advance such a chain through v27 to
v28. v2 applies to **new** ceremonies only; it is not a migration mechanism.

## Workflow

Create the canonical plan and its domain-separated commitment:

```bash
npm run genesis:ceremony -- plan \
  public-input.json signed-release.json nir1TRUSTED_RELEASE_SIGNER genesis-plan.json
```

The signed release and independently configured trusted signer address are mandatory
at every plan, assemble, verify, and compile boundary. The post-quantum release
signature and manifest hash are reverified each time. The plan commits exact public
provenance—manifest hash, signer address, source revision, and strict
`major.minor.patch` release version—so another otherwise-valid release cannot be
substituted.
The upgrade anchor is part of the same canonical plan commitment and every ceremony
signature. Omitting it, changing its authority set or log, supplying a self-chosen
replacement during compilation, or using an anchor for another network is rejected.

Each listed ceremony operator reviews the same canonical plan and signs it offline
using an existing encrypted NIR vault:

```bash
npm run genesis:ceremony -- sign \
  genesis-plan.json signed-release.json nir1TRUSTED_RELEASE_SIGNER \
  operator-vault.json approval.json
```

Genesis validators separately sign the exact epoch-zero peer-registry payload in its
existing consensus domain:

```bash
npm run genesis:ceremony -- sign-peer-registry \
  genesis-plan.json signed-release.json nir1TRUSTED_RELEASE_SIGNER \
  validator-vault.json peer-registry-approval.json
```

For v2, each validator approval also includes a distinct v2-domain signature
over the plan commitment, network ID, and peer-registry commitment; a v1 registry
signature alone cannot authorize a v2 ceremony. The original registry signature
is still included separately because `NirChain` verifies it in the existing
consensus domain. This second quorum is necessary because `NirChain` already
requires peer-registry signatures from the consensus validator keys. The plan contains explicit
`validatorSetCommitment` and `peerRegistryCommitment` values; compilation checks both.

Collect approvals into an object with `approvals` and `peerRegistryApprovals` arrays,
assemble an envelope, and verify both greater-than-two-thirds quorums:

```bash
npm run genesis:ceremony -- assemble \
  genesis-plan.json signed-release.json nir1TRUSTED_RELEASE_SIGNER \
  approvals.json envelope.json
npm run genesis:ceremony -- verify \
  genesis-plan.json envelope.json signed-release.json \
  nir1TRUSTED_RELEASE_SIGNER prior-plans.json
```

`prior-plans.json` remains a portable optional JSON array. For durable local reuse
protection, append each accepted ceremony to the fsync-backed registry:

```bash
npm run genesis:ceremony -- registry-append \
  ceremony-registry genesis-plan.json envelope.json signed-release.json \
  nir1TRUSTED_RELEASE_SIGNER
npm run genesis:ceremony -- registry-verify \
  ceremony-registry nir1TRUSTED_RELEASE_SIGNER
```

The registry is an append-only hash chain stored in primary and backup copies. A
normal read fails closed if either copy is missing, invalid, rolled back, divergent,
or a symlink. The operator root is pinned with `O_DIRECTORY|O_NOFOLLOW` and its
descriptor identity is rechecked around lock, read, rename, and repair operations;
platforms without those flags are unsupported. It never silently chooses a copy.
After investigating an interrupted write, repair exactly one invalid or strict-prefix
copy under the exclusive writer lock:

```bash
npm run genesis:ceremony -- registry-repair-one-copy \
  ceremony-registry nir1TRUSTED_RELEASE_SIGNER
```

Conflicting valid histories are ambiguous and cannot be repaired by this command.
Registry append automatically rejects reused network IDs, plan commitments, and
operator contributions against every archived record.
Each record embeds the immutable signed release and exact public provenance. Registry
verification revalidates every release signature against the externally supplied
trusted signer, respects the combined store bound, and rejects a decreasing release
version as an older-release replay.

## External monotonic anchor

Two local copies and a hash chain cannot detect a coordinated rollback of both copies.
After each accepted append, export the exact latest-head payload:

```bash
npm run genesis:ceremony -- export-anchor-payload \
  ceremony-registry nir1TRUSTED_RELEASE_SIGNER anchor-payload.json
```

The payload contains exactly `registryHead`, `count`, `latestPlanCommitment`,
`latestGenesisHash`, and `releaseManifestHash`. Latest-plan ceremony operators sign
that payload offline in the separate anchor domain:

```bash
npm run genesis:ceremony -- sign-anchor \
  anchor-payload.json genesis-plan.json signed-release.json \
  nir1TRUSTED_RELEASE_SIGNER operator-vault.json anchor-approval.json
```

Collect approvals into a JSON array and require a unique greater-than-two-thirds
latest-operator quorum:

```bash
npm run genesis:ceremony -- assemble-anchor \
  anchor-payload.json genesis-plan.json signed-release.json \
  nir1TRUSTED_RELEASE_SIGNER anchor-approvals.json anchor.json
npm run genesis:ceremony -- verify-with-anchor \
  ceremony-registry nir1TRUSTED_RELEASE_SIGNER anchor.json
```

Store or publish `anchor.json` outside the node and outside the registry storage
failure domain. Supplying it as the optional final argument to `registry-append`,
`registry-verify`, or `registry-repair-one-copy` rejects a local history below the
anchored count/head or one whose hash chain does not contain the anchor as an exact
prefix. A newer local history is accepted only when it extends that anchor. Without
an independently retained anchor, coordinated rollback of both local copies remains
undetectable.

Compile only after verification:

```bash
npm run genesis:ceremony -- compile \
  genesis-plan.json envelope.json signed-release.json \
  nir1TRUSTED_RELEASE_SIGNER genesis.json prior-plans.json
```

Compilation emits the existing `NirChain` genesis configuration, including the
quorum-signed epoch-zero `peerRegistry`, exact evaluator-bond bootstrap, and the
exact `protocolUpgradeReleaseAnchor` approved by the ceremony,
constructs the chain twice through canonical
JSON, and requires the genesis block hash and validator/topology commitments to
round-trip exactly. Evaluator and beacon endpoints and ceremony entropy remain bound
by the public plan because the chain genesis schema has no fields for them. The
mandatory capability reference is an explicit
zero-score developer-test placeholder derived from the source release and plan—it is
not evidence of model uniqueness or production capability.

Archive the plan, approval envelope, prior-plan registry, compiled genesis, reported
genesis hash, and signed source release together. Do not describe this workflow as a
mainnet or production ceremony.
