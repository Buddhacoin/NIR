# Canonical public developer-testnet gate matrix

This is the operator-facing source of truth for a public, valueless and
resettable NIR developer testnet. A green row means that the named evidence can
be verified; it does not authorize custody, sale, an incentivized network, or a
production-readiness claim. Gates are completed in order. A later gate never
waives an earlier machine check or external criterion.

| Gate | Command | Artifact | Machine-verifiable evidence | External manual criterion |
| --- | --- | --- | --- | --- |
| 0. Scope freeze | No command; publish the reviewed statement | Valueless-testnet scope, reset policy and incident contacts | Exact network ID and policy hashes are referenced by every later plan | Operators agree that units have no represented value and destructive reset remains a separate manual process |
| 1. Source and release | `npm run release:create`, `npm run release:sign`, `npm run release:verify`, `npm run release:bundle-create`, `npm run release:bundle-sign`, `npm run release:bundle-verify`, `npm run release:witness` | Signed source manifest, deterministic release bundle, transparency checkpoint and witness receipts | File hashes, source revision, threshold signatures, checkpoint inclusion/consistency and external witness quorum verify offline | Release authorities and witnesses are controlled through separately reviewed channels |
| 2. Public genesis ceremony | `npm run genesis:ceremony -- plan`, `sign`, `assemble`, `compile`, then registry `verify` | Ceremony plan/envelope, compiled genesis, signed source release and external registry anchor | Exact schema, operator quorum, contributions, peer registry, release provenance and round-trip genesis hash verify | Every operator compares the same commitment and retains the anchor outside the future node |
| 3. Roles and keys | `node blockchain/developer-testnet-preflight-cli.mjs ARTIFACT_ROOT` | Public role registry and developer preflight report | Unique operator IDs, finality/transport/beacon/evaluator/archive keys, HTTPS endpoints, TLS pins and validator bonds are checked | Named operators disclose common control, hosting, jurisdiction and conflicts; key uniqueness alone is not independence |
| 4. Validator onboarding | `npm run validator:ceremony -- init-from-ceremony ...`, then `reverify` | One encrypted finality vault, one encrypted transport vault and one immutable operator generation per validator | Genesis, release, anchor, identities, endpoint, TLS pin, modes and local key possession reverify without plaintext keys | Each operator provisions and backs up only its own secrets and TLS private key |
| 5. Certificate lifecycle | `npm run certificate:lifecycle -- plan/apply/status`, `npm run certificate:bootstrap -- ...` | Quorum-approved issue/renew/revoke history and one-time bootstrap receipt | Genesis/topology trust, quorum, sequence, overlap, revocation, active pin and rollback protection verify at finalized height | Operators review certificate possession, issuance procedure and emergency revocation contacts |
| 6. Host preflight | `node blockchain/developer-testnet-preflight-cli.mjs production ...` | Canonical production-shaped preflight report plus external rehearsal attestation input | Release/genesis/tip, external witness quorum, clock/disk/FD/ports, ingress bounds, fresh restore drill and absence of plaintext secrets verify | Host observations are taken immediately before launch; the command does not reserve ports or prove who controls a machine |
| 7. Start and discover | `npm run network:validator -- ...`; `npm run network:discover -- ...` | Running ceremony-mode validators and signed discovery announcements | Multiple transport identities return one registry-bound network/tip; lifecycle mode refuses stale or missing pins | Public routing, firewall policy, time synchronization, monitoring and operator contacts are tested from outside each host |
| 8. Finality and recovery state | Use validator transaction ingress and `POST /v1/blocks/produce`; inspect signed health/snapshot evidence | Finalized blocks, redundant journals, quorum snapshot and `recoveryStateCommitment` | A 3-of-4 quorum finalizes one tip; restart/catch-up, snapshot replay, validator handoff and recovery commitments reproduce the same state | Operators confirm no shared supervisor, filesystem or administrative credential controls the quorum |
| 9. Beacon quorum | `npm run beacon:serve -- ...`; `npm run beacon:aggregate -- ...` | Native signed shares, durable nonce/share state and aggregate | More than two thirds of the active on-chain beacon set sign one network/generation/candidate/round; replay and one-operator outage fail closed | Beacon operators retain separate keys, backups, clocks and failure domains |
| 10. Archive and backup recovery | `npm run node:backup`, `npm run backup:receipt`, `npm run backup:serve`, `npm run backup:drill-remote` | Portable backup, signed receipts from at least two sources and fresh isolated restore result | Source/operator uniqueness, inventory hashes, finalized tip/state and full replay verify before a drill passes | Copies reside outside validator hosts under separately administered storage and restore alarms have an owner |
| 11. Fault and incident drills | `node blockchain/testnet-partition-drill-cli.mjs verify ...`; run the reviewed real-service procedure | Signed partition/restart/catch-up, certificate rotation, beacon outage and corrupt-archive evidence | Required observations and validator quorum hashes bind the exact plan, release, network and tip; a 2/2 split claims no finality | Operators actually inject the documented faults on separate hosts and retain logs and external timestamps |
| 12. Multi-host launch evidence | `node blockchain/multi-host-launch-evidence-cli.mjs collect ...`, then `verify PACKAGE PLAN_HASH RUN_NONCE CHALLENGE NOW_MS` | Canonical `nir-multi-host-launch-evidence-v2` package and externally retained `runConsumptionHash` | Four validator identities, 3/4 outage finality, restart/catch-up, native beacon quorum, two signed backup/restore receipts, freshness and live challenge responses yield `EVIDENCE-CONSISTENCY-PASS` | Reviewers establish that distinct keys and origins correspond to independent operators and machines; the package explicitly does not prove this |
| 13. Reset and incident readiness | `npm run testnet:reset -- plan/sign/verify/drill` | Quorum-signed reset manifest, incident-report hash and isolated drill output | Old/new genesis and network domains, active validator authorization, reason, not-before time and non-destructive drill checks verify | Any destructive action uses a separately approved manual process and public communication outside this tool |
| 14. Launch review | Re-run gates 1–13 at the agreed observation time | Published hash index, evidence packages, limitations and contact list | Every referenced verifier returns its documented success status on the exact published bytes | Independent security reviewers and all operators sign the launch decision; unresolved critical findings keep the gate closed |

