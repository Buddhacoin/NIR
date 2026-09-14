# NIR Protocol — Draft 0.1

## 1. Purpose

NIR turns independently verified improvements in machine intelligence into a
scarce digital bearer asset. The scarce resource is not computation itself but
the ability to convert computation and energy into reproducible capability.

The protocol has two separate planes:

1. **Money plane:** private, inexpensive, highly divisible peer-to-peer payments.
2. **Progress plane:** submission, challenge, evaluation, and reward of new AI
   capability.

Keeping these planes separate prevents ordinary AI usage or self-generated jobs
from minting currency.

## 2. Monetary constants

| Parameter | Draft value |
| --- | ---: |
| Maximum supply | 21,000,000 NIR |
| Atomic units per NIR | 100,000,000 |
| Intelligence-mining pool | 18,480,000 NIR (88%) |
| Builder/protocol treasury | 2,520,000 NIR (12%) |
| Initial epoch budget | 50 NIR |
| Halving interval | 210,000 epochs |

The treasury allocation is part of the fixed cap and must be time-locked. No
administrator may mint beyond the cap.

The builder/protocol treasury exists at genesis but is linearly spendable over
ten years according to bounded block time, with no cliff and no administrator
override. Intelligence-mining supply does not unlock with ordinary blocks or
elapsed time. The first accepted progress epoch has a 50 NIR budget; after each
210,000 rewarded epochs the budget is divided by two. Empty blocks neither mint
currency nor advance the reduction counter. Rewarded blocks must be separated
by at least ten minutes, so faster hardware or a fast block producer cannot
compress the entire issuance schedule into a short interval.

## 3. Proof of Intelligence Progress

A submission contains a content-addressed artifact, a frozen baseline, an
evaluation family, an energy report, and a bond. The artifact may be a model,
algorithm, training method, dataset transformation, architecture, or other
reproducible contribution.

After a commit/reveal deadline, randomly assigned evaluators test the artifact
against hidden and rotating tasks. Results enter a challenge window. A proof is
accepted only if enough independently selected verifiers reproduce it. The same
verifier set must run the frozen baseline and candidate so a deliberately weak
baseline cannot manufacture progress. Genesis v0.1 requires three distinct
verifier identities; production must additionally make those identities
Sybil-resistant and randomly assign them.

Each verifier signs an evaluation receipt containing the network, epoch,
benchmark commitment, artifact hashes, measured metrics, recipient, and derived
score. A block can issue NIR only when a finality quorum has signed the identical
receipt. Validators recompute the score; submitters cannot choose it.

One verifier key contributes at most one result for each artifact. Energy-based
scoring is eligible only when both baseline and candidate measurements are
attested. The artifact commitment must ultimately cover the model, inference
configuration, runtime, dependencies, and evaluator harness—not merely model
weights.

### Draft score

For an accepted proof `p`:

```text
quality(p) = positive_gain
             × generality
             × reproducibility
             × safety
             × novelty

efficiency(p) = clamp(baseline_energy / candidate_energy, 0.5, 2.0)

score(p) = quality(p) × efficiency(p)
```

An epoch has a fixed issuance budget. Accepted proofs split it proportionally:

```text
reward(p) = epoch_budget × score(p) / sum(score(all accepted proofs))
```

This prevents a submitter from choosing the number of minted coins. It also
means efficient algorithmic progress can beat brute-force expenditure.

### What the score does not claim

NIR does not claim that intelligence has a universal physical unit comparable
to a joule. The score is a protocol-defined accounting measure produced by a
published evaluation constitution. Different evaluation families must not be
silently combined without calibration.

The current evaluator uses exact-answer tasks to make the state transition
deterministic. It is not a universal intelligence test. A production family
needs its own frozen grader, minimum sample size, confidence threshold,
contamination probes, adversarial cases, and human review rules where automatic
grading is not reliable.

## 4. Required defenses

