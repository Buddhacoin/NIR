import assert from "node:assert/strict";
import test from "node:test";

import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createFinalityProof, verifyFinalityProofChain, verifyRecentFinalityCheckpoint,
} from "../blockchain/light-client.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "../blockchain/state-snapshot.mjs";

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));

function fixture(networkId = "nir-chain-checkpoint-test") {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const validatorMembers = members(validators, "validator");
  const genesis = {
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: {
      adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60,
    },
    evaluators: members(evaluators, "evaluator"),
    genesisProtocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    genesisTimestamp: 0, networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address, validators: validatorMembers,
  };
  const chain = new NirChain(genesis);
  const append = (options = {}) => {
    const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1, ...options });
    const block = finalizeBlock(proposal, validators.slice(0, 3));
    chain.appendBlock(block);
    return block;
  };
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append({ protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
    version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION } });
  while (chain.height < activationHeight) append();
  return { append, chain, genesis, validatorMembers, validators };
}

test("v28 recent checkpoint verifies a bounded suffix after more than 512 blocks", () => {
  const value = fixture();
  const genesisHash = value.chain.blocks()[0].hash;
  const activation = value.chain.blocks().at(-1);
  assert.equal(activation.protocolVersion, 28);
  assert.equal(activation.chainIdentityGenesisHash, genesisHash);
  assert.equal(activation.validatorSetId, value.chain.validatorSetId);
  assert.equal(createFinalityProof(activation).format, "nir-finality-proof-v5");
  assert.equal(createFinalityProof(activation).header.format, "nir-finality-header-v4");

  for (let index = 0; index < 513; index += 1) value.append();
  const blocks = value.chain.blocks();
  const checkpointBlock = blocks.at(-2);
  const tip = blocks.at(-1);
  const checkpoint = verifyRecentFinalityCheckpoint(createFinalityProof(checkpointBlock), {
    expectedGenesisHash: genesisHash, expectedNetworkId: value.chain.networkId,
    trustedValidators: value.validatorMembers,
  });
  const verified = verifyFinalityProofChain([createFinalityProof(tip)], {
    checkpoint, expectedChainIdentityGenesisHash: genesisHash,
    expectedNetworkId: value.chain.networkId, trustedValidators: value.validatorMembers,
  });
  assert.equal(verified.tipHash, tip.hash);
  assert.equal(verified.chainIdentityGenesisHash, genesisHash);
  const snapshot = createStateSnapshot(value.chain, value.validators.slice(0, 3));
  verifyStateSnapshot(snapshot, {
    expectedNetworkId: value.chain.networkId, trustedValidators: value.validatorMembers,
  });
  const restored = NirChain.fromVerifiedSnapshot(value.genesis, snapshot);
  const next = finalizeBlock(restored.buildBlock({
    timestamp: restored.blocks().at(-1).timestamp + 1,
  }), value.validators.slice(0, 3));
  restored.appendBlock(next);
  assert.equal(next.chainIdentityGenesisHash, genesisHash);
});

test("v28 checkpoint rejects foreign same-network history, validator set and schema confusion", () => {
  const value = fixture("nir-shared-network-name");
  const foreign = fixture("nir-shared-network-name");
  const genesisHash = value.chain.blocks()[0].hash;
  const proof = createFinalityProof(value.chain.blocks().at(-1));
  assert.throws(() => verifyRecentFinalityCheckpoint(
    createFinalityProof(foreign.chain.blocks().at(-1)), {
      expectedGenesisHash: genesisHash, expectedNetworkId: value.chain.networkId,
      trustedValidators: foreign.validatorMembers,
    }), /another chain identity/);
  assert.throws(() => verifyRecentFinalityCheckpoint(proof, {
    expectedGenesisHash: genesisHash, expectedNetworkId: value.chain.networkId,
    trustedValidators: foreign.validatorMembers,
  }), /validator set is not trusted|vote is invalid/);
  const proposal = value.chain.buildBlock({ timestamp: value.chain.blocks().at(-1).timestamp + 1 });
  const { chainIdentityGenesisHash: _missing, ...missingIdentity } = proposal;
  assert.throws(() => value.chain.validateProposal(missingIdentity), /schema|unsupported value/);
  assert.throws(() => value.chain.validateProposal({
    ...proposal, validatorSetId: "0".repeat(64),
  }), /validator set commitment/);
});
