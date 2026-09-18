#!/usr/bin/env node
import {
  runDeveloperTestnetPreflight, serializeDeveloperTestnetPreflightReport,
} from "./developer-testnet-preflight.mjs";

const [root, ...extra] = process.argv.slice(2);
if (!root || extra.length > 0) {
  process.stderr.write("usage: developer-testnet-preflight <artifact-root>\n");
  process.exitCode = 1;
} else {
  try {
    const report = runDeveloperTestnetPreflight(root);
    process.stdout.write(serializeDeveloperTestnetPreflightReport(report));
    if (report.summary.status !== "PASS") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Developer testnet preflight failed safely: ${error.message}\n`);
    process.exitCode = 1;
  }
}
