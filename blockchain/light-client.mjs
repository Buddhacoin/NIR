import { canonicalJson, verifyObject } from "./crypto.mjs";
import { blockHeader, blockHeaderHash, prepareCertificateHash } from "./chain.mjs";
import {
  MAX_VALIDATORS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./constants.mjs";
import {
  normalizeProtocolUpgrade,
  normalizeSupportedProtocolVersions,
  protocolTransition,
} from "./protocol-upgrade.mjs";
import { verifyValidatorHandoff } from "./validator-handoff.mjs";
import { validatorSetId } from "./validator-rotation.mjs";
import { transactionRoot } from "./transaction-tree.mjs";
import {
  verifyValidatorRecoveryEnvelope, verifyValidatorRecoveryPlanAcceptance,
  verifyValidatorRecoveryVotes,
} from "./validator-recovery.mjs";
import {
  verifyValidatorAdmissionOmissionEvidence,
  verifyValidatorAdmissionOmissionTransactionEnvelope,
} from "./validator-admission-omission.mjs";
import {
  createValidatorRecoveryPeerRegistry, peerRegistryHash,
} from "./peer-registry.mjs";

const HASH = /^[0-9a-f]{64}$/;
const FORMAT = "nir-finality-proof-v2";
const HEADER_FORMAT = "nir-finality-header-v1";
export const MAX_FINALITY_PROOFS = 512;
export const MAX_FINALITY_CHAIN_BYTES = 32 * 1024 * 1024;

export function createFinalityProof(block) {
  return {
    certificate: structuredClone(block.certificate ?? []),
    format: FORMAT,
    hash: block.hash,
    header: blockHeader(block),
    prepareCertificate: structuredClone(block.prepareCertificate ?? []),
    round: block.prepareCertificate?.[0]?.round ?? block.round,
  };
}

function normalizeValidators(validators) {
  if (!Array.isArray(validators) || validators.length < 4 || validators.length > MAX_VALIDATORS) {
    throw new Error("light client validator set is invalid");
  }
  const ordered = [...validators].sort((a, b) => a.address.localeCompare(b.address));
  if (new Set(ordered.map(({ address }) => address)).size !== ordered.length) {
    throw new Error("light client validator set contains duplicates");
  }
  return ordered;
}

function verifyVotes(proof, validators, previousValidators = null) {
  const current = normalizeValidators(validators);
  const previous = previousValidators ? normalizeValidators(previousValidators) : null;
  const accepted = new Map([...(previous ?? []), ...current].map((member) => [member.address, member]));
  const verifyCertificate = (votes, domain, payload, label, validateVote = () => true) => {
    if (!Array.isArray(votes) || votes.length > accepted.size) {
      throw new Error(`light client ${label} certificate is invalid`);
    }
    const seen = new Set();
    for (const vote of votes) {
      const member = accepted.get(vote?.validator);
      if (!member || seen.has(member.address) || typeof vote.signature !== "string" ||
          vote.signature.length > 7_000 || !validateVote(vote) ||
          !verifyObject(
            typeof payload === "function" ? payload(vote) : payload,
            vote.signature,
            member.publicKey,
            domain,
          )) {
        throw new Error(`light client ${label} vote is invalid`);
      }
      seen.add(member.address);
    }
    const requireQuorum = (set, kind) => {
      const addresses = new Set(set.map(({ address }) => address));
      const count = [...seen].filter((address) => addresses.has(address)).length;
      if (count < Math.floor((set.length * 2) / 3) + 1) {
        throw new Error(`light client ${kind} quorum is not reached`);
      }
    };
    requireQuorum(current, label);
    if (previous) requireQuorum(previous, `old-set ${label}`);
  };
  let prepareRound = null;
  verifyCertificate(proof.prepareCertificate, "BLOCK_PREPARE", (vote) => ({
    blockHash: proof.hash, height: proof.header.height, round: vote.round,
  }), "prepare", (vote) => {
    if (!Number.isSafeInteger(vote.round) || vote.round !== proof.round ||
        (prepareRound !== null && vote.round !== prepareRound)) return false;
    prepareRound = vote.round;
    return true;
  });
  verifyCertificate(proof.certificate, "BLOCK_COMMIT", {
    blockHash: proof.hash,
    prepareCertificateHash: prepareCertificateHash(proof.prepareCertificate),
  }, "finality");
}

export function validateFinalityHeader(header, hash, expectedNetworkId, {
  supportedProtocolVersions = SUPPORTED_PROTOCOL_VERSIONS,
} = {}) {
  const supported = normalizeSupportedProtocolVersions(supportedProtocolVersions);
  const expectedKeys = [
    "accountStateRoot", "bodyHash", "capabilityMemoryRoot", "format", "height", "networkId",
    "peerRegistryHash", "previousHash", "protocolUpgrade", "protocolVersion", "stateRoot", "timestamp",
    "transactionCount", "transactionsRoot",
  ];
  if (header?.format !== HEADER_FORMAT ||
      Object.keys(header ?? {}).sort().join(",") !== expectedKeys.sort().join(",") ||
      hash !== blockHeaderHash(header) || !HASH.test(hash ?? "") ||
      header.networkId !== expectedNetworkId || !supported.includes(header.protocolVersion) ||
      !Number.isSafeInteger(header.height) || header.height < 1 ||
      !Number.isSafeInteger(header.timestamp) || header.timestamp < 0 ||
      !Number.isSafeInteger(header.transactionCount) || header.transactionCount < 0 ||
      !HASH.test(header.previousHash ?? "") || !HASH.test(header.stateRoot ?? "") ||
      !HASH.test(header.accountStateRoot ?? "") ||
      !HASH.test(header.transactionsRoot ?? "") ||
      !HASH.test(header.bodyHash ?? "") || !HASH.test(header.capabilityMemoryRoot ?? "") ||
      !HASH.test(header.peerRegistryHash ?? "")) {
    throw new Error("light client finality header is invalid");
  }
  if (header.protocolUpgrade !== null) {
    try {
      normalizeProtocolUpgrade(header.protocolUpgrade, {
        currentHeight: header.height,
        currentVersion: header.protocolVersion,
      });
    } catch { throw new Error("light client protocol upgrade is invalid"); }
  }
  return header;
}

function validateProof(proof, expectedNetworkId, supportedProtocolVersions) {
  if (!proof || proof.format !== FORMAT ||
      Object.keys(proof).sort().join(",") !==
        "certificate,format,hash,header,prepareCertificate,round" ||
      !Number.isSafeInteger(proof.round) || proof.round < 0) {
    throw new Error("light client finality proof is invalid");
  }
  return validateFinalityHeader(proof.header, proof.hash, expectedNetworkId, {
    supportedProtocolVersions,
  });
}

export function verifyFinalityProofChain(proofs, {
  checkpoint,
  expectedNetworkId,
  handoffs = [],
  supportedProtocolVersions = SUPPORTED_PROTOCOL_VERSIONS,
  trustedValidators,
} = {}) {
  if (!checkpoint || !Number.isSafeInteger(checkpoint.height) || checkpoint.height < 0 ||
      !HASH.test(checkpoint.tipHash ?? "") || !HASH.test(checkpoint.stateRoot ?? "") ||
      typeof expectedNetworkId !== "string" || !Array.isArray(proofs) || proofs.length < 1 ||
      proofs.length > MAX_FINALITY_PROOFS ||
      Buffer.byteLength(canonicalJson(proofs)) > MAX_FINALITY_CHAIN_BYTES ||
      !Array.isArray(handoffs) || handoffs.length > MAX_VALIDATORS) {
    throw new Error("light client proof chain envelope is invalid");
  }
  let current = normalizeValidators(trustedValidators);
  let previousHash = checkpoint.tipHash;
  let previousHeight = checkpoint.height;
  let previousTimestamp = null;
  let protocolVersion = checkpoint.protocolVersion ?? PROTOCOL_VERSION;
  let pendingProtocolUpgrade = checkpoint.pendingProtocolUpgrade ?? null;
  let handoffIndex = 0;
  while (handoffIndex < handoffs.length && handoffs[handoffIndex].activationHeight <= checkpoint.height) {
    const advanced = verifyValidatorHandoff(handoffs[handoffIndex], {
      expectedNetworkId,
      minimumActivationHeight: handoffIndex === 0 ? 1 : handoffs[handoffIndex - 1].activationHeight + 1,
      trustedValidators: current,
    });
    current = advanced.trustedValidators;
    handoffIndex += 1;
  }
  if (checkpoint.validatorSetId !== undefined &&
      checkpoint.validatorSetId !== validatorSetId(current)) {
    throw new Error("light client checkpoint validator set does not match handoff history");
  }
  for (const proof of proofs) {
    const header = validateProof(proof, expectedNetworkId, supportedProtocolVersions);
    if (header.height !== previousHeight + 1 || header.previousHash !== previousHash ||
        (previousTimestamp !== null && header.timestamp < previousTimestamp)) {
      throw new Error("light client finality chain is discontinuous");
    }
    const protocolState = protocolTransition({
      blockVersion: header.protocolVersion,
      currentHeight: header.height,
      currentVersion: protocolVersion,
      pendingUpgrade: pendingProtocolUpgrade,
      proposedUpgrade: header.protocolUpgrade,
      supportedVersions: supportedProtocolVersions,
    });
    protocolVersion = protocolState.protocolVersion;
    pendingProtocolUpgrade = protocolState.pendingUpgrade;
    let oldSet = null;
    const handoff = handoffs[handoffIndex];
    if (handoff && handoff.activationHeight === header.height) {
      const advanced = verifyValidatorHandoff(handoff, {
        expectedNetworkId,
        minimumActivationHeight: handoffIndex === 0 ? 1 : handoffs[handoffIndex - 1].activationHeight + 1,
        trustedValidators: current,
      });
      if (advanced.activationBlockHash !== proof.hash ||
          advanced.activationStateRoot !== header.stateRoot) {
        throw new Error("light client validator handoff does not match its activation header");
      }
      oldSet = current;
      current = advanced.trustedValidators;
      handoffIndex += 1;
    } else if (handoff && handoff.activationHeight < header.height) {
      throw new Error("light client validator handoff history is incomplete");
    }
    verifyVotes(proof, current, oldSet);
    previousHash = proof.hash;
    previousHeight = header.height;
    previousTimestamp = header.timestamp;
  }
  const last = proofs.at(-1);
  return {
    height: last.header.height,
    accountStateRoot: last.header.accountStateRoot,
    networkId: expectedNetworkId,
    pendingProtocolUpgrade,
    protocolVersion,
    stateRoot: last.header.stateRoot,
    tipHash: last.hash,
    transactionCount: last.header.transactionCount,
    transactionsRoot: last.header.transactionsRoot,
    validatorSetId: validatorSetId(current),
  };
}

export function verifyValidatorRecoveryTransition({
  expectedNetworkId, plan, previousPeerRegistry = null, previousProof, recoveryBlock,
  trustedPlanHash, trustedValidators,
} = {}) {
  const previousHeader = validateProof(previousProof, expectedNetworkId,
    SUPPORTED_PROTOCOL_VERSIONS);
  const current = normalizeValidators(trustedValidators);
  verifyVotes(previousProof, current);
  if (!/^[0-9a-f]{64}$/.test(trustedPlanHash ?? "")) {
    throw new Error("light client recovery plan hash is not pre-pinned");
  }
  const hasPeerRegistry = previousHeader.peerRegistryHash !== "0".repeat(64);
  if (hasPeerRegistry !== (previousPeerRegistry !== null) ||
      (previousPeerRegistry && peerRegistryHash(previousPeerRegistry) !==
        previousHeader.peerRegistryHash)) {
    throw new Error("light client previous peer registry proof is invalid");
  }
  const verifiedPlan = verifyValidatorRecoveryPlanAcceptance(plan, {
    activeValidators: current,
    networkId: expectedNetworkId,
    peerRegistryRequired: hasPeerRegistry,
    trustedPlanHash,
  });
  if (verifiedPlan.scheduledHeight > previousHeader.height) {
    throw new Error("light client recovery plan was not precommitted before the trigger");
  }
  const reserveOrder = verifiedPlan.reserves.map(({ address }) => address).sort();
  const expectedProposer = reserveOrder[recoveryBlock?.height % reserveOrder.length];
  if (!recoveryBlock || recoveryBlock.height !== previousHeader.height + 1 ||
      recoveryBlock.previousHash !== previousProof.hash ||
      recoveryBlock.hash !== blockHeaderHash(blockHeader(recoveryBlock)) ||
      recoveryBlock.transactions?.length !== 1 ||
      recoveryBlock.transactions[0]?.type !== "validator-recovery" ||
      recoveryBlock.transactionCount !== 1 ||
      recoveryBlock.transactionsRoot !== transactionRoot(recoveryBlock.transactions) ||
      recoveryBlock.proposer !== expectedProposer ||
      recoveryBlock.feeRecipient !== expectedProposer || recoveryBlock.round !== 0 ||
      recoveryBlock.roundCertificate !== null || recoveryBlock.protocolUpgrade !== null ||
      recoveryBlock.protocolVersion !== previousHeader.protocolVersion ||
      recoveryBlock.validatorRotation !== null || recoveryBlock.beaconRotation !== null ||
      recoveryBlock.peerRegistryUpdate !== null ||
      recoveryBlock.progressRewards.length !== 0 ||
      recoveryBlock.progressFraudProofs.length !== 0 ||
      recoveryBlock.safetySettlements.length !== 0 ||
      recoveryBlock.randomnessCommits.length !== 0 ||
      recoveryBlock.randomnessReveals.length !== 0 ||
      recoveryBlock.fallbackBeacons.length !== 0 ||
      recoveryBlock.progressBeacons.length !== 0 ||
      recoveryBlock.epochRandomnessCommits.length !== 0 ||
      recoveryBlock.epochRandomnessReveals.length !== 0) {
    throw new Error("light client validator recovery chain is invalid");
  }
  const transition = recoveryBlock.transactions[0];
  const context = verifyValidatorRecoveryEnvelope(transition, {
    currentHeight: recoveryBlock.height,
    networkId: expectedNetworkId,
    plan: verifiedPlan,
    previousBlock: { hash: previousProof.hash, height: previousHeader.height,
      previousHash: previousHeader.previousHash, stateRoot: previousHeader.stateRoot },
  });
  verifyValidatorAdmissionOmissionTransactionEnvelope(
    transition.evidenceTransaction, expectedNetworkId,
  );
  verifyValidatorAdmissionOmissionEvidence(transition.evidenceTransaction.evidence, {
    canonicalBlockHash: previousProof.hash,
    canonicalCertificate: previousProof.certificate,
    canonicalHeader: previousHeader,
    canonicalPrepareCertificateHash: prepareCertificateHash(previousProof.prepareCertificate),
    canonicalRound: previousProof.round,
    canonicalTransactionIds: transition.evidenceTransaction.evidence.transactionIds,
    currentHeight: recoveryBlock.height,
    networkId: expectedNetworkId,
    validators: current,
  });
  const expectedPeerRegistryHash = hasPeerRegistry
    ? peerRegistryHash(createValidatorRecoveryPeerRegistry({
      activationHeight: recoveryBlock.height,
      generation: verifiedPlan.generation,
      networkId: expectedNetworkId,
      peers: verifiedPlan.peers,
      planHash: verifiedPlan.planHash,
      previousRegistry: previousPeerRegistry,
    })) : "0".repeat(64);
  if (recoveryBlock.peerRegistryHash !== expectedPeerRegistryHash) {
    throw new Error("light client recovery peer registry commitment is invalid");
  }
  verifyValidatorRecoveryVotes({ commits: recoveryBlock.certificate,
    prepares: recoveryBlock.prepareCertificate }, {
    blockHash: recoveryBlock.hash,
    checkpointHash: context.checkpointHash,
    evidenceHash: context.evidenceHash,
    generation: transition.generation,
    height: recoveryBlock.height,
    networkId: expectedNetworkId,
    planHash: transition.planHash,
    reserveSetId: verifiedPlan.reserveSetId,
  }, verifiedPlan);
  return { height: recoveryBlock.height, stateRoot: recoveryBlock.stateRoot,
    tipHash: recoveryBlock.hash, trustedValidators: structuredClone(verifiedPlan.reserves),
    validatorSetId: verifiedPlan.reserveSetId };
}
