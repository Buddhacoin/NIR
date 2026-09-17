#!/usr/bin/env node
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
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

const [vaultPath, portText = "8788", origin = "http://127.0.0.1:8765", genesisPath] =
  process.argv.slice(2);
try {
  const port = Number(portText);
  if (!vaultPath || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("usage: wallet:bridge <vault> [port] [exact-browser-origin] [genesis.json]");
  }
  const wallet = walletPublicInfo(vaultPath);
  const genesis = genesisPath ? JSON.parse(readFileSync(genesisPath, "utf8")) : null;
  if (genesis && (typeof genesis.networkId !== "string" ||
      !Array.isArray(genesis.validators) || genesis.validators.length < 4)) {
    throw new Error("account proof genesis trust anchor is invalid");
  }
  const sessionToken = randomBytes(32).toString("hex");
  const pairingCode = randomInt(0, 100_000_000).toString().padStart(8, "0");
  const server = createWalletBridgeServer({
    origin,
    pairingCode,
    sessionToken,
    ...(genesis ? { trustAnchor: {
      expectedNetworkId: genesis.networkId, trustedValidators: genesis.validators,
    } } : {}),
    vaultPath,
    authorize: async (intent) => {
      console.error("\nNIR signing request");
      console.error(`Action: ${intent.type ?? "transfer"}`);
      console.error(`Network: ${intent.networkId}`);
      if (intent.recipient) console.error(`Recipient: ${intent.recipient}`);
      if (intent.delegate) console.error(`Delegate: ${intent.delegate}`);
      if (intent.limit !== undefined) console.error(`Delegated transfers per epoch: ${intent.limit}`);
      if (intent.amount) console.error(`Amount: ${intent.amount} atomic units`);
      if (intent.expiresAt) console.error(`Expires: ${new Date(intent.expiresAt).toISOString()}`);
      if (intent.memo) console.error(`Memo: ${intent.memo}`);
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
    console.log(genesis
      ? `Account proofs pinned to ${genesis.networkId} genesis validators`
      : "Account proof verification disabled: start with an explicit genesis.json path");
    console.log(`One-time pairing code: ${pairingCode} (expires in 2 minutes)`);
    console.log("Keep this terminal open. Every signature still requires confirmation and password.");
  });
} catch (error) {
  console.error(`Wallet bridge failed: ${error.message}`);
  process.exitCode = 1;
}
