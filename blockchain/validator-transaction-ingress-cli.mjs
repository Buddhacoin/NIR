#!/usr/bin/env node
import process from "node:process";

import { listenOnLoopback } from "./loopback-listener.mjs";
import { MAX_CHECKPOINT_TRUST_PACKAGE_BYTES }
  from "./checkpoint-trust-package.mjs";
import { verifyCheckpointTrustPackageV2 }
  from "./checkpoint-trust-package-v2.mjs";
import { CERTIFICATE_MODE_LIFECYCLE, RuntimeCertificatePins }
  from "./certificate-runtime.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
import { verifyCeremonyBoundTransactionIngressEvidence }
  from "./validator-transaction-ingress-ceremony.mjs";
import { assertTransactionIngressCertificateCommitment,
  createValidatorTransactionCheckpointGate }
  from "./validator-transaction-ingress-checkpoint.mjs";
import { initializeTransactionIngressFloor }
  from "./validator-transaction-ingress-floor.mjs";
import { readTransactionIngressOperatorConfig }
  from "./validator-transaction-ingress-operator-config.mjs";
import { probeValidatorLiveIdentity } from "./validator-live-identity.mjs";
import { createValidatorTransactionIngressServer }
  from "./validator-transaction-ingress.mjs";

try {
  const args = process.argv.slice(2);
  const ceremonyMode = args[0] === "--ceremony" || args[0] === "--init-floor";
  let portText, host, config, checkpointCertificateGate = null;
  if (ceremonyMode) {
    if (args.length !== 2) {
      throw new Error("usage: network:transaction-ingress --init-floor|--ceremony <absolute-operator-config.json>; old positional ceremony arguments are not accepted");
    }
    const operator = readTransactionIngressOperatorConfig(args[1]);
    portText = String(operator.listenPort); host = operator.listenHost;
    const verified = verifyCeremonyBoundTransactionIngressEvidence({
      anchor: readBoundedPublicJsonFile(operator.ceremonyAnchorPath, {
        label: "external ceremony anchor", maximumBytes: 1024 * 1024,
      }), expectedGenesisHash: operator.expectedGenesisHash,
      expectedNetworkId: operator.expectedNetworkId,
      expectedTlsCertificateSha256: operator.expectedTlsCertificateSha256,
      expectedUpstreamOrigin: operator.expectedUpstreamOrigin,
      registryDirectory: operator.registryDirectory,
      trustedReleaseSignerAddress: operator.trustedReleaseSignerAddress,
      validatorAddress: operator.validatorAddress, walletOrigin: operator.walletOrigin,
    });
    config = verified.config;
    const floorIdentity = {
      expectedGenesisHash: operator.expectedGenesisHash,
      expectedNetworkId: operator.expectedNetworkId,
      expectedPolicyId: operator.expectedPolicyId,
      validatorAddress: operator.validatorAddress,
    };
    if (args[0] === "--init-floor") {
      // A typo in a pinned witness policy must not make an unusable immutable floor.
      const checkpoint = verifyCheckpointTrustPackageV2(readBoundedPublicJsonFile(
        operator.checkpointPackagePath, {
        label: "transaction checkpoint trust package",
        maximumBytes: MAX_CHECKPOINT_TRUST_PACKAGE_BYTES,
      }), {
        expectedChainIdentityGenesisHash: operator.expectedGenesisHash,
        expectedNetworkId: operator.expectedNetworkId,
        expectedPolicyId: operator.expectedPolicyId,
        maxAgeMs: operator.maxWitnessAgeMs, maxFutureSkewMs: 5_000,
        minimumCheckpointHeight: 1, minimumSequence: 0, now: Date.now(),
      });
      const certificatePins = new RuntimeCertificatePins(
        operator.certificateDirectory, verified.genesis, {
          mode: CERTIFICATE_MODE_LIFECYCLE,
          externalAnchorPath: operator.certificateHeadAnchorPath,
        });
      const { context, history } = certificatePins.loadVerifiedHistory();
      assertTransactionIngressCertificateCommitment(checkpoint, context, history);
      initializeTransactionIngressFloor(operator.floorDirectory, floorIdentity);
      console.log("NIR transaction ingress floor initialized once; no listener was opened");
      process.exit(0);
    }
    checkpointCertificateGate = createValidatorTransactionCheckpointGate({
      certificateDirectory: operator.certificateDirectory,
      certificateHeadAnchorPath: operator.certificateHeadAnchorPath,
      checkpointPackagePath: operator.checkpointPackagePath,
      expectedGenesisHash: operator.expectedGenesisHash,
      expectedNetworkId: operator.expectedNetworkId,
      expectedPolicyId: operator.expectedPolicyId,
      floorDirectory: operator.floorDirectory,
      genesis: verified.genesis,
      maxWitnessAgeMs: operator.maxWitnessAgeMs,
      tlsCertificateSha256: config.tlsCertificateSha256,
      validatorAddress: operator.validatorAddress,
    });
    checkpointCertificateGate();
    await probeValidatorLiveIdentity({
      chainIdentityGenesisHash: operator.expectedGenesisHash,
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
    portText = selectedPort; host = selectedHost;
    config = { expectedNetworkId, tlsCertificateSha256, upstreamOrigin,
      walletOrigin: selectedWalletOrigin };
  }
  const port = Number(portText);
  const server = createValidatorTransactionIngressServer(config, { checkpointCertificateGate });
  await listenOnLoopback(server, { host, label: "validator transaction ingress", port });
  const shutdown = () => server.gracefulShutdown().then(() => process.exit(0), () => process.exit(1));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`NIR transaction ingress (${ceremonyMode ? "ceremony-bound startup" : "local/dev"}) listening on http://${host}:${port}`);
} catch (error) {
  console.error(`Transaction ingress failed: ${error.message}`);
  process.exitCode = 1;
}
