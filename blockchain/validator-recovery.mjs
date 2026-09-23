import {
  addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import { MAX_VALIDATORS, MIN_TRANSFER_FEE, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";
import { validatorSetId } from "./validator-rotation.mjs";
import { normalizePeerBindings } from "./peer-registry.mjs";

export const VALIDATOR_RECOVERY_DELAY_BLOCKS = 64;
export const MAX_RECOVERY_CERTIFICATE_BYTES = 2_000_000;

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;

export function validatorRecoveryStateCommitment({ activePlanHash = null, generation, networkId }) {
  if ((activePlanHash !== null && !HASH.test(activePlanHash ?? "")) ||
      !Number.isSafeInteger(generation) || generation < 0 ||
      typeof networkId !== "string" || networkId.length < 1 || networkId.length > 128) {
    throw new Error("validator recovery state commitment context is invalid");
  }
  return hashObject({ activePlanHash, generation, networkId },
    "VALIDATOR_RECOVERY_STATE_V1");
}

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function quorum(size) { return Math.floor((size * 2) / 3) + 1; }

function recoverySetId(members) {
  return validatorSetId([...members].sort((a, b) => a.address < b.address ? -1 : 1));
}

function canonicalSignature(value) {
  return typeof value === "string" && value.length <= 7_000 &&
    Buffer.from(value, "base64").toString("base64") === value;
}

function normalizedReserves(reserves) {
  if (!Array.isArray(reserves) || reserves.length < 4 || reserves.length > MAX_VALIDATORS) {
    throw new Error("validator recovery reserve set size is invalid");
  }
  const ordered = reserves.map((member) => {
    exact(member, ["address", "algorithm", "operatorId", "publicKey"], "recovery reserve");
    if (member.algorithm !== SIGNATURE_ALGORITHM || !ADDRESS.test(member.address ?? "") ||
        addressFromPublicKey(member.publicKey) !== member.address ||
        !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(member.operatorId ?? "")) {
      throw new Error("validator recovery reserve identity is invalid");
    }
    return structuredClone(member);
  }).sort((a, b) => a.address < b.address ? -1 : 1);
  if (new Set(ordered.map(({ address }) => address)).size !== ordered.length ||
      new Set(ordered.map(({ operatorId }) => operatorId)).size !== ordered.length ||
      new Set(ordered.map(({ publicKey }) => publicKey)).size !== ordered.length) {
    throw new Error("validator recovery reserve identities are duplicated");
  }
  return ordered;
}

function planPayload(plan) {
  return {
    activationHeight: plan.activationHeight,
    activeSetId: plan.activeSetId,
    format: plan.format,
    generation: plan.generation,
    networkId: plan.networkId,
    peers: plan.peers,
    reserves: plan.reserves,
    reserveSetId: plan.reserveSetId,
    scheduledHeight: plan.scheduledHeight,
  };
}

export function createValidatorRecoveryPlan({
  activationHeight, activeValidators, generation, networkId, reserveWallets, scheduledHeight,
}) {
  const reserves = normalizedReserves(reserveWallets.map((entry) => entry.member));
  const peers = reserveWallets.every(({ peer }) => peer === undefined) ? null :
    normalizePeerBindings(reserveWallets.map(({ peer }) => peer));
  const payload = {
    activationHeight,
    activeSetId: recoverySetId(activeValidators),
    format: "nir-validator-recovery-plan-v1",
    generation,
    networkId,
    peers,
    reserves,
    reserveSetId: recoverySetId(reserves),
    scheduledHeight,
  };
  const planHash = hashObject(payload, "VALIDATOR_RECOVERY_PLAN_V1");
  const approvals = reserveWallets.map(({ peer, transportWallet, wallet }) => ({
    reserve: wallet.address,
    signature: signObject({ planHash }, wallet, "VALIDATOR_RECOVERY_ACCEPT_V1"),
    ...(peers ? { transportSignature: signObject({ planHash }, transportWallet,
      "VALIDATOR_RECOVERY_TRANSPORT_V1") } : {}),
  })).sort((a, b) => a.reserve < b.reserve ? -1 : 1);
  return { ...payload, approvals, planHash };
}

export function verifyValidatorRecoveryPlanAcceptance(plan, {
  activeValidators, networkId, peerRegistryRequired = false, trustedPlanHash,
} = {}) {
  exact(plan, ["activationHeight", "activeSetId", "approvals", "format", "generation",
    "networkId", "peers", "planHash", "reserves", "reserveSetId", "scheduledHeight"],
  "validator recovery plan");
  const reserves = normalizedReserves(plan.reserves);
  if (plan.format !== "nir-validator-recovery-plan-v1" || plan.networkId !== networkId ||
      !Array.isArray(activeValidators) || !Number.isSafeInteger(plan.generation) ||
      plan.generation < 1 || !Number.isSafeInteger(plan.scheduledHeight) ||
      !Number.isSafeInteger(plan.activationHeight) ||
      plan.activationHeight < plan.scheduledHeight + VALIDATOR_RECOVERY_DELAY_BLOCKS ||
      (trustedPlanHash !== undefined && plan.planHash !== trustedPlanHash)) {
    throw new Error("validator recovery plan context is invalid");
  }
  if (plan.activeSetId !== recoverySetId(activeValidators)) {
    throw new Error("validator recovery plan active set is invalid");
  }
  if (plan.reserveSetId !== recoverySetId(reserves) ||
      plan.planHash !== hashObject(planPayload(plan), "VALIDATOR_RECOVERY_PLAN_V1")) {
    throw new Error("validator recovery plan commitment is invalid");
  }
  const activeAddresses = new Set(activeValidators.map(({ address }) => address));
  const activeOperators = new Set(activeValidators.map(({ operatorId }) => operatorId));
  if (reserves.length !== activeValidators.length ||
      reserves.some((member) => activeAddresses.has(member.address) ||
      activeOperators.has(member.operatorId))) {
    throw new Error("validator recovery reserve set is unequal or overlaps the active set");
  }
  if (!Array.isArray(plan.approvals) || plan.approvals.length !== reserves.length ||
      Buffer.byteLength(canonicalJson(plan)) > MAX_RECOVERY_CERTIFICATE_BYTES) {
    throw new Error("validator recovery acceptance certificate is invalid");
  }
  const members = new Map(reserves.map((member) => [member.address, member]));
  const peers = plan.peers === null ? null : normalizePeerBindings(plan.peers);
  if (peerRegistryRequired !== (peers !== null) ||
      (peers !== null && (peers.length !== reserves.length || peers.some(({ validatorAddress }) =>
        !members.has(validatorAddress)))) ||
      (peers && canonicalJson(peers) !== canonicalJson(plan.peers))) {
    throw new Error("validator recovery peer bindings are missing or inconsistent");
  }
  const peerByValidator = new Map((peers ?? []).map((peer) => [peer.validatorAddress, peer]));
  const seen = new Set();
  for (const approval of plan.approvals) {
    exact(approval, peers ? ["reserve", "signature", "transportSignature"] :
      ["reserve", "signature"], "validator recovery approval");
    const member = members.get(approval.reserve);
    if (!member || seen.has(approval.reserve) || !canonicalSignature(approval.signature) ||
        !verifyObject({ planHash: plan.planHash },
        approval.signature, member.publicKey, "VALIDATOR_RECOVERY_ACCEPT_V1")) {
      throw new Error("validator recovery acceptance signature is invalid");
    }
    const peer = peerByValidator.get(approval.reserve);
    if (peer && (!canonicalSignature(approval.transportSignature) ||
        !verifyObject({ planHash: plan.planHash }, approval.transportSignature,
          peer.transport.publicKey, "VALIDATOR_RECOVERY_TRANSPORT_V1"))) {
      throw new Error("validator recovery transport possession signature is invalid");
    }
    seen.add(approval.reserve);
  }
  return structuredClone({ ...plan, reserves });
}

export function verifyValidatorRecoveryPlan(plan, {
  activeValidators, bonds, currentHeight, expectedGeneration, networkId,
  peerRegistryRequired = false, registeredValidators,
} = {}) {
  const verified = verifyValidatorRecoveryPlanAcceptance(plan, {
    activeValidators, networkId, peerRegistryRequired,
  });
  if (verified.generation !== expectedGeneration || verified.scheduledHeight !== currentHeight ||
      !(bonds instanceof Map) || !(registeredValidators instanceof Map)) {
    throw new Error("validator recovery plan context is invalid");
  }
  if (verified.reserves.some((member) =>
    canonicalJson(registeredValidators.get(member.address)) !== canonicalJson(member) ||
    (bonds.get(member.address) ?? 0n) < MIN_VALIDATOR_BOND)) {
    throw new Error("validator recovery reserve is unknown or unbonded");
  }
  return verified;
}

export function createValidatorRecoveryPlanTransaction({ fee = MIN_TRANSFER_FEE.toString(),
  networkId, nonce, plan, wallet }) {
  const unsigned = { algorithm: SIGNATURE_ALGORITHM, fee: String(fee), networkId, nonce,
    plan: structuredClone(plan), publicKey: wallet.publicKey, sender: wallet.address,
    type: "validator-recovery-plan" };
  return { ...unsigned, signature: signObject(unsigned, wallet, "VALIDATOR_RECOVERY_PLAN_TX_V1") };
}

export function verifyValidatorRecoveryPlanTransaction(transaction, networkId) {
  exact(transaction, ["algorithm", "fee", "networkId", "nonce", "plan", "publicKey", "sender",
    "signature", "type"], "validator recovery plan transaction");
  const { signature, ...unsigned } = transaction;
  if (transaction.type !== "validator-recovery-plan" || transaction.algorithm !== SIGNATURE_ALGORITHM ||
      transaction.networkId !== networkId || addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
      !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0 ||
      !/^(0|[1-9][0-9]*)$/.test(transaction.fee ?? "") || BigInt(transaction.fee) < MIN_TRANSFER_FEE ||
      !canonicalSignature(signature) ||
      !verifyObject(unsigned, signature, transaction.publicKey, "VALIDATOR_RECOVERY_PLAN_TX_V1")) {
    throw new Error("validator recovery plan transaction is invalid");
  }
  return structuredClone(transaction);
}

export function validatorRecoveryCheckpointPayload({ blockHash, generation, height, networkId, planHash, previousHash,
  reserveSetId, stateRoot }) {
  return { blockHash, format: "nir-validator-recovery-checkpoint-v1", generation, height,
    networkId, planHash, previousHash, reserveSetId, stateRoot };
}

export function verifyValidatorRecoveryCheckpoint(certificate, context, plan) {
  exact(certificate, ["commits", "format", "prepares"], "validator recovery checkpoint certificate");
  if (certificate.format !== "nir-validator-recovery-checkpoint-certificate-v1") {
    throw new Error("validator recovery checkpoint certificate format is invalid");
  }
  const payload = validatorRecoveryCheckpointPayload(context);
  if (payload.networkId !== plan.networkId || payload.planHash !== plan.planHash ||
      payload.generation !== plan.generation || payload.reserveSetId !== plan.reserveSetId ||
      !Number.isSafeInteger(payload.height) || payload.height < plan.activationHeight ||
      !HASH.test(payload.blockHash ?? "") || !HASH.test(payload.previousHash ?? "") ||
      !HASH.test(payload.stateRoot ?? "")) {
    throw new Error("validator recovery checkpoint context is invalid");
  }
  const members = new Map(plan.reserves.map((member) => [member.address, member]));
  for (const [votes, phase, domain] of [
    [certificate.prepares, "prepare", "VALIDATOR_RECOVERY_CHECKPOINT_PREPARE_V1"],
    [certificate.commits, "commit", "VALIDATOR_RECOVERY_CHECKPOINT_COMMIT_V1"],
  ]) {
    if (!Array.isArray(votes) || votes.length > members.size) throw new Error("recovery checkpoint votes are invalid");
    const seen = new Set();
    for (const vote of votes) {
      exact(vote, ["phase", "reserve", "signature"], "validator recovery checkpoint vote");
      const member = members.get(vote.reserve);
      if (!member || vote.phase !== phase || seen.has(vote.reserve) ||
          !canonicalSignature(vote.signature) ||
          !verifyObject(payload, vote.signature, member.publicKey, domain)) {
        throw new Error("validator recovery checkpoint vote is invalid");
      }
      seen.add(vote.reserve);
    }
    if (seen.size < quorum(members.size)) throw new Error("validator recovery checkpoint quorum is not reached");
  }
  return { ...payload, certificateHash: hashObject({ certificate, payload },
    "VALIDATOR_RECOVERY_CHECKPOINT_CERT_V1") };
}

export function createValidatorRecoveryCheckpointCertificate({ commits, prepares }) {
  return { commits: [...commits].sort((a, b) => a.reserve < b.reserve ? -1 : 1),
    format: "nir-validator-recovery-checkpoint-certificate-v1",
    prepares: [...prepares].sort((a, b) => a.reserve < b.reserve ? -1 : 1) };
}

export function validatorRecoveryVotePayload({ blockHash, checkpointHash, evidenceHash, generation, height,
  networkId, planHash, reserveSetId }) {
  return { blockHash, checkpointHash, evidenceHash, format: "nir-validator-recovery-vote-v1",
    generation, height, networkId, planHash, reserveSetId };
}

export function verifyValidatorRecoveryVotes({ commits, prepares }, context, plan) {
  const payload = validatorRecoveryVotePayload(context);
  if (payload.networkId !== plan.networkId || payload.planHash !== plan.planHash ||
      payload.generation !== plan.generation || payload.reserveSetId !== plan.reserveSetId ||
      !HASH.test(payload.blockHash ?? "") || !HASH.test(payload.checkpointHash ?? "") ||
      !HASH.test(payload.evidenceHash ?? "") || !Number.isSafeInteger(payload.height)) {
    throw new Error("validator recovery vote context is invalid");
  }
  const members = new Map(plan.reserves.map((member) => [member.address, member]));
  for (const [votes, phase, domain] of [
    [prepares, "prepare", "VALIDATOR_RECOVERY_BLOCK_PREPARE_V1"],
    [commits, "commit", "VALIDATOR_RECOVERY_BLOCK_COMMIT_V1"],
  ]) {
    if (!Array.isArray(votes) || votes.length > members.size) throw new Error("validator recovery votes are invalid");
    const seen = new Set();
    for (const vote of votes) {
      exact(vote, ["phase", "reserve", "signature"], "validator recovery block vote");
      const member = members.get(vote.reserve);
      if (!member || vote.phase !== phase || seen.has(vote.reserve) ||
          !canonicalSignature(vote.signature) ||
          !verifyObject(payload, vote.signature, member.publicKey, domain)) {
        throw new Error("validator recovery block vote is invalid");
      }
      seen.add(vote.reserve);
    }
    if (seen.size < quorum(members.size)) throw new Error("validator recovery block quorum is not reached");
  }
  return payload;
}

export function verifyValidatorRecoveryEnvelope(transaction, {
  currentHeight, networkId, plan, previousBlock,
} = {}) {
  exact(transaction, ["checkpoint", "checkpointCertificate", "evidenceTransaction", "format",
    "generation", "planHash", "type"], "validator recovery transaction");
  if (transaction.type !== "validator-recovery" ||
      transaction.format !== "nir-validator-recovery-transition-v1" || !plan ||
      transaction.generation !== plan.generation || transaction.planHash !== plan.planHash ||
      currentHeight !== previousBlock?.height + 1 || currentHeight < plan.activationHeight) {
    throw new Error("validator recovery transition context is invalid");
  }
  const checkpoint = verifyValidatorRecoveryCheckpoint(
    transaction.checkpointCertificate, transaction.checkpoint, plan,
  );
  if (checkpoint.height !== previousBlock.height || checkpoint.blockHash !== previousBlock.hash ||
      checkpoint.previousHash !== previousBlock.previousHash ||
      checkpoint.stateRoot !== previousBlock.stateRoot || checkpoint.networkId !== networkId) {
    throw new Error("validator recovery checkpoint is not the finalized head");
  }
  if (transaction.evidenceTransaction?.type !== "validator-admission-omission" ||
      transaction.evidenceTransaction.evidence?.blockHash !== previousBlock.hash) {
    throw new Error("validator recovery trigger is not finalized omission evidence");
  }
  return { checkpointHash: checkpoint.certificateHash,
    evidenceHash: transaction.evidenceTransaction.evidence.evidenceHash };
}
