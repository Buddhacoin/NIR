import { NirChain, blockHash, computeChainStateRoot } from "./chain.mjs";
import { canonicalJson, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { capabilityMemorySnapshotRoot } from "./memory.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const FORMAT = "nir-state-snapshot-v1";
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

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

export function verifyStateSnapshot(snapshot, { expectedNetworkId, trustedValidators } = {}) {
  if (!snapshot || snapshot.format !== FORMAT ||
      !Number.isSafeInteger(snapshot.height) || snapshot.height < 0 ||
      typeof snapshot.networkId !== "string" || snapshot.networkId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(snapshot.tipHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(snapshot.stateRoot ?? "") ||
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
  const quorum = Math.floor((validators.size * 2) / 3) + 1;
  if (seen.size < quorum) throw new Error("state snapshot quorum is not reached");
  return {
    height: snapshot.height,
    networkId: snapshot.networkId,
    snapshotHash,
    stateRoot: snapshot.stateRoot,
    tipHash: snapshot.tipHash,
  };
}

export function restoreStateSnapshot(genesisConfig, snapshot, trustAnchor) {
  verifyStateSnapshot(snapshot, trustAnchor);
  return NirChain.fromVerifiedSnapshot(genesisConfig, snapshot);
}
