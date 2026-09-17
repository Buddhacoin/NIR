#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";

import {
  exportWatchOnly, parseCanonicalOfflineSigningPackage, readOfflineSigningPackage,
  readPrivateOfflineVault, signOfflinePackage, writePrivateCanonicalFile,
} from "./offline-signer.mjs";

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const done = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write("\n"); error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return done(new Error("cancelled"));
        if (character === "\r" || character === "\n") return done();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

function hardenProcess() {
  process.umask(0o077);
  if (process.execArgv.some((argument) => /^--inspect(?:-brk)?(?:=|$)/.test(argument))) {
    throw new Error("offline signer refuses to run with an inspector enabled");
  }
  // Node cannot portably disable OS core dumps. Avoid diagnostic reports retaining decrypted memory.
  if (process.report) process.report.reportOnFatalError = false;
}

function parseCheckpoint(path) {
  const text = readFileSync(path, "utf8");
  try { return JSON.parse(text); } catch { throw new Error("checkpoint is not valid JSON"); }
}

function packageFrom(source) {
  return source === "-"
    ? parseCanonicalOfflineSigningPackage(readFileSync(0, "utf8")).package
    : readOfflineSigningPackage(source).package;
}

const [command, ...args] = process.argv.slice(2);
try {
  hardenProcess();
  if (command === "verify" && args.length === 1) {
    const verified = packageFrom(args[0]);
    console.log(JSON.stringify({ checkpoint: verified.checkpoint, networkId: verified.networkId,
      simulationCommitment: verified.simulationCommitment, verified: true }, null, 2));
  } else if (command === "sign" && args.length === 3) {
    const [vaultPath, source, output] = args;
    const signingPackage = packageFrom(source);
    let password = await readSecret("Vault password: ");
    try {
      const signed = signOfflinePackage({ vault: readPrivateOfflineVault(vaultPath), password, signingPackage });
      writePrivateCanonicalFile(output, signed);
      console.log(JSON.stringify({ broadcast: false, output, type: signed.transaction.type, verified: true }, null, 2));
    } finally { password = ""; }
  } else if (command === "watch-export" && args.length === 3) {
    const [vaultPath, checkpointPath, output] = args;
    const watchOnly = exportWatchOnly({ vaultPath, checkpoint: parseCheckpoint(checkpointPath) });
    writePrivateCanonicalFile(output, watchOnly);
    console.log(JSON.stringify({ address: watchOnly.address, output, verified: true }, null, 2));
  } else {
    throw new Error("usage: offline:verify <package-file|-> | offline:sign <vault> <package-file|-> <new-signed-file> | offline:watch-export <vault> <checkpoint-file> <new-watch-file>");
  }
} catch (error) {
  console.error(`Offline signer failed: ${error.message}`);
  process.exitCode = 1;
}
