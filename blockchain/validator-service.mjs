import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { blockHash, transactionId } from "./chain.mjs";
import {
  isProtectedBeaconAdmission,
  verifyAdmissionInclusionCertificate,
} from "./admission-inclusion.mjs";
import { selectHighestCertifiedProposal } from "./consensus-view.mjs";
import { requestJson } from "./http-client.mjs";
import {
  hardenHttpServer,
  HTTP_MAX_HEADER_BYTES,
  HttpIngressGuard,
  ingressErrorResponse,
  readBoundedConsensusJson,
} from "./http-ingress.mjs";
import { IngressLimiter } from "./ingress-limiter.mjs";
import { MAX_SNAPSHOT_BYTES } from "./state-snapshot.mjs";
import { MAX_HANDOFF_STORE_BYTES } from "./validator-handoff-store.mjs";
import { MAX_TOPOLOGY_STORE_BYTES } from "./validator-topology-history.mjs";
import { MAX_CERTIFICATE_STORE_BYTES } from "./certificate-lifecycle-store.mjs";
import { CERTIFICATE_MODE_LIFECYCLE } from "./certificate-runtime.mjs";
import {
  boundedAllSettled,
  PeerReputation,
  VerificationScheduler,
} from "./operator-defense.mjs";

const SNAPSHOT_CATCHUP_THRESHOLD = 16;
const MAX_TOPOLOGY_HISTORY_RESPONSE_BYTES =
  MAX_HANDOFF_STORE_BYTES + MAX_TOPOLOGY_STORE_BYTES + 64 * 1024;
const MAX_CERTIFICATE_HISTORY_RESPONSE_BYTES = MAX_CERTIFICATE_STORE_BYTES + 64 * 1024;
const SIGNER = /^nir1[0-9a-f]{64}$/;
const VALIDATOR_AUTH_PATHS = new Set([
  "/v1/gossip/transactions", "/v1/p2p/blocks", "/v1/p2p/blocks/range",
  "/v1/p2p/commits", "/v1/p2p/handoffs", "/v1/p2p/handoffs/history",
  "/v1/p2p/certificates/history",
  "/v1/p2p/health", "/v1/p2p/locks", "/v1/p2p/produce",
  "/v1/p2p/proposals", "/v1/p2p/snapshots/candidate", "/v1/p2p/timeouts",
  "/v1/p2p/topologies/history",
]);
const COORDINATOR_AUTH_PATHS = new Set([
  "/v1/accounts/proof-attest", "/v1/accounts/proof-candidate", "/v1/blocks",
  "/v1/assets/proof-attest", "/v1/assets/proof-candidate",
  "/v1/commits", "/v1/handoffs", "/v1/handoffs/history", "/v1/health",
  "/v1/mempool", "/v1/mempool/transactions", "/v1/proposals",
  "/v1/snapshots/attest", "/v1/snapshots/candidate", "/v1/timeouts",
]);

function publicRequestIdentity(path) {
  return `public:${path.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160)}`;
}

