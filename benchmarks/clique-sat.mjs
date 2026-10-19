// Research tooling, not consensus code (docs/proof-mining.md §7.2.4): clique
// tasks as SAT. Answers to network clique tasks without Lean.
// A clique is shown by its vertices. Its absence is shown by an LRAT
// refutation of a CNF formula that every node builds itself from the task.
// Lean's bv_decide checks such certificates with compiled code, which the
// kernel policy rejects; this checker is small enough to review and counts its
// work deterministically, like the kernel step budget.

export const SAT_CHECK_PROFILE_V1 = Object.freeze({
  id: "nir-sat-check-v1",
  // Literal visits per refutation, counted deterministically. Provisional.
  maxCheckSteps: 500_000_000,
  maxCertificateBytes: 256 * 1024 * 1024,
});

function edge({ n, graph }, i, j) {
  return ((graph >> BigInt(i * n + j)) & 1n) === 1n;
}

// CNF that is satisfiable exactly when the graph has `k` pairwise adjacent
// vertices. Variable `i + 1` marks vertex `i`. Auxiliary variable s(i, j),
// for 1 <= i <= n and 1 <= j <= k, can be true only if at least `j` of the
// first `i` vertices are marked (a sequential counter), and s(n, k) is
// required. So any satisfying assignment marks a clique of size >= k, and an
// unsatisfiable formula means there is none.
export function cliqueCnf(instance) {
  const { n, k } = instance;
  const s = (i, j) => n + (i - 1) * k + j;
  const clauses = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!edge(instance, i, j)) clauses.push([-(i + 1), -(j + 1)]);
    }
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= k; j++) {
      // s(i, j) -> s(i-1, j) or x_i
      clauses.push(i > 1 ? [-s(i, j), s(i - 1, j), i] : [-s(i, j), i]);
      // s(i, j) -> s(i-1, j) or s(i-1, j-1), when j > 1
      if (j > 1) clauses.push(i > 1 ? [-s(i, j), s(i - 1, j), s(i - 1, j - 1)] : [-s(i, j)]);
    }
  }
  clauses.push([s(n, k)]);
  return { variables: n + n * k, clauses };
}

export function cliqueCnfDimacs(instance) {
  const { variables, clauses } = cliqueCnf(instance);
  return `p cnf ${variables} ${clauses.length}\n${clauses.map((c) => `${c.join(" ")} 0`).join("\n")}\n`;
}

// A shown clique: at least `k` distinct vertices, pairwise adjacent.
export function checkCliqueWitness(instance, vertices) {
  const { n, k } = instance;
  if (!Array.isArray(vertices) || vertices.length < k || vertices.length > n) {
    throw new Error("clique witness has the wrong size");
  }
  vertices.forEach((v, i) => {
    if (!Number.isSafeInteger(v) || v < 0 || v >= n || (i > 0 && v <= vertices[i - 1])) {
      throw new Error("clique witness must list distinct vertices in increasing order");
    }
  });
  for (let a = 0; a < vertices.length; a++) {
    for (let b = a + 1; b < vertices.length; b++) {
      if (!edge(instance, vertices[a], vertices[b])) throw new Error("clique witness has two non-adjacent vertices");
    }
  }
  return { outcome: "proved" };
}

function integers(tokens, label) {
  return tokens.map((token) => {
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(token)) throw new Error(`LRAT ${label} is not an integer`);
    const value = Number(token);
    if (!Number.isSafeInteger(value)) throw new Error(`LRAT ${label} is out of range`);
    return value;
  });
}

// Checks a textual LRAT refutation using reverse unit propagation only.
// Every added clause must follow from its hint clauses, in order, by unit
// propagation; RAT steps are rejected. The refutation succeeds once the empty
// clause is added.
export function checkLratRefutation(cnf, text, profile = SAT_CHECK_PROFILE_V1) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > profile.maxCertificateBytes) {
    throw new Error("LRAT certificate is missing or too large");
  }
  const clauses = new Map();
  cnf.clauses.forEach((clause, i) => clauses.set(i + 1, clause));
  let lastId = cnf.clauses.length;
  let steps = 0;
  const value = new Int8Array(cnf.variables + 1);
  const assigned = [];
  const assign = (v, sign) => {
    value[v] = sign;
    assigned.push(v);
  };
  const literal = (lit) => {
    const v = Math.abs(lit);
    if (lit === 0 || v > cnf.variables) throw new Error("LRAT literal is out of range");
    return v;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("c")) continue;
    const tokens = line.split(/\s+/u);
    const [id] = integers([tokens[0]], "clause id");
    if (tokens[1] === "d") {
      const ids = integers(tokens.slice(2), "deletion");
      if (ids.at(-1) !== 0) throw new Error("LRAT deletion is not terminated");
      for (const deleted of ids.slice(0, -1)) {
        if (!clauses.delete(deleted)) throw new Error("LRAT deletes an unknown clause");
      }
      continue;
    }
    if (id <= lastId) throw new Error("LRAT clause ids must increase");
    const values = integers(tokens.slice(1), "line");
    const split = values.indexOf(0);
    if (split === -1 || values.at(-1) !== 0 || values.indexOf(0, split + 1) !== values.length - 1) {
      throw new Error("LRAT addition is malformed");
    }
    const lemma = values.slice(0, split);
    const hints = values.slice(split + 1, -1);
    // Assume the negation of the lemma, then propagate the hints in order.
    for (const v of assigned) value[v] = 0;
    assigned.length = 0;
    for (const lit of lemma) {
      steps++;
      const v = literal(lit);
      if (value[v] === -Math.sign(lit)) throw new Error("LRAT lemma repeats a literal");
      if (value[v] !== 0) throw new Error("LRAT lemma is a tautology");
      assign(v, -Math.sign(lit));
    }
    let conflict = false;
    for (const hint of hints) {
      if (hint <= 0) throw new Error("LRAT RAT steps are not accepted");
      const clause = clauses.get(hint);
      if (!clause) throw new Error("LRAT hint refers to an unknown clause");
      let unit = 0;
      let open = 0;
      for (const lit of clause) {
        steps++;
        const v = literal(lit);
        const current = value[v] * Math.sign(lit);
        if (current > 0) throw new Error("LRAT hint is already satisfied");
        if (current === 0) {
          open++;
          unit = lit;
        }
      }
      if (steps > profile.maxCheckSteps) throw new Error("LRAT step limit exceeded");
      if (open === 0) {
        conflict = true;
        break;
      }
      if (open !== 1) throw new Error("LRAT hint is not unit");
      assign(Math.abs(unit), Math.sign(unit));
    }
    if (!conflict) throw new Error("LRAT lemma does not follow from its hints");
    clauses.set(id, lemma);
    lastId = id;
    if (lemma.length === 0) return { outcome: "refuted", steps };
  }
  throw new Error("LRAT certificate does not derive the empty clause");
}
