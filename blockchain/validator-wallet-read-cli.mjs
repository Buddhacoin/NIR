#!/usr/bin/env node
import { isAbsolute, join } from "node:path";
import process from "node:process";

import { CERTIFICATE_MODE_LIFECYCLE } from "./certificate-runtime.mjs";
import { DistributedCoordinator } from "./distributed-node.mjs";
import { listenOnLoopback } from "./loopback-listener.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
import { exactWalletReadOrigin, verifyCeremonyWalletReadEvidence }
  from "./validator-wallet-read.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 8) {
    throw new Error("usage: network:wallet-read <absolute-registry-dir> <absolute-ceremony-anchor.json> <trusted-release-signer-address> <pinned-genesis-hash> <absolute-coordinator-dir> <absolute-certificate-head-anchor.json> <exact-wallet-origin> <listen-port>");
  }
  const [registryDirectory, ceremonyAnchorPath, trustedReleaseSignerAddress,
    expectedGenesisHash, coordinatorDirectory, certificateHeadAnchorPath,
    walletOriginText, portText] = args;
  if (![registryDirectory, ceremonyAnchorPath, coordinatorDirectory,
    certificateHeadAnchorPath].every((path) => isAbsolute(path) && !path.includes("\0"))) {
    throw new Error("wallet read paths must be absolute");
  }
  const walletReadOrigin = exactWalletReadOrigin(walletOriginText);
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || String(port) !== portText) {
    throw new Error("wallet read listener port is invalid");
  }
  const { genesis, peerUrls } = verifyCeremonyWalletReadEvidence({
    anchor: readBoundedPublicJsonFile(ceremonyAnchorPath, {
      label: "external ceremony anchor", maximumBytes: 1024 * 1024,
    }), expectedGenesisHash,
    localGenesis: readBoundedPublicJsonFile(join(coordinatorDirectory, "genesis.json"), {
      label: "coordinator genesis", maximumBytes: 2 * 1024 * 1024,
    }), registryDirectory, trustedReleaseSignerAddress,
  });
  const coordinator = new DistributedCoordinator(coordinatorDirectory, peerUrls, {
    certificateMode: CERTIFICATE_MODE_LIFECYCLE,
    certificateHeadAnchorPath,
  });
  if (coordinator.networkId !== genesis.networkId ||
      coordinator.genesisHash !== expectedGenesisHash) {
    throw new Error("wallet read coordinator state differs from ceremony genesis");
  }
  await coordinator.verifyReadPeers();
  const server = createNodeHttpServer(coordinator, {
    rpcProfile: "public", walletReadOrigin,
  });
  await listenOnLoopback(server, { host: "127.0.0.1", label: "wallet read listener", port });
  const shutdown = () => server.gracefulShutdown().then(() => process.exit(0), () => process.exit(1));
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  console.log(`NIR wallet read HTTP surface listening on http://127.0.0.1:${port}`);
} catch (error) {
  console.error(`Wallet read launch failed: ${error.message}`);
  process.exitCode = 1;
}
