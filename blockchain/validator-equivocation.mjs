import {
  EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION, MIN_TRANSFER_FEE,
  RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION, SIGNATURE_ALGORITHM,
} from "./constants.mjs";
import {
  addressFromPublicKey,
  canonicalJson,
  hashObject,
  signObject,
  verifyObject,
} from "./crypto.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";

export const MAX_EQUIVOCATION_EVIDENCE_BYTES = 32 * 1024;

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HASH = /^[0-9a-f]{64}$/;
const EVIDENCE_FIELDS = [
  "evidenceHash", "format", "height", "nativePenaltyAvailable", "networkId",
  "round", "statements", "validator",
];
const EVIDENCE_STATEMENT_FIELDS = ["blockHash", "header", "signature"];
const LEGACY_HEADER_FIELDS = [
  "accountStateRoot", "bodyHash", "capabilityMemoryRoot", "format", "height",
  "networkId", "peerRegistryHash", "previousHash", "protocolUpgrade", "protocolVersion",
  "stateRoot", "timestamp", "transactionCount", "transactionsRoot",
];
const TRANSACTION_FIELDS = [
  "algorithm", "evidence", "fee", "networkId", "nonce", "publicKey", "sender",
  "signature", "type",
];

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function unsignedTransaction(transaction) {
  const { signature: _signature, ...unsigned } = transaction;
  return unsigned;
}

function assertHeader(header) {
  const recoveryFormat = header?.protocolVersion >= RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION;
  const assignmentFormat = header?.protocolVersion >= EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION;
  exact(header, recoveryFormat ? [...LEGACY_HEADER_FIELDS, "recoveryStateCommitment",
    ...(assignmentFormat ? ["evaluationAssignmentRoot"] : [])] : LEGACY_HEADER_FIELDS,
  "validator equivocation block header");
  if (header.format !== (assignmentFormat ? "nir-finality-header-v3" :
    recoveryFormat ? "nir-finality-header-v2" : "nir-finality-header-v1") ||
      typeof header.networkId !== "string" || header.networkId.length < 1 ||
      header.networkId.length > 128 || !Number.isSafeInteger(header.height) ||
      header.height < 1 || !Number.isSafeInteger(header.timestamp) || header.timestamp < 0 ||
      !Number.isSafeInteger(header.protocolVersion) || header.protocolVersion < 1 ||
      !Number.isSafeInteger(header.transactionCount) || header.transactionCount < 0 ||
      [header.accountStateRoot, header.bodyHash, header.capabilityMemoryRoot,
        header.peerRegistryHash, header.previousHash,
        ...(recoveryFormat ? [header.recoveryStateCommitment] : []), header.stateRoot,
        ...(assignmentFormat ? [header.evaluationAssignmentRoot] : []),
        header.transactionsRoot].some((value) => !HASH.test(value ?? ""))) {
    throw new Error("validator equivocation block header is invalid");
  }
}

function assertEvidenceEnvelope(evidence) {
  exact(evidence, EVIDENCE_FIELDS, "validator equivocation evidence");
  if (evidence.format !== "nir-validator-prepare-equivocation-v2" ||
      evidence.nativePenaltyAvailable !== true || !ADDRESS.test(evidence.validator ?? "") ||
      typeof evidence.networkId !== "string" || evidence.networkId.length < 1 ||
      evidence.networkId.length > 128 || !Number.isSafeInteger(evidence.height) ||
      evidence.height < 1 || !Number.isSafeInteger(evidence.round) || evidence.round < 0 ||
      !HASH.test(evidence.evidenceHash ?? "") || !Array.isArray(evidence.statements) ||
      evidence.statements.length !== 2) {
    throw new Error("validator equivocation evidence header is invalid");
  }
  for (const item of evidence.statements) {
    exact(item, EVIDENCE_STATEMENT_FIELDS, "validator equivocation statement");
    assertHeader(item.header);
    if (!HASH.test(item.blockHash ?? "") || typeof item.signature !== "string" ||
        item.signature.length < 1 || item.signature.length > 7_000) {
      throw new Error("validator equivocation statement is invalid");
    }
  }
  if (Buffer.byteLength(canonicalJson(evidence)) > MAX_EQUIVOCATION_EVIDENCE_BYTES) {
    throw new Error("validator equivocation evidence exceeds the byte-size limit");
  }
}

