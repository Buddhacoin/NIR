#!/usr/bin/env node
import process from "node:process";

import { MINER_ROLES, runMacMinerPreflight } from "./miner-macos-preflight.mjs";

function usage() {
  return [
    "usage: node blockchain/miner-macos-preflight-cli.mjs [--mode local-demo|public-testnet]",
    `       [--role ${Object.keys(MINER_ROLES).join("|")}] [--json]`,
  ].join("\n");
}

function parseArguments(arguments_) {
  const result = { mode: "local-demo", role: "capability-author", json: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") result.json = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--mode" && arguments_[index + 1]) result.mode = arguments_[++index];
    else if (argument === "--role" && arguments_[index + 1]) result.role = arguments_[++index];
    else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return result;
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.help) {
    console.log(usage());
  } else {
    const report = runMacMinerPreflight({ root: process.cwd(), ...arguments_ });
    if (arguments_.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`NIR Mac miner preflight: ${report.ready ? "READY" : "NOT READY"}`);
      console.log(`Scope: ${report.scope}`);
      console.log(`Role: ${MINER_ROLES[report.role].label}`);
      for (const item of report.checks) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.message}`);
      for (const warning of report.warnings) console.log(`WARNING ${warning}`);
      if (report.nextCommand) console.log(`Next: ${report.nextCommand}`);
    }
    if (!report.ready) process.exitCode = 2;
  }
} catch (error) {
  console.error(`Preflight failed: ${error.message}`);
  console.error(usage());
  process.exitCode = 2;
}
