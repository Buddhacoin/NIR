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

async function gossipRequest(validator, index, url, path, payload) {
  if (validator.peerAddress(index) === validator.address) return null;
  const auth = validator.createValidatorRequest(path, payload);
  const response = await fetch(`${url}${path}`, {
    body: JSON.stringify({ auth, payload }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `gossip peer returned ${response.status}`);
  return validator.verifyValidatorResponse(index, body.auth, auth.nonce, body.result);
}

export function createValidatorHttpServer(validator, options = {}) {
  const shouldRejectProposal = typeof options.shouldRejectProposal === "function"
    ? options.shouldRejectProposal
    : () => false;
  const peerUrls = options.peerUrls ?? (() => validator.peerUrls);
  const ingressWindows = new Map();
  const consumeIngress = (address, now = Date.now()) => {
    const current = ingressWindows.get(address);
    const window = !current || now - current.startedAt >= 60_000
      ? { count: 0, startedAt: now }
      : current;
    if (window.count >= 20) throw new Error("transaction ingress rate limit exceeded");
    window.count += 1;
    ingressWindows.set(address, window);
    if (ingressWindows.size > 1_024) {
      for (const [key, value] of ingressWindows) {
        if (now - value.startedAt >= 60_000) ingressWindows.delete(key);
      }
    }
  };
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
          mempoolSize: validator.mempoolSize,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/transactions") {
        consumeIngress(request.socket.remoteAddress ?? "unknown");
        const payload = await readBody(request);
        const result = validator.submitTransaction(payload);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        const gossip = await Promise.allSettled(urls.map((peer, index) =>
          gossipRequest(validator, index, peer, "/v1/gossip/transactions", payload)));
        return send(response, 202, {
          ...result,
          gossipedPeers: gossip.filter(({ status, value }) => status === "fulfilled" && value).length,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/gossip/transactions") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const result = validator.submitTransaction(payload);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/mempool/transactions") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorize(auth, request.method, url.pathname, payload);
        const result = validator.submitTransaction(payload);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/mempool") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorize(auth, request.method, url.pathname, payload);
        const result = { transactions: validator.pendingTransactions() };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/proposals") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorize(auth, request.method, url.pathname, payload);
        if (shouldRejectProposal(payload)) throw new Error("proposal rejected by local round policy");
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
