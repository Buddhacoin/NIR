import { addressFromPublicKey, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { MAX_VALIDATORS, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { MIN_VALIDATOR_SET_SIZE, validatorSetId } from "./validator-rotation.mjs";

const FORMAT = "nir-validator-handoff-v1";

function normalizeTrustSet(members) {
  if (!Array.isArray(members) || members.length < MIN_VALIDATOR_SET_SIZE ||
      members.length > MAX_VALIDATORS) throw new Error("validator handoff set size is invalid");
  const normalized = members.map((member) => {
    if (!member || member.algorithm !== SIGNATURE_ALGORITHM ||
        typeof member.publicKey !== "string" || member.publicKey.length > 4_000 ||
        addressFromPublicKey(member.publicKey) !== member.address ||
        typeof member.operatorId !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(member.operatorId)) {
      throw new Error("validator handoff identity is invalid");
    }
    return {
      address: member.address,
      algorithm: member.algorithm,
      operatorId: member.operatorId,
      publicKey: member.publicKey,
    };
  }).sort((left, right) => left.address.localeCompare(right.address));
  if (new Set(normalized.map(({ address }) => address)).size !== normalized.length ||
      new Set(normalized.map(({ operatorId }) => operatorId)).size !== normalized.length) {
    throw new Error("validator handoff identities must be unique");
  }
  return normalized;
}

function handoffPayload(fields) {
  const previousValidators = normalizeTrustSet(fields.previousValidators);
  const nextValidators = normalizeTrustSet(fields.nextValidators);
  const previousAddresses = new Set(previousValidators.map(({ address }) => address));
  const overlap = nextValidators.filter(({ address }) => previousAddresses.has(address)).length;
  if (overlap * 3 < Math.min(previousValidators.length, nextValidators.length)) {
    throw new Error("validator handoff requires at least one-third overlap");
  }
  const payload = {
    activationBlockHash: fields.activationBlockHash,
    activationHeight: fields.activationHeight,
    activationStateRoot: fields.activationStateRoot,
    format: FORMAT,
    networkId: fields.networkId,
    nextSetId: validatorSetId(nextValidators),
    nextValidators,
    previousSetId: validatorSetId(previousValidators),
  };
  if (typeof payload.networkId !== "string" || payload.networkId.length < 1 ||
      payload.networkId.length > 128 || !Number.isSafeInteger(payload.activationHeight) ||
      payload.activationHeight < 1 || !/^[0-9a-f]{64}$/.test(payload.activationBlockHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(payload.activationStateRoot ?? "")) {
    throw new Error("validator handoff payload is invalid");
  }
  return payload;
}

function attest(payload, wallets, domain) {
  if (!Array.isArray(wallets) || wallets.length > MAX_VALIDATORS) {
    throw new Error("validator handoff signers are invalid");
  }
  return wallets.map((wallet) => ({
    signature: signObject(payload, wallet, domain),
    validator: wallet.address,
  }));
}

export function createValidatorHandoff(fields, previousWallets, nextWallets) {
  const payload = handoffPayload(fields);
  return {
    ...payload,
    handoffHash: hashObject(payload, "VALIDATOR_HANDOFF"),
    nextAttestations: attest(payload, nextWallets, "VALIDATOR_HANDOFF_NEW"),
    previousAttestations: attest(payload, previousWallets, "VALIDATOR_HANDOFF_OLD"),
  };
}

function verifyAttestations(payload, attestations, validators, domain) {
  if (!Array.isArray(attestations) || attestations.length > validators.length) {
    throw new Error("validator handoff attestations are invalid");
  }
  const byAddress = new Map(validators.map((member) => [member.address, member]));
  const seen = new Set();
  for (const attestation of attestations) {
    const member = byAddress.get(attestation?.validator);
    if (!member || seen.has(member.address) || typeof attestation.signature !== "string" ||
        attestation.signature.length > 7_000 ||
        !verifyObject(payload, attestation.signature, member.publicKey, domain)) {
      throw new Error("validator handoff attestation is invalid");
    }
    seen.add(member.address);
  }
  const quorum = Math.floor((validators.length * 2) / 3) + 1;
  if (seen.size < quorum) throw new Error("validator handoff quorum is not reached");
}

export function verifyValidatorHandoff(handoff, {
  expectedNetworkId,
  minimumActivationHeight = 1,
  trustedValidators,
} = {}) {
  if (!handoff || handoff.format !== FORMAT || !Number.isSafeInteger(minimumActivationHeight) ||
      minimumActivationHeight < 1) throw new Error("validator handoff header is invalid");
  const current = normalizeTrustSet(trustedValidators);
  const { handoffHash, nextAttestations, previousAttestations, ...unsigned } = handoff;
  const payload = handoffPayload({ ...unsigned, previousValidators: current });
  if (payload.networkId !== expectedNetworkId || payload.activationHeight < minimumActivationHeight ||
      unsigned.previousSetId !== payload.previousSetId ||
      unsigned.nextSetId !== payload.nextSetId ||
      handoffHash !== hashObject(payload, "VALIDATOR_HANDOFF")) {
    throw new Error("validator handoff trust chain is invalid");
  }
  verifyAttestations(payload, previousAttestations, current, "VALIDATOR_HANDOFF_OLD");
  verifyAttestations(payload, nextAttestations, payload.nextValidators, "VALIDATOR_HANDOFF_NEW");
  return {
    activationBlockHash: payload.activationBlockHash,
    activationHeight: payload.activationHeight,
    activationStateRoot: payload.activationStateRoot,
    handoffHash,
    trustedValidators: payload.nextValidators,
    validatorSetId: payload.nextSetId,
  };
}

export function advanceValidatorTrust({ expectedNetworkId, handoffs = [], trustedValidators } = {}) {
  if (!Array.isArray(handoffs) || handoffs.length > MAX_VALIDATORS) {
    throw new Error("validator handoff chain is invalid");
  }
  let current = normalizeTrustSet(trustedValidators);
  let minimumActivationHeight = 1;
  let lastHandoff = null;
  for (const handoff of handoffs) {
    lastHandoff = verifyValidatorHandoff(handoff, {
      expectedNetworkId,
      minimumActivationHeight,
      trustedValidators: current,
    });
    current = lastHandoff.trustedValidators;
    minimumActivationHeight = lastHandoff.activationHeight + 1;
  }
  return { lastHandoff, trustedValidators: current };
}