## Free volunteer-machine path

The valueless developer testnet has no required software licence or hosted-service
fee. Operators may use separately administered volunteer-owned computers with
stable public connectivity, pinned self-signed certificates, direct IP HTTPS
origins where supported, encrypted local vaults, operator-owned backup media,
public time synchronization and open-source monitoring. The same gate matrix
still applies: a free path does not permit shared keys, shared administration,
loopback-only evidence, missing off-node anchors, stale drills or unbounded
public ingress.

At minimum the volunteer group supplies four validator operators, an active
beacon quorum with one-operator outage tolerance, two archive/backup operators,
separately retained release/genesis/recovery anchors, and people responsible for
alerts and incidents. One person running many keys or ports is a local rehearsal,
not a multi-host gate completion.

## Optional paid services

None of these purchases changes a protocol threshold or replaces evidence:

- hosted machines, static addresses or managed DNS;
- managed reverse proxy, traffic filtering or denial-of-service protection;
- hosted metrics, paging and log retention;
- object storage or managed backup media;
- hardware-backed key custody;
- independent penetration testing, cryptographic review and consensus audit.

Public certificate services may be used, but the protocol still authenticates
the exact lifecycle-approved fingerprint. Paid branding, listing, custody and
promotion are outside this valueless testnet plan.

## Evidence handling

Publish canonical artifacts by hash, not screenshots. Keep ceremony anchors,
release/witness checkpoints, consumed run nonces, `runConsumptionHash` values
and incident evidence outside the nodes they protect. Local hash chains cannot
detect coordinated rollback of every local copy. Wall-clock, DNS, host ownership
and organizational independence remain external observations and must never be
inferred from a machine `PASS` field. There is no automatic fork choice between
conflicting valid finalized histories; operators must stop and investigate.
