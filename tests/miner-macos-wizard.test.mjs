import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  adapterCheckCommand,
  parseRoleChoice,
  roleMenuLines,
  runMacMinerWizard,
} from "../blockchain/miner-macos-wizard.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-mac-wizard-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "nir-protocol", private: true }));
  mkdirSync(join(root, "blockchain"));
  mkdirSync(join(root, "wallet-ui"));
  mkdirSync(join(root, "nir"));
  for (const path of ["demo.mjs", "node-cli.mjs", "wallet-cli.mjs"]) {
    writeFileSync(join(root, "blockchain", path), "");
  }
  writeFileSync(join(root, "wallet-ui", "index.html"), "");
  writeFileSync(join(root, "nir", "application_adapter.py"), "");
  writeFileSync(join(root, "nir", "adapter_check.py"), "");
  return root;
}

function scriptedWizard(answers, overrides = {}) {
  const output = [];
  let index = 0;
  return runMacMinerWizard({
    root: fixture(),
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "26.0.0",
    ask: async () => answers[index++] ?? "",
    write: (line) => output.push(line),
    ...overrides,
  }).then((result) => ({ output, result }));
}

test("menu exposes every role and clearly marks planned-only roles", () => {
  const lines = roleMenuLines();
  assert.equal(lines.length, 7);
  assert.ok(lines.some((line) => /Capability author.*local demo available/.test(line)));
  assert.ok(lines.some((line) => /Safety evaluator.*planned only/.test(line)));
  assert.equal(parseRoleChoice("1"), "capability-author");
  assert.equal(parseRoleChoice("payment-node"), "payment-node");
  assert.equal(parseRoleChoice("GPU miner"), null);
});

test("available role prints one real next command without executing it", async () => {
  const { output, result } = await scriptedWizard(["1"]);
  assert.equal(result.ready, true);
  assert.equal(result.nextCommand, "npm run mine:demo");
  assert.equal(output.filter((line) => line === "npm run mine:demo").length, 1);
  assert.ok(output.includes("The wizard did not run this command."));
});

test("planned-only role prints no runnable command", async () => {
  const { output, result } = await scriptedWizard(["4"]);
  assert.equal(result.ready, false);
  assert.equal(result.nextCommand, null);
  assert.ok(output.some((line) => /No runnable next command/.test(line)));
  assert.equal(output.some((line) => /^npm run /.test(line)), false);
});

test("environment failure suppresses the next command", async () => {
  const { output, result } = await scriptedWizard(["1"], { nodeVersion: "22.0.0" });
  assert.equal(result.ready, false);
  assert.equal(result.nextCommand, null);
  assert.equal(output.some((line) => line === "npm run mine:demo"), false);
});

test("invalid input retries deterministically and stops after the limit", async () => {
  const recovered = await scriptedWizard(["wrong", "payment-node"]);
  assert.equal(recovered.result.ready, true);
  assert.equal(recovered.result.nextCommand, "npm run node:init-dev -- .nir-local-node");

  const stopped = await scriptedWizard(["x", "y", "z"]);
  assert.equal(stopped.result.ready, false);
  assert.equal(stopped.result.reason, "invalid-role");
  assert.equal(stopped.result.nextCommand, null);
});

test("developer adapter path prints an exact quoted command but runs nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-adapter-executable-"));
  const executable = join(directory, "adapter's tool");
  const marker = join(directory, "wizard-ran-adapter");
  writeFileSync(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(executable, 0o700);
  const { output, result } = await scriptedWizard(["8", executable]);
  assert.equal(result.ready, true);
  assert.equal(result.reason, "adapter-check");
  assert.equal(result.nextCommand, adapterCheckCommand(executable));
  assert.match(result.nextCommand, /mine:adapter-check -- --/);
  assert.ok(output.includes("The wizard did not run this command."));
  assert.equal(existsSync(marker), false);
});

test("adapter path must be absolute, executable, and not a link", async () => {
  const { output, result } = await scriptedWizard(["adapter-check", "relative-adapter"]);
  assert.equal(result.ready, false);
  assert.equal(result.nextCommand, null);
  assert.ok(output.some((line) => /must be absolute/.test(line)));
});
