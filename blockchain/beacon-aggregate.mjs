#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import process from "node:process";

import { aggregateBeaconShares, serializeAggregatedBeacon } from "./beacon-aggregation.mjs";
import { canonicalJson } from "./crypto.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";

const MAX_SHARE_BYTES = 64 * 1024;

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function readShare(path, seenFiles) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure beacon share reads are unavailable");
  }
  const before = lstatSync(path); let descriptor;
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 ||
        before.size > MAX_SHARE_BYTES || (before.mode & 0o022) !== 0) {
      throw new Error("beacon share file is unsafe");
    }
    const identity = `${before.dev}:${before.ino}`;
    if (seenFiles.has(identity)) throw new Error("beacon share file is duplicated");
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !same(opened, before)) {
      throw new Error("beacon share file changed during open");
    }
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (bytes.length !== opened.size || !same(opened, after) || !same(opened, linked) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs) throw new Error("beacon share file changed during read");
    const text = bytes.toString("utf8"); const canonical = text.endsWith("\n") ? text.slice(0, -1) : text;
    const value = parseConsensusJson(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("beacon share file is not canonical JSON");
    seenFiles.add(identity);
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

const args = process.argv.slice(2);
const purpose = ["fallback", "progress"].includes(args[0]) ? args.shift() : "fallback";
const [networkId, candidateId, roundText, ...paths] = args;
try {
  const round = Number(roundText);
  if (!networkId || !candidateId || !Number.isSafeInteger(round) || paths.length < 3 || paths.length > 128) {
    throw new Error("usage: beacon:aggregate [fallback|progress] <network-id> <candidate-id> <round> <share.json>...");
  }
  const seenFiles = new Set(); const shares = paths.map((path) => readShare(path, seenFiles));
  process.stdout.write(serializeAggregatedBeacon(aggregateBeaconShares({
    candidateId, networkId, purpose, round, shares,
  })));
} catch (error) {
  console.error(`Beacon aggregation failed: ${error.message}`);
  process.exitCode = 1;
}
