# Validator readiness process runtime protocol

This increment defines the byte channels and exact messages that the trusted readiness launcher will
use with isolated gateway, transport-signer, and consensus-signer processes. It deliberately does
not spawn a process, open or decrypt a vault, read a password, or start a listener. Those operations
belong to the next launcher increment and must use the boundaries described here.

## Split inherited channels

`createValidatorReadinessInheritedSplitDuplex` combines one inherited numeric read descriptor and
one different inherited numeric write descriptor into the narrow Duplex interface already consumed
by the signer protocol. `createValidatorReadinessSplitDuplex` provides the same facade for stream
ends held by the launcher. The facade owns both directions by default: an error, premature close,
write timeout, or capacity violation poisons the facade and destroys both owned ends. Clean input
EOF ends the readable side and closes the output side rather than leaving a half-open signing
channel. Pending output is byte-bounded and every underlying write and close has a deadline.

The runtime must pass numeric descriptors directly. It must not reopen `/dev/fd`, use the generic
Node IPC channel, serialize a stream handle into JSON, or combine the two directions into an
unbounded memory queue.

Descriptor-number inequality is only the portable alias check available at this layer. Different
descriptor numbers or different stream wrappers can still refer to the same kernel endpoint. The
launcher must therefore create every pipe itself, inventory each end by role and direction, reject
caller-supplied ends, and never re-export an inherited end to another child. A unique, one-way
lifeline must be inherited by exactly one child and must not be reused as a status/data channel or
passed to a sibling or later descendant. The launcher closes every parent duplicate after handoff.
The split-Duplex facade cannot prove open-file-description uniqueness.

## Launch envelopes and local trust

Every child receives one canonical, role-specific launch envelope. The envelope contains only the
public C1 bootstrap packages plus a launch anchor. It contains no password, decrypted key, encrypted
vault body, local path, or environment-derived setting. Signer envelopes carry their own bootstrap;
the gateway envelope additionally carries both signer bootstraps so it can pin the two channels.

An anchor repeats the expected role, launch nonce, bootstrap, session, and release-provenance hashes.
Its envelope hash detects mutation under a role-separated domain, but neither the hash nor the
anchor authenticates its own origin. Verification therefore requires all five expected values from
launcher-local state. A substituted, internally consistent envelope fails against those external
pins. C1 bootstrap verification remains mandatory before the runtime acts on the embedded package.
The runtime launch verifier invokes that C1 verification itself. A signer launch is verified against
the exact encrypted vault supplied out of band by the launcher; the vault body is never accepted
from the launch envelope. A gateway launch verifies the gateway bootstrap together with both signer
bootstraps embedded in its package.

## Status messages

After its listener is bound, the gateway emits an exact canonical READY message through its
inherited status descriptor. READY binds the gateway bootstrap, launch/session/release values,
certificate fingerprint, actual PID, fresh process nonce, and the exact expected host and port.
It is intentionally unsigned because the gateway owns no role key. Trust comes from the inherited
channel, the launcher's retained child handle and PID, and the external launch pins; the READY hash
is mutation detection, not an identity proof.
Verification also requires the TLS certificate fingerprint retained in launcher-local state; an
internally consistent READY message cannot choose its own certificate pin.

No process becomes active merely because it emitted READY. After all three READY messages have been
independently verified, the launcher creates a role-specific activation message for each process.
Every activation commits to the bootstrap hash, PID, process nonce, and READY hash of the entire
consensus/gateway/transport cohort, as well as the common session, release, and launcher nonce. The
receiver compares that cohort with the exact verified READY set supplied locally. If the third child
does not become ready, no activation is sent. If only part of activation delivery completes, the
launcher tears down the whole cohort. Activation hashes detect channel mutation; they
are not signatures and do not replace the trusted inherited channel.

Each signer acknowledges a height update using a separate role format and hash domain. The ACK binds
the exact update hash, sequence and height plus the signer bootstrap, process nonce, PID and launch
pins. The launcher must compare it with the exact update it sent. Consensus and transport ACKs are
not interchangeable.

Fatal status is deliberately limited to a fixed public code. There is no free-form detail field in
which a password, key, filesystem path, or exception text could be leaked. Fatal status is still a
lifecycle report over an inherited channel, not evidence that a compromised process is honest.

## Canonical framing and lifecycle boundary

All runtime messages use the shared four-byte big-endian canonical-JSON framing with a 4 MiB maximum.
Fragmented and coalesced frames are accepted; non-canonical JSON, oversized lengths, invalid UTF-8,
unknown fields, wrong message types, and partial EOF poison the decoder. The future launcher must
tear down the whole three-process cohort on any poisoned data/status channel, unexpected EOF, status
timeout, or cross-role message. A single child is never restarted inside an existing session because
that would discard the in-memory replay ledger.

The required state transition is `spawned -> bootstrap-verified -> all-ready-verified ->
all-activated -> active`. A child must not expose a listener or service a signing request before
activation. Timeout, unexpected EOF/exit, malformed status, failed activation delivery, or launcher
death aborts the entire cohort; activation is never inferred from silence or a clean EOF.

This module establishes protocol and channel invariants only. Separate service identities, disabled
core dumps, debugger restrictions, descriptor-safe vault input, one-time password delivery, process
supervision, and fatal cohort teardown remain deployment/runtime requirements.
