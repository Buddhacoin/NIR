import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { blockHash, transactionId } from "./chain.mjs";
import { selectHighestCertifiedProposal } from "./consensus-view.mjs";
import { requestJson } from "./http-client.mjs";
import { IngressLimiter } from "./ingress-limiter.mjs";

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
  const response = await requestJson(`${url}${path}`, {
    body: { auth, payload },
    method: "POST",
    tlsCertificateSha256: validator.peerTlsCertificateSha256(index),
  });
  if (!response.ok) throw new Error(response.body.error ?? `gossip peer returned ${response.status}`);
  return validator.verifyValidatorResponse(
    index, response.body.auth, auth.nonce, response.body.result,
  );
}

async function peerHealth(validator, index, url) {
  if (validator.peerAddress(index) === validator.address) return null;
  const response = await requestJson(`${url}/health`, {
    tlsCertificateSha256: validator.peerTlsCertificateSha256(index),
  });
  const body = response.body;
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

async function discoverLockedProposal(validator, urls) {
  const reports = await Promise.allSettled(urls.map(async (peer, index) => {
    if (validator.peerAddress(index) === validator.address) {
      return { index, lock: validator.lockedProposal() };
    }
    const result = await gossipRequest(validator, index, peer, "/v1/p2p/locks", {
      height: validator.height + 1,
    });
    return { index, lock: result.lock };
  }));
  const groups = new Map();
  for (const report of reports) {
    if (report.status !== "fulfilled" || report.value.lock === null) continue;
    try {
      const expected = validator.peerAddress(report.value.index);
      const candidate = validator.validateLockedProposal(report.value.lock, expected);
      const hash = blockHash(candidate.proposal);
      const group = groups.get(hash) ?? { certified: true, count: 0, ...candidate };
      group.count += 1;
      if (candidate.proposal.round > group.proposal.round) Object.assign(group, candidate);
      groups.set(hash, group);
    } catch {
      // An invalid or forged lock report cannot influence proposal selection.
    }
  }
  return selectHighestCertifiedProposal(groups, validator.validatorCount);
}

async function finalizeValidatorProposal(validator, urls, proposal, recoveredPrepare = null) {
  if (proposal.proposer !== validator.address) throw new Error("proposal producer is not its elected proposer");
  let prepareCertificate;
  if (recoveredPrepare) {
    prepareCertificate = validator.prepareCertificate(proposal, recoveredPrepare);
  } else {
    const ownPrepare = validator.vote(proposal);
    const responses = await Promise.allSettled(urls.map((peer, index) =>
      gossipRequest(validator, index, peer, "/v1/p2p/proposals", proposal)));
    const prepares = [ownPrepare, ...responses
      .filter(({ status, value }) => status === "fulfilled" && value)
      .map(({ value }) => value.vote)];
    prepareCertificate = validator.prepareCertificate(proposal, prepares);
  }
  const ownCommit = validator.commitVote(proposal, prepareCertificate);
  const commitResponses = await Promise.allSettled(urls.map((peer, index) =>
    gossipRequest(validator, index, peer, "/v1/p2p/commits", {
      prepareCertificate, proposal,
    })));
  const commits = [ownCommit, ...commitResponses
    .filter(({ status, value }) => status === "fulfilled" && value)
    .map(({ value }) => value.vote)];
  const block = validator.finalizeProposal(proposal, prepareCertificate, commits);
  const broadcasts = await Promise.allSettled(urls.map((peer, index) =>
    gossipRequest(validator, index, peer, "/v1/p2p/blocks", block)));
  return {
    blockHash: block.hash,
    committedPeers: 1 + broadcasts.filter(({ status, value }) => status === "fulfilled" && value).length,
    height: block.height,
    round: block.round,
    transactions: block.transactions.map(transactionId),
    commits: new Set(block.certificate.map(({ validator: address }) => address)).size,
    prepares: new Set(block.prepareCertificate.map(({ validator: address }) => address)).size,
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

function roundDelay(round, baseMs, maximumMs) {
  return Math.min(maximumMs, baseMs * (2 ** Math.min(round, 16)));
}

async function waitForRoundTimeout(validator, request, baseMs, maximumMs) {
  const delayMs = roundDelay(request.proposal.round, baseMs, maximumMs);
  let remaining = validator.observeRoundTimeout(request, delayMs);
  while (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
    remaining = validator.observeRoundTimeout(request, delayMs);
  }
}

async function timeoutProposal(validator, urls, proposal, baseMs, maximumMs) {
  const nextRound = proposal.round + 1;
  const request = { proposal, nextRound };
  await waitForRoundTimeout(validator, request, baseMs, maximumMs);
  if (await proposerIsReachable(validator, urls, proposal.proposer)) {
    throw new Error("elected proposer recovered before the timeout elapsed");
  }
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

async function produceValidatorBlock(validator, urls, baseMs, maximumMs) {
  await synchronizeValidator(validator, urls);
  const recovered = await discoverLockedProposal(validator, urls);
  let prepareCertificate = recovered?.prepareCertificate ?? null;
  let proposal = recovered?.proposal ?? validator.preparedProposal(0)?.proposal ?? validator.buildProposal();
  while (proposal.proposer !== validator.address) {
    if (await proposerIsReachable(validator, urls, proposal.proposer)) {
      throw new Error(`this validator is not the proposer; expected ${proposal.proposer}`);
    }
    proposal = await timeoutProposal(validator, urls, proposal, baseMs, maximumMs);
    const proposerIndex = Array.from({ length: validator.validatorCount })
      .findIndex((_, index) => validator.peerAddress(index) === proposal.proposer);
    if (proposal.proposer !== validator.address &&
        await proposerIsReachable(validator, urls, proposal.proposer)) {
      return gossipRequest(
        validator, proposerIndex, urls[proposerIndex], "/v1/p2p/produce",
        { prepareCertificate, proposal },
      );
    }
  }
  return finalizeValidatorProposal(validator, urls, proposal, prepareCertificate);
}

export function createValidatorHttpServer(validator, options = {}) {
  const shouldRejectProposal = typeof options.shouldRejectProposal === "function"
    ? options.shouldRejectProposal
    : () => false;
  const peerUrls = options.peerUrls ?? (() => validator.peerUrls);
  const roundTimeoutMs = options.roundTimeoutMs ?? 250;
  const maxRoundTimeoutMs = options.maxRoundTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(roundTimeoutMs) || roundTimeoutMs < 1 || roundTimeoutMs > 2_000 ||
      !Number.isSafeInteger(maxRoundTimeoutMs) || maxRoundTimeoutMs < roundTimeoutMs ||
      maxRoundTimeoutMs > 2_000) {
    throw new Error("validator round timeout configuration is invalid");
  }
  const ingressLimiter = options.ingressLimiter ?? new IngressLimiter();
  if (typeof ingressLimiter.consume !== "function") {
    throw new Error("validator ingress limiter is invalid");
  }
  const consumeIngress = (request) =>
    ingressLimiter.consume(request.socket.remoteAddress ?? "unknown");
  const tls = options.tls ?? null;
  if (tls !== null && (typeof tls.key !== "string" && !Buffer.isBuffer(tls.key) ||
      typeof tls.cert !== "string" && !Buffer.isBuffer(tls.cert))) {
    throw new Error("validator TLS key and certificate are required");
  }
  const createServer = tls === null
    ? (handler) => createHttpServer(handler)
    : (handler) => createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.3" }, handler);
  const server = createServer(async (request, response) => {
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
      if (request.method === "GET" && url.pathname === "/v1/discovery") {
        consumeIngress(request);
        return send(response, 200, validator.peerAnnouncement());
      }
      if (request.method === "POST" && url.pathname === "/v1/transactions") {
        consumeIngress(request);
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
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/proposals") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        if (validator.validatorAddressForPeerSigner(auth.signer) !== payload.proposer) {
          throw new Error("proposal was not sent by its proposer");
        }
        const result = { vote: validator.vote(payload) };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/commits") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        if (validator.validatorAddressForPeerSigner(auth.signer) !== payload.proposal.proposer) {
          throw new Error("commit certificate was not sent by its proposer");
        }
        const result = {
          vote: validator.commitVote(payload.proposal, payload.prepareCertificate),
        };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/locks") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        if (payload?.height !== validator.height + 1) throw new Error("lock height is invalid");
        const result = { lock: validator.lockedProposal() };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/timeouts") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        if (await proposerIsReachable(validator, urls, payload?.proposal?.proposer)) {
          throw new Error("refusing timeout while the elected proposer is reachable");
        }
        await waitForRoundTimeout(validator, payload, roundTimeoutMs, maxRoundTimeoutMs);
        if (await proposerIsReachable(validator, urls, payload?.proposal?.proposer)) {
          throw new Error("elected proposer recovered before the timeout elapsed");
        }
        const result = { timeout: validator.timeout(payload) };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/produce") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        const result = await finalizeValidatorProposal(
          validator, urls, payload.proposal, payload.prepareCertificate ?? null,
        );
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/blocks") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const result = validator.commit(payload);
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/blocks/range") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorizeValidator(auth, request.method, url.pathname, payload);
        const result = { blocks: validator.blocksAfter(payload.fromHeight, payload.limit) };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/sync") {
        consumeIngress(request);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        return send(response, 200, await synchronizeValidator(validator, urls));
      }
      if (request.method === "POST" && url.pathname === "/v1/blocks/produce") {
        consumeIngress(request);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        return send(response, 202, await produceValidatorBlock(
          validator, urls, roundTimeoutMs, maxRoundTimeoutMs,
        ));
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
      if (request.method === "POST" && url.pathname === "/v1/commits") {
        const { auth, payload } = await readBody(request);
        const nonce = validator.authorize(auth, request.method, url.pathname, payload);
        const result = {
          vote: validator.commitVote(payload.proposal, payload.prepareCertificate),
        };
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
  const maxConnections = options.maxConnections ?? 128;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 4 || maxConnections > 10_000) {
    throw new Error("validator connection limit is invalid");
  }
  server.maxConnections = maxConnections;
  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  return server;
}
