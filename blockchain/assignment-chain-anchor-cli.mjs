#!/usr/bin/env node

import fs from "node:fs";
import { verifyAssignmentChainAnchor } from "./assignment-chain-anchor.mjs";

try {
  const input = fs.readFileSync(0);
  if (input.length === 0 || input.length > 32 * 1024 * 1024) throw new Error("input size");
  const result = verifyAssignmentChainAnchor(JSON.parse(input.toString("utf8")));
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
} catch {
  process.stdout.write('{"ok":false}\n');
  process.exitCode = 1;
}
