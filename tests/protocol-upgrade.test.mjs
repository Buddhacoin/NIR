import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeBlockStore, loadBlockStore, persistBlock } from "../blockchain/block-store.mjs";
import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  PROTOCOL_VERSION,
  SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof, verifyFinalityProofChain } from "../blockchain/light-client.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "../blockchain/state-snapshot.mjs";

const UPGRADE_FORMAT = "nir-protocol-upgrade-v1";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function fixture(options = {}) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const validatorMembers = members(validators, "validator");
  const genesis = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluationEnvironment: {
      adapter_protocol: "nir-application-adapter-v1",
      cpu_limit: 2,
      format: "nir-evaluation-environment-v1",
      image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30,
      runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60,
    },
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    networkId: "nir-protocol-upgrade-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validatorMembers,
  };
  return {
    chain: new NirChain(genesis, options),
    genesis,
    treasury,
    validatorMembers,
    validators,
  };
}

function finalized(chain, validators, options = {}) {
  return finalizeBlock(chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
    ...options,
  }), validators.slice(0, 3));
}

function append(chain, validators, options = {}) {
  const block = finalized(chain, validators, options);
  chain.appendBlock(block);
  return block;
}

function schedule(version, activationHeight) {
  return { activationHeight, format: UPGRADE_FORMAT, version };
}

test("a quorum-scheduled version activates exactly after its notice window", () => {
  const { chain, genesis, treasury, validatorMembers, validators } = fixture();
  const oldNode = new NirChain(genesis, { supportedProtocolVersions: [PROTOCOL_VERSION] });
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  const startingBalance = chain.balance(treasury.address);
  const startingIssued = chain.issued;
  const blocks = [];

  const schedulingBlock = finalized(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, activationHeight),
  });
  chain.appendBlock(schedulingBlock);
  oldNode.appendBlock(schedulingBlock);
  blocks.push(schedulingBlock);
  assert.equal(createFinalityProof(schedulingBlock).format, "nir-finality-proof-v2");
  assert.equal(createFinalityProof(schedulingBlock).header.format, "nir-finality-header-v1");
  assert.equal(schedulingBlock.recoveryStateCommitment, undefined);
  assert.deepEqual(chain.pendingProtocolUpgrade,
    schedule(PROTOCOL_VERSION + 1, activationHeight));
  assert.equal(chain.protocolVersion, PROTOCOL_VERSION);

  assert.throws(() => chain.buildBlock({
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, activationHeight + 1),
  }), /already pending/);

  while (chain.height < activationHeight - 1) {
    const block = finalized(chain, validators);
    chain.appendBlock(block);
    oldNode.appendBlock(block);
    blocks.push(block);
    assert.equal(block.protocolVersion, PROTOCOL_VERSION);
  }

  const activationProposal = chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
  });
  assert.equal(activationProposal.height, activationHeight);
  assert.equal(activationProposal.protocolVersion, PROTOCOL_VERSION + 1);
  const wrongVersion = { ...activationProposal, protocolVersion: PROTOCOL_VERSION };
  assert.throws(() => chain.validateProposal(wrongVersion), /schema|activation height/);
  const missingV25Commitment = structuredClone(activationProposal);
  delete missingV25Commitment.recoveryStateCommitment;
  assert.throws(() => chain.validateProposal(missingV25Commitment),
    /block schema|unsupported value type/);

  const activationBlock = finalizeBlock(activationProposal, validators.slice(0, 3));
  chain.appendBlock(activationBlock);
  blocks.push(activationBlock);
  assert.equal(createFinalityProof(activationBlock).format, "nir-finality-proof-v3");
  assert.equal(createFinalityProof(activationBlock).header.format, "nir-finality-header-v2");
  assert.match(activationBlock.recoveryStateCommitment, /^[0-9a-f]{64}$/);
  assert.throws(() => oldNode.appendBlock(activationBlock), /unsupported protocol version/);
  assert.equal(chain.protocolVersion, PROTOCOL_VERSION + 1);
  assert.equal(chain.pendingProtocolUpgrade, null);
  assert.equal(chain.balance(treasury.address), startingBalance);
  assert.equal(chain.issued, startingIssued);
  assert.throws(() => chain.buildBlock({
    protocolUpgrade: schedule(PROTOCOL_VERSION, activationHeight +
      MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
  }), /schedule is invalid/);

  const genesisBlock = chain.blocks()[0];
  const preActivation = verifyFinalityProofChain(
    blocks.slice(0, -1).map(createFinalityProof), {
      checkpoint: {
        height: 0,
        protocolVersion: PROTOCOL_VERSION,
        stateRoot: genesisBlock.stateRoot,
        tipHash: genesisBlock.hash,
      },
      expectedNetworkId: chain.networkId,
      supportedProtocolVersions: [PROTOCOL_VERSION],
      trustedValidators: validatorMembers,
    },
  );
  assert.equal(preActivation.protocolVersion, PROTOCOL_VERSION);
  assert.equal(preActivation.pendingProtocolUpgrade.activationHeight, activationHeight);
  assert.throws(() => verifyFinalityProofChain(blocks.map(createFinalityProof), {
    checkpoint: {
      height: 0,
      protocolVersion: PROTOCOL_VERSION,
      stateRoot: genesisBlock.stateRoot,
      tipHash: genesisBlock.hash,
    },
    expectedNetworkId: chain.networkId,
    supportedProtocolVersions: [PROTOCOL_VERSION],
    trustedValidators: validatorMembers,
  }), /finality header is invalid|unsupported protocol version/);
});

