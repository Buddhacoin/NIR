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
npm run genesis:ceremony -- plan \
  public-input.json signed-release.json nir1TRUSTED_RELEASE_SIGNER genesis-plan.json
```

The signed release and independently configured trusted signer address are mandatory
at every plan, assemble, verify, and compile boundary. The post-quantum release
signature and manifest hash are reverified each time. The plan commits exact public
provenance—manifest hash, signer address, source revision, and strict
`major.minor.patch` release version—so another otherwise-valid release cannot be
substituted.

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

This second quorum is necessary because `NirChain` already requires peer-registry
signatures from the consensus validator keys. The plan contains explicit
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
