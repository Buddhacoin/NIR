import { computeChainStateRoot } from "./chain.mjs";
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

export function verifyStateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== FORMAT ||
      !Number.isSafeInteger(snapshot.height) || snapshot.height < 0 ||
      typeof snapshot.networkId !== "string" || snapshot.networkId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(snapshot.tipHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(snapshot.stateRoot ?? "") ||
      !/^[0-9a-f]{64}$/.test(snapshot.snapshotHash ?? "") ||
      Buffer.byteLength(canonicalJson(snapshot)) > MAX_SNAPSHOT_BYTES) {
    throw new Error("state snapshot header is invalid");
  }
  const { attestations, snapshotHash, ...payload } = snapshot;
  if (snapshotHash !== hashObject(payload, "STATE_SNAPSHOT")) {
    throw new Error("state snapshot hash is invalid");
  }
  if (computeChainStateRoot(snapshot.state) !== snapshot.stateRoot) {
    throw new Error("state snapshot root is invalid");
  }
  const memoryRoot = capabilityMemorySnapshotRoot(snapshot.capabilityMemory);
  if (snapshot.state?.capabilityMemoryRoot !== memoryRoot) {
    throw new Error("state snapshot capability memory is invalid");
  }
  const members = snapshot.state?.validators;
  if (!Array.isArray(members) || members.length < 4 || members.length > 128) {
    throw new Error("state snapshot validator set is invalid");
  }
  const validators = new Map();
  for (const entry of members) {
    const member = entry?.[1];
    if (!Array.isArray(entry) || entry.length !== 2 || entry[0] !== member?.address ||
        validators.has(member.address)) throw new Error("state snapshot validator set is invalid");
    validators.set(member.address, member);
  }
  if (snapshot.validatorSetId !== validatorSetId([...validators.values()])) {
    throw new Error("state snapshot validator set id is invalid");
  }
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
