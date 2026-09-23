#!/usr/bin/env node
import process from "node:process";

import { createProductionRuntimePolicyGuard,
  createWalletToolProductionGuard } from "./production-startup.mjs";
import { createProductionWalletUiServer,
  walletUiSnapshotFromArtifact } from "./wallet-ui-server.mjs";

const [walletInstallationTarget, walletHeadStore, signedReleasePath, trustedAddress,
  walletExternalAnchorPath, toolInstallationTarget, toolHeadStore, toolExternalAnchorPath,
  runtimePolicyPath, expectedRuntimePolicyHash, runtimePolicySequenceText,
  portText = "8765", host = "127.0.0.1"] = process.argv.slice(2);

try {
  const port = Number(portText);
  if (![walletInstallationTarget, walletHeadStore, signedReleasePath, trustedAddress,
    walletExternalAnchorPath, toolInstallationTarget, toolHeadStore,
    toolExternalAnchorPath, runtimePolicyPath, expectedRuntimePolicyHash].every(Boolean) ||
      !Number.isSafeInteger(Number(runtimePolicySequenceText)) ||
      Number(runtimePolicySequenceText) < 1 || !Number.isSafeInteger(port) || port < 1 ||
      port > 65535 || !new Set(["127.0.0.1", "::1"]).has(host)) {
    throw new Error("usage: wallet:serve-production <wallet-installation> <wallet-head> <signed-release> <trusted-address> <wallet-anchor> <tool-installation> <tool-head> <tool-anchor> <runtime-policy> <expected-policy-hash> <policy-sequence> [port] [loopback-host]");
  }
  const guard = createWalletToolProductionGuard({
    includeWalletArtifact: true, moduleUrl: import.meta.url, signedReleasePath,
    toolExternalAnchorPath, toolHeadStore, toolInstallationTarget, trustedAddress,
    walletExternalAnchorPath, walletHeadStore, walletInstallationTarget,
  });
  const runtimeGuard = createProductionRuntimePolicyGuard({ command: "ui",
    expectedPolicyHash: expectedRuntimePolicyHash,
    expectedSequence: Number(runtimePolicySequenceText), policyPath: runtimePolicyPath,
    tool: guard.initial.tool, wallet: guard.initial.wallet });
  const snapshot = walletUiSnapshotFromArtifact(guard.initial.wallet.artifact);
  const server = createProductionWalletUiServer(snapshot, {
    verifyRequest: () => { guard.verifyBeforeOpen(); runtimeGuard.verifyBeforeSensitiveAction(); },
  });
  guard.verifyBeforeOpen(); runtimeGuard.verifyBeforeSensitiveAction();
  const shutdown = () => server.gracefulShutdown().then(() => process.exit(0), () => process.exit(1));
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  server.once("error", () => {
    console.error("Wallet UI startup failed: loopback listener is unavailable");
    server.gracefulShutdown().then(() => process.exit(1), () => process.exit(1));
  });
  server.listen(port, host, () => {
    const displayHost = host === "::1" ? "[::1]" : host;
    console.log(`NIR production wallet UI ${guard.initial.wallet.packageHash}`);
    console.log(`Listening only on http://${displayHost}:${port}`);
  });
} catch (error) {
  console.error(`Wallet UI startup failed: ${error.message}`);
  process.exitCode = 1;
}
