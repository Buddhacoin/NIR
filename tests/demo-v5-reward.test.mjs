import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("local demo uses the approved v5 reward, not the historical 50 NIR schedule", () => {
  const output = execFileSync(process.execPath, ["blockchain/demo.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.match(output, /^alice pending: 44\.00000000 NIR$/m);
  assert.doesNotMatch(output, /^alice pending: 50\.00000000 NIR$/m);
});
