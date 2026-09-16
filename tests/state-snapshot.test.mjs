import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  NirChain,
  blockHash,
  computeChainStateRoot,
  finalizeBlock,
} from "../blockchain/chain.mjs";
import { SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import {
  createStateSnapshot,
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
    treasuryAddress: generateWallet().address,
    validators: validatorMembers,
  };
  const chain = new NirChain(genesisConfig);
  const block = chain.buildBlock({ timestamp: 1 });
  chain.appendBlock(finalizeBlock(block, validators.slice(0, 3)));
  return { chain, genesisConfig, validatorMembers, validators };
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
