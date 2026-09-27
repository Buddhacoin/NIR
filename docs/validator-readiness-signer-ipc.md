# Validator readiness signer IPC

The readiness signer IPC is a local, fail-closed boundary between the public readiness gateway and
two role-specific signing capabilities. It does not start a process, open a vault, inspect a path,
or read environment variables. A production launcher must still create the isolated processes,
deliver each pinned role package through a trusted inherited bootstrap descriptor, and supply the
already-open duplex channels.

## Framing

Every message is one four-byte unsigned big-endian length followed by exactly that many bytes of
canonical UTF-8 JSON. A body is limited to 512 KiB. Zero lengths, oversized declarations, invalid
UTF-8, duplicate keys, noncanonical JSON, partial EOF, unsolicited responses, and data after a
protocol failure poison the channel. Fragmented and coalesced frames are accepted without an
unbounded accumulation buffer. Partial input, signing, request, and output waits are time-bounded.

## Role-specific operations

The wire has no arbitrary command, signing domain, or signing payload. The transport endpoint
accepts only `nir-validator-readiness-transport-sign-request-v1`, independently verifies the full
observer challenge against the context and validator set pinned in its transport role package, and
returns `nir-validator-readiness-transport-sign-response-v1`. The consensus endpoint accepts only
`nir-validator-readiness-consensus-sign-request-v1`, independently verifies the complete transport
response, and returns `nir-validator-readiness-consensus-sign-response-v1`.

Every request and response carries the random request ID, gateway role-package hash, signer
role-package hash, and session hash. Responses additionally bind the canonical request hash and
semantic operation hash. All bindings must match the locally pinned session and request. Context,
validator membership, network, genesis, endpoint, TLS pin, checkpoint, and set identifiers come
only from that package; they cannot be supplied over signer IPC.

Immediately before a new key operation, the endpoint calls a synchronous trusted-current-height
callback. The value must be a safe integer, cannot move backwards, must be at least the pinned
checkpoint height, and must remain strictly below `expiresAtHeight`. Wall-clock session expiration
is checked independently whenever the role package is verified.

## Exactly-once session ledger

Request IDs, their canonical request hashes, and semantic operation hashes are retained without
eviction for the life of the bounded session. Reusing a request ID for different input is fatal;
an exact retry returns the cached result. The semantic operation is reserved before invoking the
key capability. A repeated valid semantic operation under either the same or a fresh request ID
returns the already verified signature result and never invokes the key twice. The completed
semantic core is stored before the first response byte is written. Capacity exhaustion fails closed
rather than discarding replay history or allowing an unbounded pending-message queue.

Only one gateway call may be outstanding on each channel. Abort, timeout, malformed response,
unknown request ID, signer failure, transport error, or EOF while work is pending poisons the
channel and rejects the operation. In particular, cancellation during signing never allows a late
result to be reused on the same channel.

## Programmatic use

An already-wired gateway creates
`createValidatorReadinessTransportSignerAdapter` and
`createValidatorReadinessConsensusSignerAdapter`. The adapters expose only
`signReadinessTransport({challenge, signal})` and
`signReadinessConsensus({transportResponse, signal})` plus their public identity.

The isolated roles create `createValidatorReadinessTransportSignerEndpoint` or
`createValidatorReadinessConsensusSignerEndpoint`. Their injected key capabilities are respectively
`signReadinessTransportInput(input, {signal})` and
`signReadinessConsensusInput(input, {signal})`; a signer object exposing a generic `sign` method is
rejected.

This module proves protocol separation and in-memory channel behavior. It is not process isolation.
Production use remains blocked until the trusted launcher, inherited-descriptor bootstrap,
role-specific vault opening, process cleanup, and authenticated current-height source are wired and
audited.
