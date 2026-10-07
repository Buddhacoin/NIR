#!/usr/bin/env node
import process from "node:process";

import { listenOnLoopback } from "./loopback-listener.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
import { verifyCeremonyBoundTransactionIngressEvidence }
  from "./validator-transaction-ingress-ceremony.mjs";
import { probeValidatorLiveIdentity } from "./validator-live-identity.mjs";
import { createValidatorTransactionIngressServer }
  from "./validator-transaction-ingress.mjs";

try {
  const args = process.argv.slice(2);
  const ceremonyMode = args[0] === "--ceremony";
  let portText, host, walletOrigin, config;
  if (ceremonyMode) {
    if (args.length < 10 || args.length > 12) {
      throw new Error("usage: network:transaction-ingress --ceremony <registry-dir> <external-anchor.json> <trusted-release-signer-address> <pinned-genesis-hash> <validator-address> <loopback-https-validator-origin> <tls-sha256-pin> <network-id> <listen-port> [127.0.0.1|::1] [exact-wallet-origin]");
    }
    const [, registryDirectory, anchorPath, trustedReleaseSignerAddress,
      expectedGenesisHash, validatorAddress, expectedUpstreamOrigin,
      expectedTlsCertificateSha256, expectedNetworkId, selectedPort,
      selectedHost = "127.0.0.1", selectedWalletOrigin = null] = args;
    portText = selectedPort; host = selectedHost; walletOrigin = selectedWalletOrigin;
    const verified = verifyCeremonyBoundTransactionIngressEvidence({
      anchor: readBoundedPublicJsonFile(anchorPath, {
        label: "external ceremony anchor", maximumBytes: 1024 * 1024,
      }), expectedGenesisHash, expectedNetworkId,
      expectedTlsCertificateSha256, expectedUpstreamOrigin, registryDirectory,
      trustedReleaseSignerAddress, validatorAddress, walletOrigin,
    });
    config = verified.config;
    await probeValidatorLiveIdentity({
      chainIdentityGenesisHash: expectedGenesisHash,
      networkId: config.expectedNetworkId,
      tlsCertificateSha256: config.tlsCertificateSha256,
      upstreamOrigin: config.upstreamOrigin,
      validator: verified.validator,
    });
  } else {
    if (args.length < 4 || args.length > 6) {
      throw new Error("usage: network:transaction-ingress <loopback-https-validator-origin> <tls-sha256-pin> <network-id> <listen-port> [127.0.0.1|::1] [exact-wallet-origin]");
    }
    const [upstreamOrigin, tlsCertificateSha256, expectedNetworkId, selectedPort,
      selectedHost = "127.0.0.1", selectedWalletOrigin = null] = args;
    portText = selectedPort; host = selectedHost; walletOrigin = selectedWalletOrigin;
    config = { expectedNetworkId, tlsCertificateSha256, upstreamOrigin, walletOrigin };
  }
  const port = Number(portText);
  const server = createValidatorTransactionIngressServer(config);
  await listenOnLoopback(server, { host, label: "validator transaction ingress", port });
  const shutdown = () => server.gracefulShutdown().then(() => process.exit(0), () => process.exit(1));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`NIR transaction ingress (${ceremonyMode ? "ceremony-bound startup" : "local/dev"}) listening on http://${host}:${port}`);
} catch (error) {
  console.error(`Transaction ingress failed: ${error.message}`);
  process.exitCode = 1;
}
