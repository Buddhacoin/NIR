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

## Certificate-bound witness package v2

`blockchain/checkpoint-trust-package-v2.mjs` provides separate v2 creation and
verification functions. Its checkpoint view and each witness attestation add
`certificateHistoryHead` (the lowercase 64-character result of
`certificateHistoryHead()`) and `certificateRecordCount` (1–1024). Distinct v2
view, attestation, package, and equivocation domains prevent a v1 signature or
hash from being reused as v2. V1 functions remain strict v1 verifiers and do
not reinterpret existing packages.

A v2 verifier confirms that a witness quorum signed the exact certificate
head and count with the finalized checkpoint view. A consumer must separately
verify the complete quorum-approved certificate history, its external anchor,
and equality with both committed fields before treating that history as
authorized. The v2 package alone does not authenticate the history contents.
The certificate lifecycle is not committed into the chain's finalized state;
v2 provides a witness attestation associated with a finalized checkpoint,
not an on-chain inclusion proof. Witness operation and history freshness remain
independent trust requirements.

### Public-only v2 package CLI for a valueless rehearsal

`npm run checkpoint:package-v2` has `assemble` and `verify` commands. It does
not create witness keys or signatures. Assemble requires a threshold of
separately supplied, already signed v2 attestations. It recomputes the complete
certificate history head and count from the lifecycle store under an external
anchor, checks the pinned genesis and policy, verifies the finality proof and
witness quorum, and requires the proof's complete validator set to match the
genesis set or the verified handoff active at its checkpoint height. A
substitute signer quorum cannot supply its own validator topology. Assemble
writes a new mode-`0600` package without overwriting a
previous file. Verify repeats these checks against the current anchored
history. Inputs must be bounded canonical JSON with one trailing newline;
symlinks and group-writable public inputs are refused.

At a verified handoff's exact activation height, both commands fail closed.
The standalone v2 package proof cannot establish the handoff-pinned activation
block hash and state root together with the required old- and new-set finality
quorums. Use a checkpoint after the activation height for this rehearsal;
accepting the activation block itself needs a verified handoff-aware finality
chain proof.

The canonical operator context has exactly these fields:
`format: "nir-checkpoint-v2-operator-context-v1"`, `version: 1`,
`genesisPath`, `policyPath`, `certificateDirectory`,
`certificateHeadAnchorPath`, `expectedGenesisHash`, `expectedNetworkId`,
`expectedPolicyId`, and `maxWitnessAgeMs` (1–120000). Paths must be absolute.
The expected hashes and policy ID must be reviewed and retained outside the
context itself. The anchor must be outside the certificate state directory.
The proof file contains one exact v5 finality proof; the attestations file
contains a JSON array of signed v2 attestations for that proof, sequence, and
certificate commitment. For a fixed validator set rehearsal, a local read
node can export a proof in the `proofs` array from
`GET /v1/finality-proofs?fromHeight=<height-minus-one>&limit=1`; select that
one proof only after independently checking its height and finality.

```bash
npm run checkpoint:package-v2 -- assemble /absolute/context.json /absolute/finality-proof.json 9 /absolute/attestations.json /absolute/checkpoint-9.json
npm run checkpoint:package-v2 -- verify /absolute/context.json /absolute/checkpoint-9.json 1 9 <current-epoch-ms>
```

Witness signing and durable per-witness anti-equivocation custody are not yet
provided by this CLI. There is therefore no complete unattended operator
command sequence to refresh v2 packages. Test fixtures with multiple keys in
one process validate the format but do not establish independent witness
operators. Distinct operators must review the pinned genesis, policy, proof,
and certificate head independently and keep their vaults on separate hosts or
under separate custody before their signatures can support a deployment claim.

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
