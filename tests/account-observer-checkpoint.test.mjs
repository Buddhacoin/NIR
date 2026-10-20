import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireAccountObserverSession, loadAccountObserverCheckpoint,
  saveAccountObserverCheckpoint,
} from "../blockchain/account-observer-checkpoint.mjs";

const binding = {
  address: `nir1${"a".repeat(64)}`,
  genesisHash: "b".repeat(64),
  networkId: "nir-observer-store-test",
};
const tip = (height, hash = "c".repeat(64)) => ({
  accountStateRoot: "d".repeat(64), height, networkId: binding.networkId,
  pendingProtocolUpgrade: null, protocolVersion: 24,
  stateRoot: "e".repeat(64), tipHash: hash,
  validatorSetId: "f".repeat(64),
});

test("observer checkpoint is private, durable, identity-bound and monotonic", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-observer-checkpoint-"));
  const path = join(directory, "checkpoint.json");
  try {
    assert.equal(loadAccountObserverCheckpoint(path, binding), null);
    saveAccountObserverCheckpoint(path, binding, tip(512), 512);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(loadAccountObserverCheckpoint(path, binding).tip.height, 512);
    assert.throws(() => loadAccountObserverCheckpoint(path, {
      ...binding, address: `nir1${"1".repeat(64)}`,
    }), /identity/);
    assert.throws(() => loadAccountObserverCheckpoint(path, {
      ...binding, networkId: "nir-other-network",
    }), /identity/);
    assert.throws(() => loadAccountObserverCheckpoint(path, {
      ...binding, genesisHash: "1".repeat(64),
    }), /identity/);
    assert.throws(() => saveAccountObserverCheckpoint(path, binding, tip(511), 511),
      /roll back/);
    assert.throws(() => saveAccountObserverCheckpoint(path, binding,
      tip(512, "1".repeat(64)), 512), /conflict/);
    const lock = openSync(`${path}.lock`, "wx", 0o600);
    try {
      assert.throws(() => saveAccountObserverCheckpoint(path, binding,
        tip(513, "2".repeat(64)), 513), /EEXIST/);
      assert.equal(loadAccountObserverCheckpoint(path, binding).tip.height, 512);
    } finally {
      closeSync(lock);
      rmSync(`${path}.lock`);
    }
    saveAccountObserverCheckpoint(path, binding, tip(513, "2".repeat(64)), 513);
    assert.equal(loadAccountObserverCheckpoint(path, binding).tip.height, 513);
    const corrupted = JSON.parse(readFileSync(path, "utf8"));
    corrupted.tip.stateRoot = "invalid";
    writeFileSync(path, JSON.stringify(corrupted));
    assert.throws(() => loadAccountObserverCheckpoint(path, binding), /tip is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observer checkpoint refuses symlinks and insecure file permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-observer-checkpoint-"));
  const path = join(directory, "checkpoint.json");
  try {
    saveAccountObserverCheckpoint(path, binding, tip(1), 1);
    chmodSync(path, 0o644);
    assert.throws(() => loadAccountObserverCheckpoint(path, binding), /unsafe/);
    chmodSync(path, 0o600);
    const link = join(directory, "checkpoint-link.json");
    symlinkSync(path, link);
    assert.throws(() => loadAccountObserverCheckpoint(link, binding), /unsafe/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a second process cannot open an active observer checkpoint session", () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-observer-session-"));
  const path = join(directory, "checkpoint.json");
  const release = acquireAccountObserverSession(path);
  try {
    const moduleUrl = new URL("../blockchain/account-observer-checkpoint.mjs", import.meta.url).href;
    const script = `import { acquireAccountObserverSession } from ${JSON.stringify(moduleUrl)}; ` +
      `acquireAccountObserverSession(${JSON.stringify(path)});`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /EEXIST/);
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});
