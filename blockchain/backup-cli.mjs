#!/usr/bin/env node
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import {
  createBackupHttpServer,
  MAX_BACKUP_RECEIPT_BYTES,
  runRemoteBackupRestoreDrill,
} from "./backup-recovery.mjs";
import { listenOnLoopback, validateLoopbackListener } from "./loopback-listener.mjs";
import { signWalletBackupReceipt } from "./wallet-files.mjs";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function readJson(path, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error(`${path} is not a bounded regular file`);
    }
    const contents = readFileSync(descriptor);
    if (contents.length !== metadata.size) throw new Error(`${path} changed while it was read`);
    return JSON.parse(contents.toString("utf8"));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExclusive(path, value) {
  const target = resolve(path);
  const descriptor = openSync(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
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

const [command, ...parameters] = process.argv.slice(2);
try {
  if (command === "receipt" && parameters.length === 6) {
    const [backupDirectory, genesisPath, vaultPath, operatorId, sourceId, outputPath] = parameters;
    const genesis = readJson(genesisPath, MAX_CONFIG_BYTES);
    const password = await readSecret("Backup operator wallet password: ");
    const receipt = signWalletBackupReceipt({
      path: vaultPath, password, directory: backupDirectory, genesis,
      options: { operatorId, sourceId },
    });
    console.log(JSON.stringify({
      checkpointHash: receipt.payload.checkpointHash,
      inventoryRoot: receipt.payload.inventoryRoot,
      path: writeExclusive(outputPath, receipt),
      receiptHash: receipt.payload.receiptHash,
    }, null, 2));
  } else if (command === "serve" && parameters.length >= 2 && parameters.length <= 4) {
    const [backupDirectory, receiptPath, portText = "8791", host = "127.0.0.1"] = parameters;
    const port = Number(portText);
    validateLoopbackListener({ host, label: "backup service", port });
    const receipt = readJson(receiptPath, MAX_BACKUP_RECEIPT_BYTES);
    const server = createBackupHttpServer(backupDirectory, receipt);
    await listenOnLoopback(server, { host, label: "backup service listener", port });
    console.log(`NIR backup service listening on http://${host}:${port}`);
  } else if (command === "drill-remote" && parameters.length >= 5) {
    const [workspaceParent, operatorsPath, genesisPath, ...sources] = parameters;
    const result = await runRemoteBackupRestoreDrill(
      workspaceParent,
      sources,
      readJson(genesisPath, MAX_CONFIG_BYTES),
      {
        allowInsecureLocalhost: true,
        trustedOperators: readJson(operatorsPath, MAX_CONFIG_BYTES),
      },
    );
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error("usage: backup:receipt <backup-directory> <genesis.json> <operator-vault> <operator-id> <source-url> <new-receipt.json> | backup:serve <backup-directory> <receipt.json> [port] [loopback-host] | backup:drill-remote <workspace-parent> <trusted-operators.json> <genesis.json> <source-a> <source-b> [...]");
  }
} catch (error) {
  console.error(`Backup operation failed: ${error.message}`);
  process.exitCode = 1;
}
