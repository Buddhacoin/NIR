import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { validateLoopbackListener } from "../blockchain/loopback-listener.mjs";

const run = (...arguments_) => spawnSync(process.execPath, arguments_, {
  cwd: process.cwd(), encoding: "utf8", env: { ...process.env },
});

test("operator HTTP services require numeric loopback instead of a resolvable hostname", () => {
  for (const [label, command, expected] of [
    ["archive service", ["blockchain/archive-cli.mjs", "serve", "/missing/archive", "8790", "localhost"],
      /archive service requires .*explicit loopback/],
    ["backup service", ["blockchain/backup-cli.mjs", "serve", "/missing/backup", "/missing/receipt",
      "8791", "localhost"], /backup service requires .*explicit loopback/],
    ["beacon service", ["blockchain/beacon-service.mjs", "/missing/vault", "nir-test",
      "/missing/policy", "8791", "localhost"], /beacon service requires .*explicit loopback/],
  ]) {
    const result = run(...command);
    assert.equal(result.status, 1, `${label} unexpectedly accepted localhost`);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /ENOENT|node:internal|\/Users\//);
  }
});

test("shared service listener policy preserves both numeric loopback families", () => {
  assert.deepEqual(validateLoopbackListener({ host: "127.0.0.1", label: "test service", port: 1 }),
    { host: "127.0.0.1", port: 1 });
  assert.deepEqual(validateLoopbackListener({ host: "::1", label: "test service", port: 65_535 }),
    { host: "::1", port: 65_535 });
  assert.throws(() => validateLoopbackListener({ host: "localhost", label: "test service", port: 8791 }),
    /test service requires .*explicit loopback/);
});
