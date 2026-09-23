# Local testnet partition rehearsal

`blockchain/testnet-drill-rehearsal-cli.mjs` is a developer-testnet rehearsal tool. It does not
deploy a network, change a firewall, contact an external host, or establish production readiness.
It consumes one machine-verifiable PASS preflight report and emits the existing partition-drill
plan, authenticated harness evidence, validation report, and a cleanup report.

## Safety boundary

The executor creates a private random directory under the operating-system temporary directory
and starts ten separate Node processes: four validator adapters, four beacon adapters, and two
archive adapters. These adapters use the existing drill signing and validation code, expose only a
bounded loopback health endpoint, and receive ephemeral private keys over inherited IPC rather than
arguments, environment variables, logs, or files. They model the service roles; they are not the
production validator, beacon, or archive runtimes and do not prove that physical infrastructure was
partitioned correctly.

The application-level proxy implements drop, partition/heal, bounded delay, deterministic reorder,
and replay delivery without root privileges or system firewall commands. Each adapter maintains its
own bounded message transcript and anti-replay set. A repeated digest is rejected with a typed error;
only then can the adapter derive and sign `replay-rejected: PASS`. The controller cannot supply a
result or evidence hash to the signing operation. Each adapter derives those values locally and
signs them over the exact network, plan, scenario, result, time, and transcript hash.

This distinction is deliberate: a lightweight adapter cannot prove real consensus finality,
no-finality, catch-up, archive restoration, beacon quorum behavior, or TLS certificate enforcement.
Those observations are signed `FAIL`, and no synthetic quorum point is emitted. Therefore a healthy
local run has `rehearsal.harnessStatus == "PASS"` but
`rehearsal.authenticatedDrillStatus == "FAIL"` and `validation.status == "FAIL"`. Within the
message-fault scenario, delay, reorder, and rejected-replay observations can individually PASS.
`converged` remains FAIL because receiving a post-heal message is not proof of consensus convergence;
therefore the scenario cannot claim finality or emit a quorum point. This is a harness self-test, not
an authenticated real partition drill.

## Invocation

```text
node blockchain/testnet-drill-rehearsal-cli.mjs /absolute/path/preflight-report.json
```

The input is bounded, opened with `O_NOFOLLOW`, and checked against its descriptor before and after
the read. The command writes its signed-free JSON result to stdout. It never writes beside the input.

Every child is launched directly (`shell:false`) in its own process group. Startup, RPC, scenario,
shutdown, stdout/stderr, process count, temporary disk, and health-response sizes are bounded. The
executor first sends `SIGTERM` to each owned process group and escalates to `SIGKILL` after the
shutdown deadline. It removes only its own random temporary directory. A crash, timeout, partial
start, occupied-port race, output overflow, validation failure, or incomplete cleanup fails the
operation. Programmatic errors include a non-secret cleanup report; the CLI deliberately prints no
internal error text or key material.

## Interpreting the result

A successful harness self-test requires `rehearsal.harnessStatus == "PASS"` and
`cleanup.status == "PASS"`; it is expected to retain `validation.status == "FAIL"`. A real drill may
only claim authenticated PASS after actual services produce the required observations and quorum
points. `rehearsal.externalNetwork` is always `false`, and `rehearsal.faultLayer` is `application`.
Use the separate partition-drill runbook and authenticated evidence format for that later operator
drill. This rehearsal checks orchestration, failure handling, local anti-replay behavior, signatures,
validator rejection rules, and evidence assembly.

The CLI exits zero when the harness and cleanup succeed even though authenticated drill validation
is expected to remain FAIL. It has no `--require-authenticated-pass` mode; callers that require a real
drill PASS must inspect `authenticatedDrillStatus` and use the real-service operator workflow. No
top-level or generic `status: PASS` field is emitted that could be mistaken for consensus success.

## Real validator recovery driver

`blockchain/testnet-drill-real-runtime-cli.mjs` is a narrower real-service integration layer. It
first inventories the executable validator, finality, beacon, and archive components. Missing or
symlinked runtime entrypoints fail closed. The current driver exercises only the real validator and
finality components; beacon and archive are reported as available but `exercised:false`.

The driver creates a fresh valueless development network in a random temporary directory and starts
four real `network-cli serve-validator` processes on loopback. `DistributedCoordinator` finalizes one
transfer, one non-proposer validator is stopped, and the remaining 3/4 quorum finalizes a second
transfer. The stopped validator is launched again from its durable directory, explicitly synchronizes
from authenticated peers, and returns a validator-signed coordinator-authenticated health response
for the second finalized tip. The report embeds both finalized blocks, so offline validation replays
them through `NirChain` and verifies their finality certificates. It also verifies every health
request and response signature, network, identity, height, and tip binding.

An exact authenticated health request is replayed during the run and must receive a 4xx rejection.
That rejection and the local PID change are controller transcript assertions, while identity and
recovered state are cryptographically bound by the validator response and finalized chain. The
report hash covers both classes and labels the result an authenticated local recovery, not a
production deployment or an external infrastructure partition. The validation uses explicit
`harnessStatus` and `scenarioStatus` fields and deliberately has no generic top-level PASS status.

```text
node blockchain/testnet-drill-real-runtime-cli.mjs
```

The command takes no host or URL arguments and cannot contact a non-loopback endpoint. Children use
direct spawn with `shell:false`, isolated process groups, an empty inherited environment except the
explicit development certificate mode, and bounded startup/request/shutdown/output/disk limits.
Cleanup terminates every owned process group, escalates after a deadline, and removes only the owned
random temporary directory. A runtime crash, replay acceptance, invalid signature, failed catch-up,
resource overflow, or incomplete cleanup makes the command fail.

## Real beacon and archive extension

The extended command requires an exact external release checkpoint binding:

```text
node blockchain/testnet-drill-real-runtime-cli.mjs services sha3-256:<64-hex-digest>
```

It first completes the real validator recovery scenario above. Its finalized network ID and tip,
together with the supplied release checkpoint, determine both beacon candidate IDs. Three independent
ephemeral beacon operators then run the actual `beacon-service.mjs`, each with a separate encrypted
vault, durable state log, requester policy, key, and loopback port. Vault passwords travel only over
restricted inherited file descriptors; they are absent from argv, environment values, files, logs,
and the report.

Each service creates a signed share and rejects an exact request replay. After one service stops, two
valid shares are explicitly rejected because the configured three-operator 2/3+1 quorum is three.
The stopped service restarts from its durable state, rejects the pre-restart nonce, returns the exact
previously issued share for the old context, and supplies the missing share for the new context. The
offline validator independently verifies unique operator identities, every share signature and
context, quorum size, and the aggregate value. These ephemeral operators are a local rehearsal set;
the result does not claim enrollment in an external or production beacon registry.

Two independent archive operators sign real history archives at the validator tip and expose them
through separate `archive:serve` processes. With one service stopped, the standard remote restore
path must reject the single remaining source. After restart it downloads matching manifests and
chunks from two distinct trusted signers and installs the verified account-history index. Offline
validation repeats both archive signature/content checks and binds recovery height and tip to the
replayed validator chain.

Beacon/archive socket failures, process IDs, HTTP replay status, and outage attempts remain hashed
controller observations. Shares, aggregates, archive artifacts, validator health, and finalized
blocks are cryptographically reverified. A scenario PASS requires the latter evidence; controller
assertions alone cannot manufacture quorum. All services inherit the same process-group cleanup,
bounded output, timeout, disk, loopback-only, no-shell, and owned-temporary-directory rules.