test("short notice, rollback, skipped versions, and minority scheduling fail closed", () => {
  const { chain, validators } = fixture();
  assert.throws(() => fixture({ supportedProtocolVersions: [
    PROTOCOL_VERSION, PROTOCOL_VERSION + 2,
  ] }), /contiguous from genesis/);
  assert.throws(() => chain.buildBlock({
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
  }), /schedule is invalid/);
  assert.throws(() => chain.buildBlock({
    protocolUpgrade: schedule(PROTOCOL_VERSION, 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
  }), /schedule is invalid/);
  assert.throws(() => chain.buildBlock({
    protocolUpgrade: schedule(PROTOCOL_VERSION + 2, 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
  }), /schedule is invalid/);

  const proposal = chain.buildBlock({
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
    timestamp: 1,
  });
  const minority = finalizeBlock(proposal, validators.slice(0, 2));
  assert.throws(() => chain.appendBlock(minority), /quorum not reached/);
  assert.equal(chain.height, 0);
  assert.equal(chain.pendingProtocolUpgrade, null);

  const left = finalized(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
  });
  const right = finalized(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, 2 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS),
  });
  assert.notEqual(left.hash, right.hash);
  chain.appendBlock(left);
  assert.throws(() => chain.appendBlock(right), /unexpected block height/);
  assert.deepEqual(chain.pendingProtocolUpgrade, left.protocolUpgrade);
});

test("pending upgrade survives a quorum snapshot and unknown activation halts", () => {
  const { chain, genesis, validatorMembers, validators } = fixture();
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 1, activationHeight),
  });
  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  verifyStateSnapshot(snapshot, {
    expectedNetworkId: chain.networkId,
    trustedValidators: validatorMembers,
  });
  const restored = NirChain.fromVerifiedSnapshot(genesis, snapshot);
  assert.deepEqual(restored.pendingProtocolUpgrade, chain.pendingProtocolUpgrade);
  const next = finalized(chain, validators);
  chain.appendBlock(next);
  restored.appendBlock(next);
  assert.equal(restored.tipHash, chain.tipHash);

  while (chain.height < activationHeight) append(chain, validators);
  assert.equal(chain.protocolVersion, PROTOCOL_VERSION + 1);
  const assignmentRootActivation = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 2, assignmentRootActivation),
  });
  while (chain.height < assignmentRootActivation) append(chain, validators);
  assert.equal(chain.protocolVersion, PROTOCOL_VERSION + 2);
  const extendedAssignmentActivation = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 3, extendedAssignmentActivation),
  });
  while (chain.height < extendedAssignmentActivation) append(chain, validators);
  assert.equal(chain.protocolVersion, PROTOCOL_VERSION + 3);
  const checkpointActivation = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 4, checkpointActivation),
  });
  while (chain.height < checkpointActivation) append(chain, validators);
  assert.equal(chain.protocolVersion, PROTOCOL_VERSION + 4);
  const unknownActivation = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, validators, {
    protocolUpgrade: schedule(PROTOCOL_VERSION + 5, unknownActivation),
  });
  while (chain.height < unknownActivation - 1) append(chain, validators);
  assert.throws(() => chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
  }), /unsupported protocol version/);
  assert.equal(chain.height, unknownActivation - 1);
  assert.equal(chain.protocolVersion, PROTOCOL_VERSION + 4);
});

test("durable replay preserves the exact activation schedule", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-protocol-upgrade-restart-"));
  const { chain, genesis, validators } = fixture();
  try {
    initializeBlockStore(temporary, chain);
    const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
    const block = finalized(chain, validators, {
      protocolUpgrade: schedule(PROTOCOL_VERSION + 1, activationHeight),
    });
    chain.appendBlock(block);
    persistBlock(temporary, block, chain);
    const restarted = loadBlockStore(temporary, genesis).chain;
    assert.equal(restarted.tipHash, chain.tipHash);
    assert.equal(restarted.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(restarted.pendingProtocolUpgrade,
      schedule(PROTOCOL_VERSION + 1, activationHeight));
    const next = finalized(chain, validators);
    chain.appendBlock(next);
    restarted.appendBlock(next);
    assert.equal(restarted.stateRoot, chain.stateRoot);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
