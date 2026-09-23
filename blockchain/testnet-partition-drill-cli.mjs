#!/usr/bin/env node
import {
  runTestnetPartitionDrillCommand, serializeTestnetPartitionDrill,
} from "./testnet-partition-drill.mjs";

const [command, root, nowText, maxAgeText, ...extra] = process.argv.slice(2);
try {
  if (!["plan", "verify"].includes(command) || !root || extra.length > 0 ||
      command === "plan" && (nowText !== undefined || maxAgeText !== undefined)) {
    throw new Error("usage: testnet-partition-drill <plan ROOT|verify ROOT NOW_MS [MAX_AGE_MS]>");
  }
  const options = command === "verify" ? {
    maxAgeMs: maxAgeText === undefined ? 86_400_000 : Number(maxAgeText), now: Number(nowText),
  } : {};
  const result = runTestnetPartitionDrillCommand(root, command, options);
  process.stdout.write(serializeTestnetPartitionDrill(result));
  if (command === "verify" && result.status !== "PASS") process.exitCode = 2;
} catch (error) {
  process.stderr.write(`Testnet partition drill failed safely: ${error.message}\n`);
  process.exitCode = 1;
}
