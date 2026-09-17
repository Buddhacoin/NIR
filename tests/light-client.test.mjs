import assert from "node:assert/strict";
import test from "node:test";

import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import { SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createFinalityProof,
  verifyFinalityProofChain,
} from "../blockchain/light-client.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const validatorMembers = members(validators, "validator");
  const chain = new NirChain({
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    networkId: "nir-light-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: validatorMembers,
  });
  return { chain, validatorMembers, validators };
}

function append(chain, validators, timestamp) {
  const proposal = chain.buildBlock({ timestamp });
  const block = finalizeBlock(proposal, validators.slice(0, 3));
  chain.appendBlock(block);
  return block;
}

test("compact finality proofs advance a checkpoint without full block bodies", () => {
  const { chain, validatorMembers, validators } = fixture();
  const genesis = chain.blocks()[0];
  const first = append(chain, validators, 1);
  const second = append(chain, validators, 2);
  const proofs = [createFinalityProof(first), createFinalityProof(second)];
  const result = verifyFinalityProofChain(proofs, {
    checkpoint: { height: 0, stateRoot: genesis.stateRoot, tipHash: genesis.hash },
    expectedNetworkId: chain.networkId,
    trustedValidators: validatorMembers,
  });
  assert.deepEqual(result, {
    accountStateRoot: second.accountStateRoot,
    height: 2,
    networkId: chain.networkId,
    stateRoot: second.stateRoot,
    tipHash: second.hash,
    validatorSetId: chain.validatorSetId,
  });
  assert.ok(JSON.stringify(proofs[0]).length < JSON.stringify(first).length);
});

test("light client rejects a forged header, discontinuity, and minority certificate", () => {
  const { chain, validatorMembers, validators } = fixture();
  const genesis = chain.blocks()[0];
  const block = append(chain, validators, 1);
  const options = {
    checkpoint: { height: 0, stateRoot: genesis.stateRoot, tipHash: genesis.hash },
    expectedNetworkId: chain.networkId,
    trustedValidators: validatorMembers,
  };
  const forged = createFinalityProof(block);
  forged.header.stateRoot = "f".repeat(64);
  assert.throws(() => verifyFinalityProofChain([forged], options), /header is invalid/);

  const broken = createFinalityProof(block);
  broken.header.previousHash = "a".repeat(64);
  broken.hash = block.hash;
  assert.throws(() => verifyFinalityProofChain([broken], options), /header is invalid/);

  const minority = createFinalityProof(block);
  minority.prepareCertificate = minority.prepareCertificate.slice(0, 2);
  minority.certificate = minority.certificate.slice(0, 2);
  assert.throws(() => verifyFinalityProofChain([minority], options), /quorum is not reached/);
});
