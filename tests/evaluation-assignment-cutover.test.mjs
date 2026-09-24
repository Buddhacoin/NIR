import assert from "node:assert/strict";
import test from "node:test";

import {
  blockHeaderHash,
  finalizeBlock,
  NirChain,
} from "../blockchain/chain.mjs";
import {
  EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
  RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION,
  SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createFinalityProof,
  validateFinalityHeader,
  verifyFinalityProofChain,
} from "../blockchain/light-client.mjs";
import { createStateSnapshot, verifyStateSnapshot } from "../blockchain/state-snapshot.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function fixture(protocolVersion) {
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
    evaluators: members(evaluators, "evaluator"),
    genesisProtocolVersion: protocolVersion,
    genesisTimestamp: 0,
    networkId: `nir-assignment-cutover-${protocolVersion}`,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validatorMembers,
  };
  const chain = new NirChain(genesis);
  return { chain, genesis, validatorMembers, validators };
}

function append(chain, validators) {
  const block = finalizeBlock(chain.buildBlock({ timestamp: chain.height + 1 }), validators.slice(0, 3));
  chain.appendBlock(block);
  return block;
}

test("assignment-root protocol has a signed header field and restart-stable empty root", () => {
  const { chain, genesis, validatorMembers, validators } =
    fixture(EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION);
  const genesisBlock = chain.blocks()[0];
  assert.match(chain.evaluationAssignmentRoot, /^[0-9a-f]{64}$/);
  assert.notEqual(chain.evaluationAssignmentRoot, "0".repeat(64));
  assert.equal(genesisBlock.evaluationAssignmentRoot, chain.evaluationAssignmentRoot);

  const block = append(chain, validators);
  const proof = createFinalityProof(block);
  assert.equal(proof.format, "nir-finality-proof-v4");
  assert.equal(proof.header.format, "nir-finality-header-v3");
  assert.equal(proof.header.evaluationAssignmentRoot, chain.evaluationAssignmentRoot);
  const tip = verifyFinalityProofChain([proof], {
    checkpoint: {
      height: 0, protocolVersion: EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION,
      stateRoot: genesisBlock.stateRoot, tipHash: genesisBlock.hash,
    },
    expectedNetworkId: chain.networkId,
    trustedValidators: validatorMembers,
  });
  assert.equal(tip.evaluationAssignmentRoot, chain.evaluationAssignmentRoot);

  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  verifyStateSnapshot(snapshot, {
    expectedNetworkId: chain.networkId, trustedValidators: validatorMembers,
  });
  const restored = NirChain.fromVerifiedSnapshot(genesis, snapshot);
  assert.equal(restored.stateRoot, chain.stateRoot);
  assert.equal(restored.evaluationAssignmentRoot, chain.evaluationAssignmentRoot);
  assert.equal(restored.tipHash, chain.tipHash);
});

test("old and new finality header schemas reject assignment-root field confusion", () => {
  const old = fixture(RECOVERY_STATE_COMMITMENT_PROTOCOL_VERSION);
  const oldBlock = append(old.chain, old.validators);
  const oldHeader = createFinalityProof(oldBlock).header;
  assert.equal(oldHeader.evaluationAssignmentRoot, undefined);
  const rootGraftedOntoOld = { ...oldHeader, evaluationAssignmentRoot: "a".repeat(64) };
  assert.throws(() => validateFinalityHeader(
    rootGraftedOntoOld, blockHeaderHash(rootGraftedOntoOld), old.chain.networkId,
  ), /finality header is invalid/);

  const current = fixture(EVALUATION_ASSIGNMENT_ROOT_PROTOCOL_VERSION);
  const currentBlock = append(current.chain, current.validators);
  const currentHeader = createFinalityProof(currentBlock).header;
  const { evaluationAssignmentRoot: _removed, ...missingRoot } = currentHeader;
  assert.throws(() => validateFinalityHeader(
    missingRoot, blockHeaderHash(missingRoot), current.chain.networkId,
  ), /finality header is invalid/);
});