function objectivePeerViolation(error) {
  return /invalid|malformed|unexpected|conflict|duplicate|replay|mismatch|not deterministic|not sent by|too many|exceeds|unknown transaction/i
    .test(error?.message ?? "");
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function gossipPeerRequest(
  validator, peer, path, payload, maxResponseBytes = undefined,
) {
  if (peer.validatorAddress === validator.address) return null;
  const auth = validator.createValidatorRequest(path, payload);
  const response = await requestJson(`${peer.url}${path}`, {
    body: { auth, payload },
    method: "POST",
    maxResponseBytes,
    timeoutMs: path === "/v1/p2p/blocks" ? 10_000 : 3_000,
    tlsCertificateSha256Pins: peer.tlsCertificateSha256Pins ??
      (peer.tlsCertificateSha256 === null ? null : [peer.tlsCertificateSha256]),
  });
  if (!response.ok) throw new Error(response.body.error ?? `gossip peer returned ${response.status}`);
  return validator.verifyValidatorResponseFrom(
    peer.transport, response.body.auth, auth.nonce, response.body.result,
  );
}

async function gossipRequest(validator, index, url, path, payload, maxResponseBytes = undefined) {
  return gossipPeerRequest(
    validator, validator.peerDescriptor(index, url), path, payload, maxResponseBytes,
  );
}

async function peerHealthDescriptor(validator, peer) {
  if (peer.validatorAddress === validator.address) return null;
  const body = await gossipPeerRequest(validator, peer, "/v1/p2p/health", {});
  if (body.address !== peer.validatorAddress ||
      body.networkId !== validator.networkId || !Number.isSafeInteger(body.height)) {
    throw new Error("peer health identity or height is invalid");
  }
  return body;
}

async function peerHealth(validator, index, url) {
  return peerHealthDescriptor(validator, validator.peerDescriptor(index, url));
}

async function discoverRecoveryPeers(validator, peers) {
  const responses = await boundedAllSettled(peers, (peer) =>
    gossipPeerRequest(
      validator, peer, "/v1/p2p/topologies/history", {},
      MAX_TOPOLOGY_HISTORY_RESPONSE_BYTES,
    ));
  const histories = responses
    .filter(({ status, value }) => status === "fulfilled" &&
      Array.isArray(value?.handoffs) && value.handoffs.length > 0 &&
      Array.isArray(value?.onboardings))
    .map(({ value }) => value)
    .sort((left, right) => right.handoffs.length - left.handoffs.length);
  if (histories.length > 0) {
    try {
      const installed = validator.installValidatorRecoveryHistoryCandidates(histories);
      return { installedHandoffs: installed.installedHandoffs, peers: installed.peers };
    } catch (error) {
      if (error?.code !== "ERR_NO_VALID_TOPOLOGY") throw error;
      // Authenticated garbage cannot replace the configured topology or block ordinary catch-up.
    }
  }
  return { installedHandoffs: 0, peers };
}

async function synchronizeCertificateLifecycle(validator, urls) {
  if (validator.certificateMode !== CERTIFICATE_MODE_LIFECYCLE) {
    return { records: 0, status: "disabled" };
  }
  const localHistory = validator.certificateLifecycleHistory();
  const peers = urls.map((url, index) => validator.peerDescriptor(index, url));
  const responses = await boundedAllSettled(peers, (peer) => gossipPeerRequest(
    validator, peer, "/v1/p2p/certificates/history", {},
    MAX_CERTIFICATE_HISTORY_RESPONSE_BYTES,
  ));
  const candidates = [{ history: localHistory, source: validator.address }];
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    if (response.status === "fulfilled" && Array.isArray(response.value?.history)) {
      candidates.push({ history: response.value.history, source: peers[index].validatorAddress });
    }
  }
  return validator.installCertificateLifecycleHistoryCandidates(candidates);
}

