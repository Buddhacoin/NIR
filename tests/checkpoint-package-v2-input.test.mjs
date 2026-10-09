import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCanonicalCheckpointV2Input }
  from "../blockchain/checkpoint-package-v2-input.mjs";

test("V2 canonical reader bounds a file that grows after descriptor open", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-checkpoint-v2-read-"));
  try {
    const path = join(root, "input.json");
    writeFileSync(path, '{"value":1}\n');
    assert.deepEqual(readCanonicalCheckpointV2Input(path, "test", 64), { value: 1 });
    assert.throws(() => readCanonicalCheckpointV2Input(path, "test", 64, {
      _afterOpen: () => appendFileSync(path, " ".repeat(1024 * 1024)),
    }), /changed during read/);
    assert.equal(readFileSync(path).length > 64, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("V2 canonical reader rejects path replacement, symbolic links and hard links", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-checkpoint-v2-read-"));
  try {
    const path = join(root, "input.json");
    const moved = join(root, "moved.json");
    writeFileSync(path, '{"value":1}\n');
    assert.throws(() => readCanonicalCheckpointV2Input(path, "test", 64, {
      _afterOpen: () => {
        renameSync(path, moved);
        writeFileSync(path, '{"value":1}\n');
      },
    }), /changed during read/);
    const symlink = join(root, "symlink.json");
    symlinkSync(path, symlink);
    assert.throws(() => readCanonicalCheckpointV2Input(symlink, "test", 64), /unsafe/);
    const hardlink = join(root, "hardlink.json");
    linkSync(path, hardlink);
    assert.throws(() => readCanonicalCheckpointV2Input(path, "test", 64), /unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
