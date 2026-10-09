import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { runMacMinerPreflight } from "./miner-macos-preflight.mjs";

function executeDemo(root) {
  return spawnSync(process.execPath, [join(root, "blockchain/demo.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

export function tryLocalMining({
  root,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  runDemo = executeDemo,
} = {}) {
  const preflight = runMacMinerPreflight({
    root, platform, arch, nodeVersion, mode: "local-demo", role: "capability-author",
  });
  if (!preflight.ready) return { ok: false, reason: "preflight", checks: preflight.checks };

  const result = runDemo(root);
  if (result.error || result.status !== 0 || !/^final block: [0-9a-f]{64}$/mu.test(result.stdout ?? "")) {
    return {
      ok: false,
      reason: "demo-failed",
      detail: result.error?.message || result.stderr?.trim() || "The demo did not complete.",
    };
  }
  return { ok: true, scope: preflight.scope, details: result.stdout.trim() };
}
