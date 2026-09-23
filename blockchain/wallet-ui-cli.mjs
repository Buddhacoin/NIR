#!/usr/bin/env node
import process from "node:process";

import { createWalletToolProductionGuard } from "./production-startup.mjs";
import { createProductionWalletUiServer,
  walletUiSnapshotFromArtifact } from "./wallet-ui-server.mjs";

const [walletInstallationTarget, walletHeadStore, signedReleasePath, trustedAddress,
  walletExternalAnchorPath, toolInstallationTarget, toolHeadStore, toolExternalAnchorPath,
  portText = "8765", host = "127.0.0.1"] = process.argv.slice(2);

try {
  const port = Number(portText);
  if (![walletInstallationTarget, walletHeadStore, signedReleasePath, trustedAddress,
    walletExternalAnchorPath, toolInstallationTarget, toolHeadStore,
    toolExternalAnchorPath].every(Boolean) || !Number.isSafeInteger(port) || port < 1 ||
      port > 65535 || !new Set(["127.0.0.1", "::1"]).has(host)) {
    throw new Error("usage: wallet:serve-production <wallet-installation> <wallet-head> <signed-release> <trusted-address> <wallet-anchor> <tool-installation> <tool-head> <tool-anchor> [port] [loopback-host]");
  }
  const guard = createWalletToolProductionGuard({
    includeWalletArtifact: true, moduleUrl: import.meta.url, signedReleasePath,
    toolExternalAnchorPath, toolHeadStore, toolInstallationTarget, trustedAddress,
    walletExternalAnchorPath, walletHeadStore, walletInstallationTarget,
  });
  const snapshot = walletUiSnapshotFromArtifact(guard.initial.wallet.artifact);
  const server = createProductionWalletUiServer(snapshot, {
    verifyRequest: () => guard.verifyBeforeOpen(),
  });
  guard.verifyBeforeOpen();
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
