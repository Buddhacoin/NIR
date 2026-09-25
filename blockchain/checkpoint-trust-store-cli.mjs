#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

import {
  acceptCheckpointTrustPackage, activateCheckpointWitnessPolicyTransition,
  createCheckpointTrustStore, loadCheckpointTrustStore,
  scheduleCheckpointWitnessPolicyTransition,
} from "./checkpoint-trust-store.mjs";
import {
  MAX_CHECKPOINT_TRUST_PACKAGE_BYTES,
} from "./checkpoint-trust-package.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";

function usage() {
  throw new Error(
    "usage: checkpoint-trust-store init <store> <package> <network> <genesis-hash> <policy-id> " +
    "[minimum-sequence] [minimum-height] | accept <store> <package> | " +
    "rotate-schedule <store> <transition> <old-policy> <new-policy> | " +
    "rotate-activate <store> <transition> <activation-package> <old-policy> <new-policy> | " +
    "show <store>",
  );
}

function readPackage(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_CHECKPOINT_TRUST_PACKAGE_BYTES) {
      throw new Error("checkpoint trust package bytes are outside the bounded limit");
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        bytes.length !== before.size) {
      throw new Error("checkpoint trust package changed during read");
    }
  } finally { closeSync(descriptor); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error("checkpoint trust package is not canonical JSON");
  const value = parseConsensusJson(text.slice(0, -1));
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error("checkpoint trust package is not canonical JSON");
  }
  return value;
}

function integer(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) usage();
  return parsed;
}

const args = process.argv.slice(2);
const command = args.shift();
try {
  let value;
  if (command === "init") {
    if (args.length < 5 || args.length > 7) usage();
    const [path, packagePath, expectedNetworkId, expectedChainIdentityGenesisHash,
      expectedPolicyId, sequenceText, heightText] = args;
    value = createCheckpointTrustStore(path, readPackage(packagePath), {
      expectedChainIdentityGenesisHash, expectedNetworkId, expectedPolicyId,
      minimumCheckpointHeight: integer(heightText, 1), minimumSequence: integer(sequenceText, 0),
    });
  } else if (command === "accept") {
    if (args.length !== 2) usage();
    value = acceptCheckpointTrustPackage(args[0], readPackage(args[1]));
  } else if (command === "rotate-schedule") {
    if (args.length !== 4) usage();
    value = scheduleCheckpointWitnessPolicyTransition(args[0], readPackage(args[1]), {
      oldPolicy: readPackage(args[2]), newPolicy: readPackage(args[3]),
    });
  } else if (command === "rotate-activate") {
    if (args.length !== 5) usage();
    value = activateCheckpointWitnessPolicyTransition(args[0], readPackage(args[1]),
      readPackage(args[2]), { oldPolicy: readPackage(args[3]), newPolicy: readPackage(args[4]) });
  } else if (command === "show") {
    if (args.length !== 1) usage();
    value = loadCheckpointTrustStore(args[0]);
  } else usage();
  process.stdout.write(`${JSON.stringify(value.record)}\n`);
} catch (error) {
  process.stderr.write(`Checkpoint trust store ${command ?? "command"} failed: ${error.message}\n`);
  process.exitCode = 1;
}
