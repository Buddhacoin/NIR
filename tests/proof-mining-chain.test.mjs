import assert from "node:assert/strict";
import test from "node:test";

import {
  NirChain, createProofAnswerCommit, createProofAnswerReveal,
} from "../blockchain/chain.mjs";
import {
  MIN_REWARD_INTERVAL_MS, PROGRESS_REWARD_ESCROW_DELAY_BLOCKS,
  PROOF_MINING_PROTOCOL_VERSION, scheduledEpochBudget,
} from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { PROOF_MINING_V1, proofAnswerCommitment } from "../blockchain/proof-mining-state.mjs";
import { append, finalizeBeaconRound, findClique, fixture } from "./proof-mining-fixture.mjs";

const genesisHash = (chain) => chain.blockAtHeight(0).hash;
const openTask = (chain) => new Map(chain.proofMiningStatus().tasks.entries()).values().next().value;

test("a beacon round issues a task, an answer is committed and revealed, and the reward matures", () => {
  const { beacons, chain, miner, validators } = fixture();
  assert.equal(chain.protocolVersion, PROOF_MINING_PROTOCOL_VERSION);
  const state0 = chain.proofMiningStatus();
  assert.equal(state0.level, 0);
  assert.equal(state0.tasks.size, 0);

  const round = finalizeBeaconRound(chain, beacons, validators);
  const task = openTask(chain);
  assert.equal(task.round, round);
  assert.equal(task.status, "open");
  const vertices = findClique(task.seed, task.level);
  const salt = "ab".repeat(32);
  const recipient = generateWallet().address;
  const commitment = proofAnswerCommitment({ networkId: chain.networkId, recipient, salt,
    taskRound: task.round, vertices });
  const balanceBefore = chain.balance(miner.address);
  append(chain, { transactions: [createProofAnswerCommit({ chainIdentityGenesisHash: genesisHash(chain),
    commitment, networkId: chain.networkId, nonce: 0, taskRound: task.round, wallet: miner })] }, validators);
  assert.equal(chain.balance(miner.address), balanceBefore - 1_000n - PROOF_MINING_V1.commitBond);
  const reveal = createProofAnswerReveal({ chainIdentityGenesisHash: genesisHash(chain), commitment,
    networkId: chain.networkId, nonce: 1, recipient, salt, vertices, wallet: miner });
  // An answer signed for another genesis is refused.
  assert.throws(() => append(chain, { transactions: [createProofAnswerReveal({
    chainIdentityGenesisHash: "0".repeat(64), commitment, networkId: chain.networkId, nonce: 1,
    recipient, salt, vertices, wallet: miner })] }, validators), /proof answer transaction is invalid/);
  // Too early: the reveal must wait for its delay.
  assert.throws(() => append(chain, { transactions: [reveal] }, validators), /outside its window/);
  append(chain, {}, validators);
  append(chain, { transactions: [reveal] }, validators);
  assert.equal(chain.balance(miner.address), balanceBefore - 2_000n);
  const solved = chain.proofMiningStatus();
  assert.equal(solved.tasks.get(task.round).status, "solved");
  assert.equal(solved.pendingRewards.length, 1);

  // The next block at least ten minutes after the last reward escrows one epoch budget.
  const issuedBefore = chain.issued;
  const epoch = chain.nextIssuanceEpoch;
  append(chain, { timestamp: chain.blocks().at(-1).timestamp + MIN_REWARD_INTERVAL_MS }, validators);
  const budget = scheduledEpochBudget(epoch);
  assert.equal(chain.issued - issuedBefore, budget);
  assert.equal(chain.nextIssuanceEpoch, epoch + 1);
  assert.equal(chain.balance(recipient), 0n);
  for (let i = 0; i < PROGRESS_REWARD_ESCROW_DELAY_BLOCKS; i++) append(chain, {}, validators);
  assert.equal(chain.balance(recipient), budget);
  assert.equal(chain.proofMiningStatus().escrows.size, 0);
});

test("proof answers are refused before protocol version 37", () => {
  const { beacons, chain, miner, validators } = fixture(PROOF_MINING_PROTOCOL_VERSION - 1);
  finalizeBeaconRound(chain, beacons, validators);
  assert.equal(chain.proofMiningStatus(), null);
  assert.throws(() => append(chain, { transactions: [createProofAnswerCommit({
    chainIdentityGenesisHash: genesisHash(chain), commitment: "1".repeat(64), networkId: chain.networkId, nonce: 0, taskRound: 0, wallet: miner,
  })] }, validators), /protocol version 37/);
});

test("proof mining state survives a verified snapshot restore", () => {
  const { beacons, chain, genesis, miner, validators } = fixture();
  finalizeBeaconRound(chain, beacons, validators);
  const task = openTask(chain);
  append(chain, { transactions: [createProofAnswerCommit({ chainIdentityGenesisHash: genesisHash(chain),
    commitment: "7".repeat(64), networkId: chain.networkId, nonce: 0, taskRound: task.round, wallet: miner })] }, validators);
  const snapshot = chain.consensusSnapshot();
  const restored = NirChain.fromVerifiedSnapshot(genesis, {
    capabilityMemory: snapshot.capabilityMemory, checkpoint: chain.blocks().at(-1),
    evaluationAssignmentRoot: chain.evaluationAssignmentRoot, height: chain.height,
    networkId: chain.networkId, recoveryStateCommitment: chain.recoveryStateCommitment,
    state: snapshot.state, stateRoot: chain.stateRoot, tipHash: chain.tipHash,
    validatorSetId: chain.validatorSetId });
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.deepEqual(restored.proofMiningStatus(), chain.proofMiningStatus());
  // The unrevealed commit is charged when its window ends, on both copies.
  for (const copy of [chain, restored]) {
    for (let i = 0; i < PROOF_MINING_V1.revealWindowBlocks; i++) append(copy, {}, validators);
  }
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.equal(chain.burned, PROOF_MINING_V1.commitBond);
});
