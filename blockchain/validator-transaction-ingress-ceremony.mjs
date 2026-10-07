import { compileGenesis, verifyGenesisCeremony } from "./genesis-ceremony.mjs";
import { verifyCeremonyRegistry } from "./genesis-ceremony-store.mjs";
import { validateValidatorTransactionIngressConfig } from "./validator-transaction-ingress.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;

/** Verify all ceremony evidence before constructing or listening on an ingress server. */
export function verifyCeremonyBoundTransactionIngressEvidence({
  anchor, expectedGenesisHash, expectedNetworkId, expectedTlsCertificateSha256,
  expectedUpstreamOrigin, registryDirectory, trustedReleaseSignerAddress,
  validatorAddress, walletOrigin = null,
} = {}) {
  if (!anchor || !HASH.test(expectedGenesisHash ?? "") ||
      !ADDRESS.test(trustedReleaseSignerAddress ?? "") ||
      !ADDRESS.test(validatorAddress ?? "") ||
      typeof registryDirectory !== "string" || registryDirectory.length < 1) {
    throw new Error("ceremony-bound transaction ingress requires external trust anchors and a validator identity");
  }
  const registry = verifyCeremonyRegistry(registryDirectory, {
    anchor, trustedAddress: trustedReleaseSignerAddress,
  });
  if (registry.count < 1 || registry.count !== anchor.payload?.count ||
      registry.head !== anchor.payload?.registryHead) {
    throw new Error("ceremony-bound transaction ingress registry is not at its external anchor");
  }
  const record = registry.records.at(-1);
  if (record.plan.format !== "nir-public-genesis-plan-v2" ||
      record.genesisHash !== expectedGenesisHash ||
      anchor.payload.latestGenesisHash !== expectedGenesisHash) {
    throw new Error("ceremony-bound transaction ingress genesis does not match its external pin");
  }
  const releaseOptions = {
    signedRelease: record.signedRelease, trustedAddress: trustedReleaseSignerAddress,
  };
  verifyGenesisCeremony(record.plan, record.envelope, releaseOptions);
  const compiled = compileGenesis(record.plan, record.envelope, releaseOptions);
  if (compiled.genesisHash !== expectedGenesisHash ||
      record.plan.networkId !== expectedNetworkId) {
    throw new Error("ceremony-bound transaction ingress genesis or network identity is invalid");
  }
  const selected = record.plan.validators.find(({ address }) => address === validatorAddress);
  const peer = compiled.genesis.peerRegistry.peers.find(({ validatorAddress: address }) =>
    address === validatorAddress);
  if (!selected || !peer || selected.endpoint !== expectedUpstreamOrigin ||
      selected.tlsCertificateSha256 !== expectedTlsCertificateSha256 ||
      peer.url !== selected.endpoint ||
      peer.tlsCertificateSha256 !== selected.tlsCertificateSha256) {
    throw new Error("ceremony-bound transaction ingress validator endpoint or TLS pin is invalid");
  }
  return { config: validateValidatorTransactionIngressConfig({
    expectedNetworkId: record.plan.networkId,
    tlsCertificateSha256: selected.tlsCertificateSha256,
    upstreamOrigin: selected.endpoint,
    walletOrigin,
  }), validator: { address: selected.address, algorithm: selected.algorithm,
    publicKey: selected.publicKey } };
}

export function verifyCeremonyBoundTransactionIngressConfig(options) {
  return verifyCeremonyBoundTransactionIngressEvidence(options).config;
}
