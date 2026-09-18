import { blockHash } from "./chain.mjs";
import { canonicalJson, hashObject, verifyObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const EVIDENCE_FIELDS = [
  "evidenceHash", "format", "height", "nativePenaltyAvailable", "networkId",
  "round", "statements", "validator",
];
const EVIDENCE_STATEMENT_FIELDS = ["blockHash", "proposal", "signature"];

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function statement(value, label) {
  const proposal = value?.proposal;
  const vote = value?.vote;
  if (!proposal || !vote || !ADDRESS.test(vote.validator ?? "") ||
      typeof vote.signature !== "string" || vote.signature.length > 7_000 ||
      typeof proposal.networkId !== "string" || proposal.networkId.length < 1 ||
      proposal.networkId.length > 128 || !Number.isSafeInteger(proposal.height) ||
      proposal.height < 1 || !Number.isSafeInteger(proposal.round) || proposal.round < 0) {
    throw new Error(`${label} validator prepare statement is invalid`);
  }
  return {
    blockHash: blockHash(proposal),
    height: proposal.height,
    networkId: proposal.networkId,
    round: proposal.round,
    signature: vote.signature,
    validator: vote.validator,
  };
}

export function proveValidatorPrepareEquivocation({ chain, first, second } = {}) {
  if (typeof chain?.validateProposal !== "function" ||
      typeof chain?.validatorMembersForHeight !== "function") {
    throw new Error("verified chain context is required for equivocation evidence");
  }
  const left = statement(first, "first");
  const right = statement(second, "second");
  if (left.validator !== right.validator || left.networkId !== right.networkId ||
      left.height !== right.height || left.round !== right.round ||
      left.blockHash === right.blockHash) {
    throw new Error("prepare statements do not prove same-round validator equivocation");
  }
  try {
    if (chain.validateProposal(first.proposal) !== left.blockHash ||
        chain.validateProposal(second.proposal) !== right.blockHash) {
      throw new Error("proposal hash mismatch");
    }
  } catch {
    throw new Error("equivocation proposal is malformed or invalid for the verified chain state");
  }
  const validators = chain.validatorMembersForHeight(left.height);
  const member = validators.find(({ address }) => address === left.validator);
  if (!member || typeof member.publicKey !== "string" ||
      !verifyObject({ blockHash: left.blockHash }, left.signature, member.publicKey, "BLOCK_PREPARE") ||
      !verifyObject({ blockHash: right.blockHash }, right.signature, member.publicKey, "BLOCK_PREPARE")) {
    throw new Error("validator equivocation signatures are invalid");
  }
  const statements = [
    { ...left, proposal: structuredClone(first.proposal) },
    { ...right, proposal: structuredClone(second.proposal) },
  ]
    .map(({ blockHash: hash, proposal, signature }) => ({
      blockHash: hash, proposal, signature,
    }))
    .sort((a, b) => a.blockHash.localeCompare(b.blockHash));
  const payload = {
    format: "nir-validator-prepare-equivocation-v1",
    height: left.height,
    nativePenaltyAvailable: false,
    networkId: left.networkId,
    round: left.round,
    statements,
    validator: left.validator,
  };
  return {
    ...payload,
    evidenceHash: hashObject(payload, "VALIDATOR_EQUIVOCATION_V1"),
  };
}

export function verifyValidatorPrepareEquivocationEvidence(evidence, { chain } = {}) {
  exact(evidence, EVIDENCE_FIELDS, "validator equivocation evidence");
  if (evidence.format !== "nir-validator-prepare-equivocation-v1" ||
      evidence.nativePenaltyAvailable !== false || !Array.isArray(evidence.statements) ||
      evidence.statements.length !== 2) {
    throw new Error("validator equivocation evidence header is invalid");
  }
  for (const statementValue of evidence.statements) {
    exact(statementValue, EVIDENCE_STATEMENT_FIELDS, "validator equivocation statement");
  }
  const rebuilt = proveValidatorPrepareEquivocation({
    chain,
    first: {
      proposal: evidence.statements[0].proposal,
      vote: { signature: evidence.statements[0].signature, validator: evidence.validator },
    },
    second: {
      proposal: evidence.statements[1].proposal,
      vote: { signature: evidence.statements[1].signature, validator: evidence.validator },
    },
  });
  if (canonicalJson(rebuilt) !== canonicalJson(evidence)) {
    throw new Error("validator equivocation evidence hash or metadata is invalid");
  }
  return rebuilt;
}
