import assert from "node:assert/strict";
import test from "node:test";

import { publicWallet, generateWallet } from "../blockchain/crypto.mjs";
import {
  blockHeaderHash,
  createTransfer,
  createValidatorBond,
  finalizeBlock,
  NirChain,
} from "../blockchain/chain.mjs";
import {
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { createFinalityProof, verifyFinalityProofChain } from "../blockchain/light-client.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import { createPeerRegistry, EMPTY_PEER_REGISTRY_HASH } from "../blockchain/peer-registry.mjs";
import {
  activeValidatorSet,
  scheduleValidatorRotation,
  validatorSetId,
} from "../blockchain/validator-rotation.mjs";

function member(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

test("finality rotation is delayed and keeps a safe overlap", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newcomers = Array.from({ length: 2 }, generateWallet);
  const current = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const proposed = [current[0], current[1], member(newcomers[0], "new-0"), member(newcomers[1], "new-1")];
  const bonds = new Map([...oldWallets, ...newcomers].map((wallet) => [wallet.address, MIN_VALIDATOR_BOND]));
  const pending = scheduleValidatorRotation({ current, proposed, bonds, currentHeight: 10, activationHeight: 15 });
  assert.deepEqual(activeValidatorSet({ current, pending, height: 14 }), current);
  assert.deepEqual(activeValidatorSet({ current, pending, height: 15 }), pending.validators);
});

test("an abrupt takeover, short notice, or unbonded member is rejected", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newWallets = Array.from({ length: 4 }, generateWallet);
  const current = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const replacement = newWallets.map((wallet, index) => member(wallet, `new-${index}`));
  const bonds = new Map([...oldWallets, ...newWallets].map((wallet) => [wallet.address, MIN_VALIDATOR_BOND]));
  assert.throws(() => scheduleValidatorRotation({
    current, proposed: replacement, bonds, currentHeight: 10, activationHeight: 15,
  }), /one-third overlap/);
  assert.throws(() => scheduleValidatorRotation({
    current, proposed: current, bonds, currentHeight: 10, activationHeight: 14,
  }), /delay/);
  bonds.delete(oldWallets[0].address);
  assert.throws(() => scheduleValidatorRotation({
    current, proposed: current, bonds, currentHeight: 10, activationHeight: 15,
  }), /bond/);
});

