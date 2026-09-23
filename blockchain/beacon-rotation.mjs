import { addressFromPublicKey, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { MIN_BEACON_BOND, SIGNATURE_ALGORITHM } from "./constants.mjs";

export const BEACON_ROTATION_DELAY_BLOCKS = 64;
export const BEACON_RETIREMENT_DELAY_BLOCKS = 64;
export const MAX_REGISTERED_BEACON_AUTHORITIES = 128;
const MAX_AUTHORITIES = 64;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function normalizeMember(member, label) {
  if (!member || Object.keys(member).sort().join("\0") !==
      ["address", "algorithm", "operatorId", "publicKey"].sort().join("\0") ||
      member.algorithm !== SIGNATURE_ALGORITHM || !ADDRESS.test(member.address ?? "") ||
      !OPERATOR_ID.test(member.operatorId ?? "") || typeof member.publicKey !== "string") {
    throw new Error(`${label} member is invalid`);
  }
  if (addressFromPublicKey(member.publicKey) !== member.address) {
    throw new Error(`${label} public key is invalid`);
  }
  return structuredClone(member);
}

function normalizeMembers(values, label) {
  if (!Array.isArray(values) || values.length < 4 || values.length > MAX_AUTHORITIES) {
    throw new Error(`${label} size is invalid`);
  }
  const members = values.map((member) => normalizeMember(member, label))
    .sort((left, right) => compareText(left.address, right.address));
  if (new Set(members.map(({ address }) => address)).size !== members.length ||
      new Set(members.map(({ operatorId }) => operatorId)).size !== members.length ||
      new Set(members.map(({ publicKey }) => publicKey)).size !== members.length) {
    throw new Error(`${label} identities are duplicated`);
  }
  return members;
}

export function beaconAuthoritySetId({ generation, members, networkId }) {
  return hashObject({
    authorities: normalizeMembers(members, "beacon authority set"), generation, networkId,
  }, "BEACON_AUTHORITY_SET_V1");
}

export function retiredBeaconIdentity(member, retiredHeight, faults = 0) {
  const identity = normalizeMember(member, "retired beacon identity");
  if (!Number.isSafeInteger(retiredHeight) || retiredHeight < 1 ||
      !Number.isSafeInteger(faults) || faults < 0) {
    throw new Error("retired beacon identity context is invalid");
  }
  return { ...identity, faults, identityCommitment: hashObject(identity,
    "BEACON_RETIRED_IDENTITY_V1"), retiredHeight };
}

function rotationPayload(value) {
  const authorities = normalizeMembers(value.authorities, "next beacon authority set");
  const payload = {
    activationHeight: value.activationHeight,
    authorities,
    generation: value.generation,
    networkId: value.networkId,
    nextSetId: value.nextSetId,
    previousSetId: value.previousSetId,
  };
  if (typeof payload.networkId !== "string" || payload.networkId.length < 1 ||
      payload.networkId.length > 64 || !Number.isSafeInteger(payload.generation) ||
      payload.generation < 1 || !Number.isSafeInteger(payload.activationHeight) ||
      payload.activationHeight < 1 || !HASH.test(payload.previousSetId ?? "") ||
      !HASH.test(payload.nextSetId ?? "")) {
    throw new Error("beacon rotation payload is invalid");
  }
  if (payload.nextSetId !== beaconAuthoritySetId({
    generation: payload.generation, members: authorities, networkId: payload.networkId,
  })) throw new Error("next beacon authority set commitment is invalid");
  return payload;
}

export function createBeaconRotationApproval({ wallet, proposal, kind }) {
  if (!['old', 'possession'].includes(kind)) throw new Error("beacon rotation approval kind is invalid");
  const payload = rotationPayload(proposal);
  return {
    authority: wallet.address,
    signature: signObject(payload, wallet,
      kind === "old" ? "BEACON_ROTATION_OLD_V1" : "BEACON_ROTATION_POSSESSION_V1"),
  };
}

export function createBeaconRotationProposal({
  activationHeight, authorities, generation, networkId, previousAuthorities,
}) {
  const previous = normalizeMembers(previousAuthorities, "current beacon authority set");
  const next = normalizeMembers(authorities, "next beacon authority set");
  return {
    activationHeight,
    authorities: next,
    generation,
    networkId,
    nextSetId: beaconAuthoritySetId({ generation, members: next, networkId }),
    previousSetId: beaconAuthoritySetId({ generation: generation - 1, members: previous, networkId }),
  };
}

export function verifyBeaconRotation(rotation, {
  bonds, currentAuthorities, currentGeneration, currentHeight, networkId,
}) {
  if (!rotation || Object.keys(rotation).sort().join("\0") !== [
    "activationHeight", "authorities", "generation", "networkId", "nextSetId",
    "oldApprovals", "possessionProofs", "previousSetId",
  ].sort().join("\0")) throw new Error("beacon rotation schema is invalid");
  const current = normalizeMembers(currentAuthorities, "current beacon authority set");
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0 ||
      !Number.isSafeInteger(currentHeight) || currentHeight < 0) {
    throw new Error("current beacon rotation context is invalid");
  }
  const payload = rotationPayload(rotation);
  if (payload.networkId !== networkId || payload.generation !== currentGeneration + 1 ||
      payload.activationHeight < currentHeight + BEACON_ROTATION_DELAY_BLOCKS ||
      payload.previousSetId !== beaconAuthoritySetId({
        generation: currentGeneration, members: current, networkId,
      }) || payload.authorities.length !== current.length) {
    throw new Error("beacon rotation lineage, generation, or delay is invalid");
  }
  const currentByAddress = new Map(current.map((member) => [member.address, member]));
  const nextByAddress = new Map(payload.authorities.map((member) => [member.address, member]));
  const overlap = [...nextByAddress.keys()].filter((address) => currentByAddress.has(address)).length;
  if (overlap < Math.ceil(current.length / 3)) {
    throw new Error("beacon rotation requires at least one-third old/new overlap");
  }
  if (!(bonds instanceof Map) || payload.authorities.some(({ address }) =>
    (bonds.get(address) ?? 0n) < MIN_BEACON_BOND)) {
    throw new Error("next beacon authority bond is below minimum");
  }
  const verifyApprovals = (approvals, members, domain, required, label) => {
    if (!Array.isArray(approvals) || approvals.length > members.size) {
      throw new Error(`${label} list is invalid`);
    }
    const seen = new Set();
    for (const [index, approval] of approvals.entries()) {
      if (!approval || Object.keys(approval).sort().join("\0") !== "authority\0signature" ||
          seen.has(approval.authority) ||
          (index > 0 && approvals[index - 1].authority >= approval.authority)) {
        throw new Error(`${label} is duplicated, unordered, or malformed`);
      }
      const member = members.get(approval.authority);
      if (!member || !verifyObject(payload, approval.signature, member.publicKey, domain)) {
        throw new Error(`${label} signature is invalid`);
      }
      seen.add(approval.authority);
    }
    if (seen.size < required) throw new Error(`${label} quorum is not reached`);
  };
  verifyApprovals(rotation.oldApprovals, currentByAddress, "BEACON_ROTATION_OLD_V1",
    Math.floor((current.length * 2) / 3) + 1, "old beacon rotation approval");
  verifyApprovals(rotation.possessionProofs, nextByAddress, "BEACON_ROTATION_POSSESSION_V1",
    nextByAddress.size, "new beacon possession proof");
  return { ...payload, oldApprovals: structuredClone(rotation.oldApprovals),
    possessionProofs: structuredClone(rotation.possessionProofs) };
}
