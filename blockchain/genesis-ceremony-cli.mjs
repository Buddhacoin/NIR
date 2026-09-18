#!/usr/bin/env node
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";
import {
  compileGenesis,
  createGenesisApprovalEnvelope,
  createGenesisPlan,
  signGenesisPlan,
  verifyGenesisCeremony,
} from "./genesis-ceremony.mjs";
import { decryptWallet } from "./vault.mjs";

function readJson(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return parseConsensusJson(readFileSync(path, "utf8"));
}

function writeExclusive(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o644);
}

function priorPlans(path) {
  if (path === undefined) return [];
  const value = readJson(path, "prior plans");
  if (!Array.isArray(value)) throw new Error("prior plans file must contain an array");
  return value;
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

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "plan" && args.length === 2) {
    const [inputPath, outputPath] = args;
    const plan = createGenesisPlan(readJson(inputPath, "genesis ceremony input"));
    writeExclusive(outputPath, plan);
    console.log(`Valueless developer testnet plan ${plan.commitment} created.`);
  } else if (command === "sign" && args.length === 3) {
    const [planPath, vaultPath, outputPath] = args;
    const password = await readSecret("Ceremony operator vault password: ");
    const wallet = decryptWallet(readJson(vaultPath, "operator vault"), password);
    try {
      writeExclusive(outputPath, signGenesisPlan(readJson(planPath, "genesis plan"), wallet));
      console.log(`Genesis commitment signed offline by ${wallet.address}.`);
    } finally { wallet.privateKey = ""; }
  } else if (command === "assemble" && args.length === 3) {
    const [planPath, approvalsPath, outputPath] = args;
    const approvals = readJson(approvalsPath, "genesis approvals");
    const envelope = createGenesisApprovalEnvelope(
      readJson(planPath, "genesis plan"), approvals,
    );
    writeExclusive(outputPath, envelope);
    console.log(`Approval envelope for ${envelope.commitment} assembled.`);
  } else if (command === "verify" && (args.length === 2 || args.length === 3)) {
    const [planPath, envelopePath, priorPath] = args;
    const result = verifyGenesisCeremony(
      readJson(planPath, "genesis plan"), readJson(envelopePath, "approval envelope"),
      { priorPlans: priorPlans(priorPath) },
    );
    console.log(`${JSON.stringify(result)}\nValueless developer testnet ceremony verified.`);
  } else if (command === "compile" && (args.length === 3 || args.length === 4)) {
    const [planPath, envelopePath, outputPath, priorPath] = args;
    const result = compileGenesis(
      readJson(planPath, "genesis plan"), readJson(envelopePath, "approval envelope"),
      { priorPlans: priorPlans(priorPath) },
    );
    writeExclusive(outputPath, result.genesis);
    console.log(`Genesis ${result.genesisHash} compiled for valueless developer testnet only.`);
  } else {
    throw new Error("usage: genesis:ceremony <plan input.json plan.json | sign plan.json encrypted-vault.json approval.json | assemble plan.json approvals.json envelope.json | verify plan.json envelope.json [prior-plans.json] | compile plan.json envelope.json genesis.json [prior-plans.json]>");
  }
} catch (error) {
  console.error(`Genesis ceremony failed: ${error.message}`);
  process.exitCode = 1;
}
