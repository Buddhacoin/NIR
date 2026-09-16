#!/usr/bin/env node
import process from "node:process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  exportBlockStoreBackup,
  finalizeBlockPruning,
  installBlockStoreSnapshot,
  loadBlockStore,
  stageBlockPruning,
  verifyStagedBlockPruning,
} from "./block-store.mjs";
import { MAX_SNAPSHOT_BYTES } from "./state-snapshot.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "./node-store.mjs";

const [command, directory, parameter = "", extra = ""] = process.argv.slice(2);

function readBoundedJson(path, maximumBytes = MAX_SNAPSHOT_BYTES) {
  if (statSync(path).size > maximumBytes) throw new Error("input JSON is too large");
  return JSON.parse(readFileSync(path, "utf8"));
}

function recoveryContext(directory, handoffsPath = "") {
  const genesis = readBoundedJson(join(directory, "genesis.json"));
  const handoffs = handoffsPath ? readBoundedJson(handoffsPath) : [];
  if (!Array.isArray(handoffs)) throw new Error("validator handoffs must be a JSON array");
  return { genesis, options: { handoffs, trustedValidators: genesis.validators } };
}
try {
  if (command === "init-dev" && directory) {
    console.log(JSON.stringify(initializeDevnet(directory), null, 2));
  } else if (command === "serve" && directory) {
    const port = Number(parameter || 8787);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    const host = extra || "127.0.0.1";
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
  } else if (command === "snapshot-install" && directory && parameter) {
    const { genesis, options } = recoveryContext(directory, extra);
    const snapshot = readBoundedJson(parameter);
    const result = installBlockStoreSnapshot(directory, genesis, snapshot, options);
    console.log(JSON.stringify({
      directory,
      height: result.chain.height,
      snapshotHash: result.snapshotHash,
      stateRoot: result.stateRoot,
      tipHash: result.chain.tipHash,
    }, null, 2));
  } else if (["prune-stage", "prune-verify", "prune-finalize"].includes(command) && directory) {
    const { genesis, options } = recoveryContext(directory, parameter);
    const operation = command === "prune-stage" ? stageBlockPruning
      : command === "prune-verify" ? verifyStagedBlockPruning : finalizeBlockPruning;
    console.log(JSON.stringify(operation(directory, genesis, options), null, 2));
  } else {
    throw new Error("usage: node:init-dev <new-directory> | node:serve <directory> [port] [host] | node:backup <directory> <new-backup-directory> | node:verify-backup <backup-directory> | snapshot-install <directory> <snapshot.json> [handoffs.json] | prune-stage|prune-verify|prune-finalize <directory> [handoffs.json]");
  }
} catch (error) {
  console.error(`Node operation failed: ${error.message}`);
  process.exitCode = 1;
}
