import { createHash } from "node:crypto";

// Issuance tasks (docs/proof-mining.md §7.2.4): find `k` pairwise adjacent
// vertices in a random graph G(n, 1/2) drawn from public randomness. A clique
// this large almost surely exists, nobody knows where in advance, and finding
// one is believed hard beyond about log2(n) vertices, while the answer is `k`
// numbers that any node checks with k(k-1)/2 hashes.
//
// The graph is never built by the checker: edge (i, j) is one bit of a SHA3
// stream, the same stream `cliqueInstance` in proof-tasks.mjs reads in order.

export const CLIQUE_SEARCH_V1 = Object.freeze({
  // Level L asks for a clique of size baseClique + floor(L / levelsPerClique)
  // in the smallest graph expected to hold at least
  // 2^(maxExpectedLog2 - expectedStepLog2 * (L % levelsPerClique)) of them:
  // fewer expected cliques make each level harder than the one before.
  baseClique: 10,
  levelsPerClique: 8,
  maxExpectedLog2: 14,
  expectedStepLog2: 2,
  maxLevel: 159,
});

const SEED = /^[0-9a-f]{64}$/u;

function binomial(n, k) {
  let result = 1n;
  for (let i = 0n; i < k; i++) result = (result * (n - i)) / (i + 1n);
  return result;
}

const parametersByLevel = new Map();

// Graph size and clique size for a difficulty level, by exact integer
// arithmetic: n is the least with C(n, k) >= 2^(target + k(k-1)/2).
export function cliqueSearchParameters(level, params = CLIQUE_SEARCH_V1) {
  if (!Number.isSafeInteger(level) || level < 0 || level > params.maxLevel) {
    throw new Error("clique search level is out of range");
  }
  if (params === CLIQUE_SEARCH_V1 && parametersByLevel.has(level)) return parametersByLevel.get(level);
  const k = params.baseClique + Math.floor(level / params.levelsPerClique);
  const expectedLog2 = params.maxExpectedLog2 - params.expectedStepLog2 * (level % params.levelsPerClique);
  const bound = 1n << BigInt(expectedLog2 + (k * (k - 1)) / 2);
  // Grow quickly, then search back down to the least n.
  let high = k;
  while (binomial(BigInt(high), BigInt(k)) < bound) high *= 2;
  let low = Math.floor(high / 2);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (binomial(BigInt(middle), BigInt(k)) >= bound) high = middle;
    else low = middle + 1;
  }
  const result = Object.freeze({ n: Math.max(high, k), k });
  if (params === CLIQUE_SEARCH_V1) parametersByLevel.set(level, result);
  return result;
}

// Bit `i < j` of the graph: position i*n - i(i+1)/2 + (j - i - 1) of the
// SHA3 stream, 256 bits per block, most significant bit first.
export function cliqueEdge(seed, n, i, j) {
  if (i === j) return false;
  const [a, b] = i < j ? [i, j] : [j, i];
  const position = a * n - (a * (a + 1)) / 2 + (b - a - 1);
  const block = createHash("sha3-256")
    .update(`NIR/PROOF_TASK/CLIQUE/v1\0${seed}\0${Math.floor(position / 256)}`).digest();
  const bit = position % 256;
  return ((block[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
}

// Accepts exactly `k` distinct vertices in increasing order, pairwise adjacent.
export function checkCliqueSearchAnswer(seed, level, vertices, params = CLIQUE_SEARCH_V1) {
  if (typeof seed !== "string" || !SEED.test(seed)) {
    throw new Error("clique search seed must be 64 lowercase hexadecimal characters");
  }
  const { n, k } = cliqueSearchParameters(level, params);
  if (!Array.isArray(vertices) || vertices.length !== k) {
    throw new Error(`clique search answer must list exactly ${k} vertices`);
  }
  vertices.forEach((v, i) => {
    if (!Number.isSafeInteger(v) || v < 0 || v >= n || (i > 0 && v <= vertices[i - 1])) {
      throw new Error("clique search answer must list distinct vertices in increasing order");
    }
  });
  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      if (!cliqueEdge(seed, n, vertices[a], vertices[b])) {
        throw new Error("clique search answer has two non-adjacent vertices");
      }
    }
  }
  return { n, k };
}
