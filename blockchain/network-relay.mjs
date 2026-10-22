// While NIR Майнер uses the shared network, NIR Wallet keeps talking to
// 127.0.0.1:8787 and this relay forwards its requests to the shared node.
// The relay is not trusted: the wallet verifies finality signatures and
// account proofs against the pinned genesis itself.
import { createServer } from "node:http";

const READ_PATH = /^\/(?:health|v1\/(?:genesis|allocations|fees|finality-proofs|proof-mining|names|validator-handoffs|names\/[a-z0-9.-]{1,40}|accounts\/nir1[0-9a-f]{64}(?:\/(?:proof|history|proof-rewards|name))?|transactions\/[0-9a-f]{64}\/proof|assets\/[0-9a-f]{64}\/proof))$/;
const POST_PATHS = new Set(["/v1/transactions", "/v1/faucet"]);
const MAX_BODY_BYTES = 64 * 1024;

function loopbackOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/.test(origin ?? "") ? origin : null;
}

export function createNetworkRelay(targetUrl, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const target = new URL(targetUrl);
  return createServer(async (request, response) => {
    const origin = request.headers.origin === undefined ? null : loopbackOrigin(request.headers.origin);
    const reply = (status, body, type = "application/json; charset=utf-8") => {
      response.writeHead(status, { "cache-control": "no-store", "content-type": type,
        ...(origin ? { "access-control-allow-origin": origin } : {}) });
      response.end(body);
    };
    try {
      if (request.headers.origin !== undefined && !origin) return reply(403, '{"error":"origin is not allowed"}');
      const url = new URL(request.url, "http://relay.local");
      if (request.method === "OPTIONS" && POST_PATHS.has(url.pathname)) {
        response.writeHead(204, { "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS", ...(origin ? { "access-control-allow-origin": origin } : {}) });
        return response.end();
      }
      const posting = request.method === "POST" && POST_PATHS.has(url.pathname);
      if (!posting && !(request.method === "GET" && READ_PATH.test(url.pathname))) {
        return reply(404, '{"error":"not found"}');
      }
      let body;
      if (posting) {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > MAX_BODY_BYTES) return reply(413, '{"error":"request is too large"}');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const forwarded = await fetchImpl(new URL(`${url.pathname}${url.search}`, target), {
        method: request.method, body, signal: AbortSignal.timeout(timeoutMs),
        headers: posting ? { "content-type": "application/json" } : {},
      });
      return reply(forwarded.status, Buffer.from(await forwarded.arrayBuffer()),
        forwarded.headers.get("content-type") ?? "application/json; charset=utf-8");
    } catch {
      return reply(502, '{"error":"the shared network did not answer"}');
    }
  });
}
