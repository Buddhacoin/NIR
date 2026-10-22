#!/usr/bin/env node
// npm run testnet:init -- <directory>
// npm run testnet:serve -- <directory> [port] [host] [--behind-proxy]
import { initializeSharedTestnet, startSharedTestnet } from "./shared-testnet.mjs";

const [command, directory, ...rest] = process.argv.slice(2);
const usage = "usage: testnet:init <directory> | testnet:serve <directory> [port] [host] [--behind-proxy]";
try {
  if (!directory) throw new Error(usage);
  if (command === "init") {
    const created = initializeSharedTestnet(directory);
    // The genesis hash is what NIR Wallet and NIR Майнер pin for this network.
    console.log(JSON.stringify({ directory: created.directory, genesisHash: created.genesisHash,
      networkId: created.networkId, protocolVersion: created.protocolVersion }, null, 2));
  } else if (command === "serve") {
    const trustProxy = rest.includes("--behind-proxy");
    const [portText = "8787", host = "127.0.0.1"] = rest.filter((value) => value !== "--behind-proxy");
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(usage);
    const { node } = await startSharedTestnet({ directory, host, port, trustProxy });
    console.log(`NIR shared test network ${node.networkId} at block ${node.height}, http://${host}:${port}`);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
