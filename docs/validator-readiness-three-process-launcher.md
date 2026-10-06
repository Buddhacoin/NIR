# Three-process validator readiness launcher

`launchValidatorReadinessThreeProcess()` is the first atomic supervisor for one local readiness
cohort. It starts two isolated signer children and one gateway child from fixed repository paths,
passes an already-bound listener to the gateway, and never returns a usable cohort until it has
verified all three READY objects, gateway PREPARE_ACK, both signer activation acknowledgements,
gateway COMMIT_ACK, and the post-activation gateway ACTIVE_ACK. The old two-signer cohort launcher
remains deliberately non-activating.

The caller supplies exact, preverified consensus, transport, and gateway child inputs; two vault
password `Buffer`s; TLS key and certificate `Buffer`s; and one numeric, already-bound socket FD.
There are no caller-selected executables, environment variables, vault paths, IPC commands, or
restart hooks. Once exact options and a valid socket FD have been accepted, the listener FD is
transferred and closed by the launcher on success or failure; the caller must not read, write, close,
or reuse it. Before that acceptance, the caller retains ownership. A production operator must
obtain the bound FD from a trusted socket-activation facility; the test harness alone uses a Node
internal handle to create its fixture. The launcher verifies that the FD is a socket and that the
child reports the expected bound address and TLS fingerprint.

The four caller-owned secret buffers are copied, checked for backing-memory overlap, and zeroed
synchronously before asynchronous startup. Copies are zeroed after delivery and on all failure
paths. The TLS private key is also checked against the certificate before spawning children. This
does not defend against a hostile process with the same OS identity, a debugger, a compromised
kernel, or a writable installed release; those require host and release controls.

The returned frozen handle exposes only `pids`, verified `readiness`, `endpoint`, verified
`activeAcknowledgement`, `state()`, `updateHeight(height)`, `close()`, and
`waitForTermination()`. It does not expose child handles, streams, listener FDs, passwords, or
generic signing. `productionActivated: true` now means the gateway reported that its HTTPS gate
was activated after the exact COMMIT_ACK; it does not mean the whole NIR network is
production-ready. Callers must continue supervising `waitForTermination()`; any child exit,
channel loss, malformed status, or height-update failure closes the whole cohort. There is no
in-place restart: a new cohort needs new bootstraps and fresh launch evidence.

The launcher is a library API, not an operator CLI or public deployment recipe. Before public
deployment it still needs independent host evidence, release/OS hardening, external operational
review, and a tested socket-activation integration. The `tests/validator-readiness-three-process-launcher.test.mjs`
suite proves a real local three-process activation, height acknowledgements, secret zeroing,
invalid inputs, and group teardown when a signer dies.
