# Validator readiness signer child runtime

The signer child is now a real, isolated Node.js process for either the consensus or transport
readiness key. It has no filesystem path, environment, network listener, generic IPC channel, raw
wallet, or general signing API. Its only command-line argument is exactly `consensus` or `transport`.

## Fixed inherited descriptors

The trusted launcher must create and exclusively own the following channels before spawning the
child. The child accepts no descriptor numbers from arguments or environment variables.

| FD | Direction | Purpose |
|---:|---|---|
| 3 | launcher → child | one canonical signer-child input, followed by EOF |
| 4 | launcher → child | one raw password, followed by EOF |
| 5 | launcher → child | persistent activation and height control |
| 6 | child → launcher | persistent READY, ACK and bounded fatal status |
| 7 | gateway → child | role-specific signing requests |
| 8 | child → gateway | role-specific signing responses |
| 9 | launcher → child | byte-empty launcher lifeline; EOF stops the child |

Each descriptor must be an inherited FIFO or socket owned by the current user. The child never
reopens `/dev/fd`, accepts a regular file, or uses Node's generic IPC channel. Descriptor numbers
cannot prove that kernel objects are distinct, so the future launcher must create every channel,
inventory every end, close its unused duplicates, and tear down the complete cohort if one child
fails.

Persistent descriptors are adopted exactly once by pollable inherited-pipe handles rather than
filesystem read streams. This keeps EOF and cancellation portable when the launcher deliberately
keeps the other control and request writers open. Teardown destroys those owning handles and waits
only for a fixed referenced, bounded close interval; it never closes an owned descriptor a second
time. The one-shot password reader uses the same pollable handle for inherited sockets while
retaining FIFO support for offline ceremonies.

## One-way lifecycle

The runtime moves only forward:

`STARTING → BOOTSTRAP_VERIFIED → CUSTODY_OPEN → READY_WRITTEN →`
`ACTIVATION_VERIFIED → ACK_FLUSHED → ACTIVE → TERMINATED`.

FD 9 is opened first. FD 3 must contain exactly one bounded canonical frame and clean EOF. The
runtime verifies the complete child input against the role supplied by the executable, then reads
the byte-native password from FD 4. Custody receives `expectedVaultCommitment` only from the already
verified role bootstrap. It cannot substitute a commitment from the encrypted vault body or from a
second command.

The child signs READY with its narrow custody capability and sends it on FD 6. The launcher must
then send one activation command containing the independently verified three-process READY set.
The child verifies the command against its retained READY and input, sends and fully flushes its
activation ACK, and only then creates the signer endpoint on FDs 7 and 8.

FD 7 is actively guarded before ACK completion. Any byte, EOF, or channel error before activation
is fatal; bytes are never buffered for later acceptance. A second or coalesced activation command,
activation replay, unexpected control message, or partial canonical frame is also fatal.

Before invoking either narrow key capability, the active endpoint yields through two event-loop poll
boundaries and rechecks the terminal state. This gives an already-readable lifeline EOF priority
over newly delivered signer work. OS scheduling cannot turn the check into a remote-delivery proof,
so the launcher still enforces its external kill deadline.

Once active, FD 5 accepts only the role-specific chained height update. Sequence, predecessor,
monotonic height, session, release, launcher and expiry bindings are reverified before the trusted
in-memory height changes. The ACK commits to the exact accepted update. The signing endpoint reads
that height immediately before and after every key operation and retains its existing exactly-once
operation ledger.

## Failure and cleanup

The first error permanently stops the process. After READY, the runtime makes one bounded attempt to
send an exact fixed-code fatal status; it never serializes exception text. Before READY, exit and EOF
are the only trustworthy failure signal because the launcher does not yet know a signed process
nonce. Password memory is cleared on every path, all owned streams and descriptors are destroyed,
the signer endpoint is closed, and custody references are dropped. The process never restarts a key
or session in place.

Lifeline EOF and termination signals request shutdown. Control or signer EOF, malformed input,
wrong password, invalid activation, invalid height, backpressure and timeouts fail closed. JavaScript
cannot erase the native `KeyObject`, interrupt a synchronous KDF/signature, disable core dumps, or
prevent debugging. Production deployment still requires a separate OS identity, debugger/core-dump
restrictions and an external launcher kill deadline.

After the runtime promise has completed its `finally` cleanup, the dedicated CLI terminates with an
explicit success or failure code. It does not rely on platform-specific natural draining of libuv
handles for inherited FIFO reads. This forced process exit happens only after bounded status writes
and descriptor cleanup have completed, and it never writes diagnostics to stdout or stderr.
