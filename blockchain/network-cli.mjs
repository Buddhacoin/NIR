#!/usr/bin/env node
import process from "node:process";

import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "./distributed-node.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { createValidatorHttpServer } from "./validator-service.mjs";

const [command, directory, parameter = "", portText = ""] = process.argv.slice(2);

function validPort(text, fallback) {
  const port = Number(text || fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return port;
}

try {
  if (command === "init-dev" && directory) {
    console.log(JSON.stringify(initializeDistributedDevnet(directory), null, 2));
  } else if (command === "serve-validator" && directory) {
    const port = validPort(parameter, 8791);
    const validator = new ValidatorReplica(directory);
    createValidatorHttpServer(validator).listen(port, "127.0.0.1", () => {
      console.log(`NIR validator ${validator.address} listening on http://127.0.0.1:${port}`);
    });
  } else if (command === "serve-coordinator" && directory && parameter) {
    const peers = parameter.split(",").filter(Boolean);
    const port = validPort(portText, 8787);
    const node = new DistributedCoordinator(directory, peers);
    createNodeHttpServer(node).listen(port, "127.0.0.1", () => {
      console.log(`NIR distributed coordinator listening on http://127.0.0.1:${port}`);
    });
  } else {
    throw new Error("usage: init-dev <new-dir> | serve-validator <dir> [port] | serve-coordinator <dir> <peer-urls> [port]");
  }
} catch (error) {
  console.error(`Network operation failed: ${error.message}`);
  process.exitCode = 1;
}
