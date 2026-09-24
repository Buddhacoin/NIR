import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runMacMinerPreflight } from "../blockchain/miner-macos-preflight.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-mac-preflight-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "nir-protocol", private: true }));
  mkdirSync(join(root, "blockchain"));
  mkdirSync(join(root, "wallet-ui"));
  for (const path of ["demo.mjs", "node-cli.mjs", "wallet-cli.mjs"]) {
    writeFileSync(join(root, "blockchain", path), "");
  }
  writeFileSync(join(root, "wallet-ui", "index.html"), "");
  return root;
}

test("passes only the supported local capability-author path", () => {
  const report = runMacMinerPreflight({
    root: fixture(), platform: "darwin", arch: "arm64", nodeVersion: "26.0.0",
  });
  assert.equal(report.ready, true);
  assert.equal(report.scope, "local-valueless-demo-only");
  assert.equal(report.nextCommand, "npm run mine:demo");
});

test("payment-node next step is copyable and does not contain a fake absolute path", () => {
  const report = runMacMinerPreflight({
    root: fixture(), role: "payment-node", platform: "darwin", arch: "arm64",
    nodeVersion: "26.0.0",
  });
  assert.equal(report.ready, true);
  assert.equal(report.nextCommand, "npm run node:init-dev -- .nir-local-node");
  assert.doesNotMatch(report.nextCommand, /\/absolute\/path/);
});

test("fails closed for a claimed public testnet", () => {
  const report = runMacMinerPreflight({
    root: fixture(), mode: "public-testnet", platform: "darwin", arch: "arm64",
    nodeVersion: "26.0.0",
  });
  assert.equal(report.ready, false);
  assert.equal(report.nextCommand, null);
  assert.match(report.checks.find(({ id }) => id === "mode").message, /unavailable/);
});

test("fails for an unavailable role, old Node, or missing files", () => {
  const root = fixture();
  const role = runMacMinerPreflight({
    root, role: "safety-evaluator", platform: "darwin", arch: "x64", nodeVersion: "26.1.0",
  });
  assert.equal(role.ready, false);
  assert.match(role.checks.find(({ id }) => id === "role").message, /specification-only/);

  const oldNode = runMacMinerPreflight({
    root, platform: "darwin", arch: "x64", nodeVersion: "22.0.0",
  });
  assert.equal(oldNode.ready, false);

  writeFileSync(join(root, "package.json"), "{}");
  const wrongRoot = runMacMinerPreflight({
    root, platform: "darwin", arch: "x64", nodeVersion: "26.0.0",
  });
  assert.equal(wrongRoot.ready, false);
});

test("rejects unknown roles instead of guessing", () => {
  assert.throws(() => runMacMinerPreflight({ root: fixture(), role: "gpu-miner" }), /unknown role/);
});

test("the advertised local mining demo completes", () => {
  const repository = join(fileURLToPath(new URL("..", import.meta.url)));
  const result = spawnSync(process.execPath, [join(repository, "blockchain", "demo.mjs")], {
    cwd: repository, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /height: \d+/);
  assert.match(result.stdout, /alice available: 0\.00000000 NIR/);
  assert.match(result.stdout, /alice pending: 50\.00000000 NIR/);
  assert.match(result.stdout, /reward unlock height: 70/);
  assert.match(result.stdout, /signature suite: ML-DSA-65/);
});
