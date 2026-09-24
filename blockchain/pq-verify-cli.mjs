#!/usr/bin/env node

import fs from "node:fs";

import { verifyObject } from "./crypto.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;

try {
  const input = fs.readFileSync(0);
  if (input.length === 0 || input.length > MAX_INPUT_BYTES) throw new Error("input size");
  const value = JSON.parse(input.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== ["domain", "payload", "publicKey", "signature"].sort().join("\0")) {
    throw new Error("input schema");
  }
  const valid = verifyObject(value.payload, value.signature, value.publicKey, value.domain);
  process.stdout.write(JSON.stringify({ valid }) + "\n");
} catch {
  process.stdout.write('{"valid":false}\n');
  process.exitCode = 1;
}
