#!/usr/bin/env node
import process from "node:process";

import {
  createVerifiedWalletBackup,
  createWalletFile,
  restoreVerifiedWalletBackup,
  signWalletTransfer,
  verifyWalletFile,
  walletPublicInfo,
} from "./wallet-files.mjs";

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
        else if (character >= " ") {
          value += character;
          if (Buffer.byteLength(value) > 1_024) return finish(new Error("secret input is too long"));
        }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "create" && args.length === 1) {
    const password = await readSecret("New wallet password: ");
    const repeated = await readSecret("Repeat wallet password: ");
    if (password !== repeated) throw new Error("passwords do not match");
    console.log(JSON.stringify(createWalletFile({ path: args[0], password }), null, 2));
  } else if (command === "address" && args.length === 1) {
    console.log(JSON.stringify(walletPublicInfo(args[0]), null, 2));
  } else if (command === "verify" && args.length === 1) {
    const password = await readSecret("Wallet password: ");
    console.log(JSON.stringify(verifyWalletFile({ path: args[0], password }), null, 2));
  } else if (command === "backup" && args.length === 4) {
    const password = await readSecret("Wallet password: ");
    const result = createVerifiedWalletBackup({
      sourcePath: args[0], targetPath: args[1], password,
      networkId: args[2], generation: Number(args[3]),
    });
    console.log(JSON.stringify({ ...result, operation: "backup" }, null, 2));
  } else if (command === "restore" && args.length === 5) {
    const password = await readSecret("Wallet password: ");
    const result = restoreVerifiedWalletBackup({
      sourcePath: args[0], targetPath: args[1], password, networkId: args[2],
      expectedAddress: args[3], minimumGeneration: Number(args[4]),
    });
    console.log(JSON.stringify({ ...result, operation: "restore" }, null, 2));
  } else if (command === "sign" && (args.length === 5 || args.length === 6)) {
    const [path, networkId, recipient, amount, nonce, fee] = args;
    console.error(`Recipient: ${recipient}\nAmount (atomic units): ${amount}\nNetwork: ${networkId}`);
    const confirmation = await readSecret("Type SIGN to continue: ");
    if (confirmation !== "SIGN") throw new Error("signing cancelled");
    const password = await readSecret("Wallet password: ");
    console.log(JSON.stringify(signWalletTransfer({
      path, password, networkId, recipient, amount, nonce: Number(nonce), fee,
    }), null, 2));
  } else {
    throw new Error("usage: wallet:create <file> | wallet:address <file> | wallet:verify <file> | wallet:backup <vault> <new-backup-file> <network-id> <generation> | wallet:restore <backup-file> <new-vault-file> <network-id> <expected-address> <minimum-generation> | wallet:sign <file> <network> <recipient> <atomic-amount> <nonce> [atomic-fee]");
  }
} catch (error) {
  console.error(`Wallet operation failed: ${error.message}`);
  process.exitCode = 1;
}
