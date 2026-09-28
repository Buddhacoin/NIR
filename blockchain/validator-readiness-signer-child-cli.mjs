#!/usr/bin/env node
import process from "node:process";

import { runValidatorReadinessSignerChildProcess }
  from "./validator-readiness-signer-child-runtime.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1 || !["consensus", "transport"].includes(arguments_[0])) {
  process.exit(2);
} else {
  let exitCode = 0;
  try {
    await runValidatorReadinessSignerChildProcess(arguments_[0]);
  } catch {
    exitCode = 1;
  }
  // Inherited FIFO reads can remain represented by platform-specific libuv handles after every
  // owned descriptor has been destroyed and closed. Runtime cleanup and every bounded status write
  // have completed at this point; do not make process termination depend on natural handle drain.
  process.exit(exitCode);
}
