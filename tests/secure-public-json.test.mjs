import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeDevnet } from "../blockchain/node-store.mjs";
import { readBoundedPublicJsonFile } from "../blockchain/secure-public-json.mjs";

test("secure public JSON accepts bounded regular data and rejects ambiguous encodings", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-public-json-"));
  try {
    const accepted = join(root, "accepted.json");
    writeFileSync(accepted, "{\n  \"height\": 1,\n  \"networkId\": \"nir-test\"\n}\n", { mode: 0o600 });
    assert.deepEqual(readBoundedPublicJsonFile(accepted), { height: 1, networkId: "nir-test" });

    const duplicate = join(root, "duplicate.json");
    writeFileSync(duplicate, "{\"height\":1,\"height\":2}\n", { mode: 0o600 });
    assert.throws(() => readBoundedPublicJsonFile(duplicate), /canonical data/);

    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, "{\"value\":\"1234567890\"}\n", { mode: 0o600 });
    assert.throws(() => readBoundedPublicJsonFile(oversized, { maximumBytes: 8 }), /unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("secure public JSON rejects links, writable inputs, and path replacement races", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-public-json-links-"));
  try {
    const target = join(root, "target.json"); const symbolic = join(root, "symbolic.json");
    writeFileSync(target, "{\"value\":1}\n", { mode: 0o600 }); symlinkSync(target, symbolic);
    assert.throws(() => readBoundedPublicJsonFile(symbolic), /unsafe/);

    const hard = join(root, "hard.json"); linkSync(target, hard);
    assert.throws(() => readBoundedPublicJsonFile(target), /unsafe/);
    rmSync(hard);

    chmodSync(target, 0o622);
    assert.throws(() => readBoundedPublicJsonFile(target), /unsafe/);
    chmodSync(target, 0o600);

    const displaced = join(root, "displaced.json");
    assert.throws(() => readBoundedPublicJsonFile(target, { _afterOpen: () => {
      renameSync(target, displaced);
      writeFileSync(target, "{\"value\":2}\n", { mode: 0o600 });
    } }), /changed during read/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("node snapshot and network discovery CLIs reject linked operator artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-public-json-cli-"));
  try {
    const node = join(root, "node"); initializeDevnet(node);
    const target = join(root, "input.json"); const linked = join(root, "linked.json");
    writeFileSync(target, "{}\n", { mode: 0o600 }); symlinkSync(target, linked);
    const snapshot = spawnSync(process.execPath,
      ["blockchain/node-cli.mjs", "snapshot-install", node, linked],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(snapshot.status, 1);
    assert.match(snapshot.stderr, /file is unsafe/);
    const discovery = spawnSync(process.execPath,
      ["blockchain/network-cli.mjs", "discover", linked, "https:\/\/seed.invalid"],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(discovery.status, 1);
    assert.match(discovery.stderr, /file is unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
