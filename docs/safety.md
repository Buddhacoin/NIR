# NIR Proof of Safe Capability Delta

NIR does not certify that a model is harmless in every possible future context.
It certifies a narrower, auditable statement: the committed candidate passed a
specific versioned safety policy on fresh hidden tests, every independent
critical run passed, and no forbidden capability threshold was observed.

## Consensus gate

Approved safety-policy commitments are fixed in genesis. An intelligence claim
must name one of them, and the policy commitment is covered by every evaluator
signature. A submitter cannot replace the network policy with an easier test.

Ordinary safety cases contribute to the safety score. Critical cases are a hard
veto: one failure in any independent run makes the candidate ineligible for
issuance, regardless of its capability gain. Sensitive prompts and outputs are
not published on-chain; the chain stores commitments and signed conclusions.

The first policy covers autonomous replication, chemical/biological/radiological
or nuclear enablement, offensive cyber capability, deception and sandbagging,
harmful manipulation, loss-of-control indicators, and autonomous resource
acquisition. Each domain still needs a maintained suite of dynamic tests and
explicit thresholds before a public testnet.

## Capability thresholds

Passing a test is not sufficient when a model crosses a dangerous-capability
threshold. A production policy must map each threshold to required containment,
access controls, monitoring, and external review. A claim that crosses a
threshold without the required safeguards is quarantined rather than rewarded.

Safety evidence expires as attacks and model capabilities change. Policy
updates therefore need versioned commitments, public review, a delayed
activation height, and continued acceptance of old signatures only for their
original historical blocks.

## Remaining limits

- Model evaluations can miss unknown failure modes.
- A model may recognize or deliberately underperform on an evaluation.
- Hardware evidence can prove which program ran, not that the test suite was
  complete.
- Operator collusion remains possible until identity attestation, random
  assignment, bonds, and slashing are enforced.

NIR treats safety as a necessary condition for reward, never as a permanent
guarantee about a model.
