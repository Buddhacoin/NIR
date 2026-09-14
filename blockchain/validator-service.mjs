import { createServer } from "node:http";

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) reject(new Error("validator request is too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("validator request is not valid JSON")); }
    });
    request.on("error", reject);
  });
}

export function createValidatorHttpServer(validator) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://validator.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, {
          address: validator.address,
          height: validator.height,
          networkId: validator.networkId,
          status: "ready",
          tipHash: validator.tipHash,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/proposals") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorize(auth, request.method, url.pathname, payload);
        const result = { vote: validator.vote(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/timeouts") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorize(auth, request.method, url.pathname, payload);
        const result = { timeout: validator.timeout(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/blocks") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorize(auth, request.method, url.pathname, payload);
        const result = validator.commit(payload);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      return send(response, 400, { error: error.message });
    }
  });
}
