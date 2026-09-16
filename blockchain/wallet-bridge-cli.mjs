#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import process from "node:process";

import { createWalletBridgeServer } from "./wallet-bridge.mjs";
import { walletPublicInfo } from "./wallet-files.mjs";

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("wallet bridge confirmation requires an interactive terminal")); return;
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

const [vaultPath, portText = "8788", origin = "http://127.0.0.1:8765"] = process.argv.slice(2);
try {
  const port = Number(portText);
  if (!vaultPath || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("usage: wallet:bridge <vault> [port] [exact-browser-origin]");
  }
  const wallet = walletPublicInfo(vaultPath);
  const sessionToken = randomBytes(32).toString("hex");
  const server = createWalletBridgeServer({
    origin,
    sessionToken,
    vaultPath,
    authorize: async (intent) => {
      console.error("\nNIR signing request");
      console.error(`Network: ${intent.networkId}`);
      console.error(`Recipient: ${intent.recipient}`);
      console.error(`Amount: ${intent.amount} atomic units`);
      console.error(`Fee: ${intent.fee ?? "consensus default"}`);
      console.error(`Nonce: ${intent.nonce}`);
      console.error(`Request: ${intent.requestId}`);
      const confirmation = await readSecret("Type SIGN to approve: ");
      if (confirmation !== "SIGN") return null;
      return readSecret("Wallet password: ");
    },
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`NIR wallet bridge for ${wallet.address}`);
    console.log(`Listening only on http://127.0.0.1:${port}`);
    console.log(`Allowed origin: ${origin}`);
    console.log(`Session token: ${sessionToken}`);
    console.log("Keep this terminal open. Every signature still requires confirmation and password.");
  });
} catch (error) {
  console.error(`Wallet bridge failed: ${error.message}`);
  process.exitCode = 1;
}
