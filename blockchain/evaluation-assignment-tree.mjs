import { canonicalJson, hashObject } from "./crypto.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const ARTIFACT = /^sha256:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const DEPTH = 256;
const FORMAT = "nir-evaluation-assignment-proof-v1";
const VALUE_FORMAT = "nir-evaluation-assignment-v1";
const EXTENDED_VALUE_FORMAT = "nir-evaluation-assignment-v2";
export const MAX_EVALUATION_ASSIGNMENT_PROOF_BYTES = 32 * 1024;
export const MAX_EVALUATION_ASSIGNMENT_VALUE_BYTES = 64 * 1024;
export const MAX_EVALUATION_ASSIGNMENTS = 4_096;

const emptyHashes = Array(DEPTH + 1);
emptyHashes[DEPTH] = hashObject(null, "EVALUATION_ASSIGNMENT_TREE_EMPTY_LEAF");
for (let depth = DEPTH - 1; depth >= 0; depth -= 1) {
  emptyHashes[depth] = hashObject({
    left: emptyHashes[depth + 1], right: emptyHashes[depth + 1],
  }, "EVALUATION_ASSIGNMENT_TREE_NODE");
}

function candidateBits(candidateId) {
  if (!HASH.test(candidateId ?? "")) throw new Error("evaluation assignment candidate id is invalid");
  return [...candidateId].map((digit) =>
    Number.parseInt(digit, 16).toString(2).padStart(4, "0")).join("");
}

export function normalizeEvaluationAssignment(value) {
  const baseFields = [
    "artifactHash", "baselineContentHash", "baselineHash", "candidateId",
    "challengeEpoch", "challengeHeight", "challengeSeed", "committedHeight",
    "committee", "contentHash", "format", "parents", "recipient", "suiteCommitment",
  ];
  const extendedFields = [
    "adapterProtocol", "authorityMode", "authoritySetHash",
    "environmentCommitment", "evaluators", "expiresAtHeight", "safetyPolicyHash",
    "sourceFinalityHeight", "sourceFinalityStateRoot",
  ];
  const extended = value?.format === EXTENDED_VALUE_FORMAT;
  const expected = [...baseFields, ...(extended ? extendedFields : [])].sort().join("\0");
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== expected ||
      ![VALUE_FORMAT, EXTENDED_VALUE_FORMAT].includes(value.format) ||
      !HASH.test(value.candidateId ?? "") || !HASH.test(value.challengeSeed ?? "") ||
      !HASH.test(value.suiteCommitment ?? "") || !ARTIFACT.test(value.artifactHash ?? "") ||
      !ARTIFACT.test(value.baselineContentHash ?? "") || !ARTIFACT.test(value.baselineHash ?? "") ||
      !ARTIFACT.test(value.contentHash ?? "") || !ADDRESS.test(value.recipient ?? "") ||
      !Number.isSafeInteger(value.committedHeight) || value.committedHeight < 1 ||
      !Number.isSafeInteger(value.challengeHeight) ||
      value.challengeHeight <= value.committedHeight ||
      value.challengeEpoch !== value.challengeHeight || !Array.isArray(value.parents) ||
      value.parents.length < 1 || value.parents.length > 32 ||
      value.parents.some((parent) => !ARTIFACT.test(parent)) ||
      new Set(value.parents).size !== value.parents.length ||
      value.parents.some((parent, index) => index > 0 && parent <= value.parents[index - 1]) ||
      !Array.isArray(value.committee) || value.committee.length < 1 ||
      value.committee.length > 256 || value.committee.some((member) => !ADDRESS.test(member)) ||
      new Set(value.committee).size !== value.committee.length ||
      value.committee.some((member, index) => index > 0 && member <= value.committee[index - 1]) ||
      Buffer.byteLength(canonicalJson(value)) > MAX_EVALUATION_ASSIGNMENT_VALUE_BYTES ||
      (extended && (!HASH.test(value.environmentCommitment ?? "") ||
        typeof value.adapterProtocol !== "string" ||
        !/^[a-z][a-z0-9._-]{0,63}$/.test(value.adapterProtocol) ||
        !HASH.test(value.safetyPolicyHash ?? "") ||
        !HASH.test(value.authoritySetHash ?? "") ||
        value.authorityMode !== "consensus-finality-certificate-v1" ||
        !Number.isSafeInteger(value.sourceFinalityHeight) || value.sourceFinalityHeight < 0 ||
        value.sourceFinalityHeight >= value.challengeHeight ||
        !HASH.test(value.sourceFinalityStateRoot ?? "") ||
        !Number.isSafeInteger(value.expiresAtHeight) ||
        value.expiresAtHeight <= value.challengeHeight ||
        !Array.isArray(value.evaluators) || value.evaluators.length !== value.committee.length ||
        value.evaluators.some((member, index) =>
          !member || Object.getPrototypeOf(member) !== Object.prototype ||
          Object.keys(member).sort().join("\0") !== "evaluatorId\0publicKeyHash" ||
          member.evaluatorId !== value.committee[index] ||
          !HASH.test(member.publicKeyHash ?? ""))))) {
    throw new Error("evaluation assignment value is invalid");
  }
  return structuredClone(value);
}

