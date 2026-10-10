import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { parseConsensusJson } from "./consensus-json.mjs";
import { nativeAssetId } from "./chain.mjs";

import {
  signWalletPaymentRequest,
  signWalletResourceOperation,
  signWalletTransfer,
  walletPublicInfo,
} from "./wallet-files.mjs";
import { verifyPaymentRequest } from "./payment-request.mjs";
import { simulateWalletOperation } from "./transaction-simulation.mjs";
import {
  createOfflineSigningPackage,
  verifyOfflineSignedPackage,
} from "./offline-signer.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import { verifyAccountProof } from "./account-proof.mjs";
import { verifyAssetProof, MAX_ASSET_PROOF_BYTES } from "./asset-proof.mjs";
import { advanceValidatorTrust } from "./validator-handoff.mjs";
import { validatorSetId } from "./validator-rotation.mjs";
import {
  enforceWalletTrustCheckpoint,
  loadWalletTrustCheckpoint,
  requireCheckpointHandoff,
  saveWalletHandoffHistory,
  saveWalletTrustCheckpoint,
} from "./wallet-trust-store.mjs";
import { MAX_HANDOFF_STORE_BYTES } from "./validator-handoff-store.mjs";
import {
  MAX_FINALITY_CHAIN_BYTES,
  verifyFinalityProofChain,
} from "./light-client.mjs";
import {
  appendWalletHeaders,
  loadWalletHeaderStore,
  walletHeaderAt,
} from "./wallet-header-store.mjs";
import {
  committedTransactionId,
  MAX_TRANSACTION_PROOF_BYTES,
  verifyTransactionProof,
} from "./transaction-tree.mjs";
import {
  MAX_ACCOUNT_HISTORY_PROOF_BYTES,
  verifyAccountHistory,
  verifyAccountHistoryEntry,
} from "./account-history.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const NETWORK = /^[a-zA-Z0-9._:-]{3,128}$/;
const REQUEST_ID = /^[0-9a-f]{64}$/;
const SIMULATION_ID = /^[0-9a-f]{64}$/;
const MAX_SIMULATIONS = 128;
const SIMULATION_LIFETIME_MS = 120_000;
const SIGN_CONFIRMATION_TIMEOUT_MS = 120_000;
const SIGN_RESULT_LIFETIME_MS = 180_000;
const SAFE_CLIENT_ERRORS = new Set([
  "bridge request is too large", "pairing code is invalid",
  "pairing is unavailable; restart the bridge",
  "another pairing request is already in progress",
  "pairing requests require application/json",
  "selected account is invalid", "account selection requires application/json",
  "account creation requires application/json", "account creation body is invalid",
  "new wallet account could not be created; check the local application",
  "new wallet account is invalid or duplicated",
  "new wallet account could not be verified; check the local application",
  "wallet session ended while the account was created",
  "bridge resource intent is invalid", "bridge signing intent is invalid",
  "bridge payment request intent is invalid",
  "simulation requires a verified account proof and network checkpoint",
  "a fresh verified simulation is required before signing",
  "simulation reference is invalid", "simulation is missing or expired; re-simulate before signing",
  "signing intent differs from the reviewed simulation",
  "verified account state changed; re-simulate before signing",
  "account proof has no matching verified finality chain",
  "account proof does not match the validator activation block",
  "account history page range is incomplete",
  "account history is incomplete or reordered",
  "account proof trust anchor does not match",
  "signing was rejected by the user",
  "bridge session ended before signing authorization completed",
  "wallet account changed during the request",
]);

function publicBridgeError(error) {
  // Native filesystem and cryptography errors may contain absolute paths or
  // private context. Only hand-authored, fixed bridge messages cross HTTP.
  return SAFE_CLIENT_ERRORS.has(error?.message)
    ? error.message : "wallet request could not be completed; retry or check the local application";
}

function send(response, status, value, origin) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "vary": "Origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function readBody(request, maximumBytes = 72 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) reject(new Error("bridge request is too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(parseConsensusJson(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("bridge request is not valid JSON")); }
    });
    request.on("error", reject);
  });
}

function validIntent(value) {
  if (!value || !REQUEST_ID.test(value.requestId ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 3 ||
      value.networkId.length > 128 || !ADDRESS.test(value.recipient ?? "") ||
      typeof value.amount !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.amount) ||
      !Number.isSafeInteger(value.nonce) || value.nonce < 0 ||
      (value.fee !== undefined &&
        (typeof value.fee !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.fee)))) {
    throw new Error("bridge signing intent is invalid");
  }
  return {
    amount: value.amount,
    ...(value.fee === undefined ? {} : { fee: value.fee }),
    networkId: value.networkId,
    nonce: value.nonce,
    recipient: value.recipient,
    requestId: value.requestId,
  };
}

function validResourceIntent(value) {
  if (!value || !REQUEST_ID.test(value.requestId ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 3 ||
      value.networkId.length > 128 || !Number.isSafeInteger(value.nonce) || value.nonce < 0 ||
      !["credit-stake", "credit-delegation", "credit-unstake-request", "credit-unstake-claim"]
        .includes(value.type)) {
    throw new Error("bridge resource intent is invalid");
  }
  const operation = {
    networkId: value.networkId,
    nonce: value.nonce,
    requestId: value.requestId,
    type: value.type,
  };
  if (["credit-stake", "credit-unstake-request"].includes(value.type)) {
    if (typeof value.amount !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.amount)) {
      throw new Error("bridge resource amount is invalid");
    }
    operation.amount = value.amount;
  }
  if (["credit-stake", "credit-delegation", "credit-unstake-request"].includes(value.type)) {
    if (typeof value.fee !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.fee)) {
      throw new Error("bridge resource fee is invalid");
    }
    operation.fee = value.fee;
  }
  if (value.type === "credit-delegation") {
    if (!ADDRESS.test(value.delegate ?? "") || !Number.isSafeInteger(value.limit) ||
        value.limit < 0 || value.limit > 1_000_000) {
      throw new Error("bridge resource delegation is invalid");
    }
    operation.delegate = value.delegate;
    operation.limit = value.limit;
  }
  return operation;
}

