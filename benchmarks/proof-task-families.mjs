#!/usr/bin/env node
// Measures candidate task families for proof mining (docs/proof-mining.md §7.2).
// Each family turns a public seed into a Lean statement that is true by
// construction. A family is useful for issuance only if Lean's standard
// automation cannot already solve its instances: a public tactic is a public
// solver, and anyone can run it.
//
// Usage: LEAN_HOME=<Lean 4.35.0> node benchmarks/proof-task-families.mjs
//          [--family linear,ring,clique] [--sizes 4,8] [--seeds 3] [--timeout 60]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

// Deterministic stream of 32-bit integers from a public seed.
export function seededRandom(seed) {
  let counter = 0;
  let buffer = Buffer.alloc(0);
  return function next(bound) {
    if (buffer.length < 4) {
      buffer = createHash("sha3-256").update(`NIR/PROOF_TASK/v1\0${seed}\0${counter++}`).digest();
    }
    const value = buffer.readUInt32BE(0);
    buffer = buffer.subarray(4);
    return value % bound;
  };
}

const signed = (random, magnitude) => random(2 * magnitude + 1) - magnitude;

// Linear integer arithmetic: the conclusion is a positive combination of the
// hypotheses, so it holds by construction.
function linear(seed, size) {
  const random = seededRandom(seed);
  const vars = Array.from({ length: size }, (_, i) => `x${i}`);
  const hypotheses = Array.from({ length: size + 1 }, () => ({
    coefficients: vars.map(() => signed(random, 9)),
    bound: random(50),
    weight: random(5) + 1,
  }));
  const form = (coefficients) => coefficients.map((c, i) => `${c} * ${vars[i]}`).join(" + ");
  const total = vars.map((_, i) => hypotheses.reduce((sum, h) => sum + h.weight * h.coefficients[i], 0));
  const bound = hypotheses.reduce((sum, h) => sum + h.weight * h.bound, 0);
  const premises = hypotheses.map((h) => `${form(h.coefficients)} ≤ ${h.bound}`);
  return {
    statement: `∀ ${vars.join(" ")} : Int, ${premises.join(" → ")} → ${form(total)} ≤ ${bound}`,
    tactics: ["omega", "grind"],
  };
}

// Polynomial identity: the right side is the generator's own expansion.
function ring(seed, size) {
  const random = seededRandom(seed);
  const vars = ["a", "b", "c"];
  const polynomial = () => {
    const terms = new Map();
    for (let t = 0; t < size; t++) {
      const exponents = vars.map(() => random(3));
      const key = exponents.join(",");
      terms.set(key, (terms.get(key) ?? 0) + signed(random, 5));
    }
    return terms;
  };
  const multiply = (p, q) => {
    const result = new Map();
    for (const [kp, cp] of p) {
      for (const [kq, cq] of q) {
        const key = kp.split(",").map((e, i) => Number(e) + Number(kq.split(",")[i])).join(",");
        result.set(key, (result.get(key) ?? 0) + cp * cq);
      }
    }
    return result;
  };
  const render = (p) => {
    const terms = [...p].filter(([, c]) => c !== 0).map(([key, c]) => {
      const monomial = key.split(",").map((e, i) => (e === "0" ? null : `${vars[i]}^${e}`)).filter(Boolean);
      return `(${c}) * ${["1", ...monomial].join(" * ")}`;
    });
    return terms.length > 0 ? terms.join(" + ") : "0";
  };
  const p = polynomial();
  const q = polynomial();
  return {
    statement: `∀ a b c : Int, (${render(p)}) * (${render(q)}) = ${render(multiply(p, q))}`,
    tactics: ["grind"],
  };
}

