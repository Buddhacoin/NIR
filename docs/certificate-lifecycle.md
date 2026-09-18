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
npm run certificate:lifecycle -- plan context.json ./node-state/certificates request.json > plan.json
```

Validators inspect the certificate possession and endpoint checks, then sign the exact
plan payload using the `NETWORK_CERTIFICATE_APPROVAL` domain. Their distinct approvals
are added to the `approvals` array without changing `recordHash`. No certificate private
key is passed to this command.

Apply the quorum-approved record:

```sh
npm run certificate:lifecycle -- apply context.json ./node-state/certificates signed-plan.json
```

The command re-verifies the complete lineage, quorum, current topology binding and
activation delay before using crash-safe writes for both primary and backup copies.
After a restart, the longest valid common lineage is loaded. One damaged or interrupted
copy is repaired from the other; conflicting authenticated histories stop startup.

Inspect active fingerprints at the current or a specified height:

```sh
npm run certificate:lifecycle -- status context.json ./node-state/certificates
npm run certificate:lifecycle -- status context.json ./node-state/certificates 12030
```

Create a revocation plan, then collect approvals and apply it in the same way:

```sh
npm run certificate:lifecycle -- revoke context.json ./node-state/certificates revoke-request.json > revoke-plan.json
npm run certificate:lifecycle -- apply context.json ./node-state/certificates signed-revoke-plan.json
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

## Runtime modes

Validator and coordinator processes have two explicit transport-certificate modes:

- `dev-genesis` is the default compatibility mode for local development. It uses
  the static pin in the finalized peer registry exactly as older devnets did.
- `lifecycle` is required for a public testnet or production-like rehearsal. Set
  `NIR_CERTIFICATE_MODE=lifecycle` before starting every validator and the
  coordinator. Each node loads its own verified redundant store from
  `<node-directory>/certificates` and derives validator sets from the verified
  handoff/topology history rooted in genesis.

Lifecycle mode resolves pins again on every outbound coordinator or validator
request at the node's current finalized height. A renewal therefore accepts the
old and new pins only through the signed overlap height and drops the predecessor
immediately afterward. A revocation, missing store, corrupt/conflicting copies,
unknown topology commitment, or validator with no active record stops the
request. Lifecycle mode never falls back to a genesis pin.

At validator startup the configured server certificate must be one of that
validator's lifecycle pins at the current height. Restart re-verifies the store,
repairs one damaged redundant copy, and retains the same height-based decision.

Lifecycle validators also expose the bounded `/v1/p2p/certificates/history` endpoint
only through the validator-authenticated transport. During synchronization a node
verifies every returned record from the genesis-rooted validator/topology history,
associates each response with its authenticated validator identity, and accepts only
the unique longest head reported by at least two thirds plus one of the active
validators. A forged response is not counted. A split without quorum, a quorum head
that conflicts with the local verified prefix, a duplicated source, or two conflicting
quorum histories fails closed.

The selected history is installed with crash-safe primary and backup writes. A shorter
history is treated as a stale prefix and can never roll back the local store. This
propagation is deliberately bounded and transports only public certificate records;
it does not issue certificates, copy TLS private keys, switch the server key, or replace
an external CA/operator procedure. Ordinary node requests still require active lifecycle
pins and never fall back to genesis pins.

## One-time migration bootstrap

A validator whose lifecycle store has never existed can explicitly migrate from the
consensus peer-registry pins. Stop that validator, confirm the genesis/consensus state
and the expected peer URLs out of band, then run:

```sh
npm run certificate:bootstrap -- ./network/validators/validator-0 \
  https://validator-0.example https://validator-1.example \
  https://validator-2.example https://validator-3.example
```

This is a dedicated operator action, not an automatic request fallback. It uses only
the TLS fingerprints committed by the node's consensus state, signs each history
request with the validator transport identity, verifies every peer response against
its authenticated transport identity, and installs only one fully verified history
head reported by a validator quorum. Plain HTTP, missing consensus pins, forged
records, a 2/2 split, or a wrong genesis certificate cannot create a store.

Successful migration writes both redundant history copies and the durable
`CERTIFICATE-LIFECYCLE-BOOTSTRAPPED.json` receipt. The existence of either store copy
or that receipt permanently disables the bootstrap path. Thus an interrupted primary
write is repaired from the verified backup on restart, while deleting or rolling back
the lifecycle store fails closed instead of re-enabling genesis pins. Preserve the
receipt with node state and backups; local deletion of both the store and receipt is
outside the protocol's ability to detect without external monotonic storage.

## Live server-certificate rotation

A lifecycle validator started with `NIR_TLS_CERT_PATH` and `NIR_TLS_KEY_PATH` handles
`SIGHUP` as an explicit local reload request. It opens both regular files without
following symlinks, binds every read to the opened descriptor, verifies the certificate
validity period and matching private key, and resolves the validator's own active pins
from the verified lifecycle history at the current finalized height. Only then does it
atomically replace the HTTPS secure context. New connections see the new certificate;
existing connections are not rewritten.

During a signed renewal overlap, operators can deploy the new cert/key files and send
`SIGHUP` after the activation height. An inactive fingerprint, revocation, wrong key,
unsafe file, corrupt lifecycle state, or secure-context error is logged as an explicit
reload failure and leaves the previous server context in service. This control is not
installed in `dev-genesis` mode and does not add automatic certificate fallback.

Before a public test network, operators still need isolated key generation, documented
certificate issuance procedures, independent deployment on real hosts, monitoring,
incident drills, and external review. Local processes are useful for testing but must
not be described as independent operators.
