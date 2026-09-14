import { createServer } from "node:http";

const ADDRESS = /^nir1[0-9a-f]{64}$/;

function send(response, status, value, origin = null) {
  const body = JSON.stringify(value);
  const headers = {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  response.writeHead(status, headers);
  response.end(body);
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return null;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/.test(origin) ? origin : false;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let failed = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (failed) return;
      body += chunk;
      if (Buffer.byteLength(body) > 64 * 1024) {
        failed = true;
        reject(new Error("request body is too large"));
      }
    });
    request.on("end", () => {
      if (failed) return;
      try { resolve(JSON.parse(body)); } catch { reject(new Error("request body is not valid JSON")); }
    });
    request.on("error", reject);
  });
}

export function createNodeHttpServer(node) {
  return createServer(async (request, response) => {
    const origin = allowedOrigin(request);
    if (origin === false) return send(response, 403, { error: "origin is not allowed" });
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        ...(origin ? { "access-control-allow-origin": origin } : {}),
      });
      response.end(); return;
    }
    try {
      const url = new URL(request.url, "http://node.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, {
          height: node.height, networkId: node.networkId, status: "ready",
          tipHash: node.tipHash, valueMode: "valueless-devnet",
        }, origin);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/accounts/")) {
        const address = decodeURIComponent(url.pathname.slice("/v1/accounts/".length));
        if (!ADDRESS.test(address)) throw new Error("address is invalid");
        return send(response, 200, node.account(address), origin);
      }
      if (request.method === "GET" && url.pathname === "/v1/fees") {
        return send(response, 200, node.feeQuote(url.searchParams.get("amount"),
          url.searchParams.get("fee") ?? undefined), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/transactions") {
        const body = await readBody(request);
        return send(response, 202, node.submitTransaction(body), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/faucet") {
        const { recipient, amount } = await readBody(request);
        if (!ADDRESS.test(recipient ?? "")) throw new Error("recipient is invalid");
        return send(response, 202, node.faucet(recipient, amount), origin);
      }
      return send(response, 404, { error: "not found" }, origin);
    } catch (error) {
      return send(response, 400, { error: error.message }, origin);
    }
  });
}
