import { signObject, verifyObject } from "./crypto.mjs";
import { requestJson } from "./http-client.mjs";
import { peerRegistryHash } from "./peer-registry.mjs";

function payloadFields({ height, networkId, registry, tipHash }) {
  if (!Number.isSafeInteger(height) || height < 0 ||
      typeof networkId !== "string" || networkId.length < 1 || networkId.length > 128 ||
      !/^[0-9a-f]{64}$/.test(tipHash ?? "") || !registry) {
    throw new Error("peer discovery payload is invalid");
  }
  return {
    height,
    networkId,
    registry,
    registryHash: peerRegistryHash(registry),
    tipHash,
  };
}

export function createPeerAnnouncement(fields, transportWallet) {
  const payload = payloadFields(fields);
  return {
    ...payload,
    signature: signObject(payload, transportWallet, "PEER_DISCOVERY"),
    signer: transportWallet.address,
  };
}

export function verifyPeerAnnouncement(announcement, {
  expectedNetworkId,
  expectedRegistryHash,
  minimumHeight = 0,
  trustedTransport,
}) {
  const payload = payloadFields(announcement ?? {});
  if (!Number.isSafeInteger(minimumHeight) || minimumHeight < 0 ||
      payload.height < minimumHeight || payload.networkId !== expectedNetworkId ||
      payload.registryHash !== expectedRegistryHash ||
      announcement.signer !== trustedTransport?.address ||
      !verifyObject(payload, announcement.signature, trustedTransport.publicKey, "PEER_DISCOVERY")) {
    throw new Error("peer discovery announcement is not trusted");
  }
  return structuredClone(payload);
}

export async function discoverPeers({
  expectedNetworkId,
  expectedRegistryHash,
  minimumHeight = 0,
  seedUrl,
  tlsCertificateSha256 = null,
  trustedTransport,
}) {
  const response = await requestJson(`${new URL(seedUrl).origin}/v1/discovery`, {
    tlsCertificateSha256,
  });
  if (!response.ok) {
    throw new Error(response.body?.error ?? `discovery seed returned ${response.status}`);
  }
  return verifyPeerAnnouncement(response.body, {
    expectedNetworkId,
    expectedRegistryHash,
    minimumHeight,
    trustedTransport,
  });
}

export function selectPeerAnnouncements(entries, {
  expectedNetworkId,
  expectedRegistryHash,
  minimumHeight = 0,
  minimumResponses = 1,
} = {}) {
  if (!Array.isArray(entries) || entries.length > 128 ||
      !Number.isSafeInteger(minimumResponses) || minimumResponses < 1 ||
      minimumResponses > 128) {
    throw new Error("peer discovery candidate policy is invalid");
  }
  const valid = [];
  const signers = new Set();
  for (const entry of entries) {
    try {
      const announcement = verifyPeerAnnouncement(entry?.announcement, {
        expectedNetworkId,
        expectedRegistryHash,
        minimumHeight,
        trustedTransport: entry?.trustedTransport,
      });
      const signer = entry.announcement.signer;
      if (signers.has(signer)) continue;
      signers.add(signer);
      valid.push({ announcement, signer });
    } catch {
      // An unavailable or malformed source cannot invalidate independent responses.
    }
  }
  if (valid.length < minimumResponses) {
    throw new Error(`peer discovery responses are insufficient (${valid.length}/${minimumResponses})`);
  }
  const tipByHeight = new Map();
  for (const { announcement } of valid) {
    const known = tipByHeight.get(announcement.height);
    if (known && known !== announcement.tipHash) {
      throw new Error("trusted discovery seeds report conflicting tips at the same height");
    }
    tipByHeight.set(announcement.height, announcement.tipHash);
  }
  valid.sort((left, right) => right.announcement.height - left.announcement.height ||
    left.signer.localeCompare(right.signer));
  return {
    ...structuredClone(valid[0].announcement),
    respondingSeeds: valid.length,
  };
}

export async function discoverPeersFromSeeds({
  expectedNetworkId,
  expectedRegistryHash,
  minimumHeight = 0,
  minimumResponses = 1,
  seeds,
}) {
  if (!Array.isArray(seeds) || seeds.length === 0 || seeds.length > 128) {
    throw new Error("discovery seed list is invalid");
  }
  const normalized = seeds.map((seed) => ({
    origin: new URL(seed?.url).origin,
    tlsCertificateSha256: seed?.tlsCertificateSha256 ?? null,
    trustedTransport: seed?.trustedTransport,
  }));
  if (new Set(normalized.map(({ origin }) => origin)).size !== normalized.length ||
      new Set(normalized.map(({ trustedTransport }) => trustedTransport?.address)).size !==
        normalized.length) {
    throw new Error("discovery seeds must have unique origins and transport identities");
  }
  const responses = await Promise.allSettled(normalized.map(async (seed) => {
    const response = await requestJson(`${seed.origin}/v1/discovery`, {
      tlsCertificateSha256: seed.tlsCertificateSha256,
    });
    if (!response.ok) {
      throw new Error(response.body?.error ?? `discovery seed returned ${response.status}`);
    }
    return { announcement: response.body, trustedTransport: seed.trustedTransport };
  }));
  return selectPeerAnnouncements(
    responses.filter(({ status }) => status === "fulfilled").map(({ value }) => value),
    { expectedNetworkId, expectedRegistryHash, minimumHeight, minimumResponses },
  );
}
