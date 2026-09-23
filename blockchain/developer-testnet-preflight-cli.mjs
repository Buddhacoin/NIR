#!/usr/bin/env node
import {
  runDeveloperTestnetPreflight, serializeDeveloperTestnetPreflightReport,
} from "./developer-testnet-preflight.mjs";
import { runDeveloperTestnetProductionPreflightFromFiles } from "./developer-testnet-production-preflight-files.mjs";
import { serializeDeveloperTestnetProductionPreflightReport } from "./developer-testnet-production-preflight.mjs";

const args = process.argv.slice(2);
const production = args[0] === "production";
if (!production && args.length !== 1 || production && args.length !== 7 && args.length !== 8) {
  process.stderr.write("usage: developer-testnet-preflight <artifact-root>|production ROOT PLAN INPUT SET STORE NOW [SKEW]\n");
  process.exitCode = 1;
} else {
  try {
    let report;
    if (production) {
      const [, developerRoot, drillPlanPath, attestationInputPath, operatorSetPath,
        attestationStorePath, nowText, skewText = "0"] = args;
      const now = Number(nowText); const maxFutureSkewMs = Number(skewText);
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxFutureSkewMs) ||
          maxFutureSkewMs < 0 || maxFutureSkewMs > 300_000) throw new Error("invalid time policy");
      report = runDeveloperTestnetProductionPreflightFromFiles({ attestationInputPath,
        attestationStorePath, developerRoot, drillPlanPath, maxFutureSkewMs, now, operatorSetPath });
      process.stdout.write(serializeDeveloperTestnetProductionPreflightReport(report));
    } else {
      report = runDeveloperTestnetPreflight(args[0]);
      process.stdout.write(serializeDeveloperTestnetPreflightReport(report));
    }
    if (report.summary.status !== "PASS") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(production ? "Developer production preflight failed safely\n"
      : `Developer testnet preflight failed safely: ${error.message}\n`);
    process.exitCode = 1;
  }
}