export function evaluationAssignmentFromCommitment(candidateId, commitment) {
  if (!commitment || commitment.challengeSeed === null || commitment.challengeHeight === null ||
      commitment.committee === null) return null;
  return normalizeEvaluationAssignment({
    artifactHash: commitment.artifactHash,
    baselineContentHash: commitment.baselineContentHash,
    baselineHash: commitment.baselineHash,
    candidateId,
    challengeEpoch: commitment.challengeHeight,
    challengeHeight: commitment.challengeHeight,
    challengeSeed: commitment.challengeSeed,
    committedHeight: commitment.committedHeight,
    // Committee selection order is an internal sampling detail.  The signed
    // external assignment represents membership as a sorted unique set, so the
    // consensus leaf must commit to the same canonical representation.
    committee: [...commitment.committee].sort(),
    contentHash: commitment.contentHash,
    format: VALUE_FORMAT,
    parents: [...commitment.parents],
    recipient: commitment.recipient,
    suiteCommitment: commitment.suiteCommitment,
  });
}

export function extendedEvaluationAssignmentFromCommitment(candidateId, commitment, {
  evaluators, authorities, sourceFinalityHeight, sourceFinalityStateRoot,
  safetyPolicyHash, expiresAtHeight, environmentCommitment, adapterProtocol,
}) {
  const base = evaluationAssignmentFromCommitment(candidateId, commitment);
  if (!base) return null;
  const assigned = base.committee.map((evaluatorId) => {
    const member = evaluators.get(evaluatorId);
    if (!member) throw new Error("evaluation assignment evaluator is not registered");
    return {
      evaluatorId,
      publicKeyHash: hashObject(member.publicKey, "EVALUATION_ASSIGNMENT_PUBLIC_KEY_V1"),
    };
  });
  const authorityMembers = [...authorities.values()]
    .map(({ address, publicKey }) => ({ authorityId: address, publicKey }))
    .sort((left, right) => left.authorityId.localeCompare(right.authorityId));
  return normalizeEvaluationAssignment({
    ...base,
    adapterProtocol,
    authorityMode: "consensus-finality-certificate-v1",
    authoritySetHash: hashObject(authorityMembers, "NIR_ASSIGN_AUTH_SET_V1"),
    environmentCommitment,
    evaluators: assigned,
    expiresAtHeight,
    format: EXTENDED_VALUE_FORMAT,
    safetyPolicyHash,
    sourceFinalityHeight,
    sourceFinalityStateRoot,
  });
}

export function evaluationAssignments(progressCommitments) {
  const entries = progressCommitments instanceof Map
    ? [...progressCommitments.entries()] : progressCommitments;
  if (!Array.isArray(entries) || entries.length > MAX_EVALUATION_ASSIGNMENTS) {
    throw new Error("evaluation assignment entries are invalid");
  }
  const assignments = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || seen.has(entry[0])) {
      throw new Error("evaluation assignment entries are invalid");
    }
    seen.add(entry[0]);
    const assignment = [VALUE_FORMAT, EXTENDED_VALUE_FORMAT].includes(entry[1]?.format)
      ? normalizeEvaluationAssignment(entry[1])
      : evaluationAssignmentFromCommitment(entry[0], entry[1]);
    if (assignment && assignment.candidateId !== entry[0]) {
      throw new Error("evaluation assignment key does not match its value");
    }
    if (assignment) assignments.push(assignment);
  }
  return assignments.sort((left, right) =>
    left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
}

