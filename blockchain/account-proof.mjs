import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,31})$/;
const FORMAT = "nir-account-proof-v1";
const MAX_PROOF_BYTES = 64 * 1024;

function orderedValidators(validators) {
  return [...validators].sort((left, right) => left.address.localeCompare(right.address));
}

function validateAccount(account) {
  if (!account || !ADDRESS.test(account.address ?? "") ||
      !ATOMIC.test(account.atomicBalance ?? "") ||
      !Number.isSafeInteger(account.nextNonce) || account.nextNonce < 0 ||
      !account.resources || !ATOMIC.test(account.resources.atomicStake ?? "") ||
      !ATOMIC.test(account.resources.availableTransferCredits ?? "") ||
      !Array.isArray(account.resources.delegations) || account.resources.delegations.length > 256) {
    throw new Error("account proof account state is invalid");
  }
  const pending = account.resources.pendingUnstake;
  if (pending !== null && (!pending || !ATOMIC.test(pending.amount ?? "") ||
      !Number.isSafeInteger(pending.unlockHeight) || pending.unlockHeight < 1)) {
    throw new Error("account proof pending unstake is invalid");
  }
  for (const delegation of account.resources.delegations) {
    if (!delegation || delegation.owner !== account.address ||
        !ADDRESS.test(delegation.delegate ?? "") || delegation.delegate === account.address ||
        !Number.isSafeInteger(delegation.epoch) || delegation.epoch < 0 ||
        !Number.isSafeInteger(delegation.limit) || delegation.limit < 1 ||
        delegation.limit > 1_000_000 || !Number.isSafeInteger(delegation.spent) ||
        delegation.spent < 0 || delegation.spent > delegation.limit) {
      throw new Error("account proof delegation is invalid");
    }
  }
}

function validateStatement(statement) {
  if (!statement || statement.format !== FORMAT ||
      typeof statement.networkId !== "string" || statement.networkId.length < 3 ||
      statement.networkId.length > 128 || !Number.isSafeInteger(statement.height) ||
      statement.height < 0 || !HASH.test(statement.tipHash ?? "") ||
      !HASH.test(statement.stateRoot ?? "") || !HASH.test(statement.validatorSetId ?? "")) {
    throw new Error("account proof statement is invalid");
  }
  validateAccount(statement.account);
}

export function createAccountProof({
  account, height, networkId, stateRoot, tipHash, validators, validatorWallets,
}) {
  if (!Array.isArray(validators) || validators.length < 4 ||
      !Array.isArray(validatorWallets)) {
    throw new Error("account proof validators are invalid");
  }
  const statement = {
    account: structuredClone(account),
    format: FORMAT,
    height,
    networkId,
    stateRoot,
    tipHash,
    validatorSetId: validatorSetId(orderedValidators(validators)),
  };
  validateStatement(statement);
  const statementHash = hashObject(statement, "ACCOUNT_PROOF");
  return {
    ...statement,
    attestations: validatorWallets.map((wallet) => ({
      signature: signObject({ statementHash }, wallet, "ACCOUNT_PROOF_APPROVAL"),
      validator: wallet.address,
    })),
    statementHash,
  };
}

export function verifyAccountProof(proof, {
  expectedAddress, expectedNetworkId, minimumHeight = 0, trustedValidators,
} = {}) {
  if (!proof || Buffer.byteLength(canonicalJson(proof)) > MAX_PROOF_BYTES ||
      !HASH.test(proof.statementHash ?? "") || !Array.isArray(proof.attestations) ||
      !Array.isArray(trustedValidators) || trustedValidators.length < 4 ||
      trustedValidators.length > 128 || !Number.isSafeInteger(minimumHeight) || minimumHeight < 0) {
    throw new Error("account proof envelope is invalid");
  }
  const { attestations, statementHash, ...statement } = proof;
  validateStatement(statement);
  if (statementHash !== hashObject(statement, "ACCOUNT_PROOF")) {
    throw new Error("account proof hash is invalid");
  }
  if (statement.networkId !== expectedNetworkId || statement.account.address !== expectedAddress ||
      statement.height < minimumHeight ||
      statement.validatorSetId !== validatorSetId(orderedValidators(trustedValidators))) {
    throw new Error("account proof trust anchor does not match");
  }
  const validators = new Map(trustedValidators.map((member) => [member.address, member]));
  const seen = new Set();
  for (const attestation of attestations) {
    const validator = validators.get(attestation?.validator);
    if (!validator || seen.has(validator.address) ||
        !verifyObject({ statementHash }, attestation.signature, validator.publicKey,
          "ACCOUNT_PROOF_APPROVAL")) {
      throw new Error("account proof attestation is invalid");
    }
    seen.add(validator.address);
  }
  const quorum = Math.floor((validators.size * 2) / 3) + 1;
  if (seen.size < quorum) throw new Error("account proof quorum is not reached");
  return structuredClone(statement);
}
