import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function serve(receiptPath) {
  return spawnSync(process.execPath, ["blockchain/backup-cli.mjs", "serve",
    "/backup-that-must-not-be-opened", receiptPath, "8791", "127.0.0.1"], {
    cwd: process.cwd(), encoding: "utf8",
  });
}

test("backup CLI rejects linked, writable, and ambiguous receipt inputs before opening backup data", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-backup-cli-input-"));
  try {
    const target = join(root, "target.json"); const hard = join(root, "hard.json");
    const symbolic = join(root, "symbolic.json");
    writeFileSync(target, "{}\n", { mode: 0o600 }); linkSync(target, hard); symlinkSync(target, symbolic);
    for (const path of [target, hard, symbolic]) {
      const result = serve(path);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /backup JSON input file is unsafe/);
      assert.doesNotMatch(result.stderr, /ENOENT|node:internal|\/Users\//);
    }
    rmSync(hard); rmSync(symbolic); chmodSync(target, 0o622);
    assert.match(serve(target).stderr, /backup JSON input file is unsafe/);

    const duplicate = join(root, "duplicate.json");
    writeFileSync(duplicate, "{\"payload\":{},\"payload\":{}}\n", { mode: 0o600 });
    const ambiguous = serve(duplicate);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /consensus JSON is not canonical data/);
    assert.doesNotMatch(ambiguous.stderr, /ENOENT|node:internal|\/Users\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
