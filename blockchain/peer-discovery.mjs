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
