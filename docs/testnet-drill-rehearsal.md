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
