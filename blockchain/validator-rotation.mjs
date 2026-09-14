import { addressFromPublicKey, hashObject } from "./crypto.mjs";
import { MAX_VALIDATORS, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { MIN_VALIDATOR_BOND } from "./validator-staking.mjs";

export const MIN_VALIDATOR_SET_SIZE = 4;
export const MIN_ROTATION_DELAY_BLOCKS = 5;

function normalizeMember(member, bonds) {
  if (!member || member.algorithm !== SIGNATURE_ALGORITHM ||
      typeof member.publicKey !== "string" || member.publicKey.length > 4_000 ||
      addressFromPublicKey(member.publicKey) !== member.address ||
      typeof member.operatorId !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(member.operatorId)) {
    throw new Error("validator identity is invalid");
  }
  if ((bonds.get(member.address) ?? 0n) < MIN_VALIDATOR_BOND) {
    throw new Error("validator bond is below the finality minimum");
  }
  return {
    address: member.address,
    algorithm: member.algorithm,
    operatorId: member.operatorId,
    publicKey: member.publicKey,
  };
}

export function normalizeValidatorSet(members, bonds) {
  if (!Array.isArray(members) || members.length < MIN_VALIDATOR_SET_SIZE || members.length > MAX_VALIDATORS ||
      !(bonds instanceof Map)) throw new Error("validator set size is invalid");
  const normalized = members.map((member) => normalizeMember(member, bonds))
    .sort((a, b) => a.address.localeCompare(b.address));
  if (new Set(normalized.map(({ address }) => address)).size !== normalized.length ||
      new Set(normalized.map(({ operatorId }) => operatorId)).size !== normalized.length) {
    throw new Error("validator addresses and operators must be unique");
  }
  return normalized;
}

export function validatorSetId(members) {
  return hashObject(members.map(({ address, operatorId, publicKey }) => ({ address, operatorId, publicKey })),
    "FINALITY_VALIDATOR_SET");
}

// A rotation is certified by the old set as part of a finalized block and only
// activates after a delay. Keeping a >=1/3 overlap prevents an instant handoff
// to a completely unrelated set while nodes distribute the new membership.
export function scheduleValidatorRotation({ current, proposed, bonds, currentHeight, activationHeight }) {
  const oldSet = normalizeValidatorSet(current, bonds);
  const nextSet = normalizeValidatorSet(proposed, bonds);
  if (!Number.isSafeInteger(currentHeight) || !Number.isSafeInteger(activationHeight) ||
      activationHeight < currentHeight + MIN_ROTATION_DELAY_BLOCKS) throw new Error("validator rotation delay is too short");
  const oldAddresses = new Set(oldSet.map(({ address }) => address));
  const overlap = nextSet.filter(({ address }) => oldAddresses.has(address)).length;
  if (overlap * 3 < Math.min(oldSet.length, nextSet.length)) {
    throw new Error("validator rotation requires at least one-third overlap");
  }
  return {
    activationHeight,
    previousSetId: validatorSetId(oldSet),
    nextSetId: validatorSetId(nextSet),
    validators: nextSet,
  };
}

export function activeValidatorSet({ current, pending, height }) {
  if (!pending || height < pending.activationHeight) return current;
  return pending.validators;
}
