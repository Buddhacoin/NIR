#!/usr/bin/env node
import process from "node:process";

import { runFormalConsensusSuite } from "./consensus-model.mjs";

try {
  const report = runFormalConsensusSuite();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    error: error.message,
    format: "nir-bounded-consensus-model-error-v2",
    ok: false,
  }));
  process.exitCode = 2;
}
