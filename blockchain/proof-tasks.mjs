import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { PROOF_CHECK_PROFILE_V1, digest, nameHash, parseKernelExport } from "./proof-export.mjs";

// The Lean form of network clique tasks (docs/proof-mining.md §7.2.2). Every
// node derives the same task from public randomness: no person chooses it and
// no one knows its answer in advance. A task asks to prove or refute that a
// random graph has a clique of `k` vertices; both answers are finite and
// decidable, so one of them always has a proof. Issuance does not use this
// form: it asks only to find a clique (clique-search.mjs), whose answer is a
// few vertex numbers rather than a proof.

const CLIQUE_LIBRARY_URL = new URL("../protocol/proof-tasks/clique-library.ndjson", import.meta.url);
export const CLIQUE_LIBRARY_SHA3 = "6d0b09e54936a71b40265e0a9caf70983baf2c2922d64dedc7c697fa62d7e3b4";
export const MIN_CLIQUE_VERTICES = 3;
export const MAX_CLIQUE_VERTICES = 1_024;

let library = null;

function cliqueLibrary() {
  if (library === null) {
    const text = readFileSync(CLIQUE_LIBRARY_URL, "utf8");
    if (createHash("sha3-256").update(text).digest("hex") !== CLIQUE_LIBRARY_SHA3) {
      throw new Error("clique task library does not match its pinned hash");
    }
    library = text;
  }
  return library;
}

function binomial(n, k) {
  let result = 1n;
  for (let i = 0n; i < k; i++) result = (result * (n - i)) / (i + 1n);
  return result;
}

// The smallest `k` at which a random graph is expected to hold fewer than one
// `k`-clique: C(n, k) < 2^(k(k-1)/2). Near this size both answers are possible
// and neither is cheap.
export function cliqueThreshold(n) {
  for (let k = 2n; ; k++) {
    if (binomial(BigInt(n), k) < 1n << ((k * (k - 1n)) / 2n)) return Number(k);
  }
}

// A random graph on `n` vertices, G(n, 1/2), drawn from `seed`. Bit
// `i * n + j` of the adjacency number marks the edge between `i` and `j`.
export function cliqueInstance(seed, n) {
  if (typeof seed !== "string" || !/^[0-9a-f]{64}$/u.test(seed)) {
    throw new Error("clique task seed must be 64 lowercase hexadecimal characters");
  }
  if (!Number.isSafeInteger(n) || n < MIN_CLIQUE_VERTICES || n > MAX_CLIQUE_VERTICES) {
    throw new Error("clique task size is out of range");
  }
  let counter = 0;
  let block = Buffer.alloc(0);
  let bit = 0;
  const nextBit = () => {
    if (bit === block.length * 8) {
      block = createHash("sha3-256").update(`NIR/PROOF_TASK/CLIQUE/v1\0${seed}\0${counter++}`).digest();
      bit = 0;
    }
    const value = (block[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return value;
  };
  let graph = 0n;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (nextBit() === 1) graph |= (1n << BigInt(i * n + j)) | (1n << BigInt(j * n + i));
    }
  }
  return { n, k: cliqueThreshold(n), graph };
}

// The Lean source a miner proves against. Elaborating it reproduces exactly the
// declaration `cliqueTaskExport` appends.
export function cliqueTaskSource({ n, k, graph }) {
  return `def NIR.statement : Prop := NIR.Clique.HasClique ${n} ${k} ${graph}\n`;
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The task's kernel export: the pinned library followed by
// `def NIR.statement : Prop := NIR.Clique.HasClique n k g`, in the form and
// order Lean's exporter writes it, reusing every name and expression the
// library already contains.
export function cliqueTaskExport(instance) {
  const text = cliqueLibrary();
  const file = parseKernelExport(text);
  const lines = [];
  const add = (record) => {
    file.addLine(record);
    lines.push(sortedJson(record));
  };
  const name = (dotted) => {
    let index = 0;
    const components = [];
    for (const part of dotted.split(".")) {
      components.push({ s: part });
      const existing = file.nameIndex.get(digest("NAME", components));
      if (existing !== undefined) index = existing;
      else {
        const assigned = file.names.length;
        add({ in: assigned, str: { pre: index, str: part } });
        index = assigned;
      }
    }
    return index;
  };
  const expr = (kind, body) => {
    const existing = file.exprIndex.get(file.exprShape(kind, body).hash);
    if (existing !== undefined) return existing;
    const assigned = file.exprs.length;
    add({ ie: assigned, [kind]: body });
    return assigned;
  };
  const constant = (dotted) => expr("const", { name: name(dotted), us: [] });
  const app = (fn, arg) => expr("app", { fn, arg });

  // `(v : Nat)` elaborates to `@OfNat.ofNat.{0} Nat v (instOfNatNat v)`.
  const ofNat = app(expr("const", { name: name("OfNat.ofNat"), us: [0] }), constant("Nat"));
  const natInstance = constant("instOfNatNat");
  const literal = (value) => {
    const raw = expr("natVal", String(value));
    return app(app(ofNat, raw), app(natInstance, raw));
  };
  // Name first, as Lean's exporter does, then the value from the head outward.
  const statementName = name(PROOF_CHECK_PROFILE_V1.statementName);
  let value = constant("NIR.Clique.HasClique");
  for (const argument of [instance.n, instance.k, instance.graph]) value = app(value, literal(argument));
  const hasClique = file.declarations.get(nameHash("NIR.Clique.HasClique"));
  add({
    def: {
      all: [statementName],
      hints: { regular: hasClique.hints.regular + 1 },
      levelParams: [],
      name: statementName,
      safety: "safe",
      type: expr("sort", 0),
      value,
    },
  });
  return `${text.endsWith("\n") ? text : `${text}\n`}${lines.join("\n")}\n`;
}
