import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { validateLoopbackListener } from "../blockchain/loopback-listener.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";

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

test("beacon bind collision closes private state and emits only a bounded startup error", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-beacon-bind-")); const occupied = createServer();
  let passwordDescriptor;
  try {
    await new Promise((resolve, reject) => {
      occupied.once("error", reject); occupied.listen(0, "127.0.0.1", resolve);
    });
    const beacon = generateWallet(); const requester = generateWallet();
    const password = "beacon-bind-collision-password";
    const vaultPath = join(root, "beacon.nirvault"); const policyPath = join(root, "policy.json");
    const passwordPath = join(root, "password");
    writeFileSync(vaultPath, `${canonicalJson(encryptWallet(beacon, password))}\n`, { mode: 0o600 });
    writeFileSync(policyPath, `${canonicalJson({
      beaconAddress: beacon.address, format: "nir-beacon-requester-policy-v1", networkId: "nir-test",
      requesters: [{ ...publicWallet(requester), operatorId: "requester-operator" }],
      reservedAddresses: [beacon.address], reservedOperatorIds: ["beacon-operator"],
    })}\n`, { mode: 0o600 });
    writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
    passwordDescriptor = openSync(passwordPath, "r");
    const result = spawnSync(process.execPath, ["blockchain/beacon-service.mjs", vaultPath,
      "nir-test", policyPath, String(occupied.address().port), "127.0.0.1"], {
      cwd: process.cwd(), encoding: "utf8",
      env: { ...process.env, NIR_BEACON_PASSWORD_FD: "3" },
      stdio: ["ignore", "pipe", "pipe", passwordDescriptor], timeout: 5_000,
    });
    closeSync(passwordDescriptor); passwordDescriptor = undefined;
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Beacon service failed: beacon service listener is unavailable\n");
    assert.equal(existsSync(`${vaultPath}.beacon-state.log.lock`), false);
  } finally {
    if (passwordDescriptor !== undefined) closeSync(passwordDescriptor);
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
