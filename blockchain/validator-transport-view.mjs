import { verifyValidatorOnboarding } from "./validator-onboarding.mjs";

const SYNC_PATHS = new Set([
  "/v1/p2p/blocks/range",
  "/v1/p2p/handoffs/history",
  "/v1/p2p/health",
  "/v1/p2p/snapshots/candidate",
]);

const ACTIVATION_PATHS = new Map([
  ["/v1/p2p/blocks", (payload) => payload?.height],
  ["/v1/p2p/commits", (payload) => payload?.proposal?.height],
  ["/v1/p2p/handoffs", (payload) => payload?.activationHeight],
  ["/v1/p2p/locks", (payload) => payload?.height],
  ["/v1/p2p/produce", (payload) => payload?.proposal?.height],
  ["/v1/p2p/proposals", (payload) => payload?.height],
  ["/v1/p2p/timeouts", (payload) => payload?.proposal?.height],
]);

function indexedPeers(registry) {
  return new Map((registry?.peers ?? []).map((peer) => [peer.validatorAddress, peer]));
}

function transportEntry(peer, role) {
  return structuredClone({
    ...peer,
    role,
  });
}

export function buildValidatorTransportView({
  currentPeerRegistry,
  currentValidators,
  height,
  networkId,
  pendingRotation = null,
} = {}) {
  if (!Number.isSafeInteger(height) || height < 0 || !currentPeerRegistry ||
      !Array.isArray(currentValidators)) {
    throw new Error("validator transport view input is invalid");
  }
  const current = indexedPeers(currentPeerRegistry);
  if (current.size !== currentValidators.length ||
      currentValidators.some(({ address }) => !current.has(address))) {
    throw new Error("active peer registry does not match the current validator set");
  }
  if (!pendingRotation || height >= pendingRotation.activationHeight) {
    return currentValidators.map(({ address }) =>
      transportEntry(current.get(address), "current"));
  }
  if (!pendingRotation.onboarding) {
    throw new Error("pending validator rotation has no onboarding commitment");
  }
  const onboarding = verifyValidatorOnboarding(pendingRotation.onboarding, {
    activationHeight: pendingRotation.activationHeight,
    currentPeerRegistry,
    currentValidators,
    networkId,
    nextValidators: pendingRotation.validators,
  });
  const future = indexedPeers(onboarding);
  const addresses = [
    ...currentValidators.map(({ address }) => address),
    ...pendingRotation.validators.map(({ address }) => address)
      .filter((address) => !current.has(address)),
  ];
  return addresses.map((address) => {
    const currentPeer = current.get(address);
    const futurePeer = future.get(address);
    if (currentPeer && futurePeer && JSON.stringify(currentPeer) !== JSON.stringify(futurePeer)) {
      throw new Error("overlapping validator has conflicting transport bindings");
    }
    const role = currentPeer && futurePeer ? "overlap" : currentPeer ? "current" : "future";
    return transportEntry(currentPeer ?? futurePeer, role);
  });
}

export function authorizeTransportAction(entry, {
  currentHeight,
  path,
  payload,
  pendingRotation = null,
} = {}) {
  if (!entry || !["current", "future", "overlap"].includes(entry.role) ||
      !Number.isSafeInteger(currentHeight) || currentHeight < 0 || typeof path !== "string") {
    throw new Error("validator transport authorization input is invalid");
  }
  if (entry.role !== "future") return true;
  if (!pendingRotation || currentHeight >= pendingRotation.activationHeight) {
    throw new Error("future validator transport is not active");
  }
  if (SYNC_PATHS.has(path)) return true;
  const heightFromPayload = ACTIVATION_PATHS.get(path);
  if (heightFromPayload && heightFromPayload(payload) === pendingRotation.activationHeight) return true;
  throw new Error("future validator transport is limited to synchronization and activation");
}
