import { addressFromPublicKey, hashObject, signObject, verifyObject } from "./crypto.mjs";
import { MAX_VALIDATORS, SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const FORMAT = "nir-validator-onboarding-v1";

function committedPayload(onboarding) {
  return {
    activationHeight: onboarding?.activationHeight,
    format: onboarding?.format,
    networkId: onboarding?.networkId,
    nextSetId: onboarding?.nextSetId,
    peers: onboarding?.peers,
    previousSetId: onboarding?.previousSetId,
  };
}

export function validatorOnboardingHash(onboarding) {
  return hashObject(committedPayload(onboarding), "VALIDATOR_ONBOARDING");
}

function normalizeValidators(validators) {
  if (!Array.isArray(validators) || validators.length < 4 || validators.length > MAX_VALIDATORS) {
    throw new Error("validator onboarding set size is invalid");
  }
  const normalized = validators.map((member) => {
    if (!member || member.algorithm !== SIGNATURE_ALGORITHM ||
        addressFromPublicKey(member.publicKey) !== member.address ||
        typeof member.operatorId !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(member.operatorId)) {
      throw new Error("validator onboarding identity is invalid");
    }
    return {
      address: member.address,
      algorithm: member.algorithm,
      operatorId: member.operatorId,
      publicKey: member.publicKey,
    };
  }).sort((left, right) => left.address.localeCompare(right.address));
  if (new Set(normalized.map(({ address }) => address)).size !== normalized.length ||
      new Set(normalized.map(({ operatorId }) => operatorId)).size !== normalized.length) {
    throw new Error("validator onboarding identities must be unique");
  }
  return normalized;
}

function normalizeUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("onboarding endpoint URL is invalid"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Error("onboarding endpoint URL contains forbidden components");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("non-loopback onboarding endpoints require HTTPS");
  }
  return parsed.origin;
}

function normalizeTransport(transport) {
  if (!transport || transport.algorithm !== SIGNATURE_ALGORITHM ||
      typeof transport.publicKey !== "string" || transport.publicKey.length > 4_000 ||
      addressFromPublicKey(transport.publicKey) !== transport.address) {
    throw new Error("validator onboarding transport identity is invalid");
  }
  return { address: transport.address, algorithm: transport.algorithm, publicKey: transport.publicKey };
}

function onboardingPayload(fields) {
  const currentValidators = normalizeValidators(fields.currentValidators);
  const nextValidators = normalizeValidators(fields.nextValidators);
  const nextByAddress = new Map(nextValidators.map((member) => [member.address, member]));
  if (!Number.isSafeInteger(fields.activationHeight) || fields.activationHeight < 1 ||
      typeof fields.networkId !== "string" || fields.networkId.length < 3 ||
      fields.networkId.length > 128 || !Array.isArray(fields.peers) ||
      fields.peers.length !== nextValidators.length) {
    throw new Error("validator onboarding header is invalid");
  }
  const urls = new Set();
  const transports = new Set();
  const peers = fields.peers.map((peer) => {
    if (!nextByAddress.has(peer?.validatorAddress)) {
      throw new Error("onboarding peer is not a next-set validator");
    }
    const url = normalizeUrl(peer.url);
    const transport = normalizeTransport(peer.transport);
    const encrypted = new URL(url).protocol === "https:";
    const tlsCertificateSha256 = encrypted ? peer.tlsCertificateSha256 : null;
    if ((encrypted && !/^[0-9a-f]{64}$/.test(tlsCertificateSha256 ?? "")) ||
        (!encrypted && peer.tlsCertificateSha256 != null) ||
        transport.address === peer.validatorAddress || urls.has(url) ||
        transports.has(transport.address)) {
      throw new Error("validator onboarding peer binding is invalid");
    }
    urls.add(url);
    transports.add(transport.address);
    return { tlsCertificateSha256, transport, url, validatorAddress: peer.validatorAddress };
  }).sort((left, right) => left.validatorAddress.localeCompare(right.validatorAddress));
  if (new Set(peers.map(({ validatorAddress }) => validatorAddress)).size !== peers.length) {
    throw new Error("validator onboarding peers must be unique");
  }
  return {
    activationHeight: fields.activationHeight,
    format: FORMAT,
    networkId: fields.networkId,
    nextSetId: validatorSetId(nextValidators),
    peers,
    previousSetId: validatorSetId(currentValidators),
  };
}

