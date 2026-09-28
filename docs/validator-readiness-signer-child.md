# Validator readiness signer child protocol

This layer defines the secret-input and canonical control packages used by the isolated readiness
signer process. The concrete inherited-descriptor lifecycle is documented in
[validator-readiness-signer-child-runtime.md](validator-readiness-signer-child-runtime.md).

## Byte-native password input

`decryptWallet` accepts either the existing string password or a caller-owned `Buffer`. The Buffer
path remains bytes through validation and `scrypt`; it is never converted to a JavaScript string.
The decryptor does not clear caller memory. The child must call `fill(0)` immediately after the
synchronous decrypt operation, whether it succeeds or fails. This narrows password lifetime but
does not claim that the JavaScript wallet private-key string can be reliably erased.

`readOneTimePasswordFd` accepts only an inherited FIFO or socket owned by the current process user.
Regular files are refused even when owner-only. Reading is asynchronous, byte-bounded, deadline-
bounded, and requires EOF. The descriptor is closed on every success or error path. Internal copies
are cleared on timeout, overflow, premature close, embedded control bytes, and stream errors. The
older synchronous reader remains unchanged for existing offline ceremony commands; it is not the
production signer-child reader.

## Trusted one-shot input

`createValidatorReadinessSignerChildInput` packages the role launch envelope, exact encrypted vault,
all three public process bootstraps, and launcher-local expected bootstrap, launch, session and
release hashes. The package contains no password, private key, local path, or environment setting.
Consensus and transport use different schemas and hash domains.

Verification takes the expected role from outside the package. It runs the full runtime/C1 launch
verification against the supplied encrypted vault, verifies the gateway bootstrap against both
signer bootstraps, requires the launch bootstrap to be the same canonical object as the selected
cohort bootstrap, and compares the complete public vault commitment. The input hash detects wire
mutation; trust in its origin still comes from the unique inherited launcher descriptor rather than
from a self-declared hash.

The runtime must consume exactly one canonical input frame and then require EOF. A second frame,
trailing partial frame, missing EOF, malformed UTF-8, noncanonical JSON, unknown field, or timeout
terminates startup.

## Non-tautological activation

An activation command carries both the hashed activation and a separate complete READY set. The
verifier does not treat the activation's own summarized `cohort` as its authority. It independently
normalizes the two role-signed signer READY proofs against the bootstraps pinned at startup, verifies
the gateway READY against the pinned endpoint and TLS certificate, requires the target role's READY
to equal the READY object retained locally by that child, and only then verifies the activation
against that normalized set.

The inherited control channel remains the authority for the unsigned gateway lifecycle fact and
the other operating-system PIDs. Cryptographic verification prevents replacing a signer READY or
moving it between roles; it does not make an untrusted launcher trustworthy.

After successful activation verification, the signer creates a role-specific activation ACK. The
ACK binds the exact activation hash, role, bootstrap, launcher/session/release hashes, PID, and fresh
process nonce. The launcher must verify the ACK before allowing gateway signing traffic. An ACK is
delivery/state-transition evidence over the inherited status channel, not a signature or a reason
to accept a different activation. Because protocol verification is deliberately stateless, the
child runtime must accept exactly one activation command: a replay of even the same valid command
after activation is a fatal state-machine violation and must never produce a second ACK.

## Framing and runtime boundary

Signer-child packages use the shared four-byte big-endian canonical JSON framing with a 4 MiB body
limit. Fragmented frames are supported; partial EOF poisons the decoder. The runtime now implements
the fixed role dispatcher, inherited FD map, READY-before-activation state machine,
pre-activation data rejection, chained height control, fixed-code fatal reporting, and teardown.
No signer endpoint is created and no request byte is accepted before activation has been verified
and its ACK has been written successfully. Process spawning and whole-cohort supervision remain the
trusted launcher's responsibility.
