# Multi-host developer-testnet launch evidence

This tool collects a narrow, machine-verifiable launch package for a valueless
developer testnet. It does not launch services, inject faults, prove that two
operators are different people or organizations, or make a production-readiness
claim.

## Trust boundary

The plan fixes one network, genesis hash, signed-release checkpoint, finalized
height/tip/state root, validator-set and peer-registry commitments,
`recoveryStateCommitment`, drill-plan hash, expiry and unique run nonce. Its
topology contains exactly four validators, at least four beacon operators and at
least two archive operators. Every operator ID, evidence key and HTTPS origin is
unique. Plain HTTP is accepted only by an explicit verifier option for loopback
tests.

Each operator signs an exact host receipt. Validator receipts bind the common
finalized state. The three surviving validators bind a finality observation made
while the selected fourth validator was unavailable; the selected validator
binds different old/new process instance nonces and catch-up from the outage
height to the reviewed tip. Beacon receipts bind distinct shares for one
candidate/generation/round and the validator tip. Archive receipts bind a real
restore result, inventory root and restored tip/state.

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
process. Operators must retain service logs, consensus certificates, restore
artifacts and external timestamps for independent review.

## PASS contract

A package passes only when all of these hold:

- every configured operator supplied one valid, fresh receipt and one live
  challenge-bound response;
- all identities, keys and origins are unique and all evidence has the same
  network, genesis, release checkpoint, plan, run nonce and finalized state;
- three of four validators attest the same outage-height finality and the
  restarted validator attests catch-up to the reviewed finalized tip;
- more than two thirds of the configured beacon operators attest distinct
  shares for one exact beacon context;
- at least two archive operators attest distinct restore receipts for one exact
  inventory and restored tip/state;
- the caller supplies the expected run nonce and verifies before the plan
  expiry.

Missing live responses, declared-only JSON, duplicated identities, forged
signatures, mixed contexts, stale packages and evidence replayed under another
run nonce fail closed. `physicalIndependenceClaimed` is always `false`.

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
  launch-evidence.json EXPECTED_PLAN_HASH EXPECTED_RUN_NONCE NOW_MS
```

The expected plan hash and run nonce must arrive through an independently
reviewed channel; a package cannot nominate its own trust root. The optional
`--allow-insecure-localhost` final argument exists only for local tests. Public
multi-host evidence requires HTTPS origins. The CLI reads
single-link bounded files with `O_NOFOLLOW`; collection never writes output
until every signature, context and live response has verified.
