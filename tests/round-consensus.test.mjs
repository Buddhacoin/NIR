import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockHash, finalizeBlock, NirChain, timeoutForRound } from "../blockchain/chain.mjs";
import { initializeDistributedDevnet } from "../blockchain/distributed-node.mjs";

test("round-one blocks require a quorum timeout certificate", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-round-certificate-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    const wallets = layout.validatorDirectories.map((directory) =>
      JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"), "utf8")));
    const invalidChain = new NirChain(genesis);
    const invalid = invalidChain.buildBlock({ timestamp: 1, round: 1, roundCertificate: [] });
    const invalidProposer = wallets.find(({ address }) => address === invalid.proposer);
    const invalidSigners = [invalidProposer, ...wallets.filter(({ address }) =>
      address !== invalid.proposer).slice(0, 2)];
    assert.throws(() => invalidChain.appendBlock(finalizeBlock(invalid, invalidSigners)),
      /round timeout quorum/);

    const chain = new NirChain(genesis);
    const value = chain.buildBlock({ timestamp: 1 });
    const timeoutFields = {
      blockHash: blockHash(value), height: 1, networkId: chain.networkId,
      nextRound: 1, previousHash: chain.tipHash,
    };
    const certificate = wallets.slice(0, 3).map((wallet) => timeoutForRound(timeoutFields, wallet));
    const block = chain.buildBlock({ timestamp: 1, round: 1, roundCertificate: certificate });
    assert.equal(blockHash(block), blockHash(value));
    assert.equal(block.stateRoot, value.stateRoot);
    assert.equal(block.accountStateRoot, value.accountStateRoot);
    assert.equal(block.capabilityMemoryRoot, value.capabilityMemoryRoot);
    assert.notEqual(block.stateRoot, "0".repeat(64));
    const proposer = wallets.find(({ address }) => address === block.proposer);
    const signers = [proposer, ...wallets.filter(({ address }) =>
      address !== block.proposer).slice(0, 2)];
    chain.appendBlock(finalizeBlock(block, signers));
    assert.equal(chain.height, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
