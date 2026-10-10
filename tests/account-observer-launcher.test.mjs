import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLaunchedAccountObserver, loadAccountObserverLaunchConfig,
  parseObserverLaunchArguments,
} from "../blockchain/account-observer-launcher.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

const ORIGIN = "moz-extension://9eeb5c1f-8628-4c41-98ce-1fd5a654091d";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-observer-launch-"));
  const state = join(root, "private");
  mkdirSync(state, { mode: 0o700 });
  const validators = Array.from({ length: 4 }, (_, index) => ({
    ...publicWallet(generateWallet()), operatorId: `validator-${index}`,
  }));
  const trustAnchor = { expectedNetworkId: "nir-observer-local-test",
    genesisCheckpoint: { height: 0, tipHash: "a".repeat(64), stateRoot: "b".repeat(64),
      accountStateRoot: "c".repeat(64), validatorSetId: validatorSetId(validators) },
    handoffs: [], trustedValidators: validators };
  const bytes = JSON.stringify(trustAnchor);
  const anchor = join(root, "reviewed-anchor.json");
  writeFileSync(anchor, bytes);
  const values = { address: generateWallet().address, origin: ORIGIN,
    node: "http://127.0.0.1:8877", "anchor-file": anchor,
    "anchor-sha256": createHash("sha256").update(bytes).digest("hex"),
    "genesis-hash": trustAnchor.genesisCheckpoint.tipHash, "state-dir": state, port: "8789" };
  return { root, state, values };
}

test("launcher requires every argument and no duplicates or unknown switches", () => {
  assert.throws(() => parseObserverLaunchArguments([]), /incomplete/);
  assert.throws(() => parseObserverLaunchArguments(["--address", "x", "--address", "y"]), /once/);
  assert.throws(() => parseObserverLaunchArguments(["--token", "x"]), /once/);
});

test("launcher requires independently pinned anchor and private identity checkpoint", () => {
  const fixtureValue = fixture();
  try {
    const config = loadAccountObserverLaunchConfig(fixtureValue.values);
    assert.equal(config.trustAnchor.genesisCheckpoint.tipHash, "a".repeat(64));
    assert.match(config.checkpointPath, /\/account-[0-9a-f]{64}\.json$/);
    assert.notEqual(config.checkpointPath,
      loadAccountObserverLaunchConfig({ ...fixtureValue.values,
        address: generateWallet().address }).checkpointPath);
    assert.equal(config.checkpointPath,
      loadAccountObserverLaunchConfig({ ...fixtureValue.values,
        origin: "moz-extension://46d1a996-3b60-4cea-8b12-a544bff7e999" }).checkpointPath,
      "reinstalling Firefox must not reset the account's anti-rollback checkpoint");
    assert.throws(() => loadAccountObserverLaunchConfig({ ...fixtureValue.values,
      "genesis-hash": "d".repeat(64) }), /genesis/);
    assert.throws(() => loadAccountObserverLaunchConfig({ ...fixtureValue.values,
      "anchor-sha256": "d".repeat(64) }), /SHA-256/);
    assert.throws(() => loadAccountObserverLaunchConfig({ ...fixtureValue.values,
      node: "http://example.com:8877" }), /loopback/);
    assert.throws(() => loadAccountObserverLaunchConfig({ ...fixtureValue.values,
      origin: "http://127.0.0.1:8765" }), /origin/);
    const linkedAnchor = join(fixtureValue.root, "linked-anchor.json");
    symlinkSync(fixtureValue.values["anchor-file"], linkedAnchor);
    assert.throws(() => loadAccountObserverLaunchConfig({ ...fixtureValue.values,
      "anchor-file": linkedAnchor }), /ELOOP|symbolic link/);
    const untrusted = { ...config.trustAnchor,
      genesisCheckpoint: { ...config.trustAnchor.genesisCheckpoint,
        validatorSetId: "d".repeat(64) } };
    const untrustedBytes = JSON.stringify(untrusted);
    writeFileSync(fixtureValue.values["anchor-file"], untrustedBytes);
    assert.throws(() => loadAccountObserverLaunchConfig({ ...fixtureValue.values,
      "anchor-sha256": createHash("sha256").update(untrustedBytes).digest("hex") }),
    /validator set/);
    chmodSync(fixtureValue.state, 0o755);
    assert.throws(() => loadAccountObserverLaunchConfig(fixtureValue.values), /private 0700/);
  } finally { rmSync(fixtureValue.root, { recursive: true, force: true }); }
});

test("launched observer is scoped to Firefox origin and never exposes signing", async () => {
  const fixtureValue = fixture();
  let server;
  try {
    const config = loadAccountObserverLaunchConfig(fixtureValue.values);
    server = createLaunchedAccountObserver(config, "f".repeat(64));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/sign`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json",
        "x-nir-observer-token": "f".repeat(64) }, body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("CLI refuses redirected output before generating or printing token", () => {
  const result = spawnSync(process.execPath,
    [new URL("../blockchain/account-observer-cli.mjs", import.meta.url).pathname],
    { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /interactive terminal/);
});
