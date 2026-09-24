#!/usr/bin/env node
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { restoreHistoryArchive } from "./archive-sync.mjs";
import {
  createHistoryArchiveHttpServer,
  restoreHistoryArchiveFromSources,
} from "./archive-service.mjs";
import { loadBlockStore } from "./block-store.mjs";
import { listenOnLoopback, validateLoopbackListener } from "./loopback-listener.mjs";
import { signWalletHistoryArchive } from "./wallet-files.mjs";

const MAX_ARCHIVE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;

function readBoundedJson(path, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error(`${path} is not a bounded regular file`);
    }
    const contents = readFileSync(descriptor);
    if (contents.length > maximumBytes) throw new Error(`${path} is too large`);
    return JSON.parse(contents.toString("utf8"));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExclusive(path, value) {
  const target = resolve(path);
  const descriptor = openSync(target, "wx", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return target;
}

function readSecret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n");
      error ? reject(error) : resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

function loadChain(directory) {
  const genesisPath = join(resolve(directory), "genesis.json");
  const genesis = readBoundedJson(genesisPath, MAX_CONFIG_FILE_BYTES);
  return loadBlockStore(directory, genesis).chain;
}

const [command, directory, ...parameters] = process.argv.slice(2);
try {
  if (command === "create" && directory && parameters.length === 2) {
    const [walletPath, outputPath] = parameters;
    const password = await readSecret("Archive operator wallet password: ");
    const chain = loadChain(directory);
    const archive = signWalletHistoryArchive({
      chain, directory, password, path: walletPath,
    });
    const path = writeExclusive(outputPath, archive);
    console.log(JSON.stringify({
      archiveHash: archive.manifest.archiveHash,
      chunks: archive.chunks.length,
      contentRoot: archive.manifest.contentRoot,
      height: archive.manifest.height,
      operator: archive.signer,
      path,
    }, null, 2));
  } else if (command === "restore" && directory && parameters.length >= 3) {
    const [operatorsPath, ...archivePaths] = parameters;
    const trustedOperators = readBoundedJson(operatorsPath, MAX_CONFIG_FILE_BYTES);
    const candidates = archivePaths.map((path) => ({
      archive: readBoundedJson(path, MAX_ARCHIVE_FILE_BYTES),
      source: resolve(path),
    }));
    const result = restoreHistoryArchive(directory, candidates, loadChain(directory), {
      trustedOperators,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "restore-remote" && directory && parameters.length >= 3) {
    const [operatorsPath, ...sources] = parameters;
    const trustedOperators = readBoundedJson(operatorsPath, MAX_CONFIG_FILE_BYTES);
    const result = await restoreHistoryArchiveFromSources(
      directory, sources, loadChain(directory), { trustedOperators },
    );
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "serve" && directory && parameters.length <= 2) {
    const port = Number(parameters[0] || 8790);
    const host = parameters[1] || "127.0.0.1";
    validateLoopbackListener({ host, label: "archive service", port });
    const archive = readBoundedJson(directory, MAX_ARCHIVE_FILE_BYTES);
    const server = createHistoryArchiveHttpServer(archive);
    const shutdown = async () => {
      try { await server.gracefulShutdown(); }
      catch (error) {
        console.error(`Archive shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await listenOnLoopback(server, { host, label: "archive service listener", port });
    console.log(`NIR history archive listening on http://${host}:${port}`);
  } else {
    throw new Error("usage: archive:create <node-directory> <operator-wallet> <new-archive.json> | archive:restore <node-directory> <trusted-operators.json> <archive-a.json> <archive-b.json> [...] | archive:restore-remote <node-directory> <trusted-operators.json> <https-source-a> <https-source-b> [...] | archive:serve <archive.json> [port] [loopback-host]");
  }
} catch (error) {
  console.error(`Archive operation failed: ${error.message}`);
  process.exitCode = 1;
}
