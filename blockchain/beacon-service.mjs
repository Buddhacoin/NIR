#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { createFallbackBeaconShare } from "./operators.mjs";
import { decryptWallet } from "./vault.mjs";

const HASH = /^[0-9a-f]{64}$/;

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

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

const [vaultPath, networkId, portText = "8791", host = "127.0.0.1"] = process.argv.slice(2);
try {
  if (!vaultPath || !networkId || Buffer.byteLength(networkId) > 64) {
    throw new Error("usage: beacon:serve <wallet-vault> <network-id> [port] [host]");
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  const resolvedVaultPath = resolve(vaultPath);
  const statePath = `${resolvedVaultPath}.beacon-state.json`;
  const password = await readSecret("Beacon vault password: ");
  const wallet = decryptWallet(JSON.parse(readFileSync(resolvedVaultPath, "utf8")), password);
  let saved = { address: wallet.address, networkId, shares: {} };
  if (existsSync(statePath)) saved = JSON.parse(readFileSync(statePath, "utf8"));
  if (saved.address !== wallet.address || saved.networkId !== networkId ||
      !saved.shares || typeof saved.shares !== "object" || Array.isArray(saved.shares)) {
    throw new Error("beacon state does not match wallet or network");
  }
  const issued = new Map(Object.entries(saved.shares));
  const persist = () => {
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      address: wallet.address, networkId, shares: Object.fromEntries(issued),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, statePath);
    chmodSync(statePath, 0o600);
  };
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { address: wallet.address, algorithm: wallet.algorithm, networkId, status: "ready" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/share") {
      json(response, 404, { error: "not found" }); return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > 8_192) request.destroy();
    });
    request.on("end", () => {
      try {
        const { candidateId, round } = JSON.parse(raw);
        if (!HASH.test(candidateId ?? "") || !Number.isSafeInteger(round) || round < 1) {
          throw new Error("candidateId or round is invalid");
        }
        const key = `${candidateId}:${round}`;
        let share = issued.get(key);
        if (!share) {
          share = createFallbackBeaconShare({
            wallet, networkId, candidateId, round, value: randomBytes(32).toString("hex"),
          });
          issued.set(key, share);
          persist();
        }
        json(response, 200, share);
      } catch (error) {
        json(response, 400, { error: error.message });
      }
    });
  });
  server.listen(port, host, () => {
    console.log(`NIR beacon ${wallet.address} listening on http://${host}:${port}`);
  });
} catch (error) {
  console.error(`Beacon service failed: ${error.message}`);
  process.exitCode = 1;
}
