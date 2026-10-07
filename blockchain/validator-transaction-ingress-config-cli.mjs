#!/usr/bin/env node
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
import { assertPrivateTransactionIngressConfigParent, readTransactionIngressOperatorConfig,
  validateTransactionIngressOperatorConfig }
  from "./validator-transaction-ingress-operator-config.mjs";

try {
  const [action, source, target] = process.argv.slice(2);
  if (action === "check" && source && target === undefined &&
      process.argv.length === 4) {
    readTransactionIngressOperatorConfig(source);
    console.log("NIR transaction ingress operator config is exact, canonical and protected");
  } else if (action === "prepare" && source && target &&
      process.argv.length === 5) {
    if (!isAbsolute(source) || !isAbsolute(target) ||
        source.includes("\0") || target.includes("\0") ||
        resolve(source) === resolve(target)) {
      throw new Error("config draft and output must be different absolute paths");
    }
    const draft = readBoundedPublicJsonFile(source, {
      label: "transaction ingress config draft", maximumBytes: 16 * 1024,
    });
    const validated = validateTransactionIngressOperatorConfig(draft);
    if (!Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW) {
      throw new Error("secure config output is unavailable");
    }
    assertPrivateTransactionIngressConfigParent(target);
    const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, `${canonicalJson(validated)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    assertPrivateTransactionIngressConfigParent(target);
    const parent = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY |
      constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    readTransactionIngressOperatorConfig(target);
    console.log("NIR transaction ingress operator config prepared; review pins before initialization");
  } else {
    throw new Error("usage: network:transaction-ingress-config prepare <absolute-draft.json> <new-absolute-config.json> | check <absolute-config.json>");
  }
} catch (error) {
  console.error(`Transaction ingress config failed: ${error.message}`);
  process.exitCode = 1;
}