async function synchronizeValidator(validator, urls) {
  const configuredPeers = urls.map((url, index) => validator.peerDescriptor(index, url));
  const recovery = await discoverRecoveryPeers(validator, configuredPeers);
  const certificateSync = await synchronizeCertificateLifecycle(validator, urls);
  const syncPeers = recovery.peers;
  const statuses = await boundedAllSettled(syncPeers, (peer) =>
    peerHealthDescriptor(validator, peer));
  const candidates = statuses.map((result, index) => ({
    height: result.status === "fulfilled" && result.value ? result.value.height : -1,
    index,
  })).filter(({ height }) => height > validator.height).sort((a, b) => b.height - a.height);
  let syncedBlocks = 0;
  let snapshotHeight = null;
  if ((candidates[0]?.height ?? validator.height) - validator.height >= SNAPSHOT_CATCHUP_THRESHOLD) {
    const snapshots = await boundedAllSettled(syncPeers, (peer) =>
      gossipPeerRequest(
        validator, peer, "/v1/p2p/snapshots/candidate", {},
        MAX_SNAPSHOT_BYTES + 64 * 1024,
      ));
    try {
      const accepted = snapshots
        .filter(({ status, value }) => status === "fulfilled" && value?.snapshot)
        .map(({ value }) => value.snapshot);
      const installed = validator.installStateSnapshotCandidates(accepted);
      snapshotHeight = installed.height;
    } catch {
      // A missing or conflicting snapshot quorum falls back to full block replay.
    }
  }
  for (const candidate of candidates) {
    try {
      while (validator.height < candidate.height) {
        const result = await gossipPeerRequest(
          validator, syncPeers[candidate.index], "/v1/p2p/blocks/range",
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
  const activeUrls = validator.peerUrls;
  const handoffResponses = await boundedAllSettled(activeUrls, (url, index) =>
    gossipRequest(
      validator, index, url, "/v1/p2p/handoffs/history", {},
      MAX_TOPOLOGY_HISTORY_RESPONSE_BYTES,
    ));
  const histories = handoffResponses
    .filter(({ status, value }) => status === "fulfilled" && Array.isArray(value?.handoffs))
    .map(({ value }) => value.handoffs)
    .sort((left, right) => right.length - left.length);
  let synchronizedHandoffs = recovery.installedHandoffs;
  for (const history of histories) {
    for (const handoff of history) {
      try {
        const result = validator.installFinalizedValidatorHandoff(handoff);
        if (result.status === "installed") synchronizedHandoffs += 1;
      } catch {
        // A malformed, conflicting, or premature history cannot block other peers.
      }
    }
  }
  return {
    height: validator.height,
    snapshotHeight,
    syncedBlocks,
    synchronizedHandoffs,
    synchronizedCertificateRecords: certificateSync.records,
    certificateHistoryStatus: certificateSync.status,
    tipHash: validator.tipHash,
  };
}

async function discoverLockedProposal(validator, urls) {
  const reports = await boundedAllSettled(urls, async (peer, index) => {
    if (validator.peerAddress(index) === validator.address) {
      return { index, lock: validator.lockedProposal() };
    }
    const result = await gossipRequest(validator, index, peer, "/v1/p2p/locks", {
      height: validator.height + 1,
    });
    return { index, lock: result.lock };
  });
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
  return selectHighestCertifiedProposal(
    groups, validator.validatorCountForHeight(validator.height + 1),
  );
}

async function finalizeValidatorProposal(validator, urls, proposal, recoveredPrepare = null) {
  if (proposal.proposer !== validator.address) throw new Error("proposal producer is not its elected proposer");
  const transitionPeers = urls.map((url, index) => validator.peerDescriptor(index, url));
  let prepareCertificate;
  if (recoveredPrepare) {
    prepareCertificate = validator.prepareCertificate(proposal, recoveredPrepare);
  } else {
    const ownPrepare = validator.vote(proposal);
    const responses = await boundedAllSettled(urls, (peer, index) =>
      gossipRequest(validator, index, peer, "/v1/p2p/proposals", proposal));
    const prepares = [ownPrepare, ...responses
      .filter(({ status, value }) => status === "fulfilled" && value)
      .map(({ value }) => value.vote)];
    prepareCertificate = validator.prepareCertificate(proposal, prepares);
  }
  const ownCommit = validator.commitVote(proposal, prepareCertificate);
  const ownHandoffCandidate = validator.validatorHandoffCandidate(proposal);
  const commitResponses = await boundedAllSettled(urls, (peer, index) =>
    gossipRequest(validator, index, peer, "/v1/p2p/commits", {
      prepareCertificate, proposal,
    }));
  const commits = [ownCommit, ...commitResponses
    .filter(({ status, value }) => status === "fulfilled" && value)
    .map(({ value }) => value.vote)];
  const handoffCandidates = [ownHandoffCandidate, ...commitResponses
    .filter(({ status, value }) => status === "fulfilled" && value?.handoffCandidate)
    .map(({ value }) => value.handoffCandidate)].filter(Boolean);
  const handoff = ownHandoffCandidate === null ? null
    : validator.assembleValidatorHandoffCandidates(handoffCandidates, proposal);
  const block = validator.finalizeProposal(proposal, prepareCertificate, commits);
  if (handoff) validator.installFinalizedValidatorHandoff(handoff);
  const broadcasts = await boundedAllSettled(transitionPeers, (peer) =>
    gossipPeerRequest(validator, peer, "/v1/p2p/blocks", block));
  if (handoff) {
    await boundedAllSettled(transitionPeers, (peer) =>
      gossipPeerRequest(validator, peer, "/v1/p2p/handoffs", handoff));
  }
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
  const index = Array.from({ length: validator.peerCount })
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
  const responses = await boundedAllSettled(urls, (peer, index) =>
    gossipRequest(validator, index, peer, "/v1/p2p/timeouts", request));
  const timeouts = [ownTimeout, ...responses
    .filter(({ status, value }) => status === "fulfilled" && value)
    .map(({ value }) => value.timeout)];
  const uniqueTimeouts = new Map(timeouts.map((vote) => [vote.validator, vote]));
  const quorum = Math.floor((validator.validatorCountForHeight(proposal.height) * 2) / 3) + 1;
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
    const proposerIndex = Array.from({ length: validator.peerCount })
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
  const verificationScheduler = options.verificationScheduler ?? new VerificationScheduler();
  const authenticationScheduler = options.authenticationScheduler ?? new VerificationScheduler({
    maxConcurrent: 8,
    maxPerIdentity: 8,
    maxQueued: 128,
    maxQueuedPerIdentity: 128,
  });
  const peerReputation = options.peerReputation ?? new PeerReputation();
  if (typeof verificationScheduler.run !== "function" ||
      typeof verificationScheduler.metrics !== "function" ||
      typeof authenticationScheduler.run !== "function" ||
      typeof authenticationScheduler.metrics !== "function" ||
      typeof peerReputation.assertAllowed !== "function" ||
      typeof peerReputation.recordViolation !== "function" ||
      typeof peerReputation.metrics !== "function") {
    throw new Error("validator operator-defense configuration is invalid");
  }
  const consumeIngress = (identity) => ingressLimiter.consume(identity);
  const httpIngressOptions = options.httpIngress ?? {};
  const httpIngress = new HttpIngressGuard(httpIngressOptions);
  const tls = options.tls ?? null;
  if (tls !== null && (typeof tls.key !== "string" && !Buffer.isBuffer(tls.key) ||
      typeof tls.cert !== "string" && !Buffer.isBuffer(tls.cert))) {
    throw new Error("validator TLS key and certificate are required");
  }
  const handler = async (request, response) => {
    let authenticatedIdentity = null;
    let identity = "public:unknown";
    let finishIngress = null;
    try {
      finishIngress = httpIngress.begin(request);
      const url = new URL(request.url, "http://validator.local");
      if (request.method === "GET" && url.pathname === "/health") {
        identity = "public:health";
        consumeIngress(identity);
        peerReputation.assertAllowed(identity);
        return await verificationScheduler.run(identity, () => send(response, 200, {
          address: validator.address,
          certificateMode: validator.certificateMode,
          height: validator.height,
          networkId: validator.networkId,
          pendingProtocolUpgrade: validator.pendingProtocolUpgrade,
          protocolVersion: validator.protocolVersion,
          status: "ready",
          tipHash: validator.tipHash,
          mempoolSize: validator.mempoolSize,
        }));
      }
      if (request.method === "GET" && url.pathname === "/v1/discovery") {
        identity = "public:discovery";
        consumeIngress(identity);
        peerReputation.assertAllowed(identity);
        return await verificationScheduler.run(identity, () =>
          send(response, 200, validator.peerAnnouncement()));
      }
      if (request.method === "GET" && url.pathname === "/v1/public/validator-candidate-context") {
        identity = "public:validator-candidate-context";
        consumeIngress(identity); peerReputation.assertAllowed(identity);
        const address = url.searchParams.get("address");
        return await verificationScheduler.run(identity, () =>
          send(response, 200, validator.validatorCandidateContext(address)));
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        identity = "public:metrics";
        consumeIngress(identity);
        peerReputation.assertAllowed(identity);
        return send(response, 200, {
          authentication: authenticationScheduler.metrics(),
          httpIngress: httpIngress.metrics(),
          ingressIdentities: ingressLimiter.size,
          nonces: validator.securityMetrics(),
          reputation: peerReputation.metrics(),
          verification: verificationScheduler.metrics(),
        });
      }
      const bodyless = request.method === "POST" &&
        ["/v1/sync", "/v1/blocks/produce"].includes(url.pathname);
      const parsedBody = request.method === "POST" && !bodyless
        ? await readBoundedConsensusJson(request, httpIngressOptions) : null;
      const authRole = request.method !== "POST" ? null
        : VALIDATOR_AUTH_PATHS.has(url.pathname) ? "validator"
          : COORDINATOR_AUTH_PATHS.has(url.pathname) ? "coordinator" : null;
      let authenticatedNonce = null;
      if (authRole !== null) {
        const { auth, payload } = parsedBody ?? {};
        if (auth === null || typeof auth !== "object" || Array.isArray(auth)) {
          throw new Error("authentication is required");
        }
        if (!SIGNER.test(auth?.signer ?? "")) {
          throw new Error("authenticated peer identity is invalid");
        }
        authenticatedNonce = await authenticationScheduler.run(
          `preauth:${authRole}`,
          () => authRole === "validator"
            ? validator.authorizeValidator(auth, request.method, url.pathname, payload)
            : validator.authorize(auth, request.method, url.pathname, payload),
        );
        authenticatedIdentity = `peer:${auth.signer}`;
        identity = authenticatedIdentity;
      } else {
        identity = publicRequestIdentity(url.pathname);
      }
      peerReputation.assertAllowed(identity);
      const authorizeValidator = (auth, method, path, payload) => {
        if (authRole !== "validator" || auth !== parsedBody?.auth || payload !== parsedBody?.payload ||
            method !== request.method || path !== url.pathname || authenticatedNonce === null) {
          throw new Error("validator authentication stage mismatch");
        }
        return authenticatedNonce;
      };
      const authorizeCoordinator = (auth, method, path, payload) => {
        if (authRole !== "coordinator" || auth !== parsedBody?.auth || payload !== parsedBody?.payload ||
            method !== request.method || path !== url.pathname || authenticatedNonce === null) {
          throw new Error("coordinator authentication stage mismatch");
        }
        return authenticatedNonce;
      };
      return await verificationScheduler.run(identity, async () => {
      if (request.method === "POST" &&
          url.pathname === "/v1/transactions/validator-admission-submission") {
        consumeIngress(identity);
        const attemptNonce = url.searchParams.get("attemptNonce");
        const candidateContextHash = url.searchParams.get("candidateContextHash");
        if (!/^[0-9a-f]{64}$/.test(attemptNonce ?? "") ||
            !/^[0-9a-f]{64}$/.test(candidateContextHash ?? "") ||
            [...url.searchParams.keys()].some((key) =>
              key !== "attemptNonce" && key !== "candidateContextHash")) {
          throw new Error("validator admission submission acknowledgement context is invalid");
        }
        const result = validator.submitTransaction(parsedBody);
        const acknowledgement = validator.acknowledgeValidatorAdmissionSubmission(result,
          { attemptNonce, candidateContextHash });
        return send(response, 202, { acknowledgement });
      }
      if (request.method === "POST" && url.pathname === "/v1/transactions") {
        consumeIngress(identity);
        const payload = parsedBody;
        const result = validator.submitTransaction(payload);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        const gossip = await boundedAllSettled(urls, (peer, index) =>
          gossipRequest(validator, index, peer, "/v1/gossip/transactions", payload));
        let inclusionCertificate;
        if (isProtectedBeaconAdmission(payload)) {
          try {
            inclusionCertificate = verifyAdmissionInclusionCertificate([
              result.receipt,
              ...gossip.filter(({ status, value }) => status === "fulfilled" && value?.receipt)
                .map(({ value }) => value.receipt),
            ], {
              acceptedHeight: validator.height, networkId: validator.networkId,
              transaction: payload, validators: validator.validatorMembers,
            });
          } catch {
            // A minority acknowledgement is deliberately not represented as an inclusion promise.
          }
        }
        return send(response, 202, {
          ...result,
          ...(inclusionCertificate ? { inclusionCertificate } : {}),
          gossipedPeers: gossip.filter(({ status, value }) => status === "fulfilled" && value).length,
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/gossip/transactions") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = validator.submitTransaction(payload);
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/health") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = {
          address: validator.address,
          certificateMode: validator.certificateMode,
          height: validator.height,
          networkId: validator.networkId,
          tipHash: validator.tipHash,
        };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/health") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = {
          address: validator.address,
          certificateMode: validator.certificateMode,
          height: validator.height,
          networkId: validator.networkId,
          tipHash: validator.tipHash,
        };
        return send(response, 200, {
          result, auth: validator.authenticateResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/proposals") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        if (validator.validatorAddressForPeerSigner(auth.signer) !== payload.proposer) {
          throw new Error("proposal was not sent by its proposer");
        }
        const result = { vote: validator.vote(payload) };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/commits") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        if (validator.validatorAddressForPeerSigner(auth.signer) !== payload.proposal.proposer) {
          throw new Error("commit certificate was not sent by its proposer");
        }
        const result = {
          vote: validator.commitVote(payload.proposal, payload.prepareCertificate),
          handoffCandidate: validator.validatorHandoffCandidate(payload.proposal),
        };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/handoffs") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = validator.installFinalizedValidatorHandoff(payload);
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/handoffs/history") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = { handoffs: validator.validatorHandoffHistory() };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/certificates/history") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = { history: validator.certificateLifecycleHistory() };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/topologies/history") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = validator.validatorTopologyHistory();
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/locks") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        if (payload?.height !== validator.height + 1) throw new Error("lock height is invalid");
        const result = { lock: validator.lockedProposal() };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/timeouts") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
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
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        const result = await finalizeValidatorProposal(
          validator, urls, payload.proposal, payload.prepareCertificate ?? null,
        );
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/blocks") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = validator.commit(payload);
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/blocks/range") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = { blocks: validator.blocksAfter(payload.fromHeight, payload.limit) };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/p2p/snapshots/candidate") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeValidator(auth, request.method, url.pathname, payload);
        const result = { snapshot: validator.stateSnapshotCandidate() };
        return send(response, 200, {
          result, auth: validator.authenticateValidatorResponse(nonce, result),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/sync") {
        consumeIngress(identity);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        return send(response, 200, await synchronizeValidator(validator, urls));
      }
      if (request.method === "POST" && url.pathname === "/v1/blocks/produce") {
        consumeIngress(identity);
        const urls = typeof peerUrls === "function" ? peerUrls() : peerUrls;
        return send(response, 202, await produceValidatorBlock(
          validator, urls, roundTimeoutMs, maxRoundTimeoutMs,
        ));
      }
      if (request.method === "POST" && url.pathname === "/v1/mempool/transactions") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = validator.submitTransaction(payload);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/mempool") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { transactions: validator.pendingTransactions() };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/snapshots/candidate") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { snapshot: validator.stateSnapshotCandidate() };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/handoffs/history") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { handoffs: validator.validatorHandoffHistory() };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/snapshots/attest") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { attestation: validator.stateSnapshotAttestation(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/accounts/proof-candidate") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { proof: validator.accountProofCandidate(payload?.address) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/accounts/proof-attest") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { attestation: validator.accountProofAttestation(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/assets/proof-candidate") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { proof: validator.assetProofCandidate(payload?.assetId, payload?.holder) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/assets/proof-attest") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { attestation: validator.assetProofAttestation(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/proposals") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        if (shouldRejectProposal(payload)) throw new Error("proposal rejected by local round policy");
        const result = { vote: validator.vote(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/commits") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = {
          vote: validator.commitVote(payload.proposal, payload.prepareCertificate),
          handoffCandidate: validator.validatorHandoffCandidate(payload.proposal),
        };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/handoffs") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = validator.installFinalizedValidatorHandoff(payload);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/timeouts") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = { timeout: validator.timeout(payload) };
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      if (request.method === "POST" && url.pathname === "/v1/blocks") {
        const { auth, payload } = parsedBody;
        const nonce = authorizeCoordinator(auth, request.method, url.pathname, payload);
        const result = validator.commit(payload);
        return send(response, 200, { result, auth: validator.authenticateResponse(nonce, result) });
      }
      return send(response, 404, { error: "not found" });
      });
    } catch (error) {
      httpIngress.record(error);
      if (authenticatedIdentity !== null && objectivePeerViolation(error)) {
        peerReputation.recordViolation(authenticatedIdentity, "objective-protocol-violation");
      }
      const rejected = ingressErrorResponse(error);
      return send(response, rejected.status, { error: rejected.message });
    } finally {
      finishIngress?.();
    }
  };
  const server = tls === null
    ? createHttpServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, handler)
    : createHttpsServer({
      cert: tls.cert, key: tls.key, maxHeaderSize: HTTP_MAX_HEADER_BYTES, minVersion: "TLSv1.3",
    }, handler);
  const maxConnections = options.maxConnections ?? 128;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 4 || maxConnections > 10_000) {
    throw new Error("validator connection limit is invalid");
  }
  return hardenHttpServer(server, { ...httpIngressOptions, maxConnections });
}
