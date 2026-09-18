import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBeaconShareRequest, verifyBeaconShareRequest,
} from "../blockchain/beacon-request-auth.mjs";
import { openBeaconStateStore } from "../blockchain/beacon-state-store.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";

const ADDRESS = `nir1${"a".repeat(64)}`;
const NETWORK = "nir-beacon-compaction-test";

function temporaryStore(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "nir-beacon-compact-"));
  const vaultPath = join(root, "beacon.nirvault.json");
  return {
    root, vaultPath,
    store: openBeaconStateStore({ address: ADDRESS, networkId: NETWORK, vaultPath, ...options }),
  };
}

test("bounded checkpoint preserves shares and live nonces while advancing durable time", () => {
  const fixture = temporaryStore({ maxNonces: 2_000 });
  let store = fixture.store;
  try {
    for (let index = 0; index < 3; index += 1) {
      store.append(`fallback:${String(index).padStart(64, "0")}:1`, { index });
    }
    // Scaled model: each record represents 500 equivalent requests in a 100k history.
    for (let index = 0; index < 200; index += 1) {
      store.appendNonce({
        expiresAt: index < 160 ? 1_100_000 : 2_100_000,
        replayKey: `${ADDRESS}:${index.toString(16).padStart(64, "0")}`,
        verifiedAt: 1_000_000,
      });
    }
    const plan = store.planCompaction({ observedNow: 2_000_000, safetyMarginMs: 100_000 });
    assert.deepEqual([plan.prunableNonces, plan.retainedNonces], [160, 40]);
    const result = store.compact({ observedNow: 2_000_000, safetyMarginMs: 100_000 });
    assert.equal(result.nextGeneration, 1);
    assert.throws(() => store.append("after:compact", {}), /requires restart/);
    store.close();
    store = openBeaconStateStore({
      address: ADDRESS, maxNonces: 2_000, networkId: NETWORK, vaultPath: fixture.vaultPath,
    });
    assert.equal(store.generation, 1);
    assert.equal(store.highWater, 2_000_000);
    assert.equal(store.issued.size, 3);
    assert.equal(store.nonces.size, 40);
    store.appendNonce({ expiresAt: 2_200_000, replayKey: `${ADDRESS}:${"f".repeat(64)}`,
      verifiedAt: 2_000_001 });
    store.close();
    store = openBeaconStateStore({
      address: ADDRESS, maxNonces: 2_000, networkId: NETWORK, vaultPath: fixture.vaultPath,
    });
    assert.equal(store.nonces.size, 41);
    assert.equal(store.highWater, 2_000_001);
  } finally {
    store?.close(); rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("clock rollback cannot reopen a nonce pruned from an older generation", () => {
  const fixture = temporaryStore();
  let store = fixture.store;
  try {
    store.appendNonce({ expiresAt: 1_030_000, replayKey: `${ADDRESS}:${"1".repeat(64)}`,
      verifiedAt: 1_000_000 });
    store.compact({ observedNow: 1_200_000, safetyMarginMs: 60_000 });
    store.close();
    store = openBeaconStateStore({ address: ADDRESS, networkId: NETWORK, vaultPath: fixture.vaultPath });
    assert.equal(store.nonces.size, 0);
    const requester = generateWallet();
    const envelope = createBeaconShareRequest({
      beaconAddress: ADDRESS, candidateId: "2".repeat(64), networkId: NETWORK,
      purpose: "fallback", round: 1,
    }, requester, { clock: () => 1_000_000, lifetimeMs: 30_000, nonce: "1".repeat(64) });
    assert.throws(() => verifyBeaconShareRequest(envelope, {
      beaconAddress: ADDRESS, clock: () => 1_000_000, minimumTime: store.highWater,
      networkId: NETWORK,
      requesters: new Map([[requester.address, { ...publicWallet(requester), operatorId: "operator-a" }]]),
    }), /validity window/);
  } finally {
    store?.close(); rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("checkpoint creation detects stale plans and partial generations fail closed", () => {
  const first = temporaryStore();
  let store = first.store;
  try {
    assert.throws(() => store.compact({
      observedNow: 1_000,
      onAfterPlan: () => store.appendNonce({
        expiresAt: 2_000, replayKey: `${ADDRESS}:${"3".repeat(64)}`, verifiedAt: 1_000,
      }),
      safetyMarginMs: 0,
    }), /changed after compaction plan/);
  } finally {
    store?.close(); rmSync(first.root, { force: true, recursive: true });
  }

  const second = temporaryStore();
  store = second.store;
  try {
    assert.throws(() => store.compact({
      observedNow: 2_000, onAfterHeader: () => { throw new Error("simulated crash"); },
      safetyMarginMs: 0,
    }), /simulated crash/);
    store.close(); store = null;
    assert.throws(() => openBeaconStateStore({
      address: ADDRESS, networkId: NETWORK, vaultPath: second.vaultPath,
    }), /seal is missing/);
  } finally {
    store?.close(); rmSync(second.root, { force: true, recursive: true });
  }
});

test("checkpoint activation rejects symlink targets and operator-root swaps", () => {
  const first = temporaryStore();
  let store = first.store;
  try {
    const target = `${first.vaultPath}.beacon-state.g00000001.log`;
    const foreign = join(first.root, "foreign");
    writeFileSync(foreign, "do-not-touch", { mode: 0o600 });
    symlinkSync(foreign, target);
    assert.throws(() => store.compact({ observedNow: 1_000, safetyMarginMs: 0 }), /EEXIST/);
    assert.equal(readFileSync(foreign, "utf8"), "do-not-touch");
  } finally {
    store?.close(); rmSync(first.root, { force: true, recursive: true });
  }

  const outer = mkdtempSync(join(tmpdir(), "nir-beacon-compact-root-"));
  const root = join(outer, "operator");
  const moved = join(outer, "operator-original");
  mkdirSync(root, { mode: 0o700 });
  const vaultPath = join(root, "beacon.nirvault.json");
  store = openBeaconStateStore({ address: ADDRESS, networkId: NETWORK, vaultPath });
  try {
    assert.throws(() => store.compact({
      observedNow: 1_000,
      onAfterPlan: () => { renameSync(root, moved); mkdirSync(root, { mode: 0o700 }); },
      safetyMarginMs: 0,
    }), /parent changed|ENOENT/);
    assert.equal(readFileSync(join(moved, "beacon.nirvault.json.beacon-state.log"), "utf8").length > 0, true);
  } finally {
    store.close(); rmSync(outer, { force: true, recursive: true });
  }
});

test("offline CLI plans, compacts, and verifies one no-replace generation", () => {
  const fixture = temporaryStore();
  fixture.store.close();
  try {
    const cli = join(process.cwd(), "blockchain", "beacon-state-cli.mjs");
    const args = [fixture.vaultPath, ADDRESS, NETWORK];
    const plan = JSON.parse(execFileSync(process.execPath,
      [cli, "plan", ...args, "1000", "100"], { encoding: "utf8" }));
    assert.equal(plan.nextGeneration, 1);
    const compact = JSON.parse(execFileSync(process.execPath,
      [cli, "compact", ...args, "1000", "100"], { encoding: "utf8" }));
    assert.equal(compact.nextGeneration, 1);
    const verified = JSON.parse(execFileSync(process.execPath,
      [cli, "verify", ...args], { encoding: "utf8" }));
    assert.deepEqual([verified.status, verified.generation, verified.highWater],
      ["verified", 1, 1_000]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
