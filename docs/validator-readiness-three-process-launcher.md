# Three-process validator readiness launcher

`launchValidatorReadinessThreeProcess()` is the installed-release-gated supervisor for one
readiness cohort. It starts two isolated signer children and one gateway child from fixed paths
within its own verified active generation, passes an already-bound listener to the gateway, and
never returns a usable cohort until it has
verified all three READY objects, gateway PREPARE_ACK, both signer activation acknowledgements,
gateway COMMIT_ACK, and the post-activation gateway ACTIVE_ACK. The old two-signer cohort launcher
remains deliberately non-activating.

The caller supplies exact, preverified consensus, transport, and gateway child inputs; a separate
trusted pin set; [signed release and operator policy evidence](validator-readiness-trusted-evidence.md);
two vault password `Buffer`s; TLS key and certificate `Buffer`s; and one numeric, already-bound
socket FD. Production calls also supply the external head anchor, durable head store, active
installation target, and an independently pinned package hash. Before accepting the listener,
the launcher checks that its own module was loaded from the active installed generation, verifies
the complete installed release against the current session and operator signer, then checks the
signed release, checkpoint, local policy and three bootstrap hashes. It repeats the installed
entrypoint and release check before gateway COMMIT. The caller must obtain the policy, release
signer, package hash, and anchor independently; the launcher cannot authenticate their source.
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
suite uses the explicitly named `launchValidatorReadinessThreeProcessDevelopment()` path to
prove a real local three-process activation, height acknowledgements, secret zeroing,
invalid inputs, and group teardown when a signer dies. A second fixture now binds a loopback
socket in an independent Python process, passes the listening OS descriptor to the Node test
process, closes the Python copy, and verifies the same cohort and HTTPS challenge. This proves
descriptor inheritance without Node's private handle API, but is still a local integration test:
it does not supply an operator CLI, a hardened service manager, or independent-host evidence.
The development path does not verify an installed release and refuses to run when its module is
loaded from an installed generation. It must not be used as a production entrypoint. An
end-to-end successful activation from a signed installed generation remains to be tested before
a production claim.
