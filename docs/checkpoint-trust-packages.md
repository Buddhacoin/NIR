# Offline-verifiable checkpoint trust packages

Protocol v28 makes a recent finality checkpoint cheap to verify, but a bare
checkpoint still requires the operator to trust both its hash and its validator
set. `blockchain/checkpoint-trust-package.mjs` narrows that trust input to one
small, independently distributed witness-policy ID.

## Trust model

`nir-checkpoint-witness-policy-v1` binds a network ID, the exact genesis block
hash, a policy generation, a greater-than-two-thirds M-of-N threshold, and
sorted ML-DSA-65 witness identities. Its `policyId` commits to every field. The verifier must pin this ID
outside the package; accepting the policy embedded in an untrusted package
without comparing its ID would permit a self-signed replacement.

The software enforces distinct operator IDs, addresses, and public keys. This
prevents duplicate identities inside one policy, but it cannot prove that the
organizations controlling those keys are economically or operationally
independent. Deployment must place witness keys with separate operators and
distribute the pinned policy ID through more than one channel.

Each witness signs one exact checkpoint view:

- network ID and chain-identity genesis hash;
- checkpoint height, block hash, and state root;
- validator-set ID and the hash of the complete v5 finality proof;
- witness-policy ID, monotonic package sequence, operator identity, and
  observation time.

The assembled `nir-checkpoint-trust-package-v1` contains the v5 proof, complete
validator identities, the policy, and a threshold of attestations. Offline
verification first validates the pinned policy scope, then the validator prepare
and commit quorums, then the exact witness quorum, and finally the package hash.
An arbitrary validator set, a different network or genesis, a mixed view, an
unknown field, a duplicate witness, or a changed signature fails closed.

## Replay and equivocation

Every verifier supplies both `minimumSequence` and `minimumCheckpointHeight`.
Those floors must come from its durable local trust state and advance only after
successful verification. A package below either floor is rejected. An optional
`now`, `maxAgeMs`, and `maxFutureSkewMs` policy also bounds witness observation
times, but wall-clock checks do not replace the durable monotonic floors.

Two valid attestations by one witness for different checkpoint views at the
same policy and sequence form canonical
`nir-checkpoint-witness-equivocation-v1` evidence. The evidence retains both
post-quantum signatures and can be checked offline. Detection supplies portable
proof; governance, removal, or slashing remains a separate policy decision.

## Canonical transport

`serializeCheckpointTrustPackage()` emits strict canonical JSON followed by one
newline. `parseAndVerifyCheckpointTrustPackage()` requires valid UTF-8, that
exact encoding, and a maximum package size of 4 MiB before cryptographic
verification. Counts for witnesses, validators, votes, keys, and signatures are
bounded independently. This prevents duplicate-key JSON, alternate encodings,
schema extension, and unbounded parser input from becoming signature ambiguity.

Minimal verification requires explicit trust inputs:

```js
const verified = parseAndVerifyCheckpointTrustPackage(bytes, {
  expectedChainIdentityGenesisHash,
  expectedNetworkId,
  expectedPolicyId,
  minimumCheckpointHeight: localTrust.height,
  minimumSequence: localTrust.sequence,
});
```

On success, `verified.checkpoint` and `verified.trustedValidators` can seed the
bounded v28 suffix verifier. The production persistence API and bounded CLI are
documented in [`checkpoint-trust-store.md`](checkpoint-trust-store.md). They
verify before writing, atomically retain redundant hash-linked copies, and use
the accepted height and sequence as the next package's anti-replay floors.

## Residual boundary

This package removes the need to trust a checkpoint and validator list obtained
from one server. It does not create independence by itself, guarantee witness
availability, or survive compromise of the configured witness threshold. A
production deployment still needs separately controlled witness services,
out-of-band policy-ID distribution, a hardware or external monotonic anchor for
the whole-filesystem rollback threat, and external audit.
