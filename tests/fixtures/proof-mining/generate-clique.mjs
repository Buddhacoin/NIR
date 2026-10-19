// Regenerates the clique-task fixtures with Lean 4.35.0: a proof that a clique
// exists and a refutation, each for a seed-derived task, and the lines Lean's
// exporter appends to the library for sample statements, which
// cliqueTaskExport must reproduce byte for byte.
// Usage: LEAN_HOME=<Lean 4.35.0> node tests/fixtures/proof-mining/generate-clique.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cliqueInstance, cliqueTaskSource } from "../../../blockchain/proof-tasks.mjs";

export const CLIQUE_FIXTURES = Object.freeze({
  proved: { seed: "23d88e594ca43b7e8a475d7aa2f98108b00730a7d9dfb57edca676f18a3dc2f8", n: 6 },
  refuted: { seed: "2a4c6e8092b4d6f81a3c5e7092b4d6f82a4c6e8092b4d6f81a3c5e7092b4d6f8", n: 6 },
});

// Includes repeated arguments, which Lean's exporter shares.
export const CLIQUE_TASK_SAMPLES = Object.freeze([
  { n: 5, k: 3, graph: 123456789n },
  { n: 4, k: 4, graph: 4n },
]);

// A vertex set of at least `k` pairwise adjacent vertices, by exhaustive search.
export function findClique({ n, k, graph }) {
  for (let x = 0; x < 2 ** n; x++) {
    const members = [...Array(n).keys()].filter((i) => (x >> i) & 1);
    if (members.length < k) continue;
    if (members.every((i) => members.every((j) => i === j || ((graph >> BigInt(i * n + j)) & 1n) === 1n))) {
      return x;
    }
  }
  return null;
}

function main() {
  const home = process.env.LEAN_HOME;
  if (!home) throw new Error("LEAN_HOME must point to Lean 4.35.0");
  const here = new URL(".", import.meta.url).pathname;
  const work = mkdtempSync(join(tmpdir(), "nir-clique-"));
  try {
    const env = { ...process.env, PATH: `${join(home, "bin")}:${process.env.PATH}`, LEAN_PATH: `${join(home, "lib", "lean")}:${work}` };
    const run = (...args) => execFileSync(args[0], args.slice(1), { cwd: work, env, encoding: "utf8" });
    copyFileSync(new URL("../../../protocol/proof-tasks/Clique.lean", import.meta.url), join(work, "Clique.lean"));
    run("lean", "-o", "Clique.olean", "Clique.lean");
    const library = run("leanexport", "Clique", "--", "NIR.Clique.HasClique", "Not");
    const pinned = new URL("../../../protocol/proof-tasks/clique-library.ndjson", import.meta.url);
    if (library !== readFileSync(pinned, "utf8")) throw new Error("Clique.lean no longer matches the pinned library export");
    const suffixes = CLIQUE_TASK_SAMPLES.map((sample, i) => {
      writeFileSync(join(work, `Sample${i}.lean`), `import Clique\n\n${cliqueTaskSource(sample)}`);
      run("lean", "-o", `Sample${i}.olean`, `Sample${i}.lean`);
      const task = run("leanexport", `Sample${i}`, "--", "NIR.statement");
      if (!task.startsWith(library)) throw new Error("task export does not extend the library");
      return task.slice(library.length);
    });
    writeFileSync(join(here, "clique-task-samples.json"), `${JSON.stringify(suffixes, null, 2)}\n`);
    for (const [name, { seed, n }] of Object.entries(CLIQUE_FIXTURES)) {
      const instance = cliqueInstance(seed, n);
      const clique = findClique(instance);
      if ((clique !== null) !== (name === "proved")) throw new Error(`seed for ${name} has the wrong outcome`);
      const proof = clique === null
        ? "theorem NIR.solution : ¬ NIR.statement :=\n  NIR.Clique.not_hasClique _ _ _ (by decide)\n"
        : `theorem NIR.solution : NIR.statement :=\n  ⟨${clique}, by decide, by decide, by decide⟩\n`;
      const module = `Clique${name[0].toUpperCase()}${name.slice(1)}`;
      writeFileSync(join(work, `${module}.lean`), `import Clique\n\n${cliqueTaskSource(instance)}\n${proof}`);
      run("lean", "-o", `${module}.olean`, `${module}.lean`);
      writeFileSync(join(here, `clique-${name}.ndjson`), run("leanexport", module, "--", "NIR.solution"));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
