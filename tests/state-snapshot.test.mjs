import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { NirChain, finalizeBlock } from "../blockchain/chain.mjs";
import { SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "../blockchain/state-snapshot.mjs";

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
  const chain = new NirChain({
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
    validators: members(validators, "validator"),
  });
  const block = chain.buildBlock({ timestamp: 1 });
  chain.appendBlock(finalizeBlock(block, validators.slice(0, 3)));
  return { chain, validators };
}

test("a quorum-authenticated state snapshot matches the finalized state root", () => {
  const { chain, validators } = fixture();
  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  assert.deepEqual(verifyStateSnapshot(snapshot), {
    height: chain.height,
    networkId: chain.networkId,
    snapshotHash: snapshot.snapshotHash,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
  });
});

test("state snapshots fail closed on mutation, minority approval, and duplicate votes", () => {
  const { chain, validators } = fixture();
  const minority = createStateSnapshot(chain, validators.slice(0, 2));
  assert.throws(() => verifyStateSnapshot(minority), /quorum is not reached/);

  const duplicate = createStateSnapshot(chain, [validators[0], validators[0], validators[1]]);
  assert.throws(() => verifyStateSnapshot(duplicate), /attestation is invalid/);

  const changedState = createStateSnapshot(chain, validators.slice(0, 3));
  changedState.state.burned = "1";
  assert.throws(() => verifyStateSnapshot(changedState), /snapshot hash is invalid/);

  const changedMemory = createStateSnapshot(chain, validators.slice(0, 3));
  changedMemory.capabilityMemory.behaviors[0] = digest("forged-behavior");
  const { attestations: _attestations, snapshotHash: _snapshotHash, ...payload } = changedMemory;
  changedMemory.snapshotHash = hashObject(payload, "STATE_SNAPSHOT");
  changedMemory.attestations = validators.slice(0, 3).map((wallet) => ({
    signature: signObject({ snapshotHash: changedMemory.snapshotHash }, wallet,
      "STATE_SNAPSHOT_APPROVAL"),
    validator: wallet.address,
  }));
  assert.throws(() => verifyStateSnapshot(changedMemory), /capability memory is invalid/);
});
