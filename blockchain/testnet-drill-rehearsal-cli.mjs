#!/usr/bin/env node
import { canonicalJson } from "./crypto.mjs";
import { runLocalTestnetPartitionRehearsalFile } from "./testnet-drill-rehearsal.mjs";

try {
  if (process.argv.length !== 3) throw new Error("usage: testnet-drill-rehearsal PREFLIGHT_REPORT_JSON");
  const result = await runLocalTestnetPartitionRehearsalFile(process.argv[2]);
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  const cleanup = error.cleanupReport ? ` cleanup=${JSON.stringify(error.cleanupReport)}` : "";
  process.stderr.write(`testnet drill rehearsal failed:${cleanup}\n`);
  process.exitCode = 1;
}
