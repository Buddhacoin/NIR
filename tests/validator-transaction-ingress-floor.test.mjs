import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { advanceTransactionIngressFloor, initializeTransactionIngressFloor,
  loadTransactionIngressFloor } from "../blockchain/validator-transaction-ingress-floor.mjs";

const identity = { expectedGenesisHash: "a".repeat(64),
  expectedNetworkId: "nir-ingress-floor-test",
  expectedPolicyId: `sha3-256:${"b".repeat(64)}`,
  validatorAddress: `nir1${"c".repeat(64)}` };
const candidate = (sequence, height, observedAt) => ({
  height, historyCount: 1, historyHead: "d".repeat(64), observedAt,
  packageHash: `sha3-256:${sequence.toString(16).padStart(64, "0")}`,
  sequence, tipHash: height.toString(16).padStart(64, "0"),
});

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "nir-ingress-floor-test-"));
  return { root, directory: join(root, "floor") };
}

test("restart reloads the exact persistent floor and refuses silent reinitialization", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    assert.throws(() => initializeTransactionIngressFloor(values.directory, identity));
    const latest = advanceTransactionIngressFloor(values.directory, identity,
      candidate(8, 10, 1_800_000_000_000));
    assert.equal(latest.revision, 1);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { loadTransactionIngressFloor } from ${JSON.stringify(new URL(
        "../blockchain/validator-transaction-ingress-floor.mjs", import.meta.url).href)};
       const floor = loadTransactionIngressFloor(process.argv[1], JSON.parse(process.argv[2]));
       process.stdout.write(JSON.stringify({ height: floor.height, sequence: floor.sequence,
         tipHash: floor.tipHash, observedAt: floor.observedAt }));`,
      values.directory, JSON.stringify(identity)], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      height: 10, sequence: 8, tipHash: candidate(8, 10, 0).tipHash,
      observedAt: 1_800_000_000_000,
    });
    assert.equal(loadTransactionIngressFloor(values.directory, identity).recordHash,
      latest.recordHash);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("interruption before rename retains old floor; after first copy recovers only linked newer floor", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    const first = advanceTransactionIngressFloor(values.directory, identity,
      candidate(8, 10, 100));
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(9, 11, 101), { _beforeCopyRename: () => { throw new Error("power cut"); } }),
    /power cut/);
    assert.equal(loadTransactionIngressFloor(values.directory, identity).recordHash,
      first.recordHash);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(9, 11, 101), { _afterFirstCopy: () => { throw new Error("power cut"); } }),
    /power cut/);
    const recovered = loadTransactionIngressFloor(values.directory, identity);
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.height, 11);
    assert.equal(recovered.previousRecordHash, first.recordHash);
    assert.equal(advanceTransactionIngressFloor(values.directory, identity,
      candidate(10, 12, 102)).revision, 3);
    assert.equal(loadTransactionIngressFloor(values.directory, identity).height, 12);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("identity mismatch, invalid monotonic transitions, corrupt copy, and lost store fail closed", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    advanceTransactionIngressFloor(values.directory, identity, candidate(8, 10, 100));
    assert.throws(() => loadTransactionIngressFloor(values.directory,
      { ...identity, expectedGenesisHash: "f".repeat(64) }), /identity/);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(7, 9, 101)), /rollback/);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      { ...candidate(9, 10, 101), tipHash: "f".repeat(64) }), /divergence/);
    assert.throws(() => advanceTransactionIngressFloor(values.directory, identity,
      candidate(9, 11, 99)), /rollback/);
    writeFileSync(join(values.directory, "FLOOR.primary.json"), "corrupt\n");
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity));
    rmSync(values.directory, { recursive: true, force: true });
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity), /ENOENT/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("private floor rejects symlinked roots and copy substitution", () => {
  const values = temporary();
  try {
    initializeTransactionIngressFloor(values.directory, identity);
    const alias = join(values.root, "alias"); symlinkSync(values.directory, alias);
    assert.throws(() => loadTransactionIngressFloor(alias, identity), /unsafe/);
    rmSync(join(values.directory, "FLOOR.primary.json"));
    symlinkSync(join(values.directory, "FLOOR.secondary.json"),
      join(values.directory, "FLOOR.primary.json"));
    assert.throws(() => loadTransactionIngressFloor(values.directory, identity), /unsafe/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});
