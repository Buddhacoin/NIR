import { createPublicKey } from "node:crypto";

import { NirChain, multisigAddress } from "./chain.mjs";
import {
  MAX_FUTURE_DRIFT_MS,
  MIN_EVALUATOR_BOND,
  PROTOCOL_VERSION,
  SAFETY_POLICY_V1_COMMITMENT,
  SIGNATURE_ALGORITHM,
  TREASURY_BPS,
  TREASURY_VESTING_MS,
} from "./constants.mjs";
import { addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { EMPTY_PEER_REGISTRY_HASH, peerRegistryHash } from "./peer-registry.mjs";
import { verifySignedRelease } from "./release-manifest.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const PLAN_FIELDS = [
  "beaconAuthorities", "ceremonyOperators", "commitment", "format", "genesisTimestamp",
  "networkId", "protocolVersion", "purpose", "sourceReleaseManifestHash", "treasury",
  "evaluatorBondAmount",
  "validators", "evaluators", "peerRegistryCommitment", "sourceRelease",
  "validatorSetCommitment",
];
const INPUT_FIELDS = PLAN_FIELDS.filter((field) =>
  !["commitment", "format", "peerRegistryCommitment", "purpose",
    "sourceRelease", "validatorSetCommitment"].includes(field));
const ROLE_FIELDS = ["address", "algorithm", "endpoint", "operatorId", "publicKey"];
const VALIDATOR_FIELDS = [
  "address", "algorithm", "endpoint", "operatorId", "publicKey", "tlsCertificateSha256",
  "transport",
];
const TRANSPORT_FIELDS = ["address", "algorithm", "publicKey"];
const OPERATOR_FIELDS = [
  "address", "algorithm", "contribution", "nonce", "operatorId", "publicKey",
];
const TREASURY_FIELDS = [
  "address", "algorithm", "memberPublicKeys", "threshold", "vestingPolicy",
];
const VESTING_FIELDS = ["allocationBps", "durationMs", "model"];
const ENVELOPE_FIELDS = ["approvals", "commitment", "format", "peerRegistryApprovals"];
const APPROVAL_FIELDS = ["operatorId", "signature"];
const REGISTRY_APPROVAL_FIELDS = ["signature", "validator"];
const RELEASE_FIELDS = ["manifestHash", "releaseVersion", "signerAddress", "sourceRevision"];
const PURPOSE = "valueless-developer-testnet";
const FORMAT = "nir-public-genesis-plan-v1";
const ENVELOPE_FORMAT = "nir-public-genesis-approvals-v1";

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} schema contains missing or unknown fields`);
  }
}

function trustedRelease({ signedRelease, trustedAddress } = {}) {
  if (!signedRelease || !ADDRESS.test(trustedAddress ?? "")) {
    throw new Error("genesis ceremony requires a signed release and trusted signer address");
  }
  rejectSecrets(signedRelease, "signed release");
  exactObject(signedRelease, ["manifest", "signature", "signer"], "signed release");
  exactObject(signedRelease.signer, ["address", "algorithm", "publicKey"],
    "signed release signer");
  exactObject(signedRelease.manifest, [
    "files", "format", "manifestHash", "releaseVersion", "sourceRevision",
  ], "signed release manifest");
  if (!Array.isArray(signedRelease.manifest.files)) {
    throw new Error("signed release manifest file schema is invalid");
  }
  for (const file of signedRelease.manifest.files) {
    exactObject(file, ["executable", "path", "sha3_256", "size"],
      "signed release manifest file");
  }
  const { manifest, signer } = verifySignedRelease(signedRelease, { trustedAddress });
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
    manifest.releaseVersion,
  )) {
    throw new Error("genesis ceremony source release version must be major.minor.patch");
  }
  return {
    manifestHash: manifest.manifestHash,
    releaseVersion: manifest.releaseVersion,
    signerAddress: signer.address,
    sourceRevision: manifest.sourceRevision,
  };
}

function rejectSecrets(value, path = "plan") {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:private|secret|seed|password|mnemonic)/i.test(key)) {
      throw new Error(`${path} contains forbidden secret or private fields`);
    }
    rejectSecrets(entry, `${path}.${key}`);
  }
}

function validPublicKey(value) {
  try {
    return createPublicKey({
      key: Buffer.from(value, "base64"), format: "der", type: "spki",
    }).asymmetricKeyType === SIGNATURE_ALGORITHM;
  } catch { return false; }
}

function publicIdentity(identity, fields, label) {
  exactObject(identity, fields, label);
  if (identity.algorithm !== SIGNATURE_ALGORITHM ||
      typeof identity.publicKey !== "string" || identity.publicKey.length > 4_000 ||
      !validPublicKey(identity.publicKey) ||
      !ADDRESS.test(identity.address ?? "") ||
      addressFromPublicKey(identity.publicKey) !== identity.address ||
      !OPERATOR_ID.test(identity.operatorId ?? "")) {
    throw new Error(`${label} public identity is invalid`);
  }
  return {
    address: identity.address,
    algorithm: identity.algorithm,
    operatorId: identity.operatorId,
    publicKey: identity.publicKey,
  };
}

function endpoint(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error("genesis participant endpoint is invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
    throw new Error("genesis participant endpoint is invalid");
  }
  return parsed.origin;
}

function roleList(entries, label, validatorRole = false) {
  if (!Array.isArray(entries) || entries.length < 4 || entries.length > 256) {
    throw new Error(`${label} must contain four to 256 public identities`);
  }
  const seenAddress = new Set();
  const seenOperator = new Set();
  const seenEndpoint = new Set();
  const result = entries.map((entry) => {
    const identity = publicIdentity(entry, validatorRole ? VALIDATOR_FIELDS : ROLE_FIELDS, label);
    const normalizedEndpoint = endpoint(entry.endpoint);
    if (seenAddress.has(identity.address) || seenOperator.has(identity.operatorId) ||
        seenEndpoint.has(normalizedEndpoint)) throw new Error(`${label} entries must be unique`);
    seenAddress.add(identity.address); seenOperator.add(identity.operatorId);
    seenEndpoint.add(normalizedEndpoint);
    if (!validatorRole) return { ...identity, endpoint: normalizedEndpoint };
    exactObject(entry.transport, TRANSPORT_FIELDS, "validator transport");
    const transport = publicIdentity(
      { ...entry.transport, operatorId: identity.operatorId },
      ["address", "algorithm", "operatorId", "publicKey"], "validator transport",
    );
    delete transport.operatorId;
    if (transport.address === identity.address ||
        (new URL(normalizedEndpoint).protocol === "https:" &&
          !HASH.test(entry.tlsCertificateSha256 ?? "")) ||
        (new URL(normalizedEndpoint).protocol === "http:" && entry.tlsCertificateSha256 !== null)) {
      throw new Error("validator endpoint transport identity or TLS pin is invalid");
    }
    return {
      ...identity, endpoint: normalizedEndpoint, tlsCertificateSha256: entry.tlsCertificateSha256,
      transport,
    };
  }).sort((left, right) => left.operatorId.localeCompare(right.operatorId));
  if (validatorRole && new Set(result.map(({ transport }) => transport.address)).size !== result.length) {
    throw new Error("validator transport identities must be unique");
  }
  return result;
}

function peerRegistryPayload(plan) {
  return {
    activationHeight: 0,
    epoch: 0,
    networkId: plan.networkId,
    peers: plan.validators.map((validator) => ({
      tlsCertificateSha256: validator.tlsCertificateSha256,
      transport: validator.transport,
      url: validator.endpoint,
      validatorAddress: validator.address,
    })).sort((left, right) => left.validatorAddress.localeCompare(right.validatorAddress)),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  };
}

function ceremonyOperators(entries) {
  if (!Array.isArray(entries) || entries.length < 3 || entries.length > 64) {
    throw new Error("genesis ceremony requires three to 64 operators");
  }
  const addresses = new Set();
  const ids = new Set();
  const contributions = new Set();
  const nonces = new Set();
  return entries.map((entry) => {
    const identity = publicIdentity(entry, OPERATOR_FIELDS, "ceremony operator");
    if (!HASH.test(entry.contribution ?? "") ||
        typeof entry.nonce !== "string" || !/^[0-9a-f]{32,128}$/.test(entry.nonce) ||
        addresses.has(identity.address) || ids.has(identity.operatorId) ||
        contributions.has(entry.contribution) || nonces.has(entry.nonce)) {
      throw new Error("ceremony operator identity, contribution, or nonce is duplicated or invalid");
    }
    addresses.add(identity.address); ids.add(identity.operatorId);
    contributions.add(entry.contribution); nonces.add(entry.nonce);
    return { ...identity, contribution: entry.contribution, nonce: entry.nonce };
  }).sort((left, right) => left.operatorId.localeCompare(right.operatorId));
}

function treasuryPolicy(treasury) {
  exactObject(treasury, TREASURY_FIELDS, "treasury");
  exactObject(treasury.vestingPolicy, VESTING_FIELDS, "treasury vesting policy");
  if (treasury.algorithm !== "ml-dsa-65-multisig" || treasury.threshold !== 2 ||
      !Array.isArray(treasury.memberPublicKeys) || treasury.memberPublicKeys.length !== 3 ||
      new Set(treasury.memberPublicKeys).size !== 3 ||
      treasury.memberPublicKeys.some((key) =>
        typeof key !== "string" || key.length > 4_000 || !validPublicKey(key)) ||
      multisigAddress(treasury.memberPublicKeys, 2) !== treasury.address ||
      treasury.vestingPolicy.model !== "linear-from-genesis" ||
      treasury.vestingPolicy.durationMs !== TREASURY_VESTING_MS ||
      treasury.vestingPolicy.allocationBps !== Number(TREASURY_BPS)) {
    throw new Error("treasury must be the public protocol 2-of-3 address and vesting policy");
  }
  return {
    address: treasury.address,
    algorithm: treasury.algorithm,
    memberPublicKeys: [...treasury.memberPublicKeys].sort(),
    threshold: 2,
    vestingPolicy: {
      allocationBps: Number(TREASURY_BPS),
      durationMs: TREASURY_VESTING_MS,
      model: "linear-from-genesis",
    },
  };
}

function planPayload(input, withHeader, release) {
  rejectSecrets(input);
  exactObject(input, withHeader ? PLAN_FIELDS : INPUT_FIELDS, "genesis plan");
  if (withHeader && (input.format !== FORMAT || input.purpose !== PURPOSE)) {
    throw new Error("genesis plan is not a valueless developer testnet plan");
  }
  if (typeof input.networkId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(input.networkId) ||
      !Number.isSafeInteger(input.genesisTimestamp) || input.genesisTimestamp < 0 ||
      input.genesisTimestamp > Date.now() + MAX_FUTURE_DRIFT_MS ||
      input.protocolVersion !== PROTOCOL_VERSION ||
      !HASH.test(input.sourceReleaseManifestHash ?? "")) {
    throw new Error("genesis plan header is invalid or unsupported");
  }
  if (input.evaluatorBondAmount !== MIN_EVALUATOR_BOND.toString()) {
    throw new Error("genesis evaluator bond must equal the protocol bootstrap amount");
  }
  exactObject(release, RELEASE_FIELDS, "genesis source release provenance");
  if (input.sourceReleaseManifestHash !== release.manifestHash ||
      (withHeader && canonicalJson(input.sourceRelease) !== canonicalJson(release))) {
    throw new Error("genesis plan does not match the trusted signed source release");
  }
  const validators = roleList(input.validators, "validator", true);
  const evaluators = roleList(input.evaluators, "evaluator");
  const beaconAuthorities = roleList(input.beaconAuthorities, "beacon authority");
  const occupiedAddresses = [...validators, ...evaluators, ...beaconAuthorities]
    .map(({ address }) => address);
  const occupiedOperators = [...validators, ...evaluators, ...beaconAuthorities]
    .map(({ operatorId }) => operatorId);
  const occupiedEndpoints = [...validators, ...evaluators, ...beaconAuthorities]
    .map(({ endpoint: participantEndpoint }) => participantEndpoint);
  const transportAddresses = validators.map(({ transport }) => transport.address);
  if (new Set(occupiedAddresses).size !== occupiedAddresses.length ||
      new Set(occupiedOperators).size !== occupiedOperators.length ||
      new Set(occupiedEndpoints).size !== occupiedEndpoints.length ||
      transportAddresses.some((address) => occupiedAddresses.includes(address))) {
    throw new Error("validator, evaluator, and beacon identities and endpoints must be disjoint");
  }
  const validatorIdentities = validators.map(
    ({ endpoint: _endpoint, tlsCertificateSha256: _tls, transport: _transport, ...identity }) =>
      identity,
  );
  const validatorSetCommitment = validatorSetId(validatorIdentities);
  const peerRegistryCommitment = peerRegistryHash(peerRegistryPayload({
    networkId: input.networkId, validators,
  }));
  if (withHeader && (input.validatorSetCommitment !== validatorSetCommitment ||
      input.peerRegistryCommitment !== peerRegistryCommitment)) {
    throw new Error("genesis validator-set or topology commitment is invalid");
  }
  return {
    beaconAuthorities,
    ceremonyOperators: ceremonyOperators(input.ceremonyOperators),
    evaluatorBondAmount: input.evaluatorBondAmount,
    format: FORMAT,
    genesisTimestamp: input.genesisTimestamp,
    networkId: input.networkId,
    protocolVersion: input.protocolVersion,
    purpose: PURPOSE,
    peerRegistryCommitment,
    sourceReleaseManifestHash: input.sourceReleaseManifestHash,
    sourceRelease: structuredClone(release),
    treasury: treasuryPolicy(input.treasury),
    validatorSetCommitment,
    validators,
    evaluators,
  };
}

export function createGenesisPlan(input, options = {}) {
  const payload = planPayload(input, false, trustedRelease(options));
  return { ...payload, commitment: hashObject(payload, "PUBLIC_GENESIS_CEREMONY_V1") };
}

export function verifyGenesisPlan(plan, options = {}) {
  const payload = planPayload(plan, true, trustedRelease(options));
  if (plan.commitment !== hashObject(payload, "PUBLIC_GENESIS_CEREMONY_V1")) {
    throw new Error("genesis plan commitment does not match its exact contents");
  }
  return structuredClone({ ...payload, commitment: plan.commitment });
}

function approvalPayload(plan) {
  return { commitment: plan.commitment, format: FORMAT, networkId: plan.networkId };
}

export function signGenesisPlan(planValue, wallet, options = {}) {
  const plan = verifyGenesisPlan(planValue, options);
  const operator = plan.ceremonyOperators.find(({ address }) => address === wallet?.address);
  if (!operator || wallet.algorithm !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(wallet.publicKey) !== wallet.address) {
    throw new Error("genesis signer is not a ceremony operator");
  }
  return {
    operatorId: operator.operatorId,
    signature: signObject(approvalPayload(plan), wallet, "PUBLIC_GENESIS_APPROVAL_V1"),
  };
}

export function signGenesisPeerRegistry(planValue, wallet, options = {}) {
  const plan = verifyGenesisPlan(planValue, options);
  const validator = plan.validators.find(({ address }) => address === wallet?.address);
  if (!validator || wallet.algorithm !== SIGNATURE_ALGORITHM ||
      addressFromPublicKey(wallet.publicKey) !== wallet.address) {
    throw new Error("peer-registry signer is not a genesis validator");
  }
  return {
    signature: signObject(peerRegistryPayload(plan), wallet, "PEER_REGISTRY_APPROVAL"),
    validator: validator.address,
  };
}

export function createGenesisApprovalEnvelope(
  planValue, approvals, peerRegistryApprovals = [], options = {},
) {
  const plan = verifyGenesisPlan(planValue, options);
  if (!Array.isArray(approvals)) throw new Error("genesis approvals must be an array");
  return {
    approvals: approvals.map((approval) => structuredClone(approval))
      .sort((left, right) => String(left.operatorId).localeCompare(String(right.operatorId))),
    commitment: plan.commitment,
    format: ENVELOPE_FORMAT,
    peerRegistryApprovals: peerRegistryApprovals.map((approval) => structuredClone(approval))
      .sort((left, right) => String(left.validator).localeCompare(String(right.validator))),
  };
}

function checkReuse(plan, priorPlans) {
  if (!Array.isArray(priorPlans)) throw new Error("prior genesis plans must be an array");
  const contributions = new Set(plan.ceremonyOperators.map(({ contribution }) => contribution));
  for (const priorValue of priorPlans) {
    exactObject(priorValue?.sourceRelease, RELEASE_FIELDS, "prior genesis source release");
    const priorPayload = planPayload(priorValue, true, priorValue.sourceRelease);
    if (priorValue.commitment !== hashObject(priorPayload, "PUBLIC_GENESIS_CEREMONY_V1")) {
      throw new Error("prior genesis plan commitment is invalid");
    }
    const prior = { ...priorPayload, commitment: priorValue.commitment };
    if (prior.commitment === plan.commitment || prior.networkId === plan.networkId) {
      throw new Error("genesis network id or ceremony plan was already used");
    }
    if (prior.ceremonyOperators.some(({ contribution }) => contributions.has(contribution))) {
      throw new Error("genesis operator contribution was already used");
    }
  }
}

export function verifyGenesisCeremony(planValue, envelope, options = {}) {
  const { priorPlans = [] } = options;
  const plan = verifyGenesisPlan(planValue, options);
  checkReuse(plan, priorPlans);
  exactObject(envelope, ENVELOPE_FIELDS, "genesis approval envelope");
  if (envelope.format !== ENVELOPE_FORMAT || envelope.commitment !== plan.commitment ||
      !Array.isArray(envelope.approvals) || envelope.approvals.length > plan.ceremonyOperators.length) {
    throw new Error("genesis approval envelope is invalid or for another commitment");
  }
  const operators = new Map(plan.ceremonyOperators.map((operator) => [operator.operatorId, operator]));
  const seen = new Set();
  for (const approval of envelope.approvals) {
    exactObject(approval, APPROVAL_FIELDS, "genesis approval");
    const operator = operators.get(approval.operatorId);
    if (!operator || seen.has(approval.operatorId) ||
        typeof approval.signature !== "string" || approval.signature.length > 7_000 ||
        !verifyObject(approvalPayload(plan), approval.signature, operator.publicKey,
          "PUBLIC_GENESIS_APPROVAL_V1")) {
      throw new Error("genesis approval is unknown, duplicated, or invalid");
    }
    seen.add(approval.operatorId);
  }
  const quorum = Math.floor((operators.size * 2) / 3) + 1;
  if (seen.size < quorum) throw new Error("genesis ceremony approval quorum not reached");
  if (!Array.isArray(envelope.peerRegistryApprovals) ||
      envelope.peerRegistryApprovals.length > plan.validators.length) {
    throw new Error("genesis peer-registry approvals are invalid");
  }
  const validators = new Map(plan.validators.map((validator) => [validator.address, validator]));
  const registryVoters = new Set();
  for (const approval of envelope.peerRegistryApprovals) {
    exactObject(approval, REGISTRY_APPROVAL_FIELDS, "genesis peer-registry approval");
    const validator = validators.get(approval.validator);
    if (!validator || registryVoters.has(approval.validator) ||
        typeof approval.signature !== "string" || approval.signature.length > 7_000 ||
        !verifyObject(peerRegistryPayload(plan), approval.signature, validator.publicKey,
          "PEER_REGISTRY_APPROVAL")) {
      throw new Error("genesis peer-registry approval is unknown, duplicated, or invalid");
    }
    registryVoters.add(approval.validator);
  }
  const registryQuorum = Math.floor((validators.size * 2) / 3) + 1;
  if (registryVoters.size < registryQuorum) {
    throw new Error("genesis peer-registry approval quorum not reached");
  }
  return {
    commitment: plan.commitment,
    peerRegistrySigners: [...registryVoters].sort(),
    quorum,
    registryQuorum,
    signers: [...seen].sort(),
    verified: true,
  };
}

export function compileGenesis(planValue, envelope, options = {}) {
  const plan = verifyGenesisPlan(planValue, options);
  verifyGenesisCeremony(plan, envelope, options);
  const genesis = {
    beaconAuthorities: plan.beaconAuthorities.map(({ endpoint: _endpoint, ...identity }) => identity),
    capabilityReferences: [{
      artifactHash: `sha256:${plan.sourceRelease.manifestHash}`,
      behaviorCommitment: hashObject({
        commitment: plan.commitment,
        sourceReleaseManifestHash: plan.sourceRelease.manifestHash,
      }, "DEV_TESTNET_CAPABILITY_PLACEHOLDER_V1"),
      capabilitiesBps: { "developer-test-v1": 0 },
    }],
    evaluators: plan.evaluators.map(({ endpoint: _endpoint, ...identity }) => identity),
    evaluatorBondAmount: plan.evaluatorBondAmount,
    genesisTimestamp: plan.genesisTimestamp,
    networkId: plan.networkId,
    peerRegistry: {
      ...peerRegistryPayload(plan),
      signatures: envelope.peerRegistryApprovals.map((approval) => structuredClone(approval))
        .sort((left, right) => left.validator.localeCompare(right.validator)),
    },
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: plan.treasury.address,
    validators: plan.validators.map(({
      endpoint: _endpoint, tlsCertificateSha256: _tls, transport: _transport, ...identity
    }) => identity),
  };
  const first = new NirChain(genesis, { supportedProtocolVersions: [plan.protocolVersion] });
  const genesisHash = first.blocks()[0].hash;
  const roundTrip = JSON.parse(canonicalJson(genesis));
  if (new NirChain(roundTrip, { supportedProtocolVersions: [plan.protocolVersion] })
    .blocks()[0].hash !== genesisHash) {
    throw new Error("compiled genesis failed canonical chain hash round trip");
  }
  if (peerRegistryHash(roundTrip.peerRegistry) !== plan.peerRegistryCommitment ||
      validatorSetId(roundTrip.validators) !== plan.validatorSetCommitment) {
    throw new Error("compiled genesis topology commitments do not round trip");
  }
  return { genesis: roundTrip, genesisHash, planCommitment: plan.commitment };
}
