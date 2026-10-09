import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { tryLocalMining } from "../blockchain/miner-try.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-miner-try-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "nir-protocol", private: true }));
  mkdirSync(join(root, "blockchain"));
  mkdirSync(join(root, "wallet-ui"));
  for (const name of ["demo.mjs", "node-cli.mjs", "wallet-cli.mjs"]) {
    writeFileSync(join(root, "blockchain", name), "");
  }
  writeFileSync(join(root, "wallet-ui", "index.html"), "");
  return root;
}

const setup = { platform: "darwin", arch: "arm64", nodeVersion: "26.0.0" };
const success = { status: 0, stdout: `final block: ${"a".repeat(64)}\n`, stderr: "" };

test("one-step practice runs exactly one in-memory demo only after preflight", () => {
  let calls = 0;
  const runDemo = () => { calls++; return success; };
  const ready = tryLocalMining({ root: fixture(), ...setup, runDemo });
  assert.equal(ready.ok, true);
  assert.equal(ready.scope, "local-valueless-demo-only");
  assert.equal(calls, 1);

  const oldNode = tryLocalMining({ root: fixture(), ...setup, nodeVersion: "22.0.0", runDemo });
  assert.equal(oldNode.ok, false);
  assert.equal(oldNode.reason, "preflight");
  assert.equal(calls, 1);
});

test("one-step practice never labels a failing or unproven demo successful", () => {
  for (const result of [
    { status: 1, stdout: "", stderr: "failed" },
    { status: 0, stdout: "height: 6\n", stderr: "" },
  ]) {
    const attempt = tryLocalMining({ root: fixture(), ...setup, runDemo: () => result });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.reason, "demo-failed");
  }
  const crashed = tryLocalMining({
    root: fixture(), ...setup, runDemo: () => { throw new Error("demo crashed"); },
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.detail, "demo crashed");
});

test("public one-step command finishes without wallet files, network promises or a displayed payout", () => {
  if (process.platform !== "darwin" || Number.parseInt(process.versions.node, 10) < 26) return;
  const root = join(import.meta.dirname, "..");
  const result = spawnSync(process.execPath, [join(root, "blockchain/miner-try-cli.mjs")], {
    cwd: root, encoding: "utf8", timeout: 40_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Реальных наград нет/);
  assert.doesNotMatch(result.stdout, /50\.00000000|44\.00000000|seed|private key/u);
});
