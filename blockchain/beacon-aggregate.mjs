#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

import { createFallbackBeacon } from "./operators.mjs";

const [networkId, candidateId, roundText, ...paths] = process.argv.slice(2);
try {
  const round = Number(roundText);
  if (!networkId || !candidateId || !Number.isSafeInteger(round) || paths.length < 3) {
    throw new Error("usage: beacon:aggregate <network-id> <candidate-id> <round> <share.json>...");
  }
  const shares = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  if (shares.some((share) => share.networkId !== networkId || share.candidateId !== candidateId || share.round !== round)) {
    throw new Error("share context does not match the requested beacon");
  }
  console.log(JSON.stringify(createFallbackBeacon({ shares, networkId, candidateId, round }), null, 2));
} catch (error) {
  console.error(`Beacon aggregation failed: ${error.message}`);
  process.exitCode = 1;
}
