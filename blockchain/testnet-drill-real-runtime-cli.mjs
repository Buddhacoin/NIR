#!/usr/bin/env node
import { canonicalJson } from "./crypto.mjs";
import { runRealValidatorRecoveryRehearsal } from "./testnet-drill-real-runtime.mjs";

try {
  if (process.argv.length !== 2) throw new Error("usage: testnet-drill-real-runtime");
  process.stdout.write(`${canonicalJson(await runRealValidatorRecoveryRehearsal())}\n`);
} catch (error) {
  const cleanup = error.cleanupReport ? ` cleanup=${JSON.stringify(error.cleanupReport)}` : "";
  const runtime = error.code === "ERR_RUNTIME_UNAVAILABLE"
    ? ` inventory=${JSON.stringify(error.runtimeInventory)}` : "";
  process.stderr.write(`real validator recovery rehearsal failed:${error.code ?? "ERR_REHEARSAL"}${runtime}${cleanup}\n`);
  process.exitCode = 1;
}