function evidencePayload(evidence) {
  const { evidenceHash: _evidenceHash, ...payload } = evidence;
  return payload;
}

function verifyEvidenceMetadata(evidence, headerHash) {
  const [left, right] = evidence.statements;
  if (left.blockHash >= right.blockHash ||
      hashObject(evidencePayload(evidence), "VALIDATOR_EQUIVOCATION_V2") !== evidence.evidenceHash) {
    throw new Error("validator equivocation evidence hash or ordering is invalid");
  }
  for (const item of evidence.statements) {
    if (item.header.networkId !== evidence.networkId || item.header.height !== evidence.height ||
        headerHash(item.header) !== item.blockHash) {
      throw new Error("validator equivocation statement context is inconsistent");
    }
  }
  if (left.header.previousHash !== right.header.previousHash) {
    throw new Error("validator equivocation statements have different parent blocks");
  }
}

export function assembleValidatorPrepareEquivocationEvidence({
  first, second, height, networkId, round, validator,
}) {
  const statements = [first, second].map((item) => ({
    blockHash: item.blockHash,
    header: structuredClone(item.header),
    signature: item.signature,
  })).sort((left, right) => left.blockHash.localeCompare(right.blockHash));
  const payload = {
    format: "nir-validator-prepare-equivocation-v2",
    height,
    nativePenaltyAvailable: true,
    networkId,
    round,
    statements,
    validator,
  };
  const evidence = { ...payload, evidenceHash: hashObject(payload, "VALIDATOR_EQUIVOCATION_V2") };
  assertEvidenceEnvelope(evidence);
  return evidence;
}

export function proveValidatorPrepareEquivocation({ chain, first, second } = {}) {
  if (typeof chain?.validateProposal !== "function" ||
      typeof chain?.validatorMembersForHeight !== "function" ||
      typeof chain?.finalityHeaderForProposal !== "function") {
    throw new Error("verified chain context is required for equivocation evidence");
  }
  const statements = [first, second];
  for (const [index, item] of statements.entries()) {
    if (!item?.proposal || !item?.vote || !ADDRESS.test(item.vote.validator ?? "") ||
        !Number.isSafeInteger(item.vote.round) || item.vote.round !== item.proposal.round ||
        typeof item.vote.signature !== "string" || item.vote.signature.length > 7_000) {
      throw new Error(`${index === 0 ? "first" : "second"} validator prepare statement is invalid`);
    }
  }
  const [left, right] = statements;
  if (left.vote.validator !== right.vote.validator ||
      left.proposal.networkId !== right.proposal.networkId ||
      left.proposal.height !== right.proposal.height || left.proposal.round !== right.proposal.round) {
    throw new Error("prepare statements do not prove same-round validator equivocation");
  }
  let verified;
  try {
    verified = statements.map(({ proposal }) => ({
      blockHash: chain.validateProposal(proposal),
      header: chain.finalityHeaderForProposal(proposal),
    }));
  } catch {
    throw new Error("equivocation proposal is malformed or invalid for the verified chain state");
  }
  if (verified[0].blockHash === verified[1].blockHash) {
    throw new Error("prepare statements do not prove same-round validator equivocation");
  }
  const member = chain.validatorMembersForHeight(left.proposal.height)
    .find(({ address }) => address === left.vote.validator);
  if (!member || typeof member.publicKey !== "string" ||
      !statements.every((item, index) => verifyObject(
        { blockHash: verified[index].blockHash, height: left.proposal.height, round: left.proposal.round },
        item.vote.signature,
        member.publicKey,
        "BLOCK_PREPARE",
      ))) {
    throw new Error("validator equivocation signatures are invalid");
  }
  return assembleValidatorPrepareEquivocationEvidence({
    first: { ...verified[0], signature: left.vote.signature },
    second: { ...verified[1], signature: right.vote.signature },
    height: left.proposal.height,
    networkId: left.proposal.networkId,
    round: left.proposal.round,
    validator: left.vote.validator,
  });
}

