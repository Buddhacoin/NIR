# Adversarial developer-testnet partition drill

This tooling plans and validates evidence for a later **valueless developer-testnet**
fault drill. It never starts a node, binds a port, changes firewall/routing state,
injects a message, rotates a certificate, downloads an archive, or writes an
artifact. A plan or PASS validation is not a production-readiness statement.

This is gate 11 in the canonical
[public-testnet gate matrix](public-testnet-gates.md). Cryptographic evidence
authenticates observations; it cannot prove that a physical fault was injected
as described without external operator review.

## Deterministic plan

The planning directory contains exactly `preflight-report.json` and `topology.json`.
The preflight report must pass its exact schema and every preflight check. Topology
uses `nir-testnet-drill-topology-v1` and contains exactly four validators, at least
four beacons, at least two archives, one network/release-checkpoint binding, and one
bounded certificate-overlap descriptor. Every participant is a full public
ML-DSA-65 identity (`address`, `algorithm`, `operatorId`, `publicKey`). Addresses and
operator IDs must be globally unique across roles.

Run:

```text
node blockchain/testnet-partition-drill-cli.mjs plan PLAN_ROOT
```

The canonical signed-free plan deterministically defines seven scenarios:

1. one validator unavailable, remaining quorum finalizes, restarted validator catches up;
2. 2/2 partition, with observations from all four proving neither side finalized;
3. 3/1 partition, exactly the majority finalizes and the minority catches up after healing;
4. authenticated messages delayed, duplicated, reordered and replayed, followed by convergence;
5. beacon quorum outage is safe and randomness resumes after recovery;
6. a corrupt archive source is rejected and an independent source restores;
7. old/new certificate pins work only during the declared overlap, then the old pin is rejected
   while finality continues.

Each scenario fixes partitions, eligible quorum signers, mandatory observation IDs,
the responsible operators, expected outcome, and whether finalized quorum hashes are
required or forbidden. The plan binds the exact PASS report hash, network, release
checkpoint, topology hash and certificate overlap.

## Evidence produced by the real drill

The actual fault-injection harness is outside this tool. For each mandatory
observation it must retain an immutable external artifact (logs, packet schedule,
health sample or restored-state comparison), hash it, and have the responsible role
key sign the exact network, plan hash, scenario ID, observation ID, PASS/FAIL result,
timestamp and artifact hash in `TESTNET_DRILL_OBSERVATION_V1`.

Every claimed finality point carries height, block/state/validator-set hashes and
unique ML-DSA-65 validator signatures in `TESTNET_DRILL_QUORUM_HASH_V1`. Signatures
are checked against the topology and the scenario's eligible partition. At least
three of four validators are required. The 2/2 scenario and non-finality role drills
forbid quorum hashes entirely.

Use `signTestnetDrillObservation` and `signTestnetDrillQuorumHash` in the isolated
runner. Assemble the exact `nir-testnet-partition-drill-evidence-v1` envelope with
`createTestnetPartitionDrillEvidence`. Do not copy signatures between observations,
scenarios or plans: every contextual field is signed.

The verification directory contains exactly `drill-plan.json` and
`drill-evidence.json`:

```text
node blockchain/testnet-partition-drill-cli.mjs verify VERIFY_ROOT NOW_MS [MAX_AGE_MS]
```

Exit `0` is a complete PASS, `2` is a valid complete evidence package containing a
FAIL observation, and `1` is unsafe/invalid input. Verification rejects missing or
duplicate observations, wrong operators, forged/replayed/cross-plan signatures,
unknown scenarios, stale evidence, mixed network/release, conflicting quorum hashes,
ineligible/duplicate/below-threshold validator signatures and any finality claim for
the 2/2 split.

Both CLI modes require a non-group/world-writable exact directory, use bounded
`O_NOFOLLOW` descriptor reads, reject hard links/symlinks/unexpected files, and pin
root/file inode and metadata across reads. They emit canonical JSON to stdout only.

## What cryptographic PASS means

The plan and validation report are signed-free deterministic wrappers. The
underlying observations and quorum hashes are cryptographically authenticated by
the public role keys committed in topology. This prevents an unrelated party from
inventing operator observations or validator quorum votes and prevents reuse in
another network, plan or scenario.

Signatures do **not** prove that a cable was unplugged, a packet was delayed by the
declared amount, storage was physically corrupted, or operators are independent.
Those facts remain properties of the external drill procedure and its retained
artifacts. Reviewers must inspect each signed `evidenceHash` artifact, the fault
injection controls and timing source. This planner does not replace a supervised
multi-host run, independent timestamping, or production incident exercise.
