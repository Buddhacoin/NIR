import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { transactionId } from "../blockchain/chain.mjs";
import {
  buildCliqueGraph, createMinerNodeClient, mineOneCliqueTask, searchClique, solveCliqueTask,
} from "../blockchain/clique-miner.mjs";
import { checkCliqueSearchAnswer, cliqueEdge, cliqueSearchParameters } from "../blockchain/clique-search.mjs";
import { createDeveloperNodeHttpServer } from "../blockchain/node-service.mjs";
import { proofAnswerCommitment, proofMiningView } from "../blockchain/proof-mining-state.mjs";
import { createWalletFile, signWalletProofAnswer } from "../blockchain/wallet-files.mjs";
import { append, finalizeBeaconRound, fixture } from "./proof-mining-fixture.mjs";

const seed = "3c".repeat(32);

test("the miner's graph is the checker's graph, read one hash per 256 edges", () => {
  const n = 70;
  const { rows } = buildCliqueGraph(seed, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      assert.equal(((rows[i][j >>> 5] >>> (j & 31)) & 1) === 1, cliqueEdge(seed, n, i, j), `${i}-${j}`);
    }
  }
});

test("the search finds valid cliques and stops when asked", () => {
  for (const level of [0, 8, 24]) {
    const { n, k } = cliqueSearchParameters(level);
    const vertices = searchClique(buildCliqueGraph(seed, n), k);
    assert.deepEqual(checkCliqueSearchAnswer(seed, level, vertices), { n, k });
  }
  const { n } = cliqueSearchParameters(40);
  assert.equal(searchClique(buildCliqueGraph(seed, n), n, { shouldStop: () => true }), null);
  const task = { level: 0, round: 3, seed };
  const answer = solveCliqueTask({ networkId: "nir-x", recipient: "nir1" + "a".repeat(64), task });
  assert.equal(answer.commitment, proofAnswerCommitment({ networkId: "nir-x",
    recipient: answer.recipient, salt: answer.salt, taskRound: 3, vertices: answer.vertices }));
});

// A real v35 chain behind the real developer HTTP service, with blocks
// produced on a timer as a network would.
test("the miner solves a network task through a node and its wallet file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-clique-miner-"));
  const password = "correct horse battery staple";
  const walletPath = join(directory, "miner.wallet");
  const { address } = createWalletFile({ password, path: walletPath });
  const { beacons, chain, validators } = fixture(undefined, { address });
  finalizeBeaconRound(chain, beacons, validators);
  const recipient = createWalletFile({ password, path: join(directory, "reward.wallet") }).address;
  const node = {
    get height() { return chain.height; },
    get networkId() { return chain.networkId; },
    get tipHash() { return chain.tipHash; },
    account: (who) => ({ address: who, atomicBalance: chain.balance(who).toString(),
      nextNonce: chain.nextNonce(who) }),
    proofMining: () => proofMiningView(chain.proofMiningStatus(),
      { height: chain.height, timestampMs: chain.tipTimestamp }),
    submitTransaction: (transaction) => {
      const block = append(chain, { transactions: [transaction] }, validators);
      return { blockHash: block.hash, height: block.height, transactionId: transactionId(transaction) };
    },
  };
  const server = createDeveloperNodeHttpServer(node);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ticker = setInterval(() => append(chain, {}, validators), 20);
  try {
    const client = createMinerNodeClient(`http://127.0.0.1:${server.address().port}`);
    const outcome = await mineOneCliqueTask({ address, client, pollMs: 10, recipient,
      sign: (operation) => signWalletProofAnswer({ operation, password, path: walletPath }) });
    assert.equal(outcome.result, "revealed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = chain.proofMiningStatus();
    assert.equal(state.tasks.get(outcome.task.round).status, "solved");
    const won = [...state.escrows.values(), ...state.pendingRewards];
    assert.ok(won.some((entry) => entry.recipient === recipient));
  } finally {
    clearInterval(ticker);
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a node before v35 reports mining as inactive", async () => {
  const outcome = await mineOneCliqueTask({ address: "nir1" + "b".repeat(64), sign: () => assert.fail(),
    client: { proofMining: async () => proofMiningView(null, { height: 5, timestampMs: 0 }) } });
  assert.equal(outcome.result, "inactive");
});
