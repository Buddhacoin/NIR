import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { verifyPeerRegistry } from "./peer-registry.mjs";
import { verifyValidatorHandoff } from "./validator-handoff.mjs";
import { verifyValidatorOnboarding } from "./validator-onboarding.mjs";

const PRIMARY = "VALIDATOR-TOPOLOGIES.json";
const BACKUP = "VALIDATOR-TOPOLOGIES.backup.json";
export const MAX_TOPOLOGY_STORE_BYTES = 16 * 1024 * 1024;

function serialized(value) {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents) > MAX_TOPOLOGY_STORE_BYTES) {
    throw new Error("validator topology history is too large");
  }
  return contents;
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function verifyValidatorTopologyHistory({
  genesisPeerRegistry,
  genesisValidators,
  handoffs = [],
  networkId,
  onboardings = [],
} = {}) {
  if (!Array.isArray(handoffs) || !Array.isArray(onboardings) ||
      handoffs.length !== onboardings.length || onboardings.length > 128) {
    throw new Error("validator topology history length is invalid");
  }
  let validators = structuredClone(genesisValidators);
  let registry = verifyPeerRegistry(genesisPeerRegistry, {
    currentHeight: 0,
    networkId,
    validators,
  });
  let minimumActivationHeight = 1;
  for (let index = 0; index < onboardings.length; index += 1) {
    const handoff = verifyValidatorHandoff(handoffs[index], {
      expectedNetworkId: networkId,
      minimumActivationHeight,
      trustedValidators: validators,
    });
    const onboarding = verifyValidatorOnboarding(onboardings[index], {
      activationHeight: handoff.activationHeight,
      currentPeerRegistry: registry,
      currentValidators: validators,
      networkId,
      nextValidators: handoff.trustedValidators,
    });
    if (onboarding.previousSetId !== handoffs[index].previousSetId ||
        onboarding.nextSetId !== handoffs[index].nextSetId) {
      throw new Error("validator topology does not match its handoff");
    }
    validators = handoff.trustedValidators;
    registry = onboarding;
    minimumActivationHeight = handoff.activationHeight + 1;
  }
  return {
    activationHeight: handoffs.at(-1)?.activationHeight ?? 0,
    onboardings: structuredClone(onboardings),
    peerRegistry: structuredClone(registry),
    trustedValidators: structuredClone(validators),
  };
}

function readCandidate(path, context) {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() ||
        statSync(path).size > MAX_TOPOLOGY_STORE_BYTES) return null;
    const onboardings = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(onboardings) || onboardings.length > context.handoffs.length) return null;
    const verified = verifyValidatorTopologyHistory({
      ...context,
      handoffs: context.handoffs.slice(0, onboardings.length),
      onboardings,
    });
    return { contents: serialized(onboardings), onboardings, verified };
  } catch {
    return null;
  }
}

export function loadValidatorTopologyHistory(directory, context) {
  const root = resolve(directory);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error("validator topology directory cannot be a symbolic link");
  }
  const paths = [join(root, PRIMARY), join(root, BACKUP)];
  const candidates = paths.map((path) => readCandidate(path, context));
  const valid = candidates.filter(Boolean).sort((left, right) =>
    right.onboardings.length - left.onboardings.length);
  if (valid.length === 0) {
    if (paths.some(existsSync)) throw new Error("all validator topology store copies are invalid");
    return verifyValidatorTopologyHistory({ ...context, handoffs: [], onboardings: [] });
  }
  if (valid.length === 2) {
    const shorter = valid[1].onboardings;
    const prefix = valid[0].onboardings.slice(0, shorter.length);
    if (serialized(shorter) !== serialized(prefix)) {
      throw new Error("validator topology store copies conflict");
    }
  }
  const selected = valid[0];
  let recoveredCopies = 0;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let index = 0; index < paths.length; index += 1) {
    if (!candidates[index] || candidates[index].contents !== selected.contents) {
      writeAtomic(paths[index], selected.contents);
      recoveredCopies += 1;
    }
  }
  return {
    ...selected.verified,
    recoveredCopies,
  };
}

export function installValidatorTopology(directory, onboarding, context) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const current = loadValidatorTopologyHistory(root, context);
  if (current.onboardings.some(({ onboardingHash }) =>
    onboardingHash === onboarding?.onboardingHash)) {
    return { ...current, status: "known" };
  }
  if (current.onboardings.length >= context.handoffs.length) {
    throw new Error("validator topology has no matching handoff");
  }
  const onboardings = [...current.onboardings, structuredClone(onboarding)];
  const verified = verifyValidatorTopologyHistory({
    ...context,
    handoffs: context.handoffs.slice(0, onboardings.length),
    onboardings,
  });
  const contents = serialized(onboardings);
  writeAtomic(join(root, BACKUP), contents);
  writeAtomic(join(root, PRIMARY), contents);
  return { ...verified, recoveredCopies: 0, status: "installed" };
}
