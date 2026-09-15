#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exportBlockStoreBackup, loadBlockStore } from "./block-store.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "./node-store.mjs";

const [command, directory, parameter = "", host = "127.0.0.1"] = process.argv.slice(2);
try {
  if (command === "init-dev" && directory) {
    console.log(JSON.stringify(initializeDevnet(directory), null, 2));
  } else if (command === "serve" && directory) {
    const port = Number(parameter || 8787);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    const node = new PersistentDevNode(directory);
    const server = createNodeHttpServer(node);
    server.listen(port, host, () => {
      console.log(`NIR ${node.networkId} node listening on http://${host}:${port} at height ${node.height}`);
    });
  } else if (command === "backup" && directory && parameter) {
    const genesis = JSON.parse(readFileSync(join(directory, "genesis.json"), "utf8"));
    console.log(JSON.stringify(exportBlockStoreBackup(directory, parameter, genesis), null, 2));
  } else if (command === "verify-backup" && directory) {
    const genesis = JSON.parse(readFileSync(join(directory, "genesis.json"), "utf8"));
    const { chain, recoveredCopies } = loadBlockStore(directory, genesis);
    console.log(JSON.stringify({
      directory,
      height: chain.height,
      networkId: chain.networkId,
      recoveredCopies,
      tipHash: chain.tipHash,
    }, null, 2));
  } else {
    throw new Error("usage: node:init-dev <new-directory> | node:serve <directory> [port] [host] | node:backup <directory> <new-backup-directory> | node:verify-backup <backup-directory>");
  }
} catch (error) {
  console.error(`Node operation failed: ${error.message}`);
  process.exitCode = 1;
}
