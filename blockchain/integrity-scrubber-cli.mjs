#!/usr/bin/env node
import process from "node:process";

import {
  integrityScrubDryRun,
  integrityScrubberHealth,
  readIntegrityScrubberConfig,
  repairIntegrityFromRemote,
  repairLocalIntegrityCopies,
  runIntegrityScrubScheduler,
  runIntegrityScrubStep,
} from "./integrity-scrubber.mjs";

const [command, configPath, ...extra] = process.argv.slice(2);
try {
  if (!configPath || extra.length > 0) throw new Error("configuration path is required");
  const config = readIntegrityScrubberConfig(configPath);
  let result;
  if (command === "dry-run") result = integrityScrubDryRun(config);
  else if (command === "step") result = runIntegrityScrubStep(config);
  else if (command === "health") {
    result = integrityScrubberHealth(config);
    if (!result.healthy) process.exitCode = 2;
  } else if (command === "repair-local") result = repairLocalIntegrityCopies(config);
  else if (command === "repair-remote") result = await repairIntegrityFromRemote(config);
  else if (command === "daemon") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    result = { runs: await runIntegrityScrubScheduler(config, { signal: controller.signal }) };
  } else {
    throw new Error("usage: integrity:dry-run|integrity:step|integrity:health|integrity:repair-local|integrity:repair-remote|integrity:daemon <config.json>");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Integrity scrubber failed: ${error.message}`);
  process.exitCode = 1;
}