export function verifyValidatorPrepareEquivocationEvidence(evidence, { chain } = {}) {
  assertEvidenceEnvelope(evidence);
  if (typeof chain?.finalityHeaderHash !== "function" ||
      typeof chain?.validatorMembersForHeight !== "function") {
    throw new Error("verified chain context is required for equivocation evidence");
  }
  verifyEvidenceMetadata(evidence, (header) => chain.finalityHeaderHash(header));
  const member = chain.validatorMembersForHeight(evidence.height)
    .find(({ address }) => address === evidence.validator);
  if (!member || !evidence.statements.every((item) => verifyObject(
    { blockHash: item.blockHash, height: evidence.height, round: evidence.round },
    item.signature,
    member.publicKey,
    "BLOCK_PREPARE",
  ))) {
    throw new Error("validator equivocation signatures are invalid");
  }
  return structuredClone(evidence);
}

export function verifyFinalizedValidatorEquivocationEvidence(evidence, {
  finalizedHeader,
  finalizedRound,
  headerHash,
  validatorBonds,
  validators,
} = {}) {
  assertEvidenceEnvelope(evidence);
  assertHeader(finalizedHeader);
  if (typeof headerHash !== "function" || !(validatorBonds instanceof Map) ||
      !Array.isArray(validators)) {
    throw new Error("finalized equivocation context is invalid");
  }
  if (evidence.networkId !== finalizedHeader.networkId ||
      evidence.height !== finalizedHeader.height || evidence.round !== finalizedRound) {
    throw new Error("equivocation evidence is not for the current finalized head");
  }
  const member = validators.find(({ address }) => address === evidence.validator);
  const bond = validatorBonds.get(evidence.validator) ?? 0n;
  if (!member || typeof member.publicKey !== "string" || bond < MIN_VALIDATOR_BOND) {
    throw new Error("equivocating validator was not active and bonded in finalized context");
  }
  verifyEvidenceMetadata(evidence, headerHash);
  if (!evidence.statements.every((item) => verifyObject(
    { blockHash: item.blockHash, height: evidence.height, round: evidence.round },
    item.signature,
    member.publicKey,
    "BLOCK_PREPARE",
  ))) {
    throw new Error("validator equivocation statement signature is invalid");
  }
  const finalized = canonicalJson(finalizedHeader);
  if (evidence.statements.filter(({ header }) => canonicalJson(header) === finalized).length !== 1) {
    throw new Error("equivocation evidence does not contain the exact finalized header");
  }
  return { bond, evidenceHash: evidence.evidenceHash, validator: evidence.validator };
}

export function createValidatorEquivocationTransaction({
  evidence, wallet, networkId, nonce, fee = MIN_TRANSFER_FEE.toString(),
}) {
  assertEvidenceEnvelope(evidence);
  const transaction = {
    algorithm: SIGNATURE_ALGORITHM,
    evidence: structuredClone(evidence),
    fee: String(fee),
    networkId,
    nonce,
    publicKey: wallet.publicKey,
    sender: wallet.address,
    type: "validator-equivocation",
  };
  return {
    ...transaction,
    signature: signObject(transaction, wallet, "VALIDATOR_EQUIVOCATION_TRANSACTION"),
  };
}

export function verifyValidatorEquivocationTransactionEnvelope(transaction, networkId) {
  exact(transaction, TRANSACTION_FIELDS, "validator equivocation transaction");
  assertEvidenceEnvelope(transaction.evidence);
  if (transaction.type !== "validator-equivocation" ||
      transaction.algorithm !== SIGNATURE_ALGORITHM || transaction.networkId !== networkId ||
      transaction.evidence.networkId !== networkId ||
      addressFromPublicKey(transaction.publicKey) !== transaction.sender ||
      !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0 ||
      typeof transaction.fee !== "string" || transaction.fee.length > 32 ||
      !DECIMAL.test(transaction.fee) || BigInt(transaction.fee) < MIN_TRANSFER_FEE ||
      !verifyObject(
        unsignedTransaction(transaction), transaction.signature, transaction.publicKey,
        "VALIDATOR_EQUIVOCATION_TRANSACTION",
      )) {
    throw new Error("validator equivocation transaction is invalid");
  }
  return structuredClone(transaction);
}
