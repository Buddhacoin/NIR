#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

import { createFallbackBeacon, createProgressBeacon } from "./operators.mjs";

const args = process.argv.slice(2);
const purpose = ["fallback", "progress"].includes(args[0]) ? args.shift() : "fallback";
const [networkId, candidateId, roundText, ...paths] = args;
try {
  const round = Number(roundText);
  if (!networkId || !candidateId || !Number.isSafeInteger(round) || paths.length < 3) {
    throw new Error("usage: beacon:aggregate [fallback|progress] <network-id> <candidate-id> <round> <share.json>...");
  }
  const shares = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const generation = shares[0]?.generation;
  if (!Number.isSafeInteger(generation) || generation < 0 ||
      shares.some((share) => share.networkId !== networkId ||
        share.candidateId !== candidateId || share.round !== round ||
        share.generation !== generation)) {
    throw new Error("share context does not match the requested beacon");
  }
  const createBeacon = purpose === "progress" ? createProgressBeacon : createFallbackBeacon;
  console.log(JSON.stringify(createBeacon({ shares, networkId, candidateId, generation, round }), null, 2));
} catch (error) {
  console.error(`Beacon aggregation failed: ${error.message}`);
  process.exitCode = 1;
}
