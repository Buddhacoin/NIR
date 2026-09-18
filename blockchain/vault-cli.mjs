#!/usr/bin/env node
import process from "node:process";

import { createVaultSet, verifyVaultSet } from "./vault-files.mjs";

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal"));
      return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") {
          value += character;
          if (Buffer.byteLength(value) > 1_024) return finish(new Error("secret input is too long"));
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function collectPasswords(confirm) {
  const passwords = [];
  for (let index = 0; index < 3; index += 1) {
    const password = await readSecret(`Guardian ${index + 1} password: `);
    if (confirm) {
      const repeated = await readSecret(`Repeat guardian ${index + 1} password: `);
      if (password !== repeated) throw new Error(`guardian ${index + 1} passwords do not match`);
    }
    passwords.push(password);
  }
  return passwords;
}

const [command, directory, networkId, generationText] = process.argv.slice(2);
const generation = Number(generationText);
if (!directory || !networkId || !Number.isSafeInteger(generation) || generation < 1 ||
    !["create", "verify"].includes(command)) {
  console.error("Usage: node blockchain/vault-cli.mjs <create|verify> <directory> <network-id> <generation-or-minimum-generation>");
  process.exitCode = 2;
} else {
  try {
    const passwords = await collectPasswords(command === "create");
    const result = command === "create"
      ? createVaultSet({ directory, passwords, networkId, generation })
      : verifyVaultSet({ directory, passwords, networkId, minimumGeneration: generation });
    console.log(`NIR multisignature address: ${result.address}`);
    console.log(command === "create" ? "Vault set created and verified." : "All vault backups verified.");
  } catch (error) {
    console.error(`Vault operation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
