import { signObject, verifyObject } from "./crypto.mjs";
import { verifyGenesisPlan } from "./genesis-ceremony.mjs";

const HASH = /^[0-9a-f]{64}$/;
const PAYLOAD_FIELDS = [
  "count", "latestGenesisHash", "latestPlanCommitment", "registryHead",
  "releaseManifestHash",
];
const APPROVAL_FIELDS = ["operatorId", "signature"];
const ENVELOPE_FIELDS = ["approvals", "format", "payload"];
const FORMAT = "nir-genesis-ceremony-registry-anchor-v1";
const DOMAIN = "GENESIS_CEREMONY_REGISTRY_ANCHOR_V1";

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function anchorPayload(value) {
  exactObject(value, PAYLOAD_FIELDS, "ceremony registry anchor payload");
  if (!Number.isSafeInteger(value.count) || value.count < 1 ||
      !HASH.test(value.registryHead ?? "") || !HASH.test(value.latestPlanCommitment ?? "") ||
      !HASH.test(value.latestGenesisHash ?? "") || !HASH.test(value.releaseManifestHash ?? "")) {
    throw new Error("ceremony registry anchor payload is invalid");
  }
  return {
    count: value.count,
    latestGenesisHash: value.latestGenesisHash,
    latestPlanCommitment: value.latestPlanCommitment,
    registryHead: value.registryHead,
    releaseManifestHash: value.releaseManifestHash,
  };
}

function assertPayloadPlan(payload, plan) {
  if (payload.latestPlanCommitment !== plan.commitment ||
      payload.releaseManifestHash !== plan.sourceRelease.manifestHash) {
    throw new Error("ceremony registry anchor does not match the latest plan");
  }
}

export function createCeremonyRegistryAnchorPayload(registry) {
  if (!registry || !Array.isArray(registry.records) || registry.records.length < 1 ||
      registry.count !== registry.records.length || registry.head !== registry.records.at(-1).recordHash) {
    throw new Error("verified non-empty ceremony registry is required for anchor export");
  }
  const latest = registry.records.at(-1);
  return anchorPayload({
    count: registry.count,
    latestGenesisHash: latest.genesisHash,
    latestPlanCommitment: latest.plan.commitment,
    registryHead: registry.head,
    releaseManifestHash: latest.releaseProvenance.manifestHash,
  });
}

export function signCeremonyRegistryAnchor(payloadValue, planValue, wallet, options = {}) {
  const payload = anchorPayload(payloadValue);
  const plan = verifyGenesisPlan(planValue, options);
  assertPayloadPlan(payload, plan);
  const operator = plan.ceremonyOperators.find(({ address }) => address === wallet?.address);
  if (!operator) throw new Error("ceremony registry anchor signer is not a latest-plan operator");
  return {
    operatorId: operator.operatorId,
    signature: signObject(payload, wallet, DOMAIN),
  };
}

function verifiedApprovals(payload, plan, approvals) {
  if (!Array.isArray(approvals) || approvals.length > plan.ceremonyOperators.length) {
    throw new Error("ceremony registry anchor approvals are invalid");
  }
  const operators = new Map(plan.ceremonyOperators.map((operator) => [operator.operatorId, operator]));
  const seen = new Set();
  for (const approval of approvals) {
    exactObject(approval, APPROVAL_FIELDS, "ceremony registry anchor approval");
    const operator = operators.get(approval.operatorId);
    if (!operator || seen.has(approval.operatorId) ||
        typeof approval.signature !== "string" || approval.signature.length > 7_000 ||
        !verifyObject(payload, approval.signature, operator.publicKey, DOMAIN)) {
      throw new Error("ceremony registry anchor approval is unknown, duplicated, or invalid");
    }
    seen.add(approval.operatorId);
  }
  const quorum = Math.floor((operators.size * 2) / 3) + 1;
  if (seen.size < quorum) throw new Error("ceremony registry anchor quorum not reached");
  return { quorum, signers: [...seen].sort() };
}

export function assembleCeremonyRegistryAnchor(
  payloadValue, planValue, approvals, options = {},
) {
  const payload = anchorPayload(payloadValue);
  const plan = verifyGenesisPlan(planValue, options);
  assertPayloadPlan(payload, plan);
  verifiedApprovals(payload, plan, approvals);
  return {
    approvals: approvals.map((approval) => structuredClone(approval))
      .sort((left, right) => left.operatorId.localeCompare(right.operatorId)),
    format: FORMAT,
    payload,
  };
}

export function verifyCeremonyRegistryAnchor(anchor, records, { trustedAddress } = {}) {
  exactObject(anchor, ENVELOPE_FIELDS, "ceremony registry anchor");
  if (anchor.format !== FORMAT) throw new Error("ceremony registry anchor format is invalid");
  const payload = anchorPayload(anchor.payload);
  if (!Array.isArray(records) || records.length < payload.count) {
    throw new Error("local ceremony registry is behind the external anchor");
  }
  const anchored = records[payload.count - 1];
  if (!anchored || anchored.recordHash !== payload.registryHead ||
      anchored.plan?.commitment !== payload.latestPlanCommitment ||
      anchored.genesisHash !== payload.latestGenesisHash ||
      anchored.releaseProvenance?.manifestHash !== payload.releaseManifestHash) {
    throw new Error("external ceremony anchor is not a prefix of the local registry");
  }
  const plan = verifyGenesisPlan(anchored.plan, {
    signedRelease: anchored.signedRelease, trustedAddress,
  });
  assertPayloadPlan(payload, plan);
  const result = verifiedApprovals(payload, plan, anchor.approvals);
  return {
    anchorCount: payload.count,
    anchorHead: payload.registryHead,
    localCount: records.length,
    localHead: records.at(-1).recordHash,
    ...result,
    verified: true,
  };
}

export function verifyCeremonyRegistryAnchorForLatestPlan(
  anchor, planValue, latestGenesisHash, options = {},
) {
  exactObject(anchor, ENVELOPE_FIELDS, "ceremony registry anchor");
  if (anchor.format !== FORMAT) throw new Error("ceremony registry anchor format is invalid");
  const payload = anchorPayload(anchor.payload);
  const plan = verifyGenesisPlan(planValue, options);
  assertPayloadPlan(payload, plan);
  if (payload.latestGenesisHash !== latestGenesisHash) {
    throw new Error("ceremony registry anchor genesis hash does not match compiled genesis");
  }
  const result = verifiedApprovals(payload, plan, anchor.approvals);
  return { ...payload, ...result, verified: true };
}
