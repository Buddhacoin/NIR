#!/usr/bin/env node
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { createBeaconHttpServer } from "./beacon-http-service.mjs";
import { openBeaconStateStore } from "./beacon-state-store.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { decryptWallet } from "./vault.mjs";

function readPrivateVault(path) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("beacon vault requires secure no-follow filesystem support");
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > 16 * 1024 * 1024 || (before.mode & 0o777) !== 0o600 ||
        uid !== undefined && before.uid !== uid) throw new Error("beacon vault is unsafe");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("beacon vault changed during read");
    }
    return parseConsensusJson(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n");
      error ? reject(error) : resolve(value);
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

const [vaultPath, networkId, portText = "8791", host = "127.0.0.1"] = process.argv.slice(2);
let stateStore = null;
try {
  if (!vaultPath || !networkId || Buffer.byteLength(networkId) > 64) {
    throw new Error("usage: beacon:serve <wallet-vault> <network-id> [port] [host]");
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("beacon service requires a valid port and loopback host");
  }
  const resolvedVaultPath = resolve(vaultPath);
  const password = await readSecret("Beacon vault password: ");
  const wallet = decryptWallet(readPrivateVault(resolvedVaultPath), password);
  stateStore = openBeaconStateStore({
    address: wallet.address, networkId, vaultPath: resolvedVaultPath,
  });
  const issued = stateStore.issued;
  const persist = (key, share) => stateStore.append(key, share);
  const server = createBeaconHttpServer({ issued, networkId, persist, wallet });
  server.once("close", () => stateStore?.close());
  const shutdown = async () => {
    try { await server.gracefulShutdown(); }
    catch (error) {
      console.error(`Beacon shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, host, () => {
    console.log(`NIR beacon ${wallet.address} listening on http://${host}:${port}`);
  });
} catch (error) {
  stateStore?.close();
  console.error(`Beacon service failed: ${error.message}`);
  process.exitCode = 1;
}