test("the finalized chain activates a scheduled set and rejects old-set certificates", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newWallets = Array.from({ length: 2 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const oldTransports = Array.from({ length: 4 }, generateWallet);
  const current = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const initialPeerRegistry = createPeerRegistry({
    activationHeight: 0,
    epoch: 0,
    networkId: "nir-rotation-test",
    peers: oldWallets.map((wallet, index) => ({
      tlsCertificateSha256: null,
      transport: publicWallet(oldTransports[index]),
      url: `http://127.0.0.1:${9300 + index}`,
      validatorAddress: wallet.address,
    })),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  }, oldWallets.slice(0, 3));
  const chain = new NirChain({
    networkId: "nir-rotation-test", validators: current,
    evaluationEnvironment: {
      adapter_protocol: "nir-application-adapter-v1",
      cpu_limit: 2,
      format: "nir-evaluation-environment-v1",
      image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30,
      runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60,
    },
    genesisProtocolVersion: 27,
    evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
    beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
    treasuryAddress: treasury.address, genesisTimestamp: 0,
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    peerRegistry: initialPeerRegistry,
  });
  const all = [...oldWallets, ...newWallets];
  const quorum = (block, wallets) => {
    const proposer = wallets.find(({ address }) => address === block.proposer);
    return [proposer, ...wallets.filter((wallet) => wallet !== proposer).slice(0, 2)];
  };
  const append = (block, wallets) => chain.appendBlock(finalizeBlock(block, quorum(block, wallets)));
  const upgradeActivationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain.buildBlock({
    protocolUpgrade: {
      activationHeight: upgradeActivationHeight,
      format: "nir-protocol-upgrade-v1",
      version: 28,
    },
    timestamp: 1,
  }), oldWallets);
  while (chain.height < upgradeActivationHeight) {
    append(chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 }), oldWallets);
  }
  const funding = all.map((wallet, index) => createTransfer({
    wallet: treasury, networkId: chain.networkId, recipient: wallet.address,
    amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(), nonce: index,
  }));
  append(chain.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS }), oldWallets);
  const bonds = all.map((wallet, index) => createValidatorBond({
    wallet, networkId: chain.networkId, amount: MIN_VALIDATOR_BOND.toString(), nonce: 0,
    operatorId: index >= oldWallets.length ? `new-${index - oldWallets.length}` : undefined,
  }));
  append(chain.buildBlock({ transactions: bonds, timestamp: TREASURY_VESTING_MS + 1 }), oldWallets);

  const nextWallets = [oldWallets[0], oldWallets[1], ...newWallets];
  const nextMembers = [current[0], current[1], member(newWallets[0], "new-0"), member(newWallets[1], "new-1")];
  const nextTransports = [oldTransports[0], oldTransports[1], generateWallet(), generateWallet()];
  const rotationActivationHeight = chain.height + 5;
  const onboarding = createValidatorOnboarding({
    activationHeight: rotationActivationHeight,
    currentValidators: current,
    networkId: chain.networkId,
    nextValidators: nextMembers,
    peers: nextWallets.map((wallet, index) => ({
      tlsCertificateSha256: null,
      transport: publicWallet(nextTransports[index]),
      url: index < 2 ? `http://127.0.0.1:${9300 + index}` : `http://127.0.0.1:${9400 + index}`,
      validatorAddress: wallet.address,
    })),
  }, oldWallets.slice(0, 3), nextWallets, nextTransports);
  const rotationBlock = chain.buildBlock({
    validatorRotation: { activationHeight: rotationActivationHeight, onboarding, validators: nextMembers },
    timestamp: TREASURY_VESTING_MS + 2,
  });
  append(rotationBlock, oldWallets);
  assert.equal(chain.pendingValidatorRotation.activationHeight, rotationActivationHeight);
  while (chain.height < rotationActivationHeight - 1) {
    append(chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 }), oldWallets);
  }
  const preActivation = chain.blocks().at(-1);
  const activationBlock = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
  assert.throws(() => chain.appendBlock(finalizeBlock(activationBlock, oldWallets.slice(0, 3))),
    /unknown validator|prepare quorum|finality quorum|proposer did not sign/);
  assert.throws(() => chain.appendBlock(finalizeBlock(activationBlock, quorum(activationBlock, nextWallets))),
    /old-set (prepare|transition) quorum/);
  const transitionSigners = [...new Map([
    ...oldWallets.slice(0, 3),
    ...quorum(activationBlock, nextWallets),
  ].map((wallet) => [wallet.address, wallet])).values()];
  chain.appendBlock(finalizeBlock(activationBlock, transitionSigners));
  const finalizedActivation = chain.blocks().at(-1);
  assert.equal(chain.pendingValidatorRotation, null);
  assert.equal(chain.peerRegistryHash, onboarding.onboardingHash);
  assert.equal(chain.validatorSetId, validatorSetId(nextMembers.sort((a, b) => a.address.localeCompare(b.address))));

  const handoff = createValidatorHandoff({
    activationBlockHash: finalizedActivation.hash,
    activationHeight: finalizedActivation.height,
    activationStateRoot: finalizedActivation.stateRoot,
    networkId: chain.networkId,
    nextValidators: nextMembers,
    previousValidators: current,
  }, oldWallets, nextWallets);
  const activationOptions = {
    checkpoint: {
      height: preActivation.height,
      protocolVersion: preActivation.protocolVersion,
      stateRoot: preActivation.stateRoot,
      tipHash: preActivation.hash,
      validatorSetId: validatorSetId(current),
    },
    expectedChainIdentityGenesisHash: chain.blocks()[0].hash,
    expectedNetworkId: chain.networkId,
    handoffs: [handoff],
    trustedValidators: current,
  };
  const activationProof = createFinalityProof(finalizedActivation);
  assert.throws(() => verifyFinalityProofChain([activationProof], {
    ...activationOptions, handoffs: [],
  }), /validator set does not match handoff history/);

  const oldOnlyActivation = createFinalityProof(finalizeBlock(activationBlock,
    oldWallets.slice(0, 3)));
  assert.throws(() => verifyFinalityProofChain([oldOnlyActivation], activationOptions),
    /new-set prepare quorum|prepare quorum is not reached/);
  assert.equal(verifyFinalityProofChain([activationProof], activationOptions).validatorSetId,
    validatorSetId(nextMembers));

  const postActivation = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 8 });
  const arbitrarySetBlock = finalizeBlock({
    ...postActivation,
    validatorSetId: "f".repeat(64),
  }, quorum(postActivation, nextWallets));
  assert.equal(arbitrarySetBlock.hash, blockHeaderHash(createFinalityProof(arbitrarySetBlock).header));
  const postActivationCheckpoint = {
    checkpoint: {
      height: finalizedActivation.height,
      protocolVersion: finalizedActivation.protocolVersion,
      stateRoot: finalizedActivation.stateRoot,
      tipHash: finalizedActivation.hash,
      validatorSetId: validatorSetId(nextMembers),
    },
    expectedChainIdentityGenesisHash: chain.blocks()[0].hash,
    expectedNetworkId: chain.networkId,
    trustedValidators: nextMembers,
  };
  assert.throws(() => verifyFinalityProofChain([
    createFinalityProof(arbitrarySetBlock),
  ], postActivationCheckpoint), /validator set does not match handoff history/);

  const oldOnlyNext = createFinalityProof(finalizeBlock(postActivation, oldWallets.slice(0, 3)));
  assert.throws(() => verifyFinalityProofChain([oldOnlyNext], postActivationCheckpoint),
    /prepare (vote is invalid|quorum is not reached)/);
  const finalizedNext = finalizeBlock(postActivation, quorum(postActivation, nextWallets));
  assert.equal(verifyFinalityProofChain([
    createFinalityProof(finalizedNext),
  ], postActivationCheckpoint).tipHash, finalizedNext.hash);
});
