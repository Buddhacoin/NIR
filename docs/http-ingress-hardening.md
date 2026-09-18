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
  versioned, post-quantum signed consensus-JSON envelope. It binds network, beacon address, purpose,
  candidate, round, requester, timestamp/expiry and nonce, then validates authorization, validity
  window and durable replay state before random generation and share signing. Unique persisted
  shares are capped (10,000 by default) rather than
  allowing unbounded attacker-selected candidate IDs. The CLI now permits loopback binding only and
  handles SIGINT/SIGTERM with bounded graceful shutdown. Its vault is read descriptor-bound with
  `O_NOFOLLOW`; share state is an append-only 0600 fsync-backed log held open by descriptor, with
  operator-directory identity checks before and after append and an exclusive single-writer lock.
  Existing bounded JSON state is migrated once without following symlinks.
- backup/recovery listeners are test/operator recovery transports, not production public RPC.

Archive content authentication is end-to-end: clients verify the archive operator's signed manifest
and every chunk hash. HTTP requests themselves are intentionally unauthenticated because archives
are public immutable data. Beacon share requests are accepted only from explicitly configured,
unique requester transport identities. Requester addresses, public keys and operator IDs must be
distinct and may not occur in the policy's required `reservedAddresses` / `reservedOperatorIds`
lists for beacon/finality identities. Unknown claimed
requesters are rejected before expensive signature verification; authorized signatures run through
a bounded pre-auth scheduler. New contexts are globally serialized; concurrent nonce duplicates
cannot observe an uncommitted random share. The nonce and a new share are appended in one fsynced
record. An ambiguous persistence failure poisons that context until restart, when the log decides
whether it exists.

The beacon CLI now requires
`<wallet-vault> <network-id> <requester-policy.json> [port] [loopback-host] [tls-cert tls-key]`.
The exact policy is `nir-beacon-requester-policy-v1` and contains `networkId`, `beaconAddress`,
public `{address, algorithm, operatorId, publicKey}` requesters, plus complete reviewed
`reservedAddresses` and `reservedOperatorIds` lists for chain finality and beacon roles.
The policy and private key are descriptor-bound 0600 inputs. Supplying only one TLS file fails
closed. Supplying both enables a TLS 1.3 server; certificate pinning remains a client/deployment
responsibility. This is server TLS plus signed application requests, not mTLS.

Capacity exhaustion is fail-safe: existing contexts remain available to newly signed requests, but
new contexts receive 503 and no randomness is generated. Operators must alert well before the
10,000-share or 100,000-nonce bound. `/metrics` reports aggregate anti-replay generation,
high-water, file size, active/capacity/remaining nonce counts, without requester identities or
nonces. Operators must not delete or truncate any generation, because doing so could let the
authority sign a second random share for an old context.

Bounded nonce compaction is an explicit offline operation. With the beacon stopped, run:

```text
node blockchain/beacon-state-cli.mjs plan <vault> <beacon-address> <network-id> <trusted-now-ms> [safety-margin-ms]
node blockchain/beacon-state-cli.mjs compact <vault> <beacon-address> <network-id> <trusted-now-ms> [safety-margin-ms]
node blockchain/beacon-state-cli.mjs verify <vault> <beacon-address> <network-id>
```

`trusted-now-ms` is an operator-observed monotonic time assertion; it may equal but cannot precede
the persisted high-water. It advances high-water even after an idle period, so a later wall-clock
rollback cannot make an expired signed request valid again. A dangerously future assertion fails
safe by rejecting requests until wall time catches up, so operators must source and review it. A
nonce is pruned only when `expiresAt <= trusted-now - safety-margin`; all shares and all remaining
nonces are copied.

Compaction acquires the normal single-writer lock, hashes and rechecks the active source immediately
before creating the next exact generation with `O_EXCL`, fsyncs a self-contained checkpoint and
seal, and never replaces or deletes an earlier generation. Each checkpoint binds the full previous
generation hash. A partial/gapped/conflicting generation makes startup and `verify` fail closed.
After success the old open handle rejects appends and the process must restart onto the new
generation. This retains disk usage intentionally: reviewed removal or off-host archival of old
generations is a separate manual policy, not part of this tool. Verification also caps the chain at
64 total generations and 1 GiB, while each generation remains capped at 128 MiB; reaching those
bounds is a fail-closed operator event, not an automatic deletion trigger.

After an unclean process death, the exclusive `.lock` file is deliberately left in place. An
operator must first prove that no beacon process still owns the state and that the append-only log
reverifies, then remove that exact lock while the service is stopped. Automatic stale-lock deletion
would risk two live signers and is intentionally absent.

These controls bound one process, not a distributed botnet. They also do not provide bandwidth
scrubbing, trusted-proxy identity, TLS termination policy, or cross-restart rate history. Production
operators still need host firewalling, file-descriptor limits, capacity alerts, and upstream DDoS
protection appropriate to their deployment.
