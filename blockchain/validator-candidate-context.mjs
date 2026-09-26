import { MAX_ACCOUNT_PROOF_BYTES, verifyAccountProof, verifyAccountProofCandidate }
  from "./account-proof.mjs";
import { MAX_CHECKPOINT_TRUST_PACKAGE_BYTES, verifyCheckpointTrustPackage }
  from "./checkpoint-trust-package.mjs";
import { MAX_VALIDATORS, MIN_TRANSFER_FEE } from "./constants.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import { verifyRecentFinalityCheckpoint } from "./light-client.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";
import {
  assembleValidatorCandidateProof, verifyValidatorCandidateProof,
  verifyValidatorCandidateProofCandidate, MAX_VALIDATOR_CANDIDATE_QUORUM_PROOF_BYTES,
} from "./validator-candidate-proof.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_PEER_REQUESTS = 8;
export const MAX_VALIDATOR_CANDIDATE_SYNC_INPUT_BYTES =
  MAX_CHECKPOINT_TRUST_PACKAGE_BYTES + 1024 * 1024;
export const MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES = MAX_CHECKPOINT_TRUST_PACKAGE_BYTES +
  MAX_ACCOUNT_PROOF_BYTES + MAX_VALIDATOR_CANDIDATE_QUORUM_PROOF_BYTES + 2 * 1024 * 1024;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function validatePeer(peer) {
  exact(peer, ["tlsCertificateSha256", "url", "validatorAddress"], "candidate context peer");
  let url;
  try { url = new URL(peer.url); } catch { throw new Error("candidate context peer URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || !HASH.test(peer.tlsCertificateSha256 ?? "") ||
      !ADDRESS.test(peer.validatorAddress ?? "")) throw new Error("candidate context peer is invalid");
  return { ...structuredClone(peer), url: url.origin };
}

export function validateValidatorCandidateSyncInput(value) {
  if (Buffer.byteLength(canonicalJson(value)) > MAX_VALIDATOR_CANDIDATE_SYNC_INPUT_BYTES) {
    throw new Error("candidate context sync input is too large");
  }
  exact(value, ["checkpointTrustPackage", "format", "peers", "version"],
  "candidate context sync input");
  if (value.format !== "nir-validator-candidate-sync-v1" || value.version !== 1 ||
      !Array.isArray(value.peers) || value.peers.length < 4 || value.peers.length > MAX_VALIDATORS) {
    throw new Error("candidate context sync input is invalid");
  }
  const peers = value.peers.map(validatePeer).sort((a, b) =>
    a.validatorAddress.localeCompare(b.validatorAddress));
  if (new Set(peers.map(({ validatorAddress }) => validatorAddress)).size !== peers.length ||
      new Set(peers.map(({ url }) => url)).size !== peers.length) {
    throw new Error("candidate context peers are duplicated");
  }
  return { ...structuredClone(value), peers };
}

async function settleBounded(values, limit, operation) {
  const results = new Array(values.length); let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await operation(values[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function conflict(message) { const error = new Error(message); error.code = "ERR_CANDIDATE_EQUIVOCATION"; return error; }
function responseView(response, { address, expectedCheckpoint, genesisHash, networkId,
  trustedValidators, validator }) {
  exact(response, ["accountProof", "candidateProof", "finalityProof"], "candidate context response");
  const checkpoint = verifyRecentFinalityCheckpoint(response.finalityProof, {
    expectedGenesisHash: genesisHash, expectedNetworkId: networkId, trustedValidators,
  });
  if (checkpoint.protocolVersion < 31) throw new Error("candidate context requires protocol v31");
  const account = verifyAccountProofCandidate(response.accountProof, { expectedAddress: address,
    expectedNetworkId: networkId, minimumHeight: checkpoint.height, trustedValidators }, validator);
  const candidate = verifyValidatorCandidateProofCandidate(response.candidateProof, {
    expectedAddress: address, expectedNetworkId: networkId, expectedValidator: validator,
    minimumHeight: checkpoint.height, trustedValidators,
  });
  if (checkpoint.height !== expectedCheckpoint.height || checkpoint.tipHash !== expectedCheckpoint.tipHash ||
      checkpoint.stateRoot !== expectedCheckpoint.stateRoot ||
      checkpoint.validatorSetId !== expectedCheckpoint.validatorSetId ||
      checkpoint.protocolVersion !== expectedCheckpoint.protocolVersion) {
    throw conflict("authenticated validator returned a conflicting checkpoint view");
  }
  for (const statement of [account, candidate.statement]) {
    if (statement.height !== checkpoint.height || statement.tipHash !== checkpoint.tipHash ||
        statement.stateRoot !== checkpoint.stateRoot ||
        statement.validatorSetId !== checkpoint.validatorSetId || statement.protocolVersion < 31) {
      throw new Error("candidate context response does not match its finalized checkpoint");
    }
  }
  const accountStateRoot = response.finalityProof?.header?.accountStateRoot;
  if (!HASH.test(accountStateRoot ?? "") || account.accountStateRoot !== accountStateRoot ||
      candidate.statement.accountStateRoot !== accountStateRoot ||
      account.protocolVersion !== candidate.statement.protocolVersion ||
      account.protocolVersion !== checkpoint.protocolVersion) {
    throw conflict("authenticated validator returned conflicting account, candidate, or finality state");
  }
  return { accountProof: response.accountProof, candidateProof: response.candidateProof,
    checkpoint, finalityProof: response.finalityProof };
}

export async function synchronizeValidatorCandidateContext({ plan, syncInput: input,
  request = null, now = Date.now() } = {}) {
  if (request === null) ({ requestJson: request } = await import("./http-client.mjs"));
  if (typeof request !== "function") throw new Error("candidate context request transport is invalid");
  const syncInput = validateValidatorCandidateSyncInput(input);
  if (!plan || !ADDRESS.test(plan.consensus?.address ?? "") ||
      plan.format !== "nir-validator-join-plan-v2" || plan.version !== 2 ||
      typeof plan.networkId !== "string" || !HASH.test(plan.expectedChainIdentityGenesisHash ?? "") ||
      typeof plan.expectedCheckpointPolicyId !== "string") throw new Error("candidate context join plan is invalid");
  const trust = verifyCheckpointTrustPackage(syncInput.checkpointTrustPackage, {
    expectedChainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    expectedNetworkId: plan.networkId, expectedPolicyId: plan.expectedCheckpointPolicyId,
    maxAgeMs: plan.candidateContextMaxWitnessAgeMs, maxFutureSkewMs: 30_000,
    minimumCheckpointHeight: plan.candidateContextMinimumCheckpointHeight,
    minimumSequence: plan.candidateContextMinimumSequence, now,
  });
  const validators = trust.trustedValidators;
  if (canonicalJson(syncInput.peers.map(({ validatorAddress }) => validatorAddress)) !==
      canonicalJson(validators.map(({ address }) => address).sort())) {
    throw new Error("candidate context peers do not exactly cover the trusted validator set");
  }
  const responses = await settleBounded(syncInput.peers, MAX_CONCURRENT_PEER_REQUESTS, async (peer) => {
    const url = new URL("/v1/public/validator-candidate-context", peer.url);
    url.searchParams.set("address", plan.consensus.address);
    const reply = await request(url.toString(), { maxResponseBytes: MAX_RESPONSE_BYTES,
      method: "GET", tlsCertificateSha256: peer.tlsCertificateSha256 });
    if (!reply.ok) throw new Error(reply.body?.error ?? `validator returned ${reply.status}`);
    return responseView(reply.body, { address: plan.consensus.address,
      expectedCheckpoint: trust.checkpoint,
      genesisHash: plan.expectedChainIdentityGenesisHash, networkId: plan.networkId,
      trustedValidators: validators, validator: peer.validatorAddress });
  });
  const verified = responses.filter(({ status }) => status === "fulfilled").map(({ value }) => value);
  const equivocation = responses.find(({ status, reason }) =>
    status === "rejected" && reason?.code === "ERR_CANDIDATE_EQUIVOCATION");
  if (equivocation) throw equivocation.reason;
  const quorum = Math.floor(validators.length * 2 / 3) + 1;
  if (verified.length < quorum) throw new Error(`candidate context node quorum not reached (${verified.length}/${quorum})`);
  const candidateViews = new Set(verified.map(({ candidateProof }) => {
    const { attestation: _attestation, statementHash: _statementHash, ...statement } = candidateProof;
    return canonicalJson(statement);
  }));
  const accountViews = new Set(verified.map(({ accountProof }) => {
    const { attestations: _attestations, ...statement } = accountProof;
    return canonicalJson(statement);
  }));
  if (candidateViews.size !== 1 || accountViews.size !== 1) {
    throw conflict("authenticated validators returned conflicting candidate or account views");
  }
  const selected = verified;
  const candidateProof = assembleValidatorCandidateProof(selected.map(({ candidateProof }) => candidateProof), {
    expectedAddress: plan.consensus.address, expectedNetworkId: plan.networkId,
    minimumHeight: selected[0].checkpoint.height, trustedValidators: validators,
  });
  const accountCandidates = selected.map(({ accountProof }) => accountProof);
  const first = accountCandidates[0];
  const accountProof = { ...first, attestations: accountCandidates.map(({ attestations }) => attestations[0])
    .sort((a, b) => a.validator.localeCompare(b.validator)) };
  const account = verifyAccountProof(accountProof, { expectedAddress: plan.consensus.address,
    expectedNetworkId: plan.networkId, minimumHeight: selected[0].checkpoint.height,
    trustedValidators: validators });
  if (canonicalJson(accountCandidates.map(({ attestations: _a, ...statement }) => statement)) !==
      canonicalJson(accountCandidates.map(() => {
        const { attestations: _a, ...statement } = first; return statement;
      }))) throw new Error("candidate context account statements disagree");
  const checkpoint = selected[0].checkpoint;
  if (account.height !== checkpoint.height || candidateProof.height !== checkpoint.height ||
      account.tipHash !== checkpoint.tipHash || candidateProof.tipHash !== checkpoint.tipHash ||
      account.stateRoot !== checkpoint.stateRoot || candidateProof.stateRoot !== checkpoint.stateRoot) {
    throw new Error("candidate context proofs do not share one finalized state");
  }
  const requiredBond = MIN_VALIDATOR_BOND.toString();
  const bondAndFeeCovered = BigInt(account.account.atomicBalance) >= MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE;
  const payload = { account: account.account, accountProof, address: plan.consensus.address,
    admission: candidateProof.admission, bondAndFeeCovered,
    checkpoint, checkpointTrustPackage: structuredClone(syncInput.checkpointTrustPackage),
    checkpointTrustPackageHash: trust.packageHash,
    format: "nir-validator-candidate-context-v1", networkId: plan.networkId,
    nodeQuorum: quorum, observedNodes: selected.length, protocolVersion: checkpoint.protocolVersion,
    queuePosition: candidateProof.queuePosition, queueSize: candidateProof.queueSize,
    requiredBond, status: candidateProof.admission === null ? "not-admitted" : "admitted", syncedAt: now,
    validatorCandidateProof: candidateProof, version: 1 };
  const context = { ...payload, contextHash: hashObject(payload, "VALIDATOR_CANDIDATE_CONTEXT_V1") };
  assertValidatorCandidateContextSize(context);
  return context;
}

export function assertValidatorCandidateContextSize(value) {
  if (Buffer.byteLength(canonicalJson(value)) > MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES) {
    throw new Error("validator candidate context is too large");
  }
}

export function validateValidatorCandidateContext(value, plan, { now = Date.now() } = {}) {
  assertValidatorCandidateContextSize(value);
  exact(value, ["account", "accountProof", "address", "admission", "bondAndFeeCovered", "checkpoint",
    "checkpointTrustPackage", "checkpointTrustPackageHash", "contextHash", "format", "networkId", "nodeQuorum",
    "observedNodes", "protocolVersion", "queuePosition", "queueSize", "requiredBond", "status",
    "syncedAt", "validatorCandidateProof", "version"], "validator candidate context");
  const { contextHash, ...payload } = value;
  if (value.format !== "nir-validator-candidate-context-v1" || value.version !== 1 ||
      value.address !== plan?.consensus?.address || value.networkId !== plan.networkId ||
      value.protocolVersion < 31 || value.requiredBond !== MIN_VALIDATOR_BOND.toString() ||
      value.bondAndFeeCovered !== (BigInt(value.account?.atomicBalance ?? "-1") >=
        MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE) ||
      !Number.isSafeInteger(value.nodeQuorum) || value.nodeQuorum < 3 ||
      !Number.isSafeInteger(value.observedNodes) || value.observedNodes < value.nodeQuorum ||
      !["not-admitted", "admitted"].includes(value.status) ||
      !Number.isSafeInteger(value.syncedAt) || value.syncedAt < 0 || value.syncedAt > now + 30_000 ||
      (value.status === "admitted") !== (value.admission !== null) ||
      contextHash !== hashObject(payload, "VALIDATOR_CANDIDATE_CONTEXT_V1")) {
    throw new Error("validator candidate context is invalid");
  }
  const trust = verifyCheckpointTrustPackage(value.checkpointTrustPackage, {
    expectedChainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    expectedNetworkId: plan.networkId, expectedPolicyId: plan.expectedCheckpointPolicyId,
    maxAgeMs: plan.candidateContextMaxWitnessAgeMs, maxFutureSkewMs: 30_000,
    minimumCheckpointHeight: plan.candidateContextMinimumCheckpointHeight,
    minimumSequence: plan.candidateContextMinimumSequence, now,
  });
  if (trust.packageHash !== value.checkpointTrustPackageHash ||
      canonicalJson(trust.checkpoint) !== canonicalJson(value.checkpoint)) {
    throw new Error("validator candidate context trust package is invalid");
  }
  const account = verifyAccountProof(value.accountProof, { expectedAddress: value.address,
    expectedNetworkId: value.networkId, minimumHeight: value.checkpoint.height,
    trustedValidators: trust.trustedValidators });
  const candidate = verifyValidatorCandidateProof(value.validatorCandidateProof, {
    expectedAddress: value.address, expectedNetworkId: value.networkId,
    minimumHeight: value.checkpoint.height, trustedValidators: trust.trustedValidators,
  });
  const expectedQuorum = Math.floor(trust.trustedValidators.length * 2 / 3) + 1;
  const accountSigners = new Set(value.accountProof.attestations?.map(({ validator }) => validator));
  const candidateSigners = new Set(value.validatorCandidateProof.attestations?.map(({ validator }) => validator));
  if (canonicalJson(account.account) !== canonicalJson(value.account) ||
      canonicalJson(candidate.admission) !== canonicalJson(value.admission) ||
      candidate.queuePosition !== value.queuePosition || candidate.queueSize !== value.queueSize ||
      account.height !== value.checkpoint.height || candidate.height !== value.checkpoint.height ||
      account.tipHash !== value.checkpoint.tipHash || candidate.tipHash !== value.checkpoint.tipHash ||
      account.stateRoot !== value.checkpoint.stateRoot || candidate.stateRoot !== value.checkpoint.stateRoot ||
      account.protocolVersion !== value.protocolVersion || candidate.protocolVersion !== value.protocolVersion ||
      account.accountStateRoot !== candidate.accountStateRoot ||
      account.accountStateRoot !== value.checkpointTrustPackage.finalityProof?.header?.accountStateRoot ||
      value.nodeQuorum !== expectedQuorum || value.observedNodes > trust.trustedValidators.length ||
      value.observedNodes !== accountSigners.size || value.observedNodes !== candidateSigners.size ||
      canonicalJson([...accountSigners].sort()) !== canonicalJson([...candidateSigners].sort())) {
    throw new Error("validator candidate context proof binding is invalid");
  }
  return structuredClone(value);
}
