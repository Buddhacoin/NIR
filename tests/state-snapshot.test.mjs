import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NirChain,
  blockHash,
  computeChainStateRoot,
  createCreditDelegation,
  createCreditStake,
  createCreditUnstakeRequest,
  createTransfer,
  finalizeBlock,
} from "../blockchain/chain.mjs";
import {
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TRANSFER_CREDIT_STAKE_UNIT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import {
  createStateSnapshot,
  mergeStateSnapshotCandidates,
  restoreStateSnapshot,
  verifyStateSnapshot,
} from "../blockchain/state-snapshot.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorMembers = members(validators, "validator");
  const treasury = generateWallet();
  const genesisConfig = {
    beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${digest("snapshot-baseline")}`,
      behaviorCommitment: digest("snapshot-behavior"),
      capabilitiesBps: { "reasoning-v1": 7_000 },
    }],
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisTimestamp: 0,
    networkId: "nir-snapshot-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validatorMembers,
  };
  const chain = new NirChain(genesisConfig);
  const block = chain.buildBlock({ timestamp: 1 });
  chain.appendBlock(finalizeBlock(block, validators.slice(0, 3)));
  return { chain, genesisConfig, treasury, validatorMembers, validators };
}

function verify(snapshot, validatorMembers) {
  return verifyStateSnapshot(snapshot, {
    expectedNetworkId: "nir-snapshot-test", trustedValidators: validatorMembers,
  });
}

test("a quorum-authenticated state snapshot matches the finalized state root", () => {
  const { chain, validatorMembers, validators } = fixture();
  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  assert.deepEqual(verify(snapshot, validatorMembers), {
    height: chain.height,
    networkId: chain.networkId,
    snapshotHash: snapshot.snapshotHash,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
  });
});

test("independent single-validator candidates merge only after reaching quorum", () => {
  const { chain, validatorMembers, validators } = fixture();
  const candidates = validators.slice(0, 3).map((wallet) =>
    createStateSnapshot(chain, [wallet]));
  const merged = mergeStateSnapshotCandidates(candidates, {
    expectedNetworkId: chain.networkId, trustedValidators: validatorMembers,
  });
  assert.equal(merged.snapshot.attestations.length, 3);
  assert.equal(merged.verified.stateRoot, chain.stateRoot);
  assert.throws(() => mergeStateSnapshotCandidates(candidates.slice(0, 2), {
    expectedNetworkId: chain.networkId, trustedValidators: validatorMembers,
  }), /candidate quorum is not reached/);
});

test("a verified snapshot restores typed state and accepts the next finalized block", () => {
  const { chain, genesisConfig, validatorMembers, validators } = fixture();
  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  const restored = restoreStateSnapshot(genesisConfig, snapshot, {
    expectedNetworkId: chain.networkId, trustedValidators: validatorMembers,
  });
  assert.equal(restored.height, chain.height);
  assert.equal(restored.tipHash, chain.tipHash);
  assert.equal(restored.stateRoot, chain.stateRoot);
  const next = restored.buildBlock({ timestamp: 2 });
  restored.appendBlock(finalizeBlock(next, validators.slice(0, 3)));
  assert.equal(restored.height, chain.height + 1);
  assert.equal(restored.blocks().length, 2);
});

test("a snapshot restores credit stake, delegation, and a pending delayed exit", () => {
  const { chain, genesisConfig, treasury, validatorMembers, validators } = fixture();
  const owner = generateWallet();
  const delegate = generateWallet();
  const funding = createTransfer({
    wallet: treasury,
    networkId: chain.networkId,
    recipient: owner.address,
    amount: (TRANSFER_CREDIT_STAKE_UNIT + 2n * MIN_TRANSFER_FEE).toString(),
    nonce: 0,
  });
  const fundingBlock = chain.buildBlock({ transactions: [funding], timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(fundingBlock, validators.slice(0, 3)));
  const stake = createCreditStake({
    wallet: owner, networkId: chain.networkId,
    amount: TRANSFER_CREDIT_STAKE_UNIT.toString(), nonce: 0,
  });
  const stakeBlock = chain.buildBlock({ transactions: [stake], timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(stakeBlock, validators.slice(0, 3)));
  const delegation = createCreditDelegation({
    wallet: owner, delegate: delegate.address, networkId: chain.networkId,
    limit: 3, nonce: 1,
  });
  const delegationBlock = chain.buildBlock({ transactions: [delegation], timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(delegationBlock, validators.slice(0, 3)));
  const exitAmount = TRANSFER_CREDIT_STAKE_UNIT / 2n;
  const request = createCreditUnstakeRequest({
    wallet: owner, networkId: chain.networkId, amount: exitAmount.toString(), nonce: 2,
  });
  const requestBlock = chain.buildBlock({ transactions: [request], timestamp: TREASURY_VESTING_MS });
  chain.appendBlock(finalizeBlock(requestBlock, validators.slice(0, 3)));

  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  const restored = restoreStateSnapshot(genesisConfig, snapshot, {
    expectedNetworkId: chain.networkId, trustedValidators: validatorMembers,
  });
  assert.equal(restored.creditStake(owner.address), TRANSFER_CREDIT_STAKE_UNIT - exitAmount);
  assert.equal(restored.creditDelegation(owner.address, delegate.address).limit, 3);
  assert.deepEqual(restored.creditUnstake(owner.address), chain.creditUnstake(owner.address));
  assert.equal(restored.stateRoot, chain.stateRoot);
});

test("state snapshots fail closed on mutation, minority approval, and duplicate votes", () => {
  const { chain, validatorMembers, validators } = fixture();
  const minority = createStateSnapshot(chain, validators.slice(0, 2));
  assert.throws(() => verify(minority, validatorMembers), /quorum is not reached/);

  const duplicate = createStateSnapshot(chain, [validators[0], validators[0], validators[1]]);
  assert.throws(() => verify(duplicate, validatorMembers), /attestation is invalid/);

  const changedState = createStateSnapshot(chain, validators.slice(0, 3));
  changedState.state.burned = "1";
  assert.throws(() => verify(changedState, validatorMembers), /snapshot hash is invalid/);

  const changedMemory = createStateSnapshot(chain, validators.slice(0, 3));
  changedMemory.capabilityMemory.behaviors[0] = digest("forged-behavior");
  const { attestations: _attestations, snapshotHash: _snapshotHash, ...payload } = changedMemory;
  changedMemory.snapshotHash = hashObject(payload, "STATE_SNAPSHOT");
  changedMemory.attestations = validators.slice(0, 3).map((wallet) => ({
    signature: signObject({ snapshotHash: changedMemory.snapshotHash }, wallet,
      "STATE_SNAPSHOT_APPROVAL"),
    validator: wallet.address,
  }));
  assert.throws(() => verify(changedMemory, validatorMembers), /capability memory is invalid/);

  const changedContent = createStateSnapshot(chain, validators.slice(0, 3));
  changedContent.capabilityMemory.contents[0] = `sha256:${digest("forged-canonical-content")}`;
  const { attestations: _contentAttestations, snapshotHash: _contentHash, ...contentPayload } =
    changedContent;
  changedContent.snapshotHash = hashObject(contentPayload, "STATE_SNAPSHOT");
  changedContent.attestations = validators.slice(0, 3).map((wallet) => ({
    signature: signObject({ snapshotHash: changedContent.snapshotHash }, wallet,
      "STATE_SNAPSHOT_APPROVAL"),
    validator: wallet.address,
  }));
  assert.throws(() => verify(changedContent, validatorMembers), /capability memory is invalid/);
});

test("a self-signed attacker validator set cannot become its own trust anchor", () => {
  const { chain, validatorMembers } = fixture();
  const attackers = Array.from({ length: 4 }, generateWallet);
  const forged = createStateSnapshot(chain, attackers.slice(0, 3));
  forged.state.validators = members(attackers, "attacker")
    .sort((left, right) => left.address.localeCompare(right.address))
    .map((member) => [member.address, member]);
  forged.validatorSetId = validatorSetId(forged.state.validators.map((entry) => entry[1]));
  forged.stateRoot = computeChainStateRoot(forged.state);
  forged.checkpoint.stateRoot = forged.stateRoot;
  forged.checkpoint.hash = blockHash(forged.checkpoint);
  forged.tipHash = forged.checkpoint.hash;
  const { attestations: _b, snapshotHash: _i, ...resignedPayload } = forged;
  forged.snapshotHash = hashObject(resignedPayload, "STATE_SNAPSHOT");
  forged.attestations = attackers.slice(0, 3).map((wallet) => ({
    signature: signObject({ snapshotHash: forged.snapshotHash }, wallet,
      "STATE_SNAPSHOT_APPROVAL"),
    validator: wallet.address,
  }));
  assert.throws(() => verify(forged, validatorMembers), /set id is invalid/);
});