function signatures(payload, wallets, domain) {
  if (!Array.isArray(wallets) || wallets.length > MAX_VALIDATORS) {
    throw new Error("validator onboarding signers are invalid");
  }
  return wallets.map((wallet) => ({
    signature: signObject(payload, wallet, domain),
    signer: wallet.address,
  })).sort((left, right) => left.signer.localeCompare(right.signer));
}

export function createValidatorOnboarding(fields, currentWallets, nextWallets, transportWallets) {
  const payload = onboardingPayload(fields);
  return {
    ...payload,
    currentApprovals: signatures(payload, currentWallets, "ONBOARDING_CURRENT"),
    nextAcceptances: signatures(payload, nextWallets, "ONBOARDING_NEXT"),
    onboardingHash: validatorOnboardingHash(payload),
    transportProofs: signatures(payload, transportWallets, "ONBOARDING_TRANSPORT"),
  };
}

function verifySignatures(payload, entries, members, domain, required) {
  if (!Array.isArray(entries) || entries.length > members.size) {
    throw new Error("validator onboarding signatures are invalid");
  }
  const seen = new Set();
  for (const entry of entries) {
    const member = members.get(entry?.signer);
    if (!member || seen.has(entry.signer) || typeof entry.signature !== "string" ||
        entry.signature.length > 7_000 ||
        !verifyObject(payload, entry.signature, member.publicKey, domain)) {
      throw new Error("validator onboarding signature is invalid");
    }
    seen.add(entry.signer);
  }
  if (seen.size < required) throw new Error("validator onboarding signature threshold is not reached");
}

export function verifyValidatorOnboarding(onboarding, {
  activationHeight,
  currentPeerRegistry = null,
  currentValidators,
  networkId,
  nextValidators,
} = {}) {
  const current = normalizeValidators(currentValidators);
  const next = normalizeValidators(nextValidators);
  const { currentApprovals, nextAcceptances, onboardingHash, transportProofs, ...unsigned } = onboarding ?? {};
  const payload = onboardingPayload({
    ...unsigned, currentValidators: current, nextValidators: next,
  });
  if (payload.networkId !== networkId || payload.activationHeight !== activationHeight ||
      unsigned.previousSetId !== payload.previousSetId || unsigned.nextSetId !== payload.nextSetId ||
      onboardingHash !== validatorOnboardingHash(payload)) {
    throw new Error("validator onboarding commitment is invalid");
  }
  if (currentPeerRegistry) {
    const currentAddresses = new Set(current.map(({ address }) => address));
    const currentPeers = new Map(currentPeerRegistry.peers.map((peer) => [peer.validatorAddress, peer]));
    for (const peer of payload.peers) {
      if (currentAddresses.has(peer.validatorAddress) &&
          JSON.stringify(peer) !== JSON.stringify(currentPeers.get(peer.validatorAddress))) {
        throw new Error("overlapping validator endpoint changed during onboarding");
      }
    }
  }
  const currentMap = new Map(current.map((member) => [member.address, member]));
  const nextMap = new Map(next.map((member) => [member.address, member]));
  const transportMap = new Map(payload.peers.map(({ transport }) => [transport.address, transport]));
  verifySignatures(payload, currentApprovals, currentMap, "ONBOARDING_CURRENT",
    Math.floor((current.length * 2) / 3) + 1);
  verifySignatures(payload, nextAcceptances, nextMap, "ONBOARDING_NEXT", next.length);
  verifySignatures(payload, transportProofs, transportMap, "ONBOARDING_TRANSPORT", next.length);
  return structuredClone({ ...payload, currentApprovals, nextAcceptances, onboardingHash, transportProofs });
}
