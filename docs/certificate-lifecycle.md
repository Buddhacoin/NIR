# Network certificate lifecycle

NIR validator endpoints use TLS 1.3 and certificate fingerprints authenticated by the
validator quorum. This lifecycle is intended for a future public test network. It does
not depend on a public certificate authority, and it does not by itself prove that the
operators or machines are independent.

Private keys and certificate files remain outside the repository and outside the
lifecycle store. The protocol stores only a normalized certificate serial number, a
SHA-256 fingerprint, activation heights, topology commitments and quorum approvals.

## Safety model

Every certificate operation is a versioned `nir-network-certificate-v1` record. A
record binds all of the following into the validators' signatures:

- network and validator address;
- monotonically increasing per-validator sequence;
- previous record hash;
- current peer-registry and validator-topology-history commitments;
- operation (`issue`, `renew`, or `revoke`);
- activation height and, for renewal, a bounded overlap end height;
- new certificate serial and fingerprint when applicable.

At least two thirds plus one of the validators in the bound topology must approve the
record. A record with a forged signature, minority approval, stale activation,
unexpected topology commitment, reused serial, reused fingerprint, repeated sequence,
or broken lineage is rejected. A revoked endpoint resolves to no trusted pins and must
not be contacted.

Certificate renewal permits at most two pins: the new certificate and its immediate
predecessor. Both are accepted from the activation height through the declared overlap
height. Only the new fingerprint is accepted afterward. The overlap is measured in
finalized block heights, so local clock disagreement cannot extend it.

## Operator files

The operator CLI consumes a bounded JSON context exported from an authenticated,
synchronized node:

```json
{
  "networkId": "nir-public-test",
  "currentHeight": 12000,
  "minimumActivationDelay": 20,
  "peerRegistryHash": "<64 lowercase hex characters>",
  "topologyHistoryHash": "<64 lowercase hex characters>",
  "validators": [
    { "address": "nir1...", "algorithm": "ML-DSA-65", "publicKey": "..." }
  ]
}
```

When the validator set has changed, `validatorSetsByTopologyHash` may additionally map
historical topology commitments to their authenticated public validator sets. This
allows old records to remain verifiable after rotation. The file must come from node
state; typing arbitrary hashes into it does not create a valid network authorization.

An issue or renewal request contains no private material:

```json
{
  "operation": "renew",
  "validatorAddress": "nir1...",
  "activationHeight": 12020,
  "overlapUntilHeight": 12040,
  "certificate": {
    "serial": "2a91",
    "sha256": "<64 lowercase hex characters>"
  }
}
```

Serials are normalized lowercase hexadecimal without leading zeroes. Fingerprints are
lowercase hexadecimal SHA-256 values.

## Plan, authorize and apply

Create an unsigned deterministic plan:

```sh
npm run certificate:lifecycle -- plan context.json ./node-state request.json > plan.json
```

Validators inspect the certificate possession and endpoint checks, then sign the exact
plan payload using the `NETWORK_CERTIFICATE_APPROVAL` domain. Their distinct approvals
are added to the `approvals` array without changing `recordHash`. No certificate private
key is passed to this command.

Apply the quorum-approved record:

```sh
npm run certificate:lifecycle -- apply context.json ./node-state signed-plan.json
```

The command re-verifies the complete lineage, quorum, current topology binding and
activation delay before using crash-safe writes for both primary and backup copies.
After a restart, the longest valid common lineage is loaded. One damaged or interrupted
copy is repaired from the other; conflicting authenticated histories stop startup.

Inspect active fingerprints at the current or a specified height:

```sh
npm run certificate:lifecycle -- status context.json ./node-state
npm run certificate:lifecycle -- status context.json ./node-state 12030
```

Create a revocation plan, then collect approvals and apply it in the same way:

```sh
npm run certificate:lifecycle -- revoke context.json ./node-state revoke-request.json > revoke-plan.json
npm run certificate:lifecycle -- apply context.json ./node-state signed-revoke-plan.json
```

The revocation request needs only `validatorAddress` and `activationHeight`. Revocation
has no grace overlap. Emergency response therefore uses the shortest activation delay
permitted by the finalized network policy.

## Client behavior

Network clients pass the exact active fingerprint set to the HTTP client. A lifecycle
lookup that returns an empty set means “do not connect”; the client rejects empty,
malformed, duplicated, or oversized pin sets. During renewal it accepts either of the
two authenticated fingerprints, and after overlap it fails closed on the predecessor.
TLS certificate validity dates are checked in addition to fingerprint matching.

Before a public test network, operators still need isolated key generation, documented
certificate issuance procedures, independent deployment on real hosts, monitoring,
incident drills, and external review. Local processes are useful for testing but must
not be described as independent operators.
