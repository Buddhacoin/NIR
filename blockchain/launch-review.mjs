import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { addressFromPublicKey, hashObject, signObject, verifyObject } from "./crypto.mjs";

export const LAUNCH_REVIEW_FORMAT = "nir-public-testnet-launch-review-v1";
export const LAUNCH_REVIEW_APPROVAL_DOMAIN = "PUBLIC_TESTNET_LAUNCH_REVIEW";

const HASH = /^[0-9a-f]{64}$/;
const GATES = [...Array(14).keys()];
const ROLES = new Set(["operator", "security-reviewer"]);
const PAYLOAD_KEYS = ["evidence", "expiresAt", "format", "networkId", "observedAt", "reviewers"];
const ENVELOPE_KEYS = [...PAYLOAD_KEYS, "approvals", "reviewHash"];

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} shape is invalid`);
  }
}

function text(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function payload(value) {
  const keys = Object.keys(value ?? {});
  if (keys.length === ENVELOPE_KEYS.length) exact(value, ENVELOPE_KEYS, "launch review");
  else exact(value, PAYLOAD_KEYS, "launch review payload");
  const networkId = text(value.networkId, "launch review network ID", 64);
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.observedAt ||
      value.expiresAt - value.observedAt > 24 * 60 * 60 * 1_000) {
    throw new Error("launch review observation window is invalid");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length !== GATES.length ||
      !Array.isArray(value.reviewers) || value.reviewers.length < 6 || value.reviewers.length > 64) {
    throw new Error("launch review membership is invalid");
  }
  const seenGates = new Set(); let priorGate = -1;
  const evidence = value.evidence.map((entry) => {
    exact(entry, ["artifactHash", "gate", "resultHash"], "launch review evidence");
    if (!Number.isSafeInteger(entry.gate) || !GATES.includes(entry.gate) || seenGates.has(entry.gate) ||
        entry.gate <= priorGate || !HASH.test(entry.artifactHash ?? "") || !HASH.test(entry.resultHash ?? "")) {
      throw new Error("launch review evidence is invalid or unordered");
    }
    seenGates.add(entry.gate); priorGate = entry.gate;
    return { artifactHash: entry.artifactHash, gate: entry.gate, resultHash: entry.resultHash };
  });
  const seenReviewers = new Set(); const seenAddresses = new Set(); const seenKeys = new Set();
  let priorReviewer = null; let operators = 0; let security = 0;
  const reviewers = value.reviewers.map((entry) => {
    exact(entry, ["address", "algorithm", "publicKey", "reviewerId", "role"], "launch reviewer");
    const reviewerId = text(entry.reviewerId, "launch reviewer ID", 96);
    if (entry.algorithm !== SIGNATURE_ALGORITHM || addressFromPublicKey(entry.publicKey ?? "") !== entry.address ||
        !ROLES.has(entry.role) || seenReviewers.has(reviewerId) || seenAddresses.has(entry.address) ||
        seenKeys.has(entry.publicKey) || (priorReviewer !== null && reviewerId <= priorReviewer)) {
      throw new Error("launch reviewer is invalid, duplicated, or unordered");
    }
    seenReviewers.add(reviewerId); seenAddresses.add(entry.address); seenKeys.add(entry.publicKey); priorReviewer = reviewerId;
    if (entry.role === "operator") operators += 1; else security += 1;
    return { address: entry.address, algorithm: entry.algorithm, publicKey: entry.publicKey,
      reviewerId, role: entry.role };
  });
  if (operators < 4 || security < 2) throw new Error("launch review lacks required roles");
  return { evidence, expiresAt: value.expiresAt, format: LAUNCH_REVIEW_FORMAT, networkId,
    observedAt: value.observedAt, reviewers };
}

export function launchReviewHash(review) {
  return hashObject(payload(review), "PUBLIC_TESTNET_LAUNCH_REVIEW");
}

export function createLaunchReview(review) {
  const unsigned = payload({ ...review, format: LAUNCH_REVIEW_FORMAT });
  return { ...unsigned, approvals: [], reviewHash: launchReviewHash(unsigned) };
}

function verifiedEnvelope(review) {
  const unsigned = payload(review);
  const reviewHash = launchReviewHash(unsigned);
  if (review.reviewHash !== reviewHash || !Array.isArray(review.approvals) ||
      review.approvals.length > unsigned.reviewers.length) throw new Error("launch review envelope is invalid");
  const reviewers = new Map(unsigned.reviewers.map((reviewer) => [reviewer.reviewerId, reviewer]));
  const used = new Set(); let prior = null;
  const approvals = review.approvals.map((approval) => {
    exact(approval, ["reviewerId", "signature"], "launch review approval");
    const reviewer = reviewers.get(approval.reviewerId);
    if (!reviewer || used.has(approval.reviewerId) || typeof approval.signature !== "string" ||
        approval.signature.length > 7_000 || (prior !== null && approval.reviewerId <= prior) ||
        !verifyObject(unsigned, approval.signature, reviewer.publicKey, LAUNCH_REVIEW_APPROVAL_DOMAIN)) {
      throw new Error("launch review approval is forged, duplicated, or unordered");
    }
    used.add(approval.reviewerId); prior = approval.reviewerId;
    return { reviewerId: approval.reviewerId, signature: approval.signature };
  });
  return { ...unsigned, approvals, reviewHash };
}

export function signLaunchReview(review, wallet, reviewerId) {
  const verified = verifiedEnvelope(review);
  const reviewer = verified.reviewers.find((entry) => entry.reviewerId === reviewerId);
  if (!reviewer || wallet?.address !== reviewer.address || wallet.publicKey !== reviewer.publicKey ||
      verified.approvals.some((approval) => approval.reviewerId === reviewerId)) {
    throw new Error("launch review signer is not an unused configured reviewer");
  }
  const unsigned = payload(verified);
  const approvals = [...verified.approvals, {
    reviewerId, signature: signObject(unsigned, wallet, LAUNCH_REVIEW_APPROVAL_DOMAIN),
  }].sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  return { ...unsigned, approvals, reviewHash: verified.reviewHash };
}

export function verifyLaunchReview(review, { expectedNetworkId, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || typeof expectedNetworkId !== "string") {
    throw new Error("launch review verification context is invalid");
  }
  const verified = verifiedEnvelope(review);
  if (verified.networkId !== expectedNetworkId || now < verified.observedAt || now > verified.expiresAt) {
    throw new Error("launch review is outside its trusted context");
  }
  if (verified.approvals.length !== verified.reviewers.length) {
    throw new Error("launch review requires every configured reviewer approval");
  }
  return { approvals: verified.approvals.length, evidenceGates: verified.evidence.length,
    networkId: verified.networkId, reviewHash: verified.reviewHash, status: "LAUNCH-REVIEW-CRYPTOGRAPHIC-PASS" };
}
