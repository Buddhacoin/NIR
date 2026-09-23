#!/usr/bin/env node
import { canonicalJson } from "./crypto.mjs";
import { runRealBeaconArchiveRehearsal } from "./testnet-drill-real-services.mjs";
import { runRealValidatorRecoveryRehearsal } from "./testnet-drill-real-runtime.mjs";

try {
  const [command, releaseCheckpointHash, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || command !== undefined && command !== "services" ||
      command === "services" && releaseCheckpointHash === undefined) {
    throw new Error("usage: testnet-drill-real-runtime [services RELEASE_CHECKPOINT_HASH]");
  }
  const result = command === "services"
    ? await runRealBeaconArchiveRehearsal({ releaseCheckpointHash })
    : await runRealValidatorRecoveryRehearsal();
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  const cleanup = error.cleanupReport ? ` cleanup=${JSON.stringify(error.cleanupReport)}` : "";
  const runtime = error.code === "ERR_RUNTIME_UNAVAILABLE"
    ? ` inventory=${JSON.stringify(error.runtimeInventory)}` : "";
  process.stderr.write(`real validator recovery rehearsal failed:${error.code ?? "ERR_REHEARSAL"}${runtime}${cleanup}\n`);
  process.exitCode = 1;
}
