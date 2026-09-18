# HTTP and P2P ingress hardening

NIR's externally reachable validator transport and public node RPC use the shared
`http-ingress.mjs` admission boundary. The boundary is intentionally before JSON parsing,
authentication, signature verification, state reads, and transaction dispatch.

## Enforced boundary

The default production boundary enforces:

- at most 128 open server connections, 128 active requests globally, and 16 active requests per
  socket IP;
- a 600 requests/minute per-IP token bucket with a burst of 256 and at most 4,096 tracked IPs;
- 16 KiB of HTTP headers, 64 headers, a 2,048-byte request target, 100 requests per socket,
  5-second header and body-idle deadlines, a 10-second request deadline, and a 2-second keep-alive;
- 2 MiB validator bodies and 64 KiB public-node bodies, checked from `Content-Length` before body
  accumulation and checked again while streaming;
- rejection of ambiguous `Content-Length`/`Transfer-Encoding` framing and every content encoding
  other than absent or `identity` (there is no decompression amplification surface);
- the consensus JSON parser's bounded depth/canonical-data rules plus an ingress-level node-count
  bound implemented without recursive or wide-container spread operations;
- syntactic transport-signer validation before the bounded authentication scheduler performs
  post-quantum signature verification;
- existing authenticated nonce replay protection, peer reputation/quarantine, per-identity
  verification queues, and transaction/mempool duplicate handling after network admission.

The peer IP is taken only from the accepted socket. `Forwarded` and `X-Forwarded-For` are ignored
because they are attacker-controlled unless a separately configured trusted proxy terminates the
connection. Operators behind carrier NAT may need to tune the per-IP burst/concurrency limits;
raising them increases the amount one source can occupy. P2P identities are not charged to a
claimed signer until authentication succeeds, preventing unauthenticated quota spoofing. Before
that point, only bounded body parsing and the bounded pre-authentication scheduler are reachable.

## Observability and shutdown

Validator `/metrics` and public-node `/metrics` expose only aggregate `httpIngress` counters:
accepted requests, active/tracked counts, and rejections for rate, concurrency, URL, body size,
body timeout, encoding, and malformed input. They do not expose IPs, authentication material,
request bodies, paths on disk, keys, or tokens. Unexpected/internal error messages are returned as
`request rejected`; only classified client/protocol failures are returned verbatim.

Both server factories expose `server.gracefulShutdown(timeoutMs)`. It stops acceptance, closes idle
connections, lets in-flight work complete, and destroys remaining sockets after the bounded
deadline. Service managers should use it during SIGTERM handling rather than waiting indefinitely
on keep-alive or slow clients.

## Endpoint inventory and remaining boundaries

The audited server surfaces are:

- `validator-service.mjs`: public health/discovery/metrics, public transaction ingress,
  validator-authenticated P2P, and coordinator-authenticated RPC. It uses the shared boundary.
- `node-service.mjs`: public read/proof/account/fee RPC and transaction/faucet/operator POSTs. It
  uses the shared boundary. Deployments must still authenticate or disable faucet, block-production,
  and snapshot operator routes at the surrounding control plane; rate limiting is not authorization.
- `wallet-bridge.mjs`: loopback wallet signing/verification bridge. It already has per-route body,
  connection, header, request, and pending-operation limits plus pairing/session authorization. It
  must remain loopback-only; this change does not turn it into a public service.
- `archive-service.mjs`: immutable GET-only archive serving behind the shared admission boundary.
  It rejects request bodies and byte ranges, validates every stored chunk against its declared
  index/size service bound before listening, bounds manifest envelopes, and streams chunk JSON in
  64 KiB pieces while honoring socket backpressure. Clients still cryptographically verify chunk
  hashes, so a faulty/malicious source remains detectable and recovery can fall back to another.
  Aborted downloads release their concurrency admission on response close. Its CLI binds only to a
  loopback host; remote HTTPS termination belongs to the deployment proxy.
- `beacon-http-service.mjs` / `beacon-service.mjs`: the operator share endpoint uses an 8 KiB exact
  consensus-JSON request, validates the complete shape and context before random generation and
  post-quantum signing, persists a new share before replying, and serves duplicate requests from the
  durable idempotency map. Unique persisted shares are capped (10,000 by default) rather than
  allowing unbounded attacker-selected candidate IDs. The CLI now permits loopback binding only and
  handles SIGINT/SIGTERM with bounded graceful shutdown. Its vault is read descriptor-bound with
  `O_NOFOLLOW`; share state is an append-only 0600 fsync-backed log held open by descriptor, with
  operator-directory identity checks before and after append and an exclusive single-writer lock.
  Existing bounded JSON state is migrated once without following symlinks.
- backup/recovery listeners are test/operator recovery transports, not production public RPC.

Archive content authentication is end-to-end: clients verify the archive operator's signed manifest
and every chunk hash. HTTP requests themselves are intentionally unauthenticated because archives
are public immutable data. Beacon share requests also retain the existing unauthenticated wire
protocol; admission, exact parsing, idempotency, and capacity checks therefore all occur before
share generation/signing. New contexts are globally serialized; concurrent duplicates wait for the
same durable commit and never observe an uncommitted random share. An ambiguous persistence failure
poisons that context until restart, when the fsynced log decides whether the share exists. Operators
must expose the loopback beacon through an authenticated TLS control plane if callers need to be
restricted. The service does not trust forwarding headers and does not claim that rate limiting is
caller authentication.

Capacity exhaustion is fail-safe: existing contexts remain replayable, but new contexts receive
503 and no randomness is generated. Operators must alert well before the 10,000-record bound. They
must not delete or truncate the log, because doing so could let the authority sign a second random
share for an old context. Raising/archiving that bound requires an offline, audited state-migration
procedure; this increment intentionally does not automate destructive recovery.
After an unclean process death, the exclusive `.lock` file is deliberately left in place. An
operator must first prove that no beacon process still owns the state and that the append-only log
reverifies, then remove that exact lock while the service is stopped. Automatic stale-lock deletion
would risk two live signers and is intentionally absent.

These controls bound one process, not a distributed botnet. They also do not provide bandwidth
scrubbing, trusted-proxy identity, TLS termination policy, or cross-restart rate history. Production
operators still need host firewalling, file-descriptor limits, capacity alerts, and upstream DDoS
protection appropriate to their deployment.
