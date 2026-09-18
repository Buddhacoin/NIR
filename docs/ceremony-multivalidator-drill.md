# Ceremony-mode multi-validator finality drill

The automated drill exercises the real validator HTTP/TLS/P2P transport without
creating or using a development coordinator:

```sh
node --test --test-concurrency=1 tests/ceremony-multivalidator-drill.test.mjs
```

It creates an ephemeral valueless developer-testnet ceremony and four operator
targets. Every target has a distinct encrypted finality vault, encrypted
transport vault, pair of vault passwords, TLS certificate, TLS private key, and
ceremony activation generation. Vault passwords enter each validator process
only through its inherited descriptors 3 and 4. Validator and transport private
keys are never written as plaintext files.

The drill then performs these checks through the network services:

1. Start four `serve-validator` processes and confirm that no plaintext
   `VALIDATOR-KEY.json`, `TRANSPORT-KEY.json`, or coordinator authorization file
   exists.
2. Submit a valid 2-of-3 treasury transfer through public ingress. The elected
   validator obtains authenticated P2P prepare votes and commit votes, assembles
   the finality certificate, and broadcasts the block to all peers.
3. Read the finalized block over an authenticated P2P range request and verify
   the responder's transport signature plus prepare/commit quorum sizes.
4. Reject an unknown transport signer, a valid old certificate replayed over a
   different height-2 proposal, and a proposal from a finalized stale height.
5. Stop a non-proposer, finalize another valid transfer with the remaining
   three-node quorum, restart the stopped validator, and invoke its public sync
   path. Its height and tip must match the quorum.
6. Restart that validator once more and prove that the caught-up finalized tip
   survived process restart.
7. Recursively scan every ceremony generation and all process arguments,
   environments, and logs for vault passwords or validator/transport private
   keys.

The same drill also confirms that initialization fails closed when supplied a
genesis or signed source release different from the ceremony commitment.

## Byzantine and partition extension

The drill's consensus-message scheduler operates against the same four live TLS
processes and authenticated P2P endpoints. It can withhold cross-partition
deliveries even though the local test machine still has TCP reachability. No
validator initiates consensus on its own; consequently the scheduler is the
complete consensus network for these phases.

The extended phases prove:

- a 2–2 split can collect only two prepares on either side, so both commit
  attempts fail quorum and every process remains at the prior finalized height;
- delayed and reordered proposal delivery plus a fresh-auth duplicate returns
  the same durable prepare vote rather than creating a second decision;
- after healing, three matching prepares and commits finalize only the already
  locked value;
- at the next height, a Byzantine proposer sends conflicting valid proposals to
  the 3-node and 1-node partitions and signs conflicting prepare votes; the
  minority's two prepares cannot form a certificate, while the majority creates
  exactly one finalized tip;
- the isolated validator retains its conflicting prepare lock across restart,
  but authenticated catch-up accepts the unique quorum-finalized block and ends
  on the majority tip. No conflicting finalized tip is produced.

`proveValidatorPrepareEquivocation` emits deterministic forensic evidence for
two conflicting same-height/same-round prepare signatures. Both proposals must
pass exact protocol-schema and state validation against the same verified
`NirChain` context; signed proposals with extra or malformed fields are rejected.
The evidence explicitly records `nativePenaltyAvailable: true`, but the native
transition is deliberately narrow: one proposal must be the exact current
finalized head, the other must be an exact-schema conflicting prepare for the
same parent/height/round, and the signer must still be active with a native bond.
The transaction is accepted only in the immediately following block. Genesis
ceremony validators have no implicit bond, so their evidence remains forensic
until they have registered a native validator bond.
The compact on-chain format and recovery/handoff boundary are specified in
`docs/validator-equivocation.md`.

This is a portable protocol and process-isolation drill. It does not claim that
four ephemeral local processes represent independent machines, operators, fault
domains, or production deployment readiness.
