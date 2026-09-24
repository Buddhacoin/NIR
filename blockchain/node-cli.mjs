#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import {
  exportBlockStoreBackup,
  finalizeBlockPruning,
  installBlockStoreSnapshot,
  loadBlockStore,
  planBlockPruning,
  stageBlockPruning,
  verifyStagedBlockPruning,
} from "./block-store.mjs";
import { MAX_SNAPSHOT_BYTES } from "./state-snapshot.mjs";
import { AccountHistoryIndex } from "./account-history-index.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { initializeDevnet, PersistentDevNode } from "./node-store.mjs";
import { acquireDataDirectoryLock } from "./data-directory-lock.mjs";
import { createProductionStartupGuard } from "./production-startup.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";

const [command, directory, parameter = "", extra = "", ...remaining] = process.argv.slice(2);

function readBoundedJson(path, maximumBytes = MAX_SNAPSHOT_BYTES) {
  return readBoundedPublicJsonFile(path, { label: "node JSON input", maximumBytes });
}

function recoveryContext(directory, handoffsPath = "") {
  const genesis = readBoundedJson(join(directory, "genesis.json"));
  const handoffs = handoffsPath ? readBoundedJson(handoffsPath) : [];
  if (!Array.isArray(handoffs)) throw new Error("validator handoffs must be a JSON array");
  return { genesis, options: { handoffs, trustedValidators: genesis.validators } };
}

function withDirectoryLock(directory, operation) {
  const release = acquireDataDirectoryLock(directory);
  try { return operation(); } finally { release(); }
}
try {
  if (command === "init-dev" && directory) {
    console.log(JSON.stringify(initializeDevnet(directory), null, 2));
  } else if (command === "serve" && directory) {
    const port = Number(parameter || 8787);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    const host = extra || "127.0.0.1";
    const releaseLock = acquireDataDirectoryLock(directory);
    let node;
    let server;
    try {
      node = new PersistentDevNode(directory);
      server = createNodeHttpServer(node);
    } catch (error) {
      releaseLock();
      throw error;
    }
    process.once("exit", releaseLock);
    const shutdown = () => server.close(() => {
      releaseLock();
      process.exit(0);
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    server.listen(port, host, () => {
      console.log(`NIR ${node.networkId} node listening on http://${host}:${port} at height ${node.height}`);
    });
  } else if (command === "serve-production" && directory && parameter && extra &&
      remaining.length === 5) {
    const installationTarget = directory; const headStore = parameter;
    const signedReleasePath = extra;
    const [trustedAddress, runtimeDirectory, portText, host, externalAnchorPath] = remaining;
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !host) {
      throw new Error("invalid production node listener");
    }
    const guard = createProductionStartupGuard({ externalAnchorPath, headStore,
      installationTarget, kind: "node", moduleUrl: import.meta.url, signedReleasePath,
      trustedAddress });
    const releaseLock = acquireDataDirectoryLock(runtimeDirectory); let server;
    try {
      const node = new PersistentDevNode(runtimeDirectory);
      server = createNodeHttpServer(node);
      guard.verifyBeforeOpen();
      process.once("exit", releaseLock);
      const shutdown = () => server.close(() => { releaseLock(); process.exit(0); });
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
      server.listen(port, host, () => {
        console.log(`NIR production package ${guard.initial.packageHash} listening on http://${host}:${port}`);
      });
    } catch (error) {
      if (server?.listening) server.close();
      releaseLock(); throw error;
    }
  } else if (command === "backup" && directory && parameter) {
    const genesis = readBoundedJson(join(directory, "genesis.json"));
    console.log(JSON.stringify(exportBlockStoreBackup(directory, parameter, genesis), null, 2));
  } else if (command === "verify-backup" && directory) {
    const genesis = readBoundedJson(join(directory, "genesis.json"));
    const { chain, recoveredCopies } = loadBlockStore(directory, genesis);
    console.log(JSON.stringify({
      directory,
      height: chain.height,
      networkId: chain.networkId,
      recoveredCopies,
      tipHash: chain.tipHash,
    }, null, 2));
  } else if (command === "snapshot-install" && directory && parameter) {
    const result = withDirectoryLock(directory, () => {
      const { genesis, options } = recoveryContext(directory, extra);
      const snapshot = readBoundedJson(parameter);
      return installBlockStoreSnapshot(directory, genesis, snapshot, options);
    });
    console.log(JSON.stringify({
      directory,
      height: result.chain.height,
      snapshotHash: result.snapshotHash,
      stateRoot: result.stateRoot,
      tipHash: result.chain.tipHash,
    }, null, 2));
  } else if (["prune-plan", "prune-stage", "prune-verify", "prune-finalize"]
    .includes(command) && directory) {
    const result = withDirectoryLock(directory, () => {
      const { genesis, options } = recoveryContext(directory, parameter);
      if (command === "prune-plan") return planBlockPruning(directory, genesis, options);
      const { chain } = loadBlockStore(directory, genesis, options);
      new AccountHistoryIndex(directory, chain);
      const operation = command === "prune-stage" ? stageBlockPruning
        : command === "prune-verify" ? verifyStagedBlockPruning : finalizeBlockPruning;
      return operation(directory, genesis, options);
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error("usage: node:init-dev <new-directory> | node:serve <directory> [port] [host] | node:serve-production <installation> <head-store> <signed-release> <trusted-address> <runtime-directory> <port> <host> <external-anchor> | node:backup <directory> <new-backup-directory> | node:verify-backup <backup-directory> | snapshot-install <directory> <snapshot.json> [handoffs.json] | prune-plan|prune-stage|prune-verify|prune-finalize <directory> [handoffs.json]");
  }
} catch (error) {
  console.error(`Node operation failed: ${error.message}`);
  process.exitCode = 1;
}
