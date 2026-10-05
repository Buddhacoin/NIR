# Validator readiness gateway child commit protocol

This protocol is the fail-closed activation boundary for the isolated readiness gateway process.
The canonical package layer itself does not spawn a child, open TLS keys, bind a listener, or connect
signer pipes. Its real process consumer and inherited-FD lifecycle are documented in
[validator-readiness-gateway-child-runtime.md](validator-readiness-gateway-child-runtime.md).

## Trusted input

`createValidatorReadinessGatewayChildInput` packages the already verified gateway runtime launch
envelope and the exact consensus, gateway, and transport process bootstraps. Its version 1 hash is
bound to launcher-local network/session/release/bootstrap pins and to the expected bound host and
port. `verifyValidatorReadinessGatewayChildInput` requires those pins independently; values carried
inside the package cannot authorize themselves.

The later protocol also requires the launcher-retained PID of every cohort member. Signer READY
packages are independently signature-verified against their exact bootstrap and retained PID. The
unsigned gateway READY is verified against the locally retained gateway PID, endpoint, certificate
fingerprint, bootstrap, and session, then compared with the gateway READY retained by the child.
No shallow cohort copied out of an activation or commit message is a trust source.

## PREPARE and COMMIT

The only valid lifecycle is:

1. verify all three READY packages;
2. independently create and verify the three role-specific launch activations;
3. accept one `PREPARE` command and return one `PREPARE_ACK`;
4. verify the exact consensus and transport signer activation acknowledgements against the retained
   activations;
5. accept one `COMMIT` command and return one `COMMIT_ACK`;
6. fully flush that exact `COMMIT_ACK` to the inherited launcher channel;
7. and only then open the HTTPS admission-readiness activation gate.

The PREPARE hash commits to the complete signed/verified readiness set, its separate readiness hash,
all three complete activation objects, and all three activation hashes. The COMMIT hash repeats the
complete readiness binding and all three activation hashes, and adds the exact PREPARE acknowledgement
hash plus both complete signer acknowledgements and their two acknowledgement hashes. PREPARE,
PREPARE_ACK, COMMIT, and COMMIT_ACK use distinct formats and cryptographic domains.

`createValidatorReadinessGatewayActivationController` enforces order and one-shot semantics. After
`prepare()` it remains in `prepare-ack-pending`; the caller must finish the bounded status-channel
write and pass the exact acknowledgement to `prepareAcknowledgementFlushed()` before a COMMIT can
be accepted. After `commit()` it remains in `commit-ack-pending`; the caller must finish the bounded
status-channel write and pass the exact acknowledgement to `commitAcknowledgementFlushed()` before
the state becomes `committed`. Duplicate, replayed, substituted, missing, cross-role, or out-of-order
messages fail closed. Closing the controller is terminal.

## HTTPS gate

`createValidatorAdmissionReadinessServer` remains active by default for existing callers. A production
runtime creates it with `{ active: false }`. While inactive, challenge requests receive HTTP 503 before
body parsing and before either signer can run. `validatorAdmissionReadinessActivate()` performs the
single irreversible inactive-to-active transition; a second call is rejected.

The runtime must call that method only after `commitAcknowledgementFlushed()` succeeds. Calling
`server.close()` disables the gate synchronously, aborts every active signer request, prevents late
responses, and permanently rejects later activation. Thus listener shutdown and activation races are
fail-closed.

Canonical frames use a four-byte big-endian length followed by canonical JSON and are bounded to
4 MiB. Fragmented and coalesced input is supported; invalid UTF-8, noncanonical JSON, oversized
frames, unknown fields, and partial EOF poison decoding.
