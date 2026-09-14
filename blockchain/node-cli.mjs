#!/usr/bin/env node
import process from "node:process";

import { createNodeHttpServer } from "./node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "./node-store.mjs";

const [command, directory, portText = "8787", host = "127.0.0.1"] = process.argv.slice(2);
try {
  if (command === "init-dev" && directory) {
    console.log(JSON.stringify(initializeDevnet(directory), null, 2));
  } else if (command === "serve" && directory) {
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    const node = new PersistentDevNode(directory);
    const server = createNodeHttpServer(node);
    server.listen(port, host, () => {
      console.log(`NIR ${node.networkId} node listening on http://${host}:${port} at height ${node.height}`);
    });
  } else {
    throw new Error("usage: node:init-dev <new-directory> | node:serve <directory> [port] [host]");
  }
} catch (error) {
  console.error(`Node operation failed: ${error.message}`);
  process.exitCode = 1;
}
