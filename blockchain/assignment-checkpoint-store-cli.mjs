#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

import {
  MAX_STORED_ASSIGNMENT_VERIFICATION_BYTES, verifyAssignmentWithCheckpointTrustStore,
} from "./assignment-checkpoint-store.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";

function usage() {
  throw new Error("usage: assignment-checkpoint-store verify <store> <canonical-assignment-package>");
}

function readCanonicalRequest(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 4096 || path.includes("\0")) {
    throw new Error("assignment package path is invalid");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_STORED_ASSIGNMENT_VERIFICATION_BYTES) {
      throw new Error("assignment package bytes are outside the bounded limit");
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        bytes.length !== before.size) {
      throw new Error("assignment package changed during read");
    }
  } finally { closeSync(descriptor); }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("assignment package is not canonical UTF-8 JSON"); }
  if (!text.endsWith("\n")) throw new Error("assignment package is not canonical JSON");
  const value = parseConsensusJson(text.slice(0, -1));
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error("assignment package is not canonical JSON");
  }
  return value;
}

try {
  const [command, storePath, requestPath, ...rest] = process.argv.slice(2);
  if (command !== "verify" || !storePath || !requestPath || rest.length !== 0) usage();
  const verified = verifyAssignmentWithCheckpointTrustStore(
    storePath, readCanonicalRequest(requestPath),
  );
  process.stdout.write(`${canonicalJson(verified)}\n`);
} catch (error) {
  process.stderr.write(`Assignment checkpoint verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
