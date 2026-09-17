#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import process from "node:process";

import {
  backupAutomationDryRun,
  backupAutomationHealth,
  readBackupAutomationConfig,
  runBackupAutomationCycle,
  runBackupAutomationScheduler,
} from "./backup-automation.mjs";
import { decryptWallet } from "./vault.mjs";

const MAX_VAULT_BYTES = 2 * 1024 * 1024;

function readVault(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_VAULT_BYTES) {
    throw new Error("automation signer vault is invalid");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function readSecret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
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
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function withWallet(vaultPath, operation) {
  const password = await readSecret("Backup automation signer password: ");
  const wallet = decryptWallet(readVault(vaultPath), password);
  try { return await operation(wallet); }
  finally { wallet.privateKey = ""; }
}

const [command, configPath, parameter = "", extra = ""] = process.argv.slice(2);
try {
  if (!configPath) throw new Error("configuration path is required");
  const config = readBackupAutomationConfig(configPath);
  if (command === "dry-run" && !parameter) {
    console.log(JSON.stringify(backupAutomationDryRun(config), null, 2));
  } else if (command === "health") {
    const minimumSequence = parameter ? Number(parameter) : 0;
    const status = backupAutomationHealth(config, {
      expectedHeadHash: extra || null, minimumSequence,
    });
    console.log(JSON.stringify(status, null, 2));
    if (!status.healthy) process.exitCode = 2;
  } else if (command === "run" && parameter && !extra) {
    const record = await withWallet(parameter, (wallet) =>
      runBackupAutomationCycle(config, wallet));
    console.log(JSON.stringify(record.payload, null, 2));
    if (record.payload.status !== "success") process.exitCode = 2;
  } else if (command === "daemon" && parameter && !extra) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await withWallet(parameter, (wallet) =>
      runBackupAutomationScheduler(config, wallet, { signal: controller.signal }));
  } else {
    throw new Error("usage: backup:auto-dry-run <config.json> | backup:auto-health <config.json> [minimum-sequence] [expected-head-hash] | backup:auto-run <config.json> <signer-vault> | backup:auto-daemon <config.json> <signer-vault>");
  }
} catch (error) {
  console.error(`Backup automation failed: ${error.message}`);
  process.exitCode = 1;
}
