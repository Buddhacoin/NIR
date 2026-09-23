# Public developer-testnet preflight

This is a read-only, machine-verifiable preflight for a **valueless developer
testnet**. It does not deploy or start anything, reserve ports, generate keys,
change files, claim host independence, or establish production readiness.

## Artifact root

Create a private-to-the-operator directory (not group/world writable) containing
`preflight.json` and the public artifacts named by it. Every referenced name is a
single canonical filename: absolute paths, subdirectories, `..`, symlinks, hard
links, changing files and a replaced artifact root fail closed. Reads use
`O_NOFOLLOW`, bounded descriptors, inode/metadata consistency checks and a pinned
root directory descriptor.

`preflight.json` has exact top-level fields:

- `format: "nir-developer-testnet-preflight-v1"`, `version: 1`, and the expected
  developer `networkId`;
- `release`: the independently reviewed transparency anchor hash, offline bundle
  hash, exact checkpoint hash, external witness-set ID, genesis source manifest
  hash, and trusted source-release signer address;
- `artifacts`: filenames for the offline release bundle, transparency anchor and
  checkpoint, witness set and receipts, signed genesis source release, ceremony
  plan/envelope, compiled genesis and latest restore-drill result;
- `archiveOperators`: public, independent archive operator identities and HTTPS endpoints;
- `bondedValidators`: public validator addresses and decimal atomic bond values
  exported from the reviewed finalized readiness state;
- `host`: one exact public observation time, clock offset, free bytes, file
  descriptor limit, exact per-endpoint port observations, SHA-256 TLS-pin inventory,
  and validator/beacon/evaluator/archive ingress profiles;
- `policy`: maximum clock skew and artifact ages plus minimum disk/FD capacity;
- `operatorRoots`: direct public operator configuration files to scan. Nested or
  secret-bearing paths are intentionally unsupported.

The release check revalidates the complete offline bundle and exact transparency
checkpoint, then requires that checkpoint to name that bundle on the expected
network. The external-witness check verifies every post-quantum witness receipt,
freshness, uniqueness, and a single threshold view of the same checkpoint. A
missing or split external witness quorum fails.

The genesis check revalidates the trusted signed source release, ceremony and
peer-registry quorums, recompiles genesis through `NirChain`, and requires exact
canonical equality with the supplied genesis. It checks disjoint validator,
transport, evaluator, beacon and archive public keys/addresses/operators, TLS pins
through the ceremony schema, and the explicit minimum validator bonds. Launch preflight is stricter
than local ceremony drills: every validator, beacon, evaluator and archive endpoint must be HTTPS,
must have one nonempty 64-hex SHA-256 pin observation, and must map to one unique observed-available
host/port. Validator observations must exactly equal the TLS pins committed by genesis; a null pin
never passes.

The restore marker must use the exact `nir-backup-restore-drill-v1` schema, match
the network, contain no private keys, name at least two distinct sources, and be
fresh at `host.observedAt`. Host readiness requires unique observed-free
non-privileged ports, safe bounded ingress profiles, clock offset, free disk and
FD limits within policy. Public operator files are scanned for secret filenames,
PEM private keys and plaintext secret JSON fields.

## Runbook

1. Independently review the release signer, bundle hash, witness policy, network
   ID and source-release manifest hash. Never take these expectations from the
   same untrusted download being checked.
2. Stop any workflow that could rewrite the artifact root. Export the latest
   finalized bond view, fresh backup/restore drill result, and read-only host
   observations. Port `available: true` is an observation, not a reservation;
   recheck at launch because another process can win the later bind race.
3. Place only public artifacts in the root. Encrypted vaults are still excluded:
   this public package is intended for publication and review.
4. Run:

   ```text
   node blockchain/developer-testnet-preflight-cli.mjs <artifact-root>
   ```

   Exit code `0` means every check is `PASS`, `2` means a valid report contains at
   least one `FAIL`, and `1` means the root or input could not be read safely.
5. Publish the canonical one-line report with the reviewed public artifacts. A
   verifier can recompute `reportHash` with the
   `DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1` domain and validate the exact report
   schema using `validateDeveloperTestnetPreflightReport`.
6. Do not launch if any check fails. Resolve the named check, create a fresh host
   observation and rerun the entire preflight. Never edit a report.

## Trust boundary and remaining risk

The report is deliberately signed-free. It proves deterministic consistency of
the supplied public material; it does not authenticate who measured remote host
capacity, bond state or port availability. Those observations must be exported
from independently reviewed operator/finalized-state procedures and distributed
with their original evidence. Clock, disk, FD and port state can change after the
observation. The tool does not probe remote machines, bind sockets, contact peers,
launch services, or provide DDoS/TLS deployment assurance. A PASS is permission to
perform a separate developer-testnet launch review—not a production or mainnet
readiness statement.

## Explicit external-evidence mode

The legacy one-argument command and report remain unchanged and developer-only. Production-shaped
review is an explicit separate mode:

```text
node blockchain/developer-testnet-preflight-cli.mjs production \
  ARTIFACT_ROOT DRILL_PLAN.json ATTESTATION_INPUT.json TRUSTED_ATTESTOR_SET.json \
  ATTESTATION_STORE NOW_MS [MAX_FUTURE_SKEW_MS]
```

The developer artifacts are evaluated once under the same pinned root descriptor. That pass derives
the compiled genesis hash, trusted signed source-manifest hash and finalized backup/restore tip
without changing the legacy report schema. Plan, attestation input and trusted set are separate
canonical public files read with bounded `O_NOFOLLOW`, single-link and inode/metadata checks. The
store loader verifies its private root, both durable heads and every append-only record before
exporting the independently verifiable transcript embedded in the report.

`EXTERNAL-EVIDENCE-PASS` additionally requires the plan to name the exact developer report, a fresh
M-of-N operator package, the package to be the durable store head, and exact agreement on network,
genesis, source release, witnessed checkpoint, finalized tip and plan hash. Missing, symlinked,
changed, stale, replayed, rolled-back, equivocated or mixed external evidence produces fixed-name
FAIL checks and exit `2`; unsafe base-root/invocation failures exit `1`. Production output and errors
do not expose filesystem paths, internal exception text or private keys.

The report embeds all public signatures, identities and hash-chain evidence so offline validation can
recompute every check. `physicalIndependenceClaimed` remains false: cryptographic operator agreement
does not itself prove separate hosts or organizations, and this remains a valueless developer-testnet
review rather than a mainnet-readiness claim.
