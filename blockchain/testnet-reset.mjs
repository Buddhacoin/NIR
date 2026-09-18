import { createHash } from "node:crypto";

import { createTransfer, NirChain } from "./chain.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import {
  addressFromPublicKey,
  generateWallet,
  hashObject,
  signObject,
  verifyObject,
} from "./crypto.mjs";

export const TESTNET_RESET_FORMAT = "nir-testnet-reset-v1";
export const TESTNET_RESET_APPROVAL_DOMAIN = "TESTNET_RESET_APPROVAL";

const HASH = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = [
  "format", "incidentReportHash", "newGenesisHash", "newNetworkId", "notBefore",
  "oldGenesisHash", "oldNetworkId", "reason",
];
const ENVELOPE_KEYS = [...PAYLOAD_KEYS, "approvals", "manifestHash"];

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${name} shape is invalid`);
  }
}

function networkId(value, name) {
  if (typeof value !== "string" || value.length < 1 ||
      Buffer.byteLength(value) > 64 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function payload(value) {
  const keys = Object.keys(value ?? {});
  if (keys.length === ENVELOPE_KEYS.length) exactKeys(value, ENVELOPE_KEYS, "reset manifest");
  else exactKeys(value, PAYLOAD_KEYS, "reset manifest payload");
  if (value.format !== TESTNET_RESET_FORMAT ||
      !HASH.test(value.oldGenesisHash ?? "") || !HASH.test(value.newGenesisHash ?? "") ||
      !HASH.test(value.incidentReportHash ?? "") ||
      !Number.isSafeInteger(value.notBefore) || value.notBefore < 0 ||
      typeof value.reason !== "string" || value.reason !== value.reason.trim() ||
      value.reason.length < 8 || value.reason.length > 1_024 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.reason)) {
    throw new Error("reset manifest fields are invalid");
  }
  const oldNetworkId = networkId(value.oldNetworkId, "old network ID");
  const newNetworkId = networkId(value.newNetworkId, "new network ID");
  if (oldNetworkId === newNetworkId) throw new Error("reset must use a new network ID");
  if (value.oldGenesisHash === value.newGenesisHash) {
    throw new Error("reset must use a new genesis hash");
  }
  return {
    format: TESTNET_RESET_FORMAT,
    incidentReportHash: value.incidentReportHash,
    newGenesisHash: value.newGenesisHash,
    newNetworkId,
    notBefore: value.notBefore,
    oldGenesisHash: value.oldGenesisHash,
    oldNetworkId,
    reason: value.reason,
  };
}

export function genesisIdentity(genesis) {
  const chain = new NirChain(genesis);
  const block = chain.blocks()[0];
  return {
    genesisHash: block.hash,
    networkId: chain.networkId,
    validators: structuredClone(genesis.validators),
  };
}

export function incidentReportHash(contents) {
  if (!Buffer.isBuffer(contents) && !(contents instanceof Uint8Array)) {
    throw new Error("incident report contents are invalid");
  }
  if (contents.length < 1) throw new Error("incident report cannot be empty");
  return createHash("sha3-256")
    .update("NIR/INCIDENT_REPORT/v1\0")
    .update(contents)
    .digest("hex");
}

export function resetManifestHash(manifest) {
  return hashObject(payload(manifest), "TESTNET_RESET_MANIFEST");
}

export function createResetManifest({
  incidentReportHash: reportHash,
  newGenesisHash,
  newNetworkId,
  notBefore,
  oldGenesisHash,
  oldNetworkId,
  reason,
}) {
  const unsigned = payload({
    format: TESTNET_RESET_FORMAT,
    incidentReportHash: reportHash,
    newGenesisHash,
    newNetworkId,
    notBefore,
    oldGenesisHash,
    oldNetworkId,
    reason,
  });
  return {
    ...unsigned,
    approvals: [],
    manifestHash: resetManifestHash(unsigned),
  };
}

function validatorMap(validators) {
  if (!Array.isArray(validators) || validators.length < 4 || validators.length > 512) {
    throw new Error("reset validator set is invalid");
  }
  const result = new Map();
  for (const validator of validators) {
    if (!validator || typeof validator !== "object" ||
        validator.algorithm !== SIGNATURE_ALGORITHM ||
        addressFromPublicKey(validator.publicKey ?? "") !== validator.address ||
        result.has(validator.address)) {
      throw new Error("reset validator set is invalid");
    }
    result.set(validator.address, validator);
  }
  return result;
}

function verifyApprovals(manifest, unsigned, validators, requireQuorum) {
  const trusted = validatorMap(validators);
  if (!Array.isArray(manifest.approvals) || manifest.approvals.length > trusted.size) {
    throw new Error("reset approvals are invalid");
  }
  const voters = new Set();
  let previous = null;
  const approvals = manifest.approvals.map((approval) => {
    exactKeys(approval, ["signature", "validator"], "reset approval");
    const validator = trusted.get(approval.validator);
    if (!validator || voters.has(approval.validator) ||
        typeof approval.signature !== "string" || approval.signature.length > 7_000 ||
        (previous !== null && approval.validator <= previous) ||
        !verifyObject(unsigned, approval.signature, validator.publicKey,
          TESTNET_RESET_APPROVAL_DOMAIN)) {
      throw new Error("reset approval is forged, duplicated, or unordered");
    }
    previous = approval.validator;
    voters.add(approval.validator);
    return { signature: approval.signature, validator: approval.validator };
  });
  const quorum = Math.floor((trusted.size * 2) / 3) + 1;
  if (requireQuorum && approvals.length < quorum) {
    throw new Error("reset approval quorum not reached");
  }
  return { approvals, quorum };
}

function verifyEnvelope(manifest, validators, requireQuorum) {
  const unsigned = payload(manifest);
  const manifestHash = resetManifestHash(unsigned);
  if (manifest.manifestHash !== manifestHash) throw new Error("reset manifest hash is invalid");
  const { approvals, quorum } = verifyApprovals(manifest, unsigned, validators, requireQuorum);
  return { ...unsigned, approvals, manifestHash, quorum };
}

export function signResetManifest(manifest, wallet, { validators } = {}) {
  const verified = verifyEnvelope(manifest, validators, false);
  const trusted = validatorMap(validators);
  const validator = trusted.get(wallet?.address);
  if (!validator || validator.publicKey !== wallet.publicKey ||
      verified.approvals.some(({ validator: address }) => address === wallet.address)) {
    throw new Error("reset signer is not an unused trusted validator");
  }
  const unsigned = payload(manifest);
  const approvals = [...verified.approvals, {
    signature: signObject(unsigned, wallet, TESTNET_RESET_APPROVAL_DOMAIN),
    validator: wallet.address,
  }].sort((left, right) => left.validator.localeCompare(right.validator));
  return {
    ...unsigned,
    approvals,
    manifestHash: verified.manifestHash,
  };
}

export function verifyResetManifest(manifest, {
  currentTimestamp = Date.now(),
  expectedIncidentReportHash,
  newGenesis,
  oldGenesis,
} = {}) {
  if (!Number.isSafeInteger(currentTimestamp) || currentTimestamp < 0) {
    throw new Error("reset verification time is invalid");
  }
  const oldIdentity = genesisIdentity(oldGenesis);
  const newIdentity = genesisIdentity(newGenesis);
  const verified = verifyEnvelope(manifest, oldIdentity.validators, true);
  if (verified.oldGenesisHash !== oldIdentity.genesisHash ||
      verified.oldNetworkId !== oldIdentity.networkId ||
      verified.newGenesisHash !== newIdentity.genesisHash ||
      verified.newNetworkId !== newIdentity.networkId ||
      verified.incidentReportHash !== expectedIncidentReportHash) {
    throw new Error("reset manifest does not match its reviewed inputs");
  }
  if (currentTimestamp < verified.notBefore) throw new Error("reset is not yet eligible");
  return verified;
}

export function createResetDrill(manifest, options = {}) {
  const verified = verifyResetManifest(manifest, options);
  const probe = generateWallet();
  const oldTransfer = createTransfer({
    amount: "1",
    fee: "1",
    networkId: verified.oldNetworkId,
    nonce: 0,
    recipient: probe.address,
    wallet: probe,
  });
  const { signature, ...oldUnsigned } = oldTransfer;
  const newUnsigned = { ...oldUnsigned, networkId: verified.newNetworkId };
  const oldDomainAcceptsSignature = verifyObject(
    oldUnsigned, signature, probe.publicKey, "TRANSFER",
  );
  const newDomainRejectsOldSignature = !verifyObject(
    newUnsigned, signature, probe.publicKey, "TRANSFER",
  );
  if (!oldDomainAcceptsSignature || !newDomainRejectsOldSignature) {
    throw new Error("transaction domain isolation drill failed");
  }
  return {
    destructiveExecutionAvailable: false,
    destructiveExecutionPolicy: "A separate documented manual process is required outside this tool.",
    format: "nir-testnet-reset-drill-v1",
    incidentReportHash: verified.incidentReportHash,
    liveDataTouched: false,
    manifestHash: verified.manifestHash,
    newGenesisHash: verified.newGenesisHash,
    newNetworkId: verified.newNetworkId,
    oldDomainAcceptsSignature,
    oldGenesisHash: verified.oldGenesisHash,
    oldNetworkId: verified.oldNetworkId,
    newDomainRejectsOldSignature,
    quorum: verified.quorum,
    signatures: verified.approvals.length,
  };
}
