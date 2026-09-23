# Multi-host developer-testnet launch evidence

This tool collects a narrow, machine-verifiable launch package for a valueless
developer testnet. It does not launch services, inject faults, prove that two
operators are different people or organizations, or make a production-readiness
claim.

This package is gate 12 in the canonical
[public-testnet gate matrix](public-testnet-gates.md). PASS preserves signed
operator claims and authenticated service responses; it does not infer physical
independence from distinct names or endpoints.

## Trust boundary

The plan fixes one network, genesis hash, signed-release checkpoint, finalized
height/tip/state root, validator-set and peer-registry commitments,
`recoveryStateCommitment`, drill-plan hash, expiry and unique run nonce. Its
topology contains exactly four validators, at least four beacon operators and at
least two archive operators. Every operator ID, evidence key and HTTPS origin is
unique. Plain HTTP is accepted only by an explicit verifier option for loopback
tests.

Each operator signs an exact version-2 host receipt. Validator receipts bind the common
finalized state. The three surviving validators bind a finality observation made
while the selected fourth validator was unavailable; the selected validator
binds different old/new process instance nonces and catch-up from the outage
height to the reviewed tip. Beacon receipts embed the complete native beacon
share; verification checks its `FALLBACK_RANDOMNESS_SHARE` signature against
the configured beacon key, rather than trusting a declared share hash. Archive
receipts embed the normal signed remote-backup receipt and a separate signed
restore receipt binding that exact backup receipt, inventory, drill plan and
restored tip/state.

A receipt by itself cannot pass. During collection the tool generates a fresh
challenge and sends it to every configured origin at
`POST /v1/launch-evidence`. The service must return a response signed by the
same configured operator evidence key over the challenge, exact receipt hash,
plan, run nonce, role, origin and response time. The collector bounds response
size and time and refuses redirects. An offline verifier later checks every
receipt and fetched response without contacting the services.

The endpoint proves that the configured origin currently controls the evidence
key and endorses the exact receipt. Its claims remain operator attestations. It
does not prove physical fault injection, organizational independence, hosting
diversity, honest clocks, or that a sidecar shares a failure domain with the NIR
process. Several DNS names, IP addresses and keys can still be controlled by one
process or organization; endpoint uniqueness cannot prove otherwise. Operators must retain service logs, consensus certificates, restore
artifacts and external timestamps for independent review.

## Operator endpoint

`createLaunchEvidenceSidecar()` provides the narrow endpoint implementation for
an operator. It accepts only `POST /v1/launch-evidence`, only an exact challenge
for one configured plan and host receipt, and signs using the receipt's already
configured evidence key. It has bounded ingress and does not expose a wallet,
receipt mutation API, metrics with secrets, or a general signing API. Place it
behind the operator's existing TLS reverse proxy at the exact public origin in
the plan; keep its local listener private. The sidecar proves key control for
the configured receipt, not physical co-location with the validator, beacon or
archive process.

Start it with the operator CLI. `PLAN` and `RECEIPT` must be canonical JSON,
single-link files that are not writable by group or others. `VAULT` must be a
single-link, owner-only `0600` encrypted vault. The secret itself is never an
argument or environment value: the environment contains only the number of an
already inherited restricted file descriptor. The listener is deliberately
fixed to `127.0.0.1`; the operator's existing HTTPS proxy is responsible for
the public origin in the plan.

```sh
NIR_LAUNCH_EVIDENCE_PASSWORD_FD=3 \
  node blockchain/launch-evidence-sidecar-cli.mjs \
  plan.json host-receipt.json operator-vault.json 8797 3< /secure/password-fd
```

The password descriptor is consumed and closed at startup, and the CLI clears
its in-memory password buffer immediately after decrypting the vault. The
optional `--allow-insecure-localhost` mode exists solely for local fixtures;
never use it for a public operator. The endpoint has no general signing route:
it will answer only challenges bound to that one plan and receipt.

## PASS contract

A package passes only when all of these hold:

- every configured operator supplied one valid, fresh receipt and one live
  challenge-bound response;
- all identities, keys and origins are unique and all evidence has the same
  network, genesis, release checkpoint, plan, run nonce and finalized state;
- three of four validators attest the same outage-height finality and the
  restarted validator attests catch-up to the reviewed finalized tip;
- more than two thirds of the configured beacon operators provide distinct,
  cryptographically valid native shares for one exact beacon context;
- at least two archive operators provide valid signed backup receipts and
  distinct signed restore receipts for one exact inventory and restored tip/state;
- the caller supplies the independently retained plan hash, one-use run nonce
  and collector challenge; host observations and the final package are within
  the strict 15-minute default freshness window.

Missing live responses, declared-only JSON, duplicated identities, noncanonical
key/signature encodings, forged native shares or restore receipts, mixed
contexts, stale packages and evidence replayed under another run or challenge
fail closed. Compressed responses are forbidden and uncompressed bodies are
streamed into a fixed bounded buffer. The result status is
`EVIDENCE-CONSISTENCY-PASS`, never a production or physical-independence PASS;
`physicalIndependenceClaimed` is always `false`.

## CLI

Prepare the signed plan and host receipts through the operator ceremony, then
collect them while every evidence endpoint is reachable:

```sh
node blockchain/multi-host-launch-evidence-cli.mjs collect \
  plan.json host-receipts.json launch-evidence.json
```

The output path must not exist. Verify the canonical package offline with the
run nonce obtained through the independently reviewed launch plan:

```sh
node blockchain/multi-host-launch-evidence-cli.mjs verify \
  launch-evidence.json EXPECTED_PLAN_HASH EXPECTED_RUN_NONCE \
  EXPECTED_CHALLENGE_NONCE NOW_MS
```

The expected plan hash, run nonce and challenge must arrive through an independently
reviewed channel; a package cannot nominate its own trust root. After a PASS,
the caller must atomically retain `runConsumptionHash` outside the collected
package and never accept that run nonce again. Offline code cannot detect a
rollback of every local copy of that consumed-run state; an external monotonic
anchor remains necessary. `NOW_MS` is likewise a trusted observation: a rolled
back operator clock can make stale evidence appear fresh. The optional
`--allow-insecure-localhost` final argument exists only for local tests. Public
multi-host evidence requires HTTPS origins. The CLI reads
single-link bounded files with `O_NOFOLLOW`; collection never writes output
until every signature, context and live response has verified.