function validPaymentRequestIntent(value) {
  const now = Date.now();
  if (!value || !REQUEST_ID.test(value.requestId ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 3 ||
      value.networkId.length > 128 || typeof value.amount !== "string" ||
      !/^[1-9][0-9]{0,30}$/.test(value.amount) || typeof value.memo !== "string" ||
      Buffer.byteLength(value.memo, "utf8") > 160 ||
      /[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value.memo) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now ||
      value.expiresAt > now + 30 * 24 * 60 * 60 * 1_000) {
    throw new Error("bridge payment request intent is invalid");
  }
  return {
    amount: value.amount,
    expiresAt: value.expiresAt,
    memo: value.memo,
    networkId: value.networkId,
    requestId: value.requestId,
  };
}

function authorized(request, sessionToken) {
  const supplied = request.headers["x-nir-bridge-token"];
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(sessionToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameSecret(leftValue, rightValue) {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function simulationIntent(body, walletAddress) {
  if (!body?.intent || typeof body.intent !== "object" || Array.isArray(body.intent)) {
    throw new Error("transaction simulation intent is invalid");
  }
  const intent = structuredClone(body.intent);
  if (intent.type !== "payment-request" && intent.requestId !== undefined) {
    if (!REQUEST_ID.test(intent.requestId)) throw new Error("transaction simulation request id is invalid");
    delete intent.requestId;
  }
  if (intent.type === "payment-request" && intent.signature === undefined) {
    if (intent.recipient === undefined) intent.recipient = walletAddress;
    if (intent.recipient !== walletAddress) {
      throw new Error("wallet can preview only its own unsigned payment request");
    }
  } else if (intent.type !== "payment-request") {
    if (intent.sender === undefined) intent.sender = walletAddress;
    if (intent.sender !== walletAddress) throw new Error("wallet can simulate only its own authority");
  }
  return intent;
}

function simulationParticipants(intent, walletAddress) {
  const participants = new Set([walletAddress]);
  if (intent.type !== "payment-request") participants.add(intent.sender);
  if (intent.type === "transfer" && intent.resource === "transfer-credit") {
    participants.add(intent.feePayer ?? intent.creditOwner ?? intent.sender);
  } else if (intent.type === "transfer" && intent.feePayer !== undefined) {
    participants.add(intent.feePayer);
  }
  return [...participants];
}

function assetSimulationParticipants(intent) {
  if (!intent.type?.startsWith("asset-")) return [];
  return intent.type === "asset-transfer"
    ? [[intent.assetId, intent.sender], [intent.assetId, intent.recipient]]
    : [[intent.assetId, intent.sender]];
}

function bridgeSimulationEvidence({ body, intent, verifiedAccountStates, verifiedAssetStates, walletAddress }) {
  if (!body?.verifiedAccount || body.verifiedAccount.proofVerified !== true ||
      !body?.network || typeof body.network.networkId !== "string" ||
      !Number.isSafeInteger(body.network.height) || body.network.height < 0) {
    throw new Error("simulation requires a verified account proof and network checkpoint");
  }
  const accounts = {};
  let checkpoint = null;
  for (const address of simulationParticipants(intent, walletAddress)) {
    if (typeof address !== "string") throw new Error("simulation participant is invalid");
    const state = verifiedAccountStates.get(address);
    if (!state) throw new Error("simulation participant has no independently verified account proof");
    if (!checkpoint) checkpoint = state;
    if (state.networkId !== checkpoint.networkId || state.height !== checkpoint.height ||
        state.tipHash !== checkpoint.tipHash || state.stateRoot !== checkpoint.stateRoot) {
      throw new Error("simulation participants are not proven at one finalized state");
    }
    accounts[address] = structuredClone(state.account);
  }
  const assetProofs = [];
  for (const [assetId, holder] of assetSimulationParticipants(intent)) {
    const statement = verifiedAssetStates.get(`${assetId}:${holder}`);
    if (!statement) throw new Error("simulation participant has no independently verified asset proof");
    if (!checkpoint || statement.networkId !== checkpoint.networkId || statement.height !== checkpoint.height ||
        statement.tipHash !== checkpoint.tipHash || statement.stateRoot !== checkpoint.stateRoot) {
      throw new Error("asset and account proofs are not proven at one finalized state");
    }
    assetProofs.push(structuredClone(statement));
  }
  if (!checkpoint || body.network.networkId !== checkpoint.networkId ||
      body.network.height !== checkpoint.height || intent.networkId !== checkpoint.networkId ||
      (body.verifiedAccount.address !== undefined && body.verifiedAccount.address !== walletAddress) ||
      (body.verifiedAccount.height !== undefined && body.verifiedAccount.height !== checkpoint.height)) {
    throw new Error("simulation checkpoint does not match protected verified state");
  }
  return {
    accounts, assetProofs, height: checkpoint.height, networkId: checkpoint.networkId,
    proofVerified: true, stateRoot: checkpoint.stateRoot, tipHash: checkpoint.tipHash, verified: true,
  };
}

function simulationForSigning({ body, intent, pathname, simulations, verifiedAccountStates, walletAddress }) {
  if (body.simulationId === undefined) {
    throw new Error("a fresh verified simulation is required before signing");
  }
  if (typeof body.simulationId !== "string" || !SIMULATION_ID.test(body.simulationId)) {
    throw new Error("simulation reference is invalid");
  }
  const simulation = simulations.get(body.simulationId);
  if (!simulation || simulation.expiresAt <= Date.now()) {
    simulations.delete(body.simulationId);
    throw new Error("simulation is missing or expired; re-simulate before signing");
  }
  const { requestId: _requestId, ...withoutRequestId } = intent;
  const operation = pathname === "/v1/sign-payment-request" ? intent : withoutRequestId;
  const expected = pathname === "/v1/sign-payment-request"
    ? { ...operation, recipient: walletAddress, type: "payment-request" }
    : pathname === "/v1/sign-resource" ? { ...operation, sender: walletAddress }
      : { ...operation, sender: walletAddress, type: "transfer" };
  if (simulation.intentHash !== hashObject(JSON.parse(canonicalJson(expected)), "WALLET_SIMULATION_INTENT_V1")) {
    throw new Error("signing intent differs from the reviewed simulation");
  }
  const current = verifiedAccountStates.get(walletAddress);
  if (!current || current.networkId !== simulation.proof.networkId ||
      current.tipHash !== simulation.proof.tipHash || current.stateRoot !== simulation.proof.stateRoot) {
    throw new Error("verified account state changed; re-simulate before signing");
  }
  simulations.delete(body.simulationId);
  return body.simulationId;
}

export function createWalletBridgeServer({
  accounts,
  authorize,
  createAccount,
  firefoxPairing = false,
  origin,
  pairingCode,
  pairingLifetimeMs = 120_000,
  presentPairingCode,
  sessionToken,
  trustAnchor,
  trustCheckpointPath,
  headerHistoryPath,
  trustHistoryPath,
  vaultPath,
} = {}) {
  if (typeof authorize !== "function" || typeof vaultPath !== "string" ||
      (createAccount !== undefined && typeof createAccount !== "function") ||
      (presentPairingCode !== undefined &&
        (typeof presentPairingCode !== "function" || pairingCode === undefined)) ||
      (accounts !== undefined && (!Array.isArray(accounts) || accounts.length < 1 ||
        accounts.length > 100 || accounts.some((account) =>
          typeof account?.path !== "string" || !ADDRESS.test(account?.address ?? "")))) ||
      !/^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?|chrome-extension:\/\/[a-p]{32})$/.test(origin ?? "") ||
      typeof firefoxPairing !== "boolean" || (firefoxPairing && pairingCode === undefined) ||
      !/^[0-9a-f]{64}$/.test(sessionToken ?? "") ||
      (trustAnchor !== undefined &&
        (typeof trustAnchor?.expectedNetworkId !== "string" ||
         !Array.isArray(trustAnchor?.trustedValidators) ||
         trustAnchor.trustedValidators.length < 4 ||
         (trustAnchor.genesisCheckpoint !== undefined &&
          (!Number.isSafeInteger(trustAnchor.genesisCheckpoint?.height) ||
           trustAnchor.genesisCheckpoint.height !== 0 ||
           !/^[0-9a-f]{64}$/.test(trustAnchor.genesisCheckpoint?.accountStateRoot ?? "") ||
           !/^[0-9a-f]{64}$/.test(trustAnchor.genesisCheckpoint?.tipHash ?? "") ||
           !/^[0-9a-f]{64}$/.test(trustAnchor.genesisCheckpoint?.stateRoot ?? "") ||
           !/^[0-9a-f]{64}$/.test(trustAnchor.genesisCheckpoint?.validatorSetId ?? ""))))) ||
      (pairingCode !== undefined && !/^[0-9]{8}$/.test(pairingCode)) ||
      (trustCheckpointPath !== undefined && typeof trustCheckpointPath !== "string") ||
      (headerHistoryPath !== undefined && typeof headerHistoryPath !== "string") ||
      (trustHistoryPath !== undefined && typeof trustHistoryPath !== "string") ||
      !Number.isSafeInteger(pairingLifetimeMs) || pairingLifetimeMs < 1 || pairingLifetimeMs > 300_000) {
    throw new Error("wallet bridge configuration is invalid");
  }
  const accountTrust = trustAnchor ? {
    expectedNetworkId: trustAnchor.expectedNetworkId,
    handoffs: structuredClone(trustAnchor.handoffs ?? []),
    trustedValidators: structuredClone(trustAnchor.trustedValidators),
  } : null;
  const genesisCheckpoint = trustAnchor?.genesisCheckpoint
    ? structuredClone(trustAnchor.genesisCheckpoint) : null;
  if (accountTrust) {
    advanceValidatorTrust(accountTrust);
  }
  if (trustCheckpointPath && !accountTrust) {
    throw new Error("wallet trust checkpoint requires an account trust anchor");
  }
  let trustCheckpoint = trustCheckpointPath
    ? loadWalletTrustCheckpoint(trustCheckpointPath, accountTrust.expectedNetworkId) : null;
  let verifiedFinalityTip = null;
  let verifiedAccountState = null;
  if (trustCheckpoint) requireCheckpointHandoff(trustCheckpoint, accountTrust.handoffs);
  if (headerHistoryPath && (!accountTrust || !genesisCheckpoint)) {
    throw new Error("wallet header history requires a genesis trust anchor");
  }
  const headerStoreOptions = headerHistoryPath ? {
    checkpoint: trustCheckpoint,
    genesisCheckpoint,
    networkId: accountTrust.expectedNetworkId,
  } : null;
  let headerStore = headerHistoryPath
    ? loadWalletHeaderStore(headerHistoryPath, headerStoreOptions) : null;
  if (headerStore?.headers.length) {
    const last = headerStore.headers.at(-1);
    const activeTrust = advanceValidatorTrust({
      expectedNetworkId: accountTrust.expectedNetworkId,
      handoffs: accountTrust.handoffs.filter(({ activationHeight }) =>
        activationHeight <= last.header.height),
      trustedValidators: accountTrust.trustedValidators,
    });
    verifiedFinalityTip = {
      accountStateRoot: last.header.accountStateRoot,
      height: last.header.height,
      networkId: accountTrust.expectedNetworkId,
      stateRoot: last.header.stateRoot,
      tipHash: last.hash,
      transactionCount: last.header.transactionCount,
      transactionsRoot: last.header.transactionsRoot,
      validatorSetId: validatorSetId(activeTrust.trustedValidators),
    };
  }
  let activeVaultPath = vaultPath;
  let walletAddress = walletPublicInfo(vaultPath).address;
  const accountEntries = new Map();
  const accountPaths = new Set();
  const addAccount = ({ address, path }) => {
    if (accountPaths.has(path) || walletPublicInfo(path).address !== address) {
      throw new Error("wallet account list has a duplicate path or mismatched address");
    }
    const id = randomBytes(16).toString("hex");
    accountEntries.set(id, { address, path });
    accountPaths.add(path);
    return id;
  };
  for (const account of accounts ?? []) addAccount(account);
  let activeAccountId = [...accountEntries].find(([, entry]) => entry.path === vaultPath)?.[0];
  if (!activeAccountId) activeAccountId = addAccount({ address: walletAddress, path: vaultPath });
  const verifiedAccountStates = new Map();
  const verifiedAssetStates = new Map();
  const simulations = new Map();
  const seen = new Set();
  const signResults = new Map();
  const pruneSignResults = () => {
    for (const [id, entry] of signResults) {
      if (entry.completedAt && Date.now() - entry.completedAt > SIGN_RESULT_LIFETIME_MS) {
        signResults.delete(id);
      }
    }
    while (signResults.size > 128) {
      const oldest = [...signResults].find(([, entry]) => entry.completedAt);
      if (!oldest) break;
      signResults.delete(oldest[0]);
    }
  };
  let pending = false;
  let pairingAttempts = 0;
  let pairingAvailable = pairingCode !== undefined;
  let pairingPending = false;
  let sessionActive = pairingCode === undefined;
  let pairedFirefoxOrigin = null;
  let sessionGeneration = 0;
  let accountActionPending = false;
  const activateAccount = (id) => {
    if (id === activeAccountId) return;
    const entry = accountEntries.get(id);
    if (!entry) throw new Error("selected account is unavailable");
    activeAccountId = id;
    activeVaultPath = entry.path;
    walletAddress = entry.address;
    sessionGeneration += 1;
    verifiedAccountState = null;
    verifiedAccountStates.clear();
    verifiedAssetStates.clear();
    simulations.clear();
    signResults.clear();
  };
  const pairingDeadline = Date.now() + pairingLifetimeMs;
  const configuredOrigin = origin;
  const server = createServer(async (request, response) => {
    const requestGeneration = sessionGeneration;
    const readAuthenticatedBody = async (limit) => {
      const body = await readBody(request, limit);
      if (!sessionActive || requestGeneration !== sessionGeneration) {
        throw new Error("wallet account changed during the request");
      }
      return body;
    };
    const requestOrigin = request.headers.origin;
    const firefoxCandidate = firefoxPairing && pairedFirefoxOrigin === null &&
      !sessionActive && pairingAvailable && Date.now() <= pairingDeadline &&
      pairingAttempts < 5 &&
      /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestOrigin ?? "") &&
      ["/v1/pair", "/v1/pairing-prompt"].includes(request.url) &&
      ["POST", "OPTIONS"].includes(request.method);
    // A candidate can only attempt one-time pairing; the successful exact origin
    // is then frozen for every privileged request for the remainder of the session.
    const origin = firefoxPairing
      ? (pairedFirefoxOrigin ?? (firefoxCandidate ? requestOrigin : null))
      : configuredOrigin;
    const host = request.headers.host ?? "";
    const remoteAddress = request.socket.remoteAddress ?? "";
    if (!origin || requestOrigin !== origin || !/^(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(host) ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
      return send(response, 403, { error: "bridge origin or host is not allowed" }, origin);
    }
    if (request.method === "OPTIONS") {
      if (firefoxCandidate &&
          (request.headers["access-control-request-method"] !== "POST" ||
           ![undefined, "content-type"].includes(
             request.headers["access-control-request-headers"]?.toLowerCase()))) {
        return send(response, 403, { error: "bridge pairing preflight is invalid" }, origin);
      }
      response.writeHead(204, {
        "access-control-allow-headers": "content-type, x-nir-bridge-token",
        "access-control-allow-methods": "DELETE, GET, POST, OPTIONS",
        "access-control-allow-origin": origin,
        "access-control-max-age": "300",
        "vary": "Origin",
      });
      response.end(); return;
    }
    const url = new URL(request.url, "http://bridge.local");
    if (url.search) {
      return send(response, 404, { error: "bridge endpoint query is not allowed" }, origin);
    }
    if (request.method === "POST" && url.pathname === "/v1/pairing-prompt") {
      if (!presentPairingCode || !pairingAvailable || sessionActive ||
          Date.now() > pairingDeadline || pairingAttempts >= 5) {
        return send(response, 409, { error: "pairing is unavailable; restart the bridge" }, origin);
      }
      try {
        presentPairingCode();
        return send(response, 202, { shownOnDevice: true }, origin);
      } catch {
        return send(response, 503, { error: "pairing window could not be opened" }, origin);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/pair") {
      try {
        if (pairingPending) throw new Error("another pairing request is already in progress");
        if (!pairingAvailable || sessionActive || Date.now() > pairingDeadline || pairingAttempts >= 5) {
          pairingAvailable = false;
          throw new Error("pairing is unavailable; restart the bridge");
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("pairing requests require application/json");
        }
        pairingPending = true;
        pairingAttempts += 1;
        const body = await readBody(request, 128);
        if (!body || Object.keys(body).length !== 1 || typeof body.code !== "string" ||
            !sameSecret(body.code, pairingCode)) {
          throw new Error("pairing code is invalid");
        }
        pairingAvailable = false;
        if (firefoxPairing) pairedFirefoxOrigin = requestOrigin;
        sessionActive = true;
        return send(response, 200, { sessionToken }, origin);
      } catch (error) {
        return send(response, 400, { error: publicBridgeError(error) }, origin);
      } finally {
        pairingPending = false;
      }
    }
    if (!sessionActive || !authorized(request, sessionToken)) {
      return send(response, 401, { error: "bridge session is not authorized" }, origin);
    }
    try {
      if (request.method === "DELETE" && url.pathname === "/v1/session") {
        sessionActive = false;
        sessionGeneration += 1;
        pairingAvailable = false;
        verifiedAccountState = null;
        verifiedAccountStates.clear();
        verifiedAssetStates.clear();
        simulations.clear();
        signResults.clear();
        return send(response, 200, { disconnected: true }, origin);
      }
      if (accountActionPending) {
        return send(response, 409, { error: "finish creating the new account first" }, origin);
      }
      if (request.method === "GET" && url.pathname === "/v1/accounts") {
        return send(response, 200, {
          activeId: activeAccountId,
          canCreate: Boolean(createAccount),
          accounts: [...accountEntries].map(([id, entry], index) => ({
            id, address: entry.address, label: `Кошелёк ${index + 1}`,
          })),
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/select-account") {
        if (pending) return send(response, 409, { error: "finish signing before switching" }, origin);
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("account selection requires application/json");
        }
        const body = await readAuthenticatedBody(128);
        if (!body || Object.keys(body).length !== 1 ||
            !/^[0-9a-f]{32}$/.test(body.id ?? "") || !accountEntries.has(body.id)) {
          throw new Error("selected account is invalid");
        }
        if (pending || accountActionPending) {
          return send(response, 409, { error: "finish the pending wallet action before switching" }, origin);
        }
        activateAccount(body.id);
        return send(response, 200, { id: activeAccountId, address: walletAddress }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/create-account") {
        if (!createAccount) return send(response, 404, { error: "account creation is unavailable" }, origin);
        if (pending || accountEntries.size >= 100) {
          return send(response, 409, { error: "finish the pending wallet action first" }, origin);
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("account creation requires application/json");
        }
        const body = await readAuthenticatedBody(16);
        if (!body || Array.isArray(body) || Object.keys(body).length !== 0) {
          throw new Error("account creation body is invalid");
        }
        if (pending || accountActionPending || accountEntries.size >= 100) {
          return send(response, 409, { error: "finish the pending wallet action first" }, origin);
        }
        accountActionPending = true;
        const creatingGeneration = sessionGeneration;
        try {
          let created;
          try { created = await createAccount(); }
          catch { throw new Error("new wallet account could not be created; check the local application"); }
          if (!sessionActive || sessionGeneration !== creatingGeneration) {
            throw new Error("wallet session ended while the account was created");
          }
          let valid = false;
          try {
            valid = ADDRESS.test(created?.address ?? "") && typeof created?.path === "string" &&
              !accountPaths.has(created.path) &&
              walletPublicInfo(created.path).address === created.address;
          } catch { /* Never send a native file path from verification errors to the browser. */ }
          if (!valid) {
            throw new Error("new wallet account is invalid or duplicated");
          }
          let id;
          try { id = addAccount(created); }
          catch { throw new Error("new wallet account could not be verified; check the local application"); }
          activateAccount(id);
          return send(response, 200, { id, address: walletAddress }, origin);
        } finally { accountActionPending = false; }
      }
      if (request.method === "GET" && /^\/v1\/sign-result\/[0-9a-f]{64}$/.test(url.pathname)) {
        pruneSignResults();
        const entry = signResults.get(url.pathname.slice("/v1/sign-result/".length));
        if (!entry) return send(response, 404, { error: "signing result is unavailable" }, origin);
        if (!entry.completedAt) return send(response, 202, { status: "pending" }, origin);
        return send(response, entry.status, entry.value, origin);
      }
      if (request.method === "GET" && url.pathname === "/v1/wallet") {
        return send(response, 200, walletPublicInfo(activeVaultPath), origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/derive-asset-id") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("asset id derivation requires application/json");
        }
        const body = await readAuthenticatedBody(1_024);
        if (!body || Object.keys(body).length !== 2 ||
            !Object.hasOwn(body, "networkId") || !Object.hasOwn(body, "nonce") ||
            body.networkId !== accountTrust?.expectedNetworkId ||
            !Number.isSafeInteger(body.nonce) || body.nonce < 0) {
          throw new Error("asset id derivation request is invalid");
        }
        return send(response, 200, { assetId: nativeAssetId({ creator: walletAddress,
          networkId: body.networkId, nonce: body.nonce }), creator: walletAddress,
          networkId: body.networkId, nonce: body.nonce, verified: true }, origin);
      }
      if (request.method === "GET" && url.pathname === "/v1/trust-info") {
        return send(response, 200, {
          enabled: Boolean(accountTrust),
          minimumHeight: verifiedFinalityTip?.height ?? trustCheckpoint?.height ??
            genesisCheckpoint?.height ?? 0,
          networkId: accountTrust?.expectedNetworkId ?? null,
          tipHash: verifiedFinalityTip?.tipHash ?? trustCheckpoint?.tipHash ??
            genesisCheckpoint?.tipHash ?? null,
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-payment-request") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("payment request verification requires application/json");
        }
        const body = await readAuthenticatedBody();
        if (typeof body?.networkId !== "string" || body.networkId.length > 128) {
          throw new Error("payment request network is invalid");
        }
        return send(response, 200, {
          request: verifyPaymentRequest(body.request, { networkId: body.networkId }), verified: true,
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/update-validator-trust") {
        if (!accountTrust) throw new Error("bridge account trust anchor is not configured");
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("validator trust updates require application/json");
        }
        const body = await readAuthenticatedBody(MAX_HANDOFF_STORE_BYTES);
        if (!Array.isArray(body?.handoffs) || body.handoffs.length > 128 ||
            body.handoffs.length < accountTrust.handoffs.length ||
            accountTrust.handoffs.some(({ handoffHash }, index) =>
              body.handoffs[index]?.handoffHash !== handoffHash)) {
          throw new Error("validator trust update does not extend the accepted history");
        }
        const advanced = advanceValidatorTrust({
          expectedNetworkId: accountTrust.expectedNetworkId,
          handoffs: body.handoffs,
          trustedValidators: accountTrust.trustedValidators,
        });
        requireCheckpointHandoff(trustCheckpoint, body.handoffs);
        if (trustHistoryPath && body.handoffs.length > accountTrust.handoffs.length) {
          saveWalletHandoffHistory(trustHistoryPath, body.handoffs);
        }
        accountTrust.handoffs = structuredClone(body.handoffs);
        verifiedFinalityTip = null;
        verifiedAccountState = null;
        verifiedAccountStates.clear();
        verifiedAssetStates.clear();
        simulations.clear();
        return send(response, 200, {
          activationHeight: advanced.lastHandoff?.activationHeight ?? 0,
          handoffs: accountTrust.handoffs.length,
          updated: true,
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-finality-chain") {
        if (!accountTrust || (!trustCheckpoint && !genesisCheckpoint)) {
          throw new Error("a genesis or account checkpoint is required before light sync");
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("finality proof verification requires application/json");
        }
        const body = await readAuthenticatedBody(MAX_FINALITY_CHAIN_BYTES + 64 * 1024);
        const persistedBase = trustCheckpoint ?? genesisCheckpoint;
        const restartsFromPersisted = body?.proofs?.[0]?.header?.height === persistedBase.height + 1 &&
          body.proofs[0].header.previousHash === persistedBase.tipHash;
        const base = restartsFromPersisted ? persistedBase : (verifiedFinalityTip ?? persistedBase);
        const nextTip = verifyFinalityProofChain(body?.proofs, {
          checkpoint: base,
          expectedNetworkId: accountTrust.expectedNetworkId,
          handoffs: accountTrust.handoffs,
          trustedValidators: accountTrust.trustedValidators,
        });
        if (headerHistoryPath) {
          headerStore = appendWalletHeaders(
            headerHistoryPath,
            headerStore,
            body.proofs.map(({ hash, header }) => ({ hash, header })),
            { ...headerStoreOptions, checkpoint: trustCheckpoint },
          );
        }
        verifiedFinalityTip = nextTip;
        // A previously attested account is not a simulation snapshot for a newer finalized tip.
        verifiedAccountState = null;
        verifiedAccountStates.clear();
        verifiedAssetStates.clear();
        simulations.clear();
        return send(response, 200, { tip: verifiedFinalityTip, verified: true }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-transaction-proof") {
        if (!accountTrust || !headerStore) {
          throw new Error("wallet verified transaction history is not configured");
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("transaction proof verification requires application/json");
        }
        const body = await readAuthenticatedBody(MAX_TRANSACTION_PROOF_BYTES + 96 * 1024);
        const envelope = body?.proof;
        if (!envelope || !Number.isSafeInteger(envelope.height) || envelope.height < 1 ||
            !/^[0-9a-f]{64}$/.test(envelope.blockHash ?? "") ||
            !/^[0-9a-f]{64}$/.test(envelope.transactionsRoot ?? "") ||
            envelope.transaction?.networkId !== accountTrust.expectedNetworkId ||
            (envelope.transaction?.sender !== walletAddress &&
             envelope.transaction?.recipient !== walletAddress)) {
          throw new Error("wallet transaction proof request is invalid");
        }
        const committedHeader = walletHeaderAt(headerStore, envelope.height);
        if (!committedHeader || committedHeader.hash !== envelope.blockHash ||
            committedHeader.header.transactionsRoot !== envelope.transactionsRoot ||
            committedHeader.header.transactionCount !== envelope.proof?.count) {
          throw new Error("transaction proof does not match a verified finality header");
        }
        const transactionId = verifyTransactionProof(
          envelope.transaction, envelope.proof, committedHeader.header.transactionsRoot,
        );
        if (body.transactionId !== undefined && body.transactionId !== transactionId) {
          throw new Error("transaction proof identifier does not match");
        }
        return send(response, 200, {
          blockHash: committedHeader.hash,
          height: committedHeader.header.height,
          transaction: envelope.transaction,
          transactionId,
          verified: true,
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-account-history") {
        if (!verifiedAccountState || verifiedAccountState.address !== walletAddress) {
          throw new Error("verify the current wallet account before its history");
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("account history verification requires application/json");
        }
        const body = await readAuthenticatedBody(MAX_ACCOUNT_HISTORY_PROOF_BYTES + 1_024);
        const commitment = verifyAccountHistory(body?.transactionIds, verifiedAccountState.history);
        return send(response, 200, { ...commitment, verified: true }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-account-history-page") {
        if (!verifiedAccountState || verifiedAccountState.address !== walletAddress) {
          throw new Error("verify the current wallet account before its history");
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("account history page verification requires application/json");
        }
        const body = await readAuthenticatedBody(512 * 1024);
        const { before, limit, page } = body ?? {};
        const count = verifiedAccountState.history.count;
        if (!Number.isSafeInteger(before) || before < 0 || before > count ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
            !page || page.count !== count || !Array.isArray(page.entries)) {
          throw new Error("account history page request is invalid");
        }
        const start = Math.max(0, before - limit);
        if (page.start !== start || page.nextBefore !== (start === 0 ? null : start) ||
            page.entries.length !== before - start) {
          throw new Error("account history page range is incomplete");
        }
        const entries = page.entries.map((entry, offset) => {
          if (!entry || entry.index !== start + offset || entry.proof?.index !== entry.index) {
            throw new Error("account history page index is invalid");
          }
          verifyAccountHistoryEntry(entry.id, entry.proof, verifiedAccountState.history);
          return { id: entry.id, index: entry.index };
        });
        return send(response, 200, {
          count, entries, nextBefore: page.nextBefore, start, verified: true,
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-account-proof") {
        if (!accountTrust) throw new Error("bridge account trust anchor is not configured");
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("account proof verification requires application/json");
        }
        const body = await readAuthenticatedBody();
        if (!ADDRESS.test(body?.address ?? "") || !Number.isSafeInteger(body?.minimumHeight) ||
            body.minimumHeight < 0) {
          throw new Error("account proof request is invalid");
        }
        const activeTrust = advanceValidatorTrust({
          expectedNetworkId: accountTrust.expectedNetworkId,
          handoffs: accountTrust.handoffs.filter(({ activationHeight }) =>
            Number.isSafeInteger(body.proof?.height) && activationHeight <= body.proof.height),
          trustedValidators: accountTrust.trustedValidators,
        });
        if (activeTrust.lastHandoff?.activationHeight === body.proof?.height &&
            (body.proof.tipHash !== activeTrust.lastHandoff.activationBlockHash ||
             body.proof.stateRoot !== activeTrust.lastHandoff.activationStateRoot)) {
          throw new Error("account proof does not match the validator activation block");
        }
        const statement = verifyAccountProof(body.proof, {
            expectedAddress: body.address,
            expectedNetworkId: accountTrust.expectedNetworkId,
            minimumHeight: body.minimumHeight,
            trustedValidators: activeTrust.trustedValidators,
          });
        enforceWalletTrustCheckpoint(trustCheckpoint, statement);
        const requiredBase = trustCheckpoint ?? genesisCheckpoint;
        if (requiredBase && statement.height > requiredBase.height &&
            (!verifiedFinalityTip || verifiedFinalityTip.height !== statement.height ||
             statement.accountStateRoot !== verifiedFinalityTip.accountStateRoot ||
             JSON.stringify(statement.pendingProtocolUpgrade) !==
               JSON.stringify(verifiedFinalityTip.pendingProtocolUpgrade) ||
             statement.protocolVersion !== verifiedFinalityTip.protocolVersion ||
             verifiedFinalityTip.tipHash !== statement.tipHash ||
             verifiedFinalityTip.stateRoot !== statement.stateRoot ||
             verifiedFinalityTip.validatorSetId !== statement.validatorSetId)) {
          throw new Error("account proof has no matching verified finality chain");
        }
        if (trustCheckpointPath &&
            (!trustCheckpoint || statement.height > trustCheckpoint.height)) {
          trustCheckpoint = saveWalletTrustCheckpoint(
            trustCheckpointPath, statement, activeTrust.lastHandoff,
          );
          verifiedFinalityTip = null;
        }
        verifiedAccountState = structuredClone(statement.account);
        verifiedAccountStates.set(statement.account.address, structuredClone(statement));
        if (verifiedAccountStates.size > 16) {
          verifiedAccountStates.delete(verifiedAccountStates.keys().next().value);
        }
        simulations.clear();
        return send(response, 200, {
          statement,
          verified: true,
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-asset-proof") {
        const finalizedCheckpoint = verifiedFinalityTip ?? trustCheckpoint ?? genesisCheckpoint;
        if (!accountTrust || !finalizedCheckpoint) throw new Error("verify a finality chain before asset state");
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("asset proof verification requires application/json");
        }
        const body = await readAuthenticatedBody(MAX_ASSET_PROOF_BYTES + 1_024);
        if (!/^[0-9a-f]{64}$/.test(body?.assetId ?? "") || !ADDRESS.test(body?.holder ?? "") ||
            !Number.isSafeInteger(body?.minimumHeight) || body.minimumHeight < 0) {
          throw new Error("asset proof request is invalid");
        }
        const activeTrust = advanceValidatorTrust({ expectedNetworkId: accountTrust.expectedNetworkId,
          handoffs: accountTrust.handoffs.filter(({ activationHeight }) =>
            Number.isSafeInteger(body.proof?.height) && activationHeight <= body.proof.height),
          trustedValidators: accountTrust.trustedValidators });
        const statement = verifyAssetProof(body.proof, { expectedAssetId: body.assetId,
          expectedHolder: body.holder, expectedNetworkId: accountTrust.expectedNetworkId,
          minimumHeight: body.minimumHeight, trustedValidators: activeTrust.trustedValidators });
        if (statement.height !== finalizedCheckpoint.height || statement.tipHash !== finalizedCheckpoint.tipHash ||
            statement.stateRoot !== finalizedCheckpoint.stateRoot ||
            statement.validatorSetId !== finalizedCheckpoint.validatorSetId) {
          throw new Error("asset proof has no matching verified finality chain");
        }
        verifiedAssetStates.set(`${statement.assetId}:${statement.holder}`, structuredClone(statement));
        if (verifiedAssetStates.size > 16) verifiedAssetStates.delete(verifiedAssetStates.keys().next().value);
        simulations.clear();
        return send(response, 200, { statement, verified: true }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/simulate-transaction") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("transaction simulation requires application/json");
        }
        const body = await readAuthenticatedBody();
        const intent = simulationIntent(body, walletAddress);
        const stateEvidence = bridgeSimulationEvidence({
          body, intent, verifiedAccountStates, verifiedAssetStates, walletAddress,
        });
        const simulation = simulateWalletOperation({ intent, stateEvidence });
        const simulationId = randomBytes(32).toString("hex");
        const now = Date.now();
        for (const [id, entry] of simulations) {
          if (entry.expiresAt <= now) simulations.delete(id);
        }
        simulations.set(simulationId, {
          expiresAt: now + SIMULATION_LIFETIME_MS,
          intentHash: simulation.intentHash,
          intent: simulation.intent,
          proof: { ...simulation.proof, networkId: simulation.networkId },
          stateEvidence: structuredClone(stateEvidence),
        });
        if (simulations.size > MAX_SIMULATIONS) simulations.delete(simulations.keys().next().value);
        return send(response, 200, {
          simulation: { ...simulation, simulationId }, verified: true,
        }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/create-offline-signing-package") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("offline signing package requires application/json");
        }
        const body = await readAuthenticatedBody();
        // The browser is deliberately not allowed to choose a checkpoint, or to
        // stretch a package lifetime.  Both values are derived from the bridge's
        // protected finality state and its short-lived reviewed simulation.
        if (!body || Object.keys(body).length !== 1 || !SIMULATION_ID.test(body.simulationId ?? "")) {
          throw new Error("offline signing package request is invalid");
        }
        const stored = simulations.get(body.simulationId);
        if (!stored || stored.expiresAt <= Date.now()) throw new Error("simulation is missing or expired; re-simulate before export");
        const protectedCheckpoint = verifiedFinalityTip ?? trustCheckpoint ?? genesisCheckpoint;
        if (!protectedCheckpoint || stored.proof.networkId !== accountTrust?.expectedNetworkId ||
            stored.proof.tipHash !== protectedCheckpoint.tipHash ||
            stored.proof.stateRoot !== protectedCheckpoint.stateRoot ||
            stored.stateEvidence.height !== protectedCheckpoint.height) {
          throw new Error("verified finality state changed; re-simulate before offline export");
        }
        const checkpoint = {
          height: protectedCheckpoint.height,
          networkId: accountTrust.expectedNetworkId,
          stateRoot: protectedCheckpoint.stateRoot,
          tipHash: protectedCheckpoint.tipHash,
          validatorSetId: protectedCheckpoint.validatorSetId,
        };
        const signingPackage = createOfflineSigningPackage({
          intent: stored.intent, stateEvidence: stored.stateEvidence, checkpoint,
          expiresAt: Date.now() + 10 * 60_000,
        });
        return send(response, 200, { signingPackage, verified: true }, origin);
      }
      if (request.method === "POST" && url.pathname === "/v1/verify-offline-signed-package") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("offline signed package requires application/json");
        }
        const body = await readAuthenticatedBody(160 * 1024);
        if (!NETWORK.test(body?.networkId ?? "") || body.networkId !== accountTrust?.expectedNetworkId) {
          throw new Error("offline signed package network is invalid");
        }
        const checked = verifyOfflineSignedPackage(body.signedPackage);
        if (checked.package.networkId !== body.networkId) throw new Error("offline signed package belongs to another network");
        // Preserve the canonical envelope: the UI independently compares this
        // exact public artifact before it ever displays an import result.
        return send(response, 200, { intent: checked.package.intent, signedPackage: body.signedPackage,
          simulation: checked.simulation, verified: true }, origin);
      }
      if (request.method === "POST" &&
          ["/v1/sign", "/v1/sign-resource", "/v1/sign-payment-request"].includes(url.pathname)) {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          throw new Error("bridge signing requests require application/json");
        }
        const body = await readAuthenticatedBody(16 * 1024);
        const { simulationId: _simulationId, ...unsignedBody } = body ?? {};
        const intent = url.pathname === "/v1/sign-resource" ? validResourceIntent(unsignedBody)
          : url.pathname === "/v1/sign-payment-request" ? validPaymentRequestIntent(unsignedBody)
            : validIntent(unsignedBody);
        if (pending) throw new Error("another signing request is awaiting confirmation");
        if (seen.has(intent.requestId)) throw new Error("signing request was already used");
        const reviewedSimulationId = simulationForSigning({
          body, intent, pathname: url.pathname, simulations, verifiedAccountStates, walletAddress,
        });
        seen.add(intent.requestId);
        if (seen.size > 1_000) seen.delete(seen.values().next().value);
        pruneSignResults();
        const resultEntry = { completedAt: null, status: null, value: null };
        signResults.set(intent.requestId, resultEntry);
        pending = true;
        const signingGeneration = sessionGeneration;
        try {
          const authorizationAbort = new AbortController();
          let timeout;
          const password = await Promise.race([
            authorize(structuredClone(intent), { signal: authorizationAbort.signal }),
            new Promise((_, reject) => {
              timeout = setTimeout(() => {
                authorizationAbort.abort();
                reject(new Error("signing confirmation expired; review and start a new request"));
              }, SIGN_CONFIRMATION_TIMEOUT_MS);
            }),
          ]).finally(() => clearTimeout(timeout));
          if (typeof password !== "string") throw new Error("signing was rejected by the user");
          if (!sessionActive || signingGeneration !== sessionGeneration) {
            throw new Error("bridge session ended before signing authorization completed");
          }
          const { requestId, ...payload } = intent;
          const transaction = url.pathname === "/v1/sign-resource"
            ? signWalletResourceOperation({ path: activeVaultPath, password, operation: payload })
            : url.pathname === "/v1/sign-payment-request"
              ? signWalletPaymentRequest({
                path: activeVaultPath, password, intent: { ...payload, requestId },
              })
              : signWalletTransfer({ path: activeVaultPath, password, ...payload });
          const value = {
            requestId,
            ...(reviewedSimulationId ? { simulationId: reviewedSimulationId } : {}),
            ...(url.pathname === "/v1/sign-payment-request"
              ? { paymentRequest: transaction } : { transaction }),
          };
          resultEntry.status = 200;
          resultEntry.value = value;
          resultEntry.completedAt = Date.now();
          return send(response, 200, value, origin);
        } catch (error) {
          resultEntry.status = 400;
          resultEntry.value = { error: publicBridgeError(error) };
          resultEntry.completedAt = Date.now();
          throw error;
        } finally {
          pending = false;
        }
      }
      return send(response, 404, { error: "not found" }, origin);
    } catch (error) {
      return send(response, 400, { error: publicBridgeError(error) }, origin);
    }
  });
  server.maxConnections = 8;
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 2_000;
  return server;
}
