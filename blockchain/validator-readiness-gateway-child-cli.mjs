#!/usr/bin/env node
import process from "node:process";

import { runValidatorReadinessGatewayChildProcess }
  from "./validator-readiness-gateway-child-runtime.mjs";

if (process.argv.length !== 2) {
  process.exit(2);
} else {
  let exitCode = 0;
  try { await runValidatorReadinessGatewayChildProcess(); }
  catch { exitCode = 1; }
  process.exit(exitCode);
}
