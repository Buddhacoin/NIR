# External-evidence developer-testnet production preflight

`evaluateDeveloperTestnetProductionPreflight` is the offline policy layer between the existing
developer-only public preflight and a later production-shaped launch review. It does not replace or
silently upgrade `runDeveloperTestnetPreflight`: the existing report remains backward-compatible and
its PASS still means developer readiness only.

The evaluator accepts already descriptor-verified inputs so filesystem/CLI integration can remain a
separate atomic layer:

- one exact PASS `nir-developer-testnet-preflight-report-v1`;
- its exact deterministic partition-drill plan;
- the separately trusted rehearsal attestor set;
- the portable M-of-N rehearsal preflight input;
- a canonical cryptographically verified durable-store transcript;
- independently derived genesis hash, signed source-release manifest hash, and finalized tip;
- an explicit current time and bounded future-skew policy.

`EXTERNAL-EVIDENCE-PASS` requires all five checks to pass. The plan must name the exact developer
report hash. The operator signatures must be fresh and agree on one run. Signed network, genesis,
release checkpoint, source manifest, finalized tip and drill-plan hash must match their independent
inputs. The accepted package must be the last package in the store transcript.

The transcript contains every canonical record envelope, its complete `previousRecordHash` chain, a
cryptographic head with count/checksum, and a transcript commitment. Verification recomputes every
record hash and rejects fabricated tails, truncation, reordering, mutation and rollback. A local
exporter must first load the on-disk store, which separately verifies both fsynced head copies,
filesystem identity and the append-only files.

Missing, stale, future, mixed, replayed, equivocated or rolled-back evidence produces fixed-name FAIL
checks. The report embeds the public operator set, signatures, plan, developer report and store
transcript so an offline verifier can recompute every check; it contains no filesystem paths,
exception text, private keys or secret material. The wrapper report itself is signed-free and
independently reproducible; authority comes from the embedded separately verified operator package,
not from the wrapper hash.

This layer still cannot infer physical or organizational independence. The portable input keeps
`physicalIndependenceClaimed: false`; external signatures prove only that the configured keys signed
the exact evidence and context. This remains scoped to a valueless public developer testnet and is
not a mainnet-readiness statement.
