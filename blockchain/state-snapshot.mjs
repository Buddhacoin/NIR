import { NirChain, blockHash, computeChainStateRoot } from "./chain.mjs";
import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { capabilityMemorySnapshotRoot } from "./memory.mjs";
import { validatorSetId } from "./validator-rotation.mjs";
import { advanceValidatorTrust } from "./validator-handoff.mjs";
import { validatorRecoveryStateCommitment } from "./validator-recovery.mjs";
import {
  EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
  RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION,
} from "./constants.mjs";
import {
  assertActiveEvaluationAssignmentRegistry,
  evaluationAssignmentRoot,
} from "./evaluation-assignment-tree.mjs";

const FORMAT = "nir-state-snapshot-v1";
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function snapshotPayload(chain) {
  const exported = chain.consensusSnapshot();
  const validators = exported.state.validators?.map?.((entry) => entry[1]);
  if (!Array.isArray(validators) || validators.length < 4) {
    throw new Error("snapshot validator state is invalid");
  }
  return {
    capabilityMemory: exported.capabilityMemory,
    checkpoint: chain.blocks().at(-1),
    format: FORMAT,
    height: chain.height,
    networkId: chain.networkId,
    ...(chain.protocolVersion >= RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION
      ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    ...(chain.protocolVersion >= EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION
      ? { evaluationAssignmentRoot: chain.evaluationAssignmentRoot } : {}),
    state: exported.state,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
    validatorSetId: validatorSetId(validators),
  };
}

export function createStateSnapshot(chain, validatorWallets) {
  if (!Array.isArray(validatorWallets)) throw new Error("snapshot validator wallets are required");
  const payload = snapshotPayload(chain);
  const snapshotHash = hashObject(payload, "STATE_SNAPSHOT");
  return {
    ...payload,
    attestations: validatorWallets.map((wallet) => ({
      signature: signObject({ snapshotHash }, wallet, "STATE_SNAPSHOT_APPROVAL"),
      validator: wallet.address,
    })),
    snapshotHash,
  };
}

function verifySnapshotContent(snapshot, { expectedNetworkId, trustedValidators } = {}) {
  if (!snapshot || snapshot.format !== FORMAT ||
      !Number.isSafeInteger(snapshot.height) || snapshot.height < 0 ||
      typeof snapshot.networkId !== "string" || snapshot.networkId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(snapshot.tipHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(snapshot.stateRoot ?? "") ||
      (snapshot.state?.protocolVersion >= RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION
        ? !/^[0-9a-f]{64}$/.test(snapshot.recoveryStateCommitment ?? "")
        : snapshot.recoveryStateCommitment !== undefined) ||
      (snapshot.state?.protocolVersion >= EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION
        ? !/^[0-9a-f]{64}$/.test(snapshot.evaluationAssignmentRoot ?? "")
        : snapshot.evaluationAssignmentRoot !== undefined) ||
      !/^[0-9a-f]{64}$/.test(snapshot.snapshotHash ?? "") ||
      Buffer.byteLength(canonicalJson(snapshot)) > MAX_SNAPSHOT_BYTES) {
    throw new Error("state snapshot header is invalid");
  }
  if (snapshot.networkId !== expectedNetworkId || !Array.isArray(trustedValidators) ||
      trustedValidators.length < 4 || trustedValidators.length > 128) {
    throw new Error("state snapshot trust anchor is invalid");
  }
  const { attestations, snapshotHash, ...payload } = snapshot;
  if (snapshotHash !== hashObject(payload, "STATE_SNAPSHOT")) {
    throw new Error("state snapshot hash is invalid");
  }
  if (computeChainStateRoot(snapshot.state) !== snapshot.stateRoot) {
    throw new Error("state snapshot root is invalid");
  }
  const recoveryGeneration = snapshot.state?.validatorRecoveryGeneration;
  const activePlanHash = snapshot.state?.validatorRecoveryPlan?.planHash ?? null;
  const recoveryCommitmentActive =
    snapshot.state?.protocolVersion >= RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION;
  if ((recoveryCommitmentActive && (
    snapshot.recoveryStateCommitment !== validatorRecoveryStateCommitment({
      activePlanHash, generation: recoveryGeneration, networkId: snapshot.networkId,
    }) || snapshot.state?.recoveryStateCommitment !== snapshot.recoveryStateCommitment ||
      snapshot.checkpoint?.recoveryStateCommitment !== snapshot.recoveryStateCommitment)) ||
      (!recoveryCommitmentActive && (snapshot.state?.recoveryStateCommitment !== undefined ||
        snapshot.checkpoint?.recoveryStateCommitment !== undefined))) {
    throw new Error("state snapshot recovery commitment is invalid");
  }
  const assignmentRootActive = snapshot.state?.protocolVersion >=
    EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION;
  const derivedAssignmentRoot = assignmentRootActive
    ? evaluationAssignmentRoot(snapshot.state?.evaluationAssignments) : undefined;
  if (assignmentRootActive) {
    assertActiveEvaluationAssignmentRegistry(
      snapshot.state?.progressCommitments, snapshot.state?.evaluationAssignments,
    );
  }
  if ((assignmentRootActive && (
    snapshot.evaluationAssignmentRoot !== derivedAssignmentRoot ||
    snapshot.state?.evaluationAssignmentRoot !== derivedAssignmentRoot ||
    snapshot.checkpoint?.evaluationAssignmentRoot !== derivedAssignmentRoot)) ||
      (!assignmentRootActive && (snapshot.state?.evaluationAssignmentRoot !== undefined ||
        snapshot.checkpoint?.evaluationAssignmentRoot !== undefined))) {
    throw new Error("state snapshot evaluation assignment commitment is invalid");
  }
  if (!snapshot.checkpoint || snapshot.checkpoint.height !== snapshot.height ||
      snapshot.checkpoint.networkId !== snapshot.networkId ||
      snapshot.checkpoint.hash !== snapshot.tipHash ||
      snapshot.checkpoint.stateRoot !== snapshot.stateRoot ||
      (snapshot.height > 0 && blockHash(snapshot.checkpoint) !== snapshot.tipHash)) {
    throw new Error("state snapshot checkpoint is invalid");
  }
  const memoryRoot = capabilityMemorySnapshotRoot(snapshot.capabilityMemory);
  if (snapshot.state?.capabilityMemoryRoot !== memoryRoot) {
    throw new Error("state snapshot capability memory is invalid");
  }
  const members = snapshot.state?.validators;
  if (!Array.isArray(members) || members.length < 4 || members.length > 128) {
    throw new Error("state snapshot validator set is invalid");
  }
  const snapshotValidators = [];
  for (const entry of members) {
    const member = entry?.[1];
    if (!Array.isArray(entry) || entry.length !== 2 || entry[0] !== member?.address ||
        snapshotValidators.some(({ address }) => address === member.address)) {
      throw new Error("state snapshot validator set is invalid");
    }
    snapshotValidators.push(member);
  }
  const orderedTrusted = [...trustedValidators].sort((left, right) =>
    left.address.localeCompare(right.address));
  const trustedSetId = validatorSetId(orderedTrusted);
  if (snapshot.validatorSetId !== validatorSetId(snapshotValidators) ||
      snapshot.validatorSetId !== trustedSetId) {
    throw new Error("state snapshot validator set id is invalid");
  }
  const validators = new Map(orderedTrusted.map((member) => [member.address, member]));
  return {
    attestations,
    validators,
    verified: {
      height: snapshot.height,
      networkId: snapshot.networkId,
      snapshotHash,
      stateRoot: snapshot.stateRoot,
      tipHash: snapshot.tipHash,
    },
  };
}

function verifySnapshotAttestations(attestations, validators, snapshotHash, minimum) {
  if (!Array.isArray(attestations) || attestations.length > validators.size) {
    throw new Error("state snapshot attestations are invalid");
  }
  const seen = new Set();
  for (const attestation of attestations) {
    const member = validators.get(attestation?.validator);
    if (!member || seen.has(member.address) ||
        !verifyObject({ snapshotHash }, attestation.signature, member.publicKey,
          "STATE_SNAPSHOT_APPROVAL")) {
      throw new Error("state snapshot attestation is invalid");
    }
    seen.add(member.address);
  }
  if (seen.size < minimum) throw new Error("state snapshot quorum is not reached");
  return seen;
}

export function verifyStateSnapshot(snapshot, trustAnchor) {
  const content = verifySnapshotContent(snapshot, trustAnchor);
  const quorum = Math.floor((content.validators.size * 2) / 3) + 1;
  verifySnapshotAttestations(
    content.attestations, content.validators, content.verified.snapshotHash, quorum,
  );
  return content.verified;
}

export function verifyStateSnapshotWithHandoffs(snapshot, trustAnchor) {
  const { lastHandoff, trustedValidators } = advanceValidatorTrust(trustAnchor);
  if (lastHandoff && snapshot?.height < lastHandoff.activationHeight) {
    throw new Error("state snapshot predates its validator handoff");
  }
  if (lastHandoff && snapshot?.height === lastHandoff.activationHeight &&
      (snapshot.tipHash !== lastHandoff.activationBlockHash ||
       snapshot.stateRoot !== lastHandoff.activationStateRoot)) {
    throw new Error("state snapshot does not match its validator activation handoff");
  }
  return verifyStateSnapshot(snapshot, {
    expectedNetworkId: trustAnchor?.expectedNetworkId,
    trustedValidators,
  });
}

export function verifyStateSnapshotCandidate(snapshot, trustAnchor, expectedValidator = null) {
  const content = verifySnapshotContent(snapshot, trustAnchor);
  const seen = verifySnapshotAttestations(
    content.attestations, content.validators, content.verified.snapshotHash, 1,
  );
  if (expectedValidator !== null &&
      (content.attestations.length !== 1 || !seen.has(expectedValidator))) {
    throw new Error("state snapshot candidate signer is invalid");
  }
  return content.verified;
}

export function mergeStateSnapshotCandidates(candidates, trustAnchor) {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 128) {
    throw new Error("state snapshot candidates are invalid");
  }
  const groups = new Map();
  for (const snapshot of candidates) {
    try {
      const content = verifySnapshotContent(snapshot, trustAnchor);
      verifySnapshotAttestations(
        content.attestations, content.validators, content.verified.snapshotHash, 1,
      );
      const key = `${content.verified.height}:${content.verified.snapshotHash}`;
      const group = groups.get(key) ?? {
        attestations: new Map(), snapshot: structuredClone(snapshot), verified: content.verified,
      };
      for (const attestation of content.attestations) {
        group.attestations.set(attestation.validator, structuredClone(attestation));
      }
      groups.set(key, group);
    } catch {
      // Invalid or stale validator candidates do not poison an honest quorum.
    }
  }
  const complete = [];
  for (const group of groups.values()) {
    const merged = {
      ...group.snapshot,
      attestations: [...group.attestations.values()].sort((left, right) =>
        left.validator.localeCompare(right.validator)),
    };
    try {
      complete.push({ snapshot: merged, verified: verifyStateSnapshot(merged, trustAnchor) });
    } catch {
      // A partial group is not a snapshot.
    }
  }
  if (complete.length === 0) throw new Error("state snapshot candidate quorum is not reached");
  const byHeight = new Map();
  for (const entry of complete) {
    const hashes = byHeight.get(entry.verified.height) ?? new Set();
    hashes.add(entry.verified.snapshotHash);
    byHeight.set(entry.verified.height, hashes);
  }
  for (const hashes of byHeight.values()) {
    if (hashes.size > 1) throw new Error("conflicting snapshot candidate quorums exist at the same height");
  }
  complete.sort((left, right) => right.verified.height - left.verified.height);
  return complete[0];
}

export function restoreStateSnapshot(genesisConfig, snapshot, trustAnchor) {
  verifyStateSnapshot(snapshot, trustAnchor);
  return NirChain.fromVerifiedSnapshot(genesisConfig, snapshot);
}

export function restoreStateSnapshotWithHandoffs(genesisConfig, snapshot, trustAnchor) {
  verifyStateSnapshotWithHandoffs(snapshot, trustAnchor);
  return NirChain.fromVerifiedSnapshot(genesisConfig, snapshot);
}

export function selectStateSnapshot(candidates, trustAnchor, { minimumSources = 2 } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0 ||
      !Number.isSafeInteger(minimumSources) || minimumSources < 2 || minimumSources > 128) {
    throw new Error("snapshot candidate selection is invalid");
  }
  const seenSources = new Set();
  const groups = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.source !== "string" ||
        candidate.source.length < 1 || Buffer.byteLength(candidate.source) > 256 ||
        seenSources.has(candidate.source)) {
      throw new Error("snapshot sources must be unique canonical identifiers");
    }
    seenSources.add(candidate.source);
    try {
      const verified = verifyStateSnapshot(candidate.snapshot, trustAnchor);
      const key = `${verified.height}:${verified.snapshotHash}`;
      const group = groups.get(key) ?? {
        snapshot: structuredClone(candidate.snapshot), sources: [], verified,
      };
      group.sources.push(candidate.source);
      groups.set(key, group);
    } catch {
      // A Byzantine or stale source cannot prevent selection from enough valid peers.
    }
  }
  const byHeight = new Map();
  for (const group of groups.values()) {
    const hashes = byHeight.get(group.verified.height) ?? new Set();
    hashes.add(group.verified.snapshotHash);
    byHeight.set(group.verified.height, hashes);
  }
  for (const hashes of byHeight.values()) {
    if (hashes.size > 1) throw new Error("conflicting quorum snapshots exist at the same height");
  }
  const eligible = [...groups.values()]
    .filter(({ sources }) => sources.length >= minimumSources)
    .sort((left, right) => right.verified.height - left.verified.height);
  if (eligible.length === 0) throw new Error("no state snapshot has enough independent sources");
  const selected = eligible[0];
  return {
    snapshot: selected.snapshot,
    sources: [...selected.sources].sort(),
    verified: structuredClone(selected.verified),
  };
}
