# Validator readiness signer cohort launcher

This increment launches and supervises the real consensus and transport signer children as one
fail-closed cohort. It does **not** claim that a production readiness gateway exists and it cannot
activate the signers. The repository currently defines the gateway protocol packages but has no
gateway process that binds the pinned TLS listener and owns the signer data channels.

## What the launcher guarantees

`launchValidatorReadinessSignerCohort` accepts the two exact signer-child inputs and two independent
caller-owned password buffers. Before spawning anything it:

- verifies both child packages with their exact roles;
- requires one launcher nonce, session, release provenance and complete bootstrap cohort;
- rejects overlapping password storage;
- uses the repository-owned signer CLI path and passes only the role in `argv`;
- starts both children with an empty environment and no stdout, stderr or generic Node IPC channel.

Every child receives a fresh set of seven inherited channels. Bootstrap and password bytes are sent
once on FDs 3 and 4 and followed by EOF. Passwords never enter arguments, environment variables,
paths or JSON and both caller buffers are cleared on success and failure. The launcher retains the
control, signer-data and lifeline ends; it does not expose them before a real gateway can be placed
under the same supervision boundary.

The launcher accepts READY only from each child's inherited FD 6, verifies its post-quantum
signature, exact bootstrap, launch/session/release bindings and the PID returned by `spawn`, and
then reports `signers-ready-awaiting-gateway`. Returned readiness evidence and PIDs are frozen public
metadata. `productionActivated` is always `false`, and there is intentionally no activation method.

The path is anchored to this installed module rather than the working directory, `PATH`, caller
arguments or environment. This does not protect a writable installation from a same-user file
replacement between release verification and spawn. Production packaging must make the verified
release tree read-only to the launcher account (or execute it from a verified immutable image).

## Supervision and teardown

Any spawn error, channel failure, malformed or partial READY, timeout, bad password, premature child
exit, or explicit caller close tears down both children. The launcher first closes both retained
lifelines, then applies bounded `SIGTERM` and `SIGKILL` deadlines, waits for both child exit events,
and destroys every parent pipe. A child cannot be silently replaced or relaunched inside the same
cohort. `waitForTermination()` reports only the bounded public reason `closed` or `failed`.

The signer children currently allow ten seconds between READY and activation. Until the gateway
runtime exists, callers must use this launcher only as a bounded custody/readiness probe and close it
immediately after inspecting the signed evidence.

If the launcher process dies, the operating system closes its sole parent lifeline writers and both
signers fail closed. This is process-lifetime containment, not protection against `SIGSTOP`, a
compromised same-UID process, inherited descriptors introduced by a future wrapper, or a hostile
kernel. Production service supervision must not pass these descriptors to launcher descendants.

## Missing production boundary

Production activation requires one launcher to spawn and pin a gateway child, verify its unsigned
READY over an inherited status channel after the TLS listener is bound, assemble the exact
three-process readiness set, send role-specific activation commands to both signers, verify both
activation ACKs, and expose signer data channels to that same gateway only after the all-or-nothing
ACK barrier. Accepting a gateway READY object from an arbitrary caller would not authenticate the
gateway PID or listener and is deliberately unsupported.
