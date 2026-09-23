import { hashObject, signObject, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validateReleaseAuthoritySet } from "./offline-release-governance.mjs";

const FORMAT = "nir-wallet-release-authority-transition-v1";
const SIGNATURE_FORMAT = "nir-wallet-release-authority-transition-signature-v1";
const HASH = /^[0-9a-f]{64}$/; const PREFIXED = /^sha3-256:[0-9a-f]{64}$/;
const MAX_DELAY = 1024; const MAX_GRACE = 1024;
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) throw new Error(`${label} schema is invalid`);
}
function payload(value) {
  exact(value, ["activationSequence", "createdAt", "format", "genesisHash", "graceEndSequence",
    "networkId", "newSet", "oldCheckpointHash", "oldCount", "oldMerkleRoot", "oldSetId",
    "transitionNonce", "version"], "wallet authority transition");
  const next = validateReleaseAuthoritySet(value.newSet);
  if (value.format !== FORMAT || value.version !== 1 || !PREFIXED.test(value.oldSetId ?? "") ||
      next.generation < 2 || !HASH.test(value.oldCheckpointHash ?? "") ||
      !HASH.test(value.oldMerkleRoot ?? "") || !Number.isSafeInteger(value.oldCount) || value.oldCount < 1 ||
      !Number.isSafeInteger(value.activationSequence) || value.activationSequence < value.oldCount + 2 ||
      value.activationSequence > value.oldCount + MAX_DELAY || !Number.isSafeInteger(value.graceEndSequence) ||
      value.graceEndSequence < value.activationSequence || value.graceEndSequence > value.activationSequence + MAX_GRACE ||
      !Number.isSafeInteger(value.createdAt) || !/^[0-9a-f]{64}$/.test(value.transitionNonce ?? "") ||
      !/^(?:sha3-256:)?[0-9a-f]{64}$/.test(value.genesisHash ?? "") ||
      typeof value.networkId !== "string" || value.networkId.length < 2 || value.networkId.length > 64) {
    throw new Error("wallet authority transition is invalid");
  }
  return { ...structuredClone(value), newSet: next };
}
export function createWalletReleaseAuthorityTransition({ activationDelay, createdAt, genesisHash,
  graceRecords, networkId, newSet, oldCheckpoint, oldSet, transitionNonce }) {
  const previous = validateReleaseAuthoritySet(oldSet); const next = validateReleaseAuthoritySet(newSet);
  if (next.generation !== previous.generation + 1 || next.setId === previous.setId ||
      oldCheckpoint?.checkpoint?.authoritySetId !== previous.setId ||
      oldCheckpoint.checkpoint.networkId !== networkId || oldCheckpoint.checkpoint.genesisHash !== genesisHash ||
      !Number.isSafeInteger(activationDelay) || activationDelay < 2 ||
      !Number.isSafeInteger(graceRecords) || graceRecords < 1) throw new Error("wallet authority generation or checkpoint is invalid");
  const unsigned = payload({ activationSequence: oldCheckpoint.checkpoint.count + activationDelay,
    createdAt, format: FORMAT, genesisHash,
    graceEndSequence: oldCheckpoint.checkpoint.count + activationDelay + graceRecords,
    networkId, newSet: next, oldCheckpointHash: oldCheckpoint.checkpointHash,
    oldCount: oldCheckpoint.checkpoint.count, oldMerkleRoot: oldCheckpoint.checkpoint.merkleRoot,
    oldSetId: previous.setId, transitionNonce, version: 1 });
  return { ...unsigned, transitionHash: hashObject(unsigned, "WALLET_RELEASE_AUTHORITY_TRANSITION_V1") };
}
export function validateWalletReleaseAuthorityTransition(value, { oldSet } = {}) {
  exact(value, ["activationSequence", "createdAt", "format", "genesisHash", "graceEndSequence",
    "networkId", "newSet", "oldCheckpointHash", "oldCount", "oldMerkleRoot", "oldSetId",
    "transitionHash", "transitionNonce", "version"], "wallet authority transition envelope");
  const { transitionHash, ...unsigned } = value; const result = payload(unsigned);
  const previous = validateReleaseAuthoritySet(oldSet);
  if (previous.setId !== result.oldSetId || result.newSet.generation !== previous.generation + 1 ||
      transitionHash !== hashObject(result, "WALLET_RELEASE_AUTHORITY_TRANSITION_V1")) throw new Error("wallet authority transition generation or hash is invalid");
  return { ...result, transitionHash };
}
export function signWalletReleaseAuthorityTransition(value, oldSet, { operatorId, role, wallet }) {
  const transition = validateWalletReleaseAuthorityTransition(value, { oldSet });
  const set = role === "old" ? validateReleaseAuthoritySet(oldSet) : transition.newSet;
  if (!new Set(["old", "new"]).has(role)) throw new Error("wallet authority transition role is invalid");
  const authority = set.authorities.find((entry) => entry.operatorId === operatorId);
  if (!authority || authority.address !== wallet.address || authority.publicKey !== wallet.publicKey) throw new Error("wallet authority transition signer is not authorized");
  const signed = { role, setId: set.setId, transitionHash: transition.transitionHash };
  return { address: authority.address, algorithm: SIGNATURE_ALGORITHM, format: SIGNATURE_FORMAT,
    operatorId, role, setId: set.setId, signature: signObject(signed, wallet,
      "WALLET_RELEASE_AUTH_TRANSITION_SIG_V1"), transitionHash: transition.transitionHash, version: 1 };
}
function quorum(transition, set, values, role) {
  if (!Array.isArray(values) || values.length < set.threshold || values.length > set.authorities.length) throw new Error("wallet authority transition quorum is missing");
  const seen = new Set(); return values.map((item) => {
    exact(item, ["address", "algorithm", "format", "operatorId", "role", "setId", "signature",
      "transitionHash", "version"], "wallet authority transition signature");
    const authority = set.authorities.find((entry) => entry.operatorId === item.operatorId);
    const signed = { role, setId: set.setId, transitionHash: transition.transitionHash };
    if (!authority || item.format !== SIGNATURE_FORMAT || item.version !== 1 || item.role !== role ||
        item.setId !== set.setId || item.transitionHash !== transition.transitionHash ||
        item.address !== authority.address || item.algorithm !== SIGNATURE_ALGORITHM || seen.has(item.operatorId) ||
        !verifyObject(signed, item.signature, authority.publicKey,
          "WALLET_RELEASE_AUTH_TRANSITION_SIG_V1")) throw new Error("wallet authority transition signature is invalid or duplicate");
    seen.add(item.operatorId); return structuredClone(item);
  }).sort((a, b) => a.operatorId < b.operatorId ? -1 : 1);
}
export function assembleWalletReleaseAuthorityTransition(value, oldSet, oldSignatures, newSignatures) {
  const transition = validateWalletReleaseAuthorityTransition(value, { oldSet });
  const envelope = { newSignatures: quorum(transition, transition.newSet, newSignatures, "new"),
    oldSet: validateReleaseAuthoritySet(oldSet), oldSignatures: quorum(transition,
      validateReleaseAuthoritySet(oldSet), oldSignatures, "old"), transition };
  return { ...envelope, envelopeHash: hashObject(envelope, "WALLET_RELEASE_AUTH_TRANSITION_ENV_V1") };
}
export function verifyWalletReleaseAuthorityTransitionEnvelope(value) {
  exact(value, ["envelopeHash", "newSignatures", "oldSet", "oldSignatures", "transition"],
    "wallet authority transition approval envelope");
  const expected = assembleWalletReleaseAuthorityTransition(value.transition, value.oldSet,
    value.oldSignatures, value.newSignatures);
  if (expected.envelopeHash !== value.envelopeHash) throw new Error("wallet authority transition envelope hash is invalid");
  return expected;
}
