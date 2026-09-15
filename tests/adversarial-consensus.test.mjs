import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockHash, NirChain, voteForBlock } from "../blockchain/chain.mjs";
import { initializeDistributedDevnet } from "../blockchain/distributed-node.mjs";

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffledDeliveries(random, honestIndexes) {
  const deliveries = [];
  for (const validator of honestIndexes) {
    for (const value of ["first", "second"]) {
      if (random() < 0.28) continue; // dropped
      const copies = random() < 0.45 ? 2 : 1; // replayed
      for (let copy = 0; copy < copies; copy += 1) {
        deliveries.push({ delay: Math.floor(random() * 10_000), validator, value });
      }
    }
  }
  return deliveries.sort((left, right) => left.delay - right.delay ||
    left.validator - right.validator || left.value.localeCompare(right.value));
}

test("512 delayed, dropped, reordered, and replayed schedules cannot finalize conflicting values", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-adversarial-consensus-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    const wallets = layout.validatorDirectories.map((directory) =>
      JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"), "utf8")));
    const template = new NirChain(genesis);
    const first = template.buildBlock({ timestamp: 1 });
    const second = template.buildBlock({ timestamp: 2 });
    assert.notEqual(blockHash(first), blockHash(second));
    const proposerIndex = wallets.findIndex(({ address }) => address === first.proposer);
    const honestIndexes = [0, 1, 2, 3].filter((index) => index !== proposerIndex);

    for (let seed = 1; seed <= 512; seed += 1) {
      const random = randomSource(seed);
      const proposals = { first, second };
      const locks = new Map();
      const votes = {
        first: new Map([[first.proposer, voteForBlock(first, wallets[proposerIndex])]]),
        second: new Map([[second.proposer, voteForBlock(second, wallets[proposerIndex])]]),
      };
      for (const delivery of shuffledDeliveries(random, honestIndexes)) {
        const proposal = proposals[delivery.value];
        const hash = blockHash(proposal);
        const existing = locks.get(delivery.validator);
        if (existing && existing.hash !== hash) continue;
        if (!existing) {
          locks.set(delivery.validator, {
            hash,
            vote: voteForBlock(proposal, wallets[delivery.validator]),
          });
        }
        votes[delivery.value].set(
          wallets[delivery.validator].address,
          locks.get(delivery.validator).vote,
        );
      }

      const finalized = [];
      for (const value of ["first", "second"]) {
        if (votes[value].size < 3) continue;
        const proposal = proposals[value];
        const block = {
          ...proposal,
          certificate: [...votes[value].values()],
          hash: blockHash(proposal),
        };
        const verifier = new NirChain(genesis);
        verifier.appendBlock(block);
        finalized.push(block.hash);
      }
      assert.ok(finalized.length <= 1, `conflicting finality in schedule ${seed}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
