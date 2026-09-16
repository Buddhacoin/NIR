import { addressFromPublicKey, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validatorOnboardingHash } from "./validator-onboarding.mjs";

const ZERO_HASH = "0".repeat(64);
const MAX_REGISTRY_EPOCH = 1_000_000_000;

function normalizedUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error("peer endpoint URL is invalid"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Error("peer endpoint must not contain credentials, path, query, or fragment");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("non-loopback peer endpoints require HTTPS");
  }
  return parsed.origin;
}

function normalizeTransport(identity) {
  if (!identity || identity.algorithm !== SIGNATURE_ALGORITHM ||
      typeof identity.publicKey !== "string" || identity.publicKey.length > 4_000 ||
      addressFromPublicKey(identity.publicKey) !== identity.address) {
    throw new Error("peer transport identity is invalid");
  }
  return {
    address: identity.address,
    algorithm: identity.algorithm,
    publicKey: identity.publicKey,
  };
}

function normalizeTlsPin(value, url) {
  const encrypted = new URL(url).protocol === "https:";
  if (encrypted && !/^[0-9a-f]{64}$/.test(value ?? "")) {
    throw new Error("HTTPS peer endpoint requires a SHA-256 certificate pin");
  }
  if (!encrypted && value !== null && value !== undefined) {
    throw new Error("plaintext peer endpoint cannot declare a TLS certificate pin");
  }
  return encrypted ? value : null;
}

function registryPayload({ activationHeight, epoch, networkId, peers, previousRegistryHash }) {
  if (typeof networkId !== "string" || networkId.length < 3 || networkId.length > 128 ||
      !Number.isSafeInteger(epoch) || epoch < 0 || epoch > MAX_REGISTRY_EPOCH ||
      !Number.isSafeInteger(activationHeight) || activationHeight < 0 ||
      !/^[0-9a-f]{64}$/.test(previousRegistryHash ?? "")) {
    throw new Error("peer registry header is invalid");
  }
  if (!Array.isArray(peers) || peers.length < 4) throw new Error("peer registry is too small");
  const transportAddresses = new Set();
  const urls = new Set();
  const normalizedPeers = peers.map((peer) => {
    if (!/^nir1[0-9a-f]{64}$/.test(peer?.validatorAddress ?? "")) {
      throw new Error("peer validator address is invalid");
    }
    const url = normalizedUrl(peer.url);
    const transport = normalizeTransport(peer.transport);
    const tlsCertificateSha256 = normalizeTlsPin(peer.tlsCertificateSha256, url);
    if (transport.address === peer.validatorAddress) {
      throw new Error("consensus and transport identities must be separate");
    }
    if (transportAddresses.has(transport.address) || urls.has(url)) {
      throw new Error("peer endpoints and transport identities must be unique");
    }
    transportAddresses.add(transport.address);
    urls.add(url);
    return { tlsCertificateSha256, transport, url, validatorAddress: peer.validatorAddress };
  }).sort((left, right) => left.validatorAddress.localeCompare(right.validatorAddress));
  if (new Set(normalizedPeers.map(({ validatorAddress }) => validatorAddress)).size !==
      normalizedPeers.length) throw new Error("peer validator addresses must be unique");
  return { activationHeight, epoch, networkId, peers: normalizedPeers, previousRegistryHash };
}

export function peerRegistryHash(registry) {
  if (registry?.format === "nir-validator-onboarding-v1") {
    if (registry.onboardingHash !== validatorOnboardingHash(registry)) {
      throw new Error("active onboarding registry commitment is invalid");
    }
    return registry.onboardingHash;
  }
  return hashObject(registryPayload(registry), "PEER_REGISTRY");
}

export function createPeerRegistry(fields, validatorWallets) {
  const payload = registryPayload(fields);
  const signatures = validatorWallets.map((wallet) => ({
    signature: signObject(payload, wallet, "PEER_REGISTRY_APPROVAL"),
    validator: wallet.address,
  })).sort((left, right) => left.validator.localeCompare(right.validator));
  return { ...payload, signatures };
}

export function verifyPeerRegistry(registry, {
  currentHeight,
  networkId,
  previousRegistry = null,
  validators,
}) {
  if (!Array.isArray(validators) || validators.length < 4 ||
      !Number.isSafeInteger(currentHeight) || currentHeight < 0) {
    throw new Error("peer registry verification context is invalid");
  }
  const payload = registryPayload(registry);
  if (payload.networkId !== networkId || payload.activationHeight > currentHeight) {
    throw new Error("peer registry is not active on this network");
  }
  const validatorMap = new Map(validators.map((validator) => [validator.address, validator]));
  if (validatorMap.size !== validators.length || payload.peers.length !== validatorMap.size ||
      payload.peers.some(({ validatorAddress }) => !validatorMap.has(validatorAddress))) {
    throw new Error("peer registry does not cover the validator set");
  }
  if (previousRegistry === null) {
    if (payload.epoch !== 0 || payload.previousRegistryHash !== ZERO_HASH) {
      throw new Error("initial peer registry lineage is invalid");
    }
  } else if (payload.epoch !== previousRegistry.epoch + 1 ||
      payload.previousRegistryHash !== peerRegistryHash(previousRegistry) ||
      payload.activationHeight <= previousRegistry.activationHeight) {
    throw new Error("peer registry rotation or lineage is invalid");
  }
  if (!Array.isArray(registry.signatures) || registry.signatures.length > validatorMap.size) {
    throw new Error("peer registry signatures are invalid");
  }
  const voters = new Set();
  for (const approval of registry.signatures) {
    const validator = validatorMap.get(approval?.validator);
    if (!validator || voters.has(approval.validator) ||
        typeof approval.signature !== "string" || approval.signature.length > 7_000 ||
        !verifyObject(payload, approval.signature, validator.publicKey, "PEER_REGISTRY_APPROVAL")) {
      throw new Error("peer registry approval is invalid or duplicated");
    }
    voters.add(approval.validator);
  }
  const quorum = Math.floor((validatorMap.size * 2) / 3) + 1;
  if (voters.size < quorum) throw new Error("peer registry approval quorum not reached");
  return structuredClone({ ...payload, signatures: registry.signatures });
}

export { ZERO_HASH as EMPTY_PEER_REGISTRY_HASH };
