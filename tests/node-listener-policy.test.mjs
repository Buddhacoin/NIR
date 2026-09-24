import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateLoopbackListener } from "../blockchain/loopback-listener.mjs";
import { initializeDevnet } from "../blockchain/node-store.mjs";

test("node listener policy accepts only explicit loopback addresses", () => {
  assert.deepEqual(validateLoopbackListener({ host: "127.0.0.1", port: 8787 }),
    { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(validateLoopbackListener({ host: "::1", port: 8787 }),
    { host: "::1", port: 8787 });
  for (const host of ["0.0.0.0", "::", "localhost", "example.invalid", ""]) {
    assert.throws(() => validateLoopbackListener({ host, port: 8787 }), /explicit loopback/);
  }
  for (const port of [0, 65_536, 1.5, Number.NaN]) {
    assert.throws(() => validateLoopbackListener({ host: "127.0.0.1", port }), /valid port/);
  }
});

test("development and production node commands reject public plaintext binds before opening state", () => {
  const cli = "blockchain/node-cli.mjs";
  const development = spawnSync(process.execPath,
    [cli, "serve", "/path/that/must/not/be/opened", "8787", "0.0.0.0"],
    { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(development.status, 1);
  assert.match(development.stderr, /explicit loopback host/);
  const production = spawnSync(process.execPath, [cli, "serve-production",
    "/untrusted/install", "/untrusted/head", "/untrusted/release", "nir1invalid",
    "/untrusted/runtime", "8787", "0.0.0.0", "/untrusted/anchor"],
  { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(production.status, 1);
  assert.match(production.stderr, /explicit loopback host/);
});

test("listener collision fails cleanly and releases the node writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-node-listener-"));
  const node = join(root, "node"); const occupied = createServer();
  try {
    initializeDevnet(node);
    await new Promise((resolve, reject) => {
      occupied.once("error", reject); occupied.listen(0, "127.0.0.1", resolve);
    });
    const result = spawnSync(process.execPath,
      ["blockchain/node-cli.mjs", "serve", node, String(occupied.address().port), "127.0.0.1"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Node operation failed: loopback listener is unavailable\n$/);
    assert.doesNotMatch(result.stderr, /node:internal|file:\/|\/Users\//);
    assert.equal(existsSync(join(node, ".nir-writer-lock")), false);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