- **Benchmark secrecy:** hidden tasks are committed before submissions and
  revealed after the epoch.
- **Evaluator capture:** random selection, heterogeneous operators, bonds, and
  conflicting-result slashing.
- **Role capture:** evaluation and block-finality keys belong to disjoint
  operator registries; production admission must prove that those operators are
  independently controlled.
- **Duplicate work:** artifact and lineage fingerprints prevent repeated claims.
- **Benchmark gaming:** rotating task families and out-of-distribution tests.
- **Energy fraud:** signed hardware telemetry plus statistical and spot audits.
- **Safety regression:** a safety floor can reject a proof regardless of gain.
- **Critical danger:** one critical failure in any independent run vetoes
  issuance; only safety policies committed in genesis are valid.
- **Deliberate vulnerability farming:** a confirmed unsafe candidate receives
  no issuance; its bond funds a bounded bounty and at least 20 percent is burned,
  so a submitter/reporter/evaluator coalition cannot profit from its own defect.
- **Tiny-test farming:** minimum absolute gain and breadth thresholds.
- **Whale control:** asset ownership does not equal evaluator or governance
  control; selection must not be purely stake-weighted.
- **Quantum migration:** addresses and signatures need crypto-agility from
  genesis, with versioned post-quantum signature suites and migration paths.

The operator-security prototype requires two independently signed external
credentials for every operator, a minimum bond, deterministic committee
selection, and replay-protected evidence that can confiscate a bond when one
operator signs two incompatible statements for the same slot. Committee
randomness is safe only when it becomes available after the complete candidate
commitment is final. Consequently this component must not authorize issuance
until an on-chain commit/future-randomness/evaluate state machine is connected.

The local operator module now enforces this ordering as an admission state
machine: an artifact, baseline, suite, recipient, and epoch are committed first;
only randomness from a later epoch can assign the complete evaluator committee;
the assignment cannot be replaced, shortened, or duplicated. The remaining
network step is to derive that randomness from a distributed beacon or a
commit/reveal contribution from many operators and persist admissions in blocks.

Identical incorrect votes do not, by themselves, cryptographically prove
collusion. Penalizing coordinated fraud needs an objective fraud proof or an
explicit dispute process; a simple majority accusation is not sufficient.

## 5. World capability memory

NIR does not reward possession of knowledge already demonstrated by existing
models. Before issuance starts, reference models form a sealed, unrewarded
world-capability snapshot. For each evaluation family the ledger remembers the
best verified score, model lineage, artifact commitment, and behavioral-output
commitment.

A renamed model, a bot repeatedly calling an existing API, or a known model
compared with a deliberately weak baseline earns nothing because it does not
move the world frontier. A candidate is novel only for the measured marginal
delta above the previous best. Its challenge is derived after the complete
artifact is committed, so stored answers cannot be prepared for the exact test.
Every accepted change produces a new deterministic memory root.
That root is committed by genesis and every block, so all validators must apply
the same history before they can finalize another intelligence reward.

This defines two different things:

- **knowledge** is information or an answer that can be copied;
- **intelligence progress** is a reproducible increase in capability on fresh,
  procedurally generated tasks, including transfer to unseen variations.

The memory stores commitments and capability measurements, not private model
weights or the world's conversations.

## 6. Open research questions

Before any public testnet, the project must specify:

1. the first narrow evaluation family;
2. reproducible execution environments;
3. energy attestation hardware and audit rules;
4. evaluator selection without stake capture;
5. privacy architecture for payments and model submissions;
6. post-quantum signature and zero-knowledge proof choices;
7. treasury vesting, spending transparency, and founder allocation;
8. applicable securities, payments, sanctions, tax, and privacy law.

## 7. First realistic milestone

The first testnet should reward progress on one open, inexpensive benchmark
family. It should use valueless test units. Only after adversarial trials show
that duplicate submissions, evaluator collusion, energy falsification, and
benchmark overfitting are controlled should monetary deployment be considered.