export function assertActiveEvaluationAssignmentRegistry(progressCommitments, entries) {
  const expected = evaluationAssignments(progressCommitments);
  const actual = evaluationAssignments(entries);
  if (actual.length !== expected.length) {
    throw new Error("active evaluation assignment registry is inconsistent");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const projection = Object.fromEntries(Object.keys(expected[index])
      .map((key) => [key, actual[index][key]]));
    projection.format = expected[index].format;
    if (canonicalJson(projection) !== canonicalJson(expected[index])) {
      throw new Error("active evaluation assignment registry is inconsistent");
    }
  }
  return actual;
}

function leafHash(assignment) {
  return hashObject(normalizeEvaluationAssignment(assignment), "EVALUATION_ASSIGNMENT_TREE_LEAF");
}

function buildLevels(assignments) {
  const leaves = new Map();
  for (const value of assignments) {
    const assignment = normalizeEvaluationAssignment(value);
    const path = candidateBits(assignment.candidateId);
    if (leaves.has(path)) throw new Error("evaluation assignment tree contains a duplicate candidate");
    leaves.set(path, leafHash(assignment));
  }
  const levels = Array(DEPTH + 1);
  levels[DEPTH] = leaves;
  for (let depth = DEPTH - 1; depth >= 0; depth -= 1) {
    const parents = new Set([...levels[depth + 1].keys()].map((path) => path.slice(0, depth)));
    const nodes = new Map();
    for (const parent of parents) {
      const left = levels[depth + 1].get(`${parent}0`) ?? emptyHashes[depth + 1];
      const right = levels[depth + 1].get(`${parent}1`) ?? emptyHashes[depth + 1];
      nodes.set(parent, hashObject({ left, right }, "EVALUATION_ASSIGNMENT_TREE_NODE"));
    }
    levels[depth] = nodes;
  }
  return levels;
}

export function evaluationAssignmentRoot(progressCommitments) {
  const levels = buildLevels(evaluationAssignments(progressCommitments));
  return levels[0].get("") ?? emptyHashes[0];
}

export function createEvaluationAssignmentWitness(progressCommitments, candidateId) {
  const assignments = evaluationAssignments(progressCommitments);
  const assignment = assignments.find((value) => value.candidateId === candidateId);
  if (!assignment) throw new Error("evaluation assignment is not available");
  const levels = buildLevels(assignments);
  const path = candidateBits(candidateId);
  const siblings = [];
  for (let depth = DEPTH; depth > 0; depth -= 1) {
    const prefix = path.slice(0, depth);
    const sibling = `${prefix.slice(0, -1)}${prefix.endsWith("0") ? "1" : "0"}`;
    siblings.push(levels[depth].get(sibling) ?? emptyHashes[depth]);
  }
  return {
    assignment,
    evaluationAssignmentRoot: levels[0].get("") ?? emptyHashes[0],
    inclusionProof: { format: FORMAT, siblings },
  };
}

export function verifyEvaluationAssignmentProof(assignment, proof, expectedRoot) {
  const normalized = normalizeEvaluationAssignment(assignment);
  if (!proof || Object.keys(proof).sort().join(",") !== "format,siblings" ||
      proof.format !== FORMAT || !Array.isArray(proof.siblings) ||
      proof.siblings.length !== DEPTH || proof.siblings.some((hash) => !HASH.test(hash ?? "")) ||
      !HASH.test(expectedRoot ?? "") ||
      Buffer.byteLength(canonicalJson(proof)) > MAX_EVALUATION_ASSIGNMENT_PROOF_BYTES) {
    throw new Error("evaluation assignment inclusion proof is invalid");
  }
  const path = candidateBits(normalized.candidateId);
  let current = leafHash(normalized);
  for (let index = 0; index < DEPTH; index += 1) {
    const sibling = proof.siblings[index];
    current = path[DEPTH - 1 - index] === "0"
      ? hashObject({ left: current, right: sibling }, "EVALUATION_ASSIGNMENT_TREE_NODE")
      : hashObject({ left: sibling, right: current }, "EVALUATION_ASSIGNMENT_TREE_NODE");
  }
  if (current !== expectedRoot) throw new Error("evaluation assignment root does not match");
  return normalized;
}
