import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { validatorSetId } from "./validator-rotation.mjs";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./constants.mjs";
import { normalizePendingProtocolUpgrade } from "./protocol-upgrade.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,31})$/;
const FORMAT = "nir-native-asset-proof-v1";
export const MAX_ASSET_PROOF_BYTES = 64 * 1024;

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`asset proof ${label} has unknown or missing fields`);
  }
}

function orderedValidators(validators) {
  return [...validators].sort((left, right) => left.address.localeCompare(right.address));
}

function validateAsset(asset, assetId, networkId) {
  if (asset === null) return;
  exact(asset, new Set(["assetId", "authority", "creationNonce", "creator", "fixedSupply",
    "maxSupply", "metadataHash", "minted", "supply"]), "asset");
  if (asset.assetId !== assetId || !ADDRESS.test(asset.creator ?? "") ||
      (asset.authority !== null && !ADDRESS.test(asset.authority ?? "")) ||
      !Number.isSafeInteger(asset.creationNonce) || asset.creationNonce < 0 ||
      typeof asset.fixedSupply !== "boolean" || !HASH.test(asset.metadataHash ?? "") ||
      !ATOMIC.test(asset.maxSupply ?? "") || !ATOMIC.test(asset.minted ?? "") ||
      !ATOMIC.test(asset.supply ?? "") || BigInt(asset.maxSupply) === 0n ||
      BigInt(asset.supply) > BigInt(asset.minted) || BigInt(asset.minted) > BigInt(asset.maxSupply) ||
      assetId !== hashObject({ creator: asset.creator, networkId, nonce: asset.creationNonce },
        "NATIVE_ASSET_ID_V1") ||
      (asset.authority !== null && asset.authority !== asset.creator) ||
      (asset.fixedSupply && (asset.authority !== null || asset.minted !== asset.maxSupply))) {
    throw new Error("asset proof asset state is invalid");
  }
}

function validateStatement(statement) {
  exact(statement, new Set(["asset", "assetId", "balance", "format", "height", "holder",
    "networkId", "pendingProtocolUpgrade", "protocolVersion", "stateRoot", "tipHash",
    "validatorSetId"]), "statement");
  if (statement.format !== FORMAT || !HASH.test(statement.assetId ?? "") ||
      statement.assetId === "0".repeat(64) || !ADDRESS.test(statement.holder ?? "") ||
      !ATOMIC.test(statement.balance ?? "") || typeof statement.networkId !== "string" ||
      statement.networkId.length < 3 || statement.networkId.length > 128 ||
      !Number.isSafeInteger(statement.height) || statement.height < 0 ||
      !HASH.test(statement.tipHash ?? "") || !HASH.test(statement.stateRoot ?? "") ||
      !HASH.test(statement.validatorSetId ?? "") ||
      !SUPPORTED_PROTOCOL_VERSIONS.includes(statement.protocolVersion) ||
      (statement.asset === null && statement.balance !== "0")) {
    throw new Error("asset proof statement is invalid");
  }
  validateAsset(statement.asset, statement.assetId, statement.networkId);
  if (statement.asset !== null && BigInt(statement.balance) > BigInt(statement.asset.supply)) {
    throw new Error("asset proof holder balance exceeds current supply");
  }
  normalizePendingProtocolUpgrade(statement.pendingProtocolUpgrade, {
    currentHeight: statement.height, currentVersion: statement.protocolVersion,
  });
}

export function createAssetProof({ asset, assetId, balance, height, holder, networkId,
  pendingProtocolUpgrade = null, protocolVersion = PROTOCOL_VERSION, stateRoot, tipHash,
  validators, validatorWallets } = {}) {
  if (!Array.isArray(validators) || validators.length < 4 || !Array.isArray(validatorWallets)) {
    throw new Error("asset proof validators are invalid");
  }
  const normalizedAsset = asset === null ? null : {
    ...structuredClone(asset), maxSupply: String(asset.maxSupply), minted: String(asset.minted),
    supply: String(asset.supply),
  };
  const statement = { asset: normalizedAsset, assetId, balance: String(balance), format: FORMAT,
    height, holder, networkId, pendingProtocolUpgrade: structuredClone(pendingProtocolUpgrade),
    protocolVersion, stateRoot, tipHash, validatorSetId: validatorSetId(orderedValidators(validators)) };
  validateStatement(statement);
  const statementHash = hashObject(statement, "NATIVE_ASSET_PROOF");
  return { ...statement, attestations: validatorWallets.map((wallet) => ({
    signature: signObject({ statementHash }, wallet, "NATIVE_ASSET_PROOF_APPROVAL"),
    validator: wallet.address,
  })), statementHash };
}

function verifyEnvelope(proof, { expectedAssetId, expectedHolder, expectedNetworkId,
  minimumHeight = 0, trustedValidators } = {}, required) {
  if (!proof || Buffer.byteLength(canonicalJson(proof)) > MAX_ASSET_PROOF_BYTES ||
      !HASH.test(proof.statementHash ?? "") || !Array.isArray(proof.attestations) ||
      !Array.isArray(trustedValidators) || trustedValidators.length < 4 ||
      trustedValidators.length > 128 ||
      !Number.isSafeInteger(minimumHeight) || minimumHeight < 0) {
    throw new Error("asset proof envelope is invalid");
  }
  const { attestations, statementHash, ...statement } = proof;
  validateStatement(statement);
  if (statementHash !== hashObject(statement, "NATIVE_ASSET_PROOF")) throw new Error("asset proof hash is invalid");
  if (statement.assetId !== expectedAssetId || statement.holder !== expectedHolder ||
      statement.networkId !== expectedNetworkId || statement.height < minimumHeight ||
      statement.validatorSetId !== validatorSetId(orderedValidators(trustedValidators))) {
    throw new Error("asset proof trust anchor does not match");
  }
  const validators = new Map(trustedValidators.map((entry) => [entry.address, entry]));
  const seen = new Set();
  for (const attestation of attestations) {
    exact(attestation, new Set(["signature", "validator"]), "attestation");
    const validator = validators.get(attestation?.validator);
    if (!validator || seen.has(validator.address) ||
        !verifyObject({ statementHash }, attestation.signature, validator.publicKey,
          "NATIVE_ASSET_PROOF_APPROVAL")) throw new Error("asset proof attestation is invalid");
    seen.add(validator.address);
  }
  if (seen.size < required) throw new Error("asset proof quorum is not reached");
  return structuredClone(statement);
}

export function verifyAssetProofCandidate(proof, options = {}, expectedValidator) {
  if (proof?.attestations?.length !== 1 || proof.attestations[0]?.validator !== expectedValidator) {
    throw new Error("asset proof candidate signer is invalid");
  }
  return verifyEnvelope(proof, options, 1);
}

export function verifyAssetProof(proof, options = {}) {
  return verifyEnvelope(proof, options, Math.floor(((options.trustedValidators?.length ?? 0) * 2) / 3) + 1);
}

export const ASSET_PROOF_FORMAT = FORMAT;
