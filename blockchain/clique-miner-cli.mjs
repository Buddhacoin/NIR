#!/usr/bin/env node
// Mines network clique tasks through a NIR node (docs/proof-mining.md §7.2.3).
// Usage: npm run mine:clique -- --node http://127.0.0.1:8787 --wallet my.wallet
//          [--recipient nir1...] [--once]
import { parseArgs } from "node:util";

import { createMinerNodeClient, mineOneCliqueTask } from "./clique-miner.mjs";
import { signWalletProofAnswer, walletPublicInfo } from "./wallet-files.mjs";

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

async function main() {
  const { values } = parseArgs({ options: {
    node: { type: "string", default: "http://127.0.0.1:8787" },
    wallet: { type: "string" },
    recipient: { type: "string" },
    once: { type: "boolean", default: false },
  } });
  if (!values.wallet) throw new Error("--wallet is required");
  const { address } = walletPublicInfo(values.wallet);
  const password = await readSecret("Wallet password: ");
  const client = createMinerNodeClient(values.node);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`);
  log(`mining for ${values.recipient ?? address} through ${values.node}`);
  do {
    const outcome = await mineOneCliqueTask({ address, client, log, recipient: values.recipient,
      shouldStop: () => stopping,
      sign: (operation) => signWalletProofAnswer({ operation, password, path: values.wallet }) });
    if (outcome.result === "inactive") {
      log("proof mining is not active on this network (protocol version 37 is required)");
      break;
    }
    if (outcome.result !== "revealed") await new Promise((resolve) => setTimeout(resolve, 5_000));
  } while (!values.once && !stopping);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
