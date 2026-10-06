# Validator readiness gateway child runtime

The gateway child is the real isolated process that owns the admission-readiness TLS listener and
the two narrow signer channels. It is deliberately not a key custodian: it receives TLS material
only as bounded inherited bytes, cannot open a path, and can request only the fixed transport and
consensus readiness signatures exposed by the existing signer children.

This increment does not change `launchValidatorReadinessSignerCohort`. The separate
[`launchValidatorReadinessThreeProcess()`](validator-readiness-three-process-launcher.md)
now creates the complete descriptor inventory, starts all three children, independently verifies
their READY evidence, drives PREPARE and signer activation, then sends COMMIT. Running the gateway
CLI by hand is not a production deployment.

## Fixed inherited descriptors

The dedicated CLI accepts no arguments and reads no environment values. The trusted launcher must
spawn it with an empty environment and give it these exact descriptors:

| FD | Direction | Purpose |
|---:|---|---|
| 3 | launcher → gateway | one canonical trusted runtime input, then EOF |
| 4 | launcher → gateway | raw TLS private-key bytes, then EOF |
| 5 | launcher → gateway | raw TLS certificate bytes, then EOF |
| 6 | launcher → gateway | persistent PREPARE and COMMIT control |
| 7 | gateway → launcher | READY, PREPARE_ACK, COMMIT_ACK and bounded fatal status |
| 8 | transport signer → gateway | role-specific signer responses |
| 9 | gateway → transport signer | role-specific signer requests |
| 10 | consensus signer → gateway | role-specific signer responses |
| 11 | gateway → consensus signer | role-specific signer requests |
| 12 | launcher → gateway | already-bound TCP listener |
| 13 | launcher → gateway | byte-empty launcher lifeline |

FD 13 is adopted first. Persistent channels use single-owner pollable handles and the bounded split
duplex adapter; the runtime never reaches into private stream handles or uses generic Node IPC.
Bootstrap, key, and certificate inputs require clean EOF. All descriptors must be launcher-created
FIFOs or sockets owned by the current user, and FD 12 must be a socket.

The canonical `nir-validator-readiness-gateway-runtime-input-v1` wrapper adds the launcher-retained
gateway, consensus signer, and transport signer PIDs to the already verified gateway child input.
The child checks its own PID locally. The PIDs of the signer children remain external trust pins for
PREPARE verification and for deriving each signer channel epoch; PREPARE cannot replace them.

## Bind and activation lifecycle

The only successful order is:

1. adopt the lifeline and validate the fixed descriptor inventory;
2. verify exactly one trusted runtime input;
3. read bounded TLS key and certificate bytes and compare the local X.509 DER SHA-256 fingerprint
   with the verified gateway bootstrap;
4. create the HTTPS service with its activation gate closed;
5. adopt FD 12, then verify its exact bound host and port;
6. emit gateway READY containing that locally observed listener identity;
7. independently verify PREPARE against the three retained PIDs and complete readiness cohort;
8. connect the narrow role-specific adapters, write PREPARE_ACK, and treat its write callback as the
   flush barrier before accepting COMMIT;
9. independently verify COMMIT and both exact signer activation acknowledgements;
10. recheck both signer channels, write COMMIT_ACK, treat its write callback as the second flush
    barrier, mark the controller committed, recheck both channels again, and only then activate
    the HTTPS service.

Before step 10, a readiness challenge receives HTTP 503 before its body is parsed and before either
signer can run. After activation, every request is relayed through the existing exactly-once,
epoch-bound signer adapters. No general signing operation is exposed.
If either signer disappears at the COMMIT boundary or later, the gateway closes the listener and
aborts in-flight signing. These checks narrow an activation race; they do not replace the missing
atomic three-process launcher or make the deployment production-ready.

## Failure and teardown

Malformed, duplicate, replayed, coalesced out-of-order, partial-EOF, cross-role, stale-child, wrong
listener, wrong certificate, signer-channel, backpressure, timeout, abort, or status-write failure is
terminal. After READY, the child makes one bounded attempt to send a fixed-code fatal status; it
never serializes exception text. The externally reachable HTTPS gate is disabled and active signing
is aborted before that best-effort fatal write starts, so a stalled launcher status reader cannot
extend signing lifetime. Lifeline EOF and termination signals request clean shutdown.

Closing begins by disabling the HTTP gate and aborting in-flight responses. It then closes the
activation controller, control decoder, signer channels, listener, and every owned inherited handle
within bounded teardown intervals. TLS input buffers are zeroed immediately after server creation
and again on every error path. The CLI exits explicitly only after runtime cleanup completes.

Portable process isolation does not protect the TLS key against a hostile same-UID debugger, core
dump, writable installed release, or compromised kernel. Production still requires an immutable
verified release, separate OS identity, debugger/core-dump restrictions, unique launcher inventory,
and an external kill deadline for the whole three-process cohort.
