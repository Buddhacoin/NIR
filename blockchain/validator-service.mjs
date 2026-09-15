import { createServer } from "node:http";

import { transactionId } from "./chain.mjs";

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

async function peerHealth(validator, index, url) {
  if (validator.peerAddress(index) === validator.address) return null;
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
  const body = await response.json();
  if (!response.ok || body.address !== validator.peerAddress(index) ||
      body.networkId !== validator.networkId || !Number.isSafeInteger(body.height)) {
    throw new Error("peer health identity or height is invalid");
  }
  return body;
}

async function synchronizeValidator(validator, urls) {
  const statuses = await Promise.allSettled(urls.map((url, index) =>
    peerHealth(validator, index, url)));
  const candidates = statuses.map((result, index) => ({
    height: result.status === "fulfilled" && result.value ? result.value.height : -1,
    index,
  })).filter(({ height }) => height > validator.height).sort((a, b) => b.height - a.height);
  let syncedBlocks = 0;
  for (const candidate of candidates) {
    try {
      while (validator.height < candidate.height) {
        const result = await gossipRequest(
          validator, candidate.index, urls[candidate.index], "/v1/p2p/blocks/range",
          { fromHeight: validator.height + 1, limit: 8 },
        );
        if (!result || !Array.isArray(result.blocks) || result.blocks.length === 0) break;
        for (const block of result.blocks) {
          validator.commit(block);
          syncedBlocks += 1;
        }
      }
      if (validator.height >= candidate.height) break;
    } catch {
      // Try the next independently authenticated peer.
    }
  }
  return { height: validator.height, syncedBlocks, tipHash: validator.tipHash };
}

async function finalizeValidatorProposal(validator, urls, proposal) {
  if (proposal.proposer !== validator.address) throw new Error("proposal producer is not its elected proposer");
  const ownVote = validator.vote(proposal);
  const responses = await Promise.allSettled(urls.map((peer, index) =>
    gossipRequest(validator, index, peer, "/v1/p2p/proposals", proposal)));
  const votes = [ownVote, ...responses
    .filter(({ status, value }) => status === "fulfilled" && value)
    .map(({ value }) => value.vote)];
  const block = validator.finalizeProposal(proposal, votes);
  const broadcasts = await Promise.allSettled(urls.map((peer, index) =>
    gossipRequest(validator, index, peer, "/v1/p2p/blocks", block)));
  return {
    blockHash: block.hash,
    committedPeers: 1 + broadcasts.filter(({ status, value }) => status === "fulfilled" && value).length,
    height: block.height,
    round: block.round,
    transactions: block.transactions.map(transactionId),
    votes: new Set(block.certificate.map(({ validator: address }) => address)).size,
  };
}

async function proposerIsReachable(validator, urls, address) {
  const index = Array.from({ length: validator.validatorCount })
    .findIndex((_, candidate) => validator.peerAddress(candidate) === address);
  if (index < 0) throw new Error("expected proposer is not in the validator set");
  if (address === validator.address) return true;
  try {
    await peerHealth(validator, index, urls[index]);
    return true;
  } catch {
    return false;
  }
}

async function timeoutProposal(validator, urls, proposal) {
  const nextRound = proposal.round + 1;
  const request = { proposal, nextRound };
  const ownTimeout = validator.timeout(request);
  const responses = await Promise.allSettled(urls.map((peer, index) =>
    gossipRequest(validator, index, peer, "/v1/p2p/timeouts", request)));
  const timeouts = [ownTimeout, ...responses
    .filter(({ status, value }) => status === "fulfilled" && value)
    .map(({ value }) => value.timeout)];
  const uniqueTimeouts = new Map(timeouts.map((vote) => [vote.validator, vote]));
  const quorum = Math.floor((validator.validatorCount * 2) / 3) + 1;
  if (uniqueTimeouts.size < quorum) {
    throw new Error(`round timeout quorum not reached (${uniqueTimeouts.size}/${quorum})`);
  }
  return validator.advanceProposal(proposal, nextRound, [...uniqueTimeouts.values()]);
}

async function produceValidatorBlock(validator, urls) {
  await synchronizeValidator(validator, urls);
  let proposal = validator.buildProposal();
  while (proposal.proposer !== validator.address) {
    if (await proposerIsReachable(validator, urls, proposal.proposer)) {
      throw new Error(`this validator is not the proposer; expected ${proposal.proposer}`);
    }
    proposal = await timeoutProposal(validator, urls, proposal);
    const proposerIndex = Array.from({ length: validator.validatorCount })
      .findIndex((_, index) => validator.peerAddress(index) === proposal.proposer);
    if (proposal.proposer !== validator.address &&
        await proposerIsReachable(validator, urls, proposal.proposer)) {
      return gossipRequest(
        validator, proposerIndex, urls[proposerIndex], "/v1/p2p/produce", { proposal },
      );
    }
  }
  return finalizeValidatorProposal(validator, urls, proposal);
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
      if (request.method === "POST" && url.pathname === "/v1/p2p/proposals") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        if (auth.signer !== payload.proposer) throw new Error("proposal was not sent by its proposer");
        const result = { vote: validator.vote(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/timeouts") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        if (await proposerIsReachable(validator, urls, payload?.proposal?.proposer)) {
          throw new Error("refusing timeout while the elected proposer is reachable");
        }
        const result = { timeout: validator.timeout(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/produce") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        const result = await finalizeValidatorProposal(validator, urls, payload.proposal);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/blocks") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const result = validator.commit(payload);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/blocks/range") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const result = { blocks: validator.blocksAfter(payload.fromHeight, payload.limit) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/sync") {
        consumeIngress(request.socket.remoteAddress ?? "unknown");
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        return send(response, 200, await synchronizeValidator(validator, urls));
      }
      if (request.method === "POST" && url.pathname === "/v1/blocks/produce") {
        consumeIngress(request.socket.remoteAddress ?? "unknown");
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        return send(response, 202, await produceValidatorBlock(validator, urls));
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
