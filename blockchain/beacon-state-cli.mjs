#!/usr/bin/env node
import { openBeaconStateStore } from "./beacon-state-store.mjs";

function usage() {
  throw new Error(
    "usage: beacon-state <verify|plan|compact> <vault-path> <beacon-address> <network-id> " +
    "[trusted-observed-now-ms] [safety-margin-ms]",
  );
}

const [command, vaultPath, address, networkId, observedText, marginText] = process.argv.slice(2);
let store;
try {
  if (!["verify", "plan", "compact"].includes(command) || !vaultPath || !address || !networkId) {
    usage();
  }
  const observedNow = observedText === undefined ? undefined : Number(observedText);
  const safetyMarginMs = marginText === undefined ? 300_000 : Number(marginText);
  if (command !== "verify" && (!Number.isSafeInteger(observedNow) || observedNow < 0)) usage();
  store = openBeaconStateStore({ address, networkId, vaultPath });
  let result;
  if (command === "verify") {
    if (observedText !== undefined || marginText !== undefined) usage();
    result = {
      activeNonces: store.nonces.size,
      chainBytes: store.chainBytes,
      fileBytes: store.fileBytes,
      generation: store.generation,
      highWater: store.highWater,
      issuedShares: store.issued.size,
      maxNonces: store.maxNonces,
      status: "verified",
    };
  } else {
    result = store[command === "plan" ? "planCompaction" : "compact"]({
      observedNow, safetyMarginMs,
    });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`Beacon state ${command ?? "command"} failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  store?.close();
}
