import { createHash, randomBytes } from "node:crypto";

import { cliqueSearchParameters } from "./clique-search.mjs";
import { requestJson } from "./http-client.mjs";
import { proofAnswerCommitment } from "./proof-mining-state.mjs";

// Miner side of network clique tasks (docs/proof-mining.md §7.2.3). Nothing
// here is consensus: a faster search simply wins more often. The network
// accepts any `k` pairwise adjacent vertices, however they were found.

// The whole graph as bit rows, reading the task's SHA3 stream in order: one
// hash per 256 edges, instead of one per edge as the checker does.
export function buildCliqueGraph(seed, n) {
  const words = Math.ceil(n / 32);
  const rows = Array.from({ length: n }, () => new Uint32Array(words));
  let counter = 0;
  let block = null;
  let bit = 256;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (bit === 256) {
        block = createHash("sha3-256").update(`NIR/PROOF_TASK/CLIQUE/v1\0${seed}\0${counter++}`).digest();
        bit = 0;
      }
      if ((block[bit >> 3] >> (7 - (bit & 7))) & 1) {
        rows[i][j >>> 5] |= 1 << (j & 31);
        rows[j][i >>> 5] |= 1 << (i & 31);
      }
      bit++;
    }
  }
  return { n, rows, words };
}

// Branch and bound: extend the current clique only with later vertices
// adjacent to all of it, and give up on a branch whose candidates cannot
// reach `k`. Candidate lists shrink fast with depth, which made this simple
// form faster than recomputing bit sets at every step. Returns the vertices
// in increasing order, or null when `shouldStop` says so or no clique exists.
// `onProgress` hears the number of branches visited and the deepest partial
// clique so far, every 65,536 branches.
export function searchClique({ n, rows }, k, { shouldStop = () => false, onProgress = () => {} } = {}) {
  let visited = 0;
  let deepest = 0;
  const adjacent = (v, u) => ((rows[v][u >>> 5] >>> (u & 31)) & 1) === 1;
  const extend = (chosen, candidates) => {
    if (chosen.length === k) return chosen;
    if (chosen.length > deepest) deepest = chosen.length;
    if ((++visited & 0xffff) === 0) {
      onProgress({ deepest, visited });
      if (shouldStop()) throw new SearchStopped();
    }
    for (let x = 0; x < candidates.length && chosen.length + candidates.length - x >= k; x++) {
      const v = candidates[x];
      const next = [];
      for (let y = x + 1; y < candidates.length; y++) if (adjacent(v, candidates[y])) next.push(candidates[y]);
      if (chosen.length + 1 + next.length >= k) {
        const found = extend([...chosen, v], next);
        if (found) return found;
      }
    }
    return null;
  };
  try {
    const found = extend([], Array.from({ length: n }, (_, v) => v));
    onProgress({ deepest: found ? k : deepest, visited });
    return found;
  } catch (error) {
    if (error instanceof SearchStopped) return null;
    throw error;
  }
}

class SearchStopped extends Error {}

// Solves one task and prepares what the miner must publish: the commitment
// now, and the salt and vertices for the reveal later.
export function solveCliqueTask({ networkId, task, recipient, shouldStop, onProgress,
  salt = randomBytes(32).toString("hex") }) {
  const { n, k } = cliqueSearchParameters(task.level);
  const vertices = searchClique(buildCliqueGraph(task.seed, n), k, { onProgress, shouldStop });
  if (vertices === null) return null;
  return {
    commitment: proofAnswerCommitment({ networkId, recipient, salt, taskRound: task.round, vertices }),
    recipient,
    salt,
    taskRound: task.round,
    vertices,
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mines one task end to end through a node: pick the oldest open task, find a
// clique before the task closes, commit, wait out the reveal delay, reveal.
// `client` talks to the node; `sign` turns an operation into a transaction,
// so keys never pass through this function.
// `solve` may move the search elsewhere, such as a worker thread; it gets the
// same arguments as solveCliqueTask. `onTask` hears the chosen task first.
export async function mineOneCliqueTask({ client, sign, address, recipient = address,
  now = Date.now, pollMs = 1_000, log = () => {}, shouldStop = () => false,
  solve = solveCliqueTask, onTask = () => {} }) {
  const status = await client.proofMining();
  if (!status.active) return { result: "inactive" };
  if (!/^[0-9a-f]{64}$/.test(status.chainIdentityGenesisHash ?? "")) {
    throw new Error("the node did not report its genesis hash");
  }
  // Task times are block times; translate the deadline to the local clock.
  const task = status.openTasks.find((candidate) => candidate.closesAtMs > status.timestampMs);
  if (!task) return { result: "no-open-task" };
  const deadline = now() + (task.closesAtMs - status.timestampMs);
  log(`task ${task.round}: level ${task.level}, searching`);
  onTask(task);
  const { networkId } = await client.health();
  const started = now();
  const answer = await solve({ deadline, networkId, recipient, task,
    shouldStop: () => shouldStop() || now() > deadline });
  if (answer === null) return { result: "not-found", task };
  log(`task ${task.round}: found ${answer.vertices.length} vertices in ${now() - started} ms`);
  const nonce = (await client.account(address)).nextNonce;
  const { chainIdentityGenesisHash } = status;
  await client.submit(sign({ chainIdentityGenesisHash, commitment: answer.commitment, networkId, nonce,
    taskRound: task.round, type: "proof-answer-commit" }));
  // The commit is in once the nonce moves; reveal no sooner than the delay.
  let committedHeight = null;
  while (committedHeight === null) {
    if ((await client.account(address)).nextNonce > nonce) committedHeight = (await client.health()).height;
    else await pause(pollMs);
  }
  while ((await client.health()).height < committedHeight + status.revealDelayBlocks) await pause(pollMs);
  await client.submit(sign({ chainIdentityGenesisHash, commitment: answer.commitment, networkId,
    nonce: nonce + 1,
    recipient: answer.recipient, salt: answer.salt, type: "proof-answer-reveal",
    vertices: answer.vertices }));
  log(`task ${task.round}: revealed; the reward follows if this commit was the earliest`);
  return { result: "revealed", task, answer };
}

// The node calls a miner needs, over the node's HTTP interface.
export function createMinerNodeClient(baseUrl) {
  const call = async (path, body) => {
    const { body: value, ok, status } = await requestJson(new URL(path, baseUrl).toString(),
      body === undefined ? {} : { body });
    if (!ok) throw new Error(`node answered ${status}: ${value?.error ?? "unknown error"}`);
    return value;
  };
  return {
    account: (address) => call(`/v1/accounts/${address}`),
    health: () => call("/health"),
    proofMining: () => call("/v1/proof-mining"),
    submit: (transaction) => call("/v1/transactions", transaction),
  };
}
