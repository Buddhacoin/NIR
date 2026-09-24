#!/usr/bin/env node
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { runMacMinerWizard } from "./miner-macos-wizard.mjs";

if (process.argv.length > 2) {
  console.error("usage: npm run mine:wizard");
  process.exitCode = 2;
} else {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await runMacMinerWizard({
      root: process.cwd(),
      ask: (prompt) => terminal.question(prompt),
      write: (line) => console.log(line),
    });
    if (!result.ready) process.exitCode = 2;
  } catch (error) {
    console.error(`Wizard stopped safely: ${error.message}`);
    process.exitCode = 2;
  } finally {
    terminal.close();
  }
}
