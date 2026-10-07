#!/usr/bin/env node
import process from "node:process";

import { listenOnLoopback } from "./loopback-listener.mjs";
import { createValidatorTransactionIngressServer }
  from "./validator-transaction-ingress.mjs";

const [upstreamOrigin, tlsCertificateSha256, expectedNetworkId, portText, host = "127.0.0.1",
  walletOrigin = null] =
  process.argv.slice(2);

try {
  if (process.argv.length < 6 || process.argv.length > 8) {
    throw new Error("usage: network:transaction-ingress <loopback-https-validator-origin> <tls-sha256-pin> <network-id> <listen-port> [127.0.0.1|::1] [exact-wallet-origin]");
  }
  const port = Number(portText);
  const server = createValidatorTransactionIngressServer({
    expectedNetworkId, tlsCertificateSha256, upstreamOrigin, walletOrigin,
  });
  await listenOnLoopback(server, { host, label: "validator transaction ingress", port });
  const shutdown = () => server.gracefulShutdown().then(() => process.exit(0), () => process.exit(1));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`NIR transaction ingress listening on http://${host}:${port}`);
} catch (error) {
  console.error(`Transaction ingress failed: ${error.message}`);
  process.exitCode = 1;
}