// Graph G(n, 1/2) from the seed: no clique of size ω+1, where ω is the clique
// number the generator computes by exhaustive search.
function clique(seed, size) {
  const random = seededRandom(seed);
  const adjacency = Array.from({ length: size }, () => 0n);
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      if (random(2) === 1) {
        adjacency[i] |= 1n << BigInt(j);
        adjacency[j] |= 1n << BigInt(i);
      }
    }
  }
  let best = 0;
  const extend = (candidates, depth) => {
    if (candidates === 0n) {
      best = Math.max(best, depth);
      return;
    }
    let remaining = candidates;
    while (remaining !== 0n) {
      const v = remaining.toString(2).length - 1;
      remaining &= ~(1n << BigInt(v));
      if (depth + 1 + popcount(remaining) <= best) return;
      extend(remaining & adjacency[v], depth + 1);
    }
  };
  extend((1n << BigInt(size)) - 1n, 0);
  const k = best + 1;
  const bits = (value) => `${value}#${size}`;
  const member = (i) => `((x >>> ${i}) &&& ${bits(1)})`;
  const closed = adjacency.map((row, i) => `(${member(i)} = ${bits(0)} ∨ x &&& ~~~${bits(row | (1n << BigInt(i)))} = ${bits(0)})`);
  const count = Array.from({ length: size }, (_, i) => member(i)).join(" + ");
  return {
    statement: `∀ x : BitVec ${size}, ¬ ((${closed.join(" ∧ ")}) ∧ ${bits(k)} ≤ ${count})`,
    tactics: ["bv_decide"],
    note: `ω = ${best}, refuting a ${k}-clique`,
  };
}

function popcount(value) {
  let count = 0;
  for (let v = value; v !== 0n; v &= v - 1n) count++;
  return count;
}

export const FAMILIES = { linear, ring, clique };

function runLean(statement, tactic, timeoutSeconds) {
  const directory = mkdtempSync(join(tmpdir(), "nir-task-"));
  try {
    const file = join(directory, "Task.lean");
    writeFileSync(file, `import Std.Tactic.BVDecide\n\nset_option maxRecDepth 100000\nset_option maxHeartbeats 0\n\ntheorem task : ${statement} := by\n  ${tactic}\n`);
    const home = process.env.LEAN_HOME;
    const started = performance.now();
    const result = spawnSync(join(home, "bin", "lean"), [file], {
      env: { ...process.env, PATH: `${join(home, "bin")}:${process.env.PATH}`, LEAN_PATH: join(home, "lib", "lean") },
      timeout: timeoutSeconds * 1_000,
      encoding: "utf8",
    });
    const seconds = (performance.now() - started) / 1_000;
    const solved = result.status === 0 && !/error|sorry/u.test(result.stdout);
    return { solved, seconds, timedOut: result.signal !== null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  if (!process.env.LEAN_HOME) throw new Error("LEAN_HOME must point to Lean 4.35.0");
  const { values } = parseArgs({
    options: {
      family: { type: "string", default: Object.keys(FAMILIES).join(",") },
      sizes: { type: "string" },
      seeds: { type: "string", default: "3" },
      timeout: { type: "string", default: "60" },
    },
  });
  const defaults = { linear: [2, 4, 8, 16], ring: [2, 4, 8], clique: [8, 16, 24, 32] };
  for (const name of values.family.split(",")) {
    const family = FAMILIES[name];
    if (!family) throw new Error(`unknown family ${name}`);
    const sizes = values.sizes ? values.sizes.split(",").map(Number) : defaults[name];
    for (const size of sizes) {
      for (let s = 0; s < Number(values.seeds); s++) {
        const instance = family(`${name}-${size}-${s}`, size);
        for (const tactic of instance.tactics) {
          const run = runLean(instance.statement, tactic, Number(values.timeout));
          console.log(JSON.stringify({
            family: name, size, seed: s, tactic, solved: run.solved, timedOut: run.timedOut,
            seconds: Number(run.seconds.toFixed(2)), statementBytes: Buffer.byteLength(instance.statement),
            ...(instance.note ? { note: instance.note } : {}),
          }));
        }
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
