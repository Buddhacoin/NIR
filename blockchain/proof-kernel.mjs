import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROOF_CHECK_PROFILE_V1 } from "./proof-export.mjs";

// The kernel half of proof verification: the pinned external Lean type
// checker re-checks every declaration of an export the policy half already
// accepted. The export is passed on stdin; the checker sees no other input.
//
// Not yet consensus: the checker has no deterministic step limit, so the
// wall-clock timeout below is a local safeguard only (docs/proof-mining.md §6).
export async function runKernelCheck(exportText, {
  checkerPath,
  profile = PROOF_CHECK_PROFILE_V1,
  timeoutMs = 120_000,
} = {}) {
  if (typeof checkerPath !== "string" || checkerPath.length === 0) {
    throw new Error("kernel checker path is required");
  }
  const directory = await mkdtemp(join(tmpdir(), "nir-kernel-"));
  try {
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      use_stdin: true,
      permitted_axioms: Object.keys(profile.allowedAxioms),
      unpermitted_axiom_hard_error: true,
      nat_extension: true,
      string_extension: true,
      num_threads: 1,
      print_success_message: false,
      print_axioms: false,
    }), { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = spawn(checkerPath, [configPath], {
        stdio: ["pipe", "ignore", "pipe"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4_096) stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        resolve({ accepted: code === 0 && signal === null, code, signal, stderr: stderr.slice(0, 4_096) });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(exportText);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
