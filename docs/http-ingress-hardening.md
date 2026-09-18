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
- `archive-service.mjs`: immutable GET-only archive serving with bounded stored chunks and HTTP
  timeouts/header count. A high-volume public deployment still needs connection/rate limiting at a
  reverse proxy or a later adoption of the shared boundary.
- `beacon-service.mjs`: operator beacon share service, loopback by default. Its CLI permits a custom
  bind host and therefore must not be Internet-exposed without authenticated transport and an
  ingress proxy; its current 8 KiB body cap alone is not a public-service defense.
- backup/recovery listeners are test/operator recovery transports, not production public RPC.

These controls bound one process, not a distributed botnet. They also do not provide bandwidth
scrubbing, trusted-proxy identity, TLS termination policy, or cross-restart rate history. Production
operators still need host firewalling, file-descriptor limits, capacity alerts, and upstream DDoS
protection appropriate to their deployment.
