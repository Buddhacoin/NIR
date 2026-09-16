import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeBlockStore,
  installBlockStoreSnapshot,
  loadBlockStore,
  persistBlock,
} from "../blockchain/block-store.mjs";
import {
  createTransfer,
  createValidatorBond,
  finalizeBlock,
  NirChain,
} from "../blockchain/chain.mjs";
import {
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createPeerRegistry, EMPTY_PEER_REGISTRY_HASH } from "../blockchain/peer-registry.mjs";
import {
  createStateSnapshot,
  restoreStateSnapshotWithHandoffs,
  verifyStateSnapshotWithHandoffs,
} from "../blockchain/state-snapshot.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";

function member(wallet, operatorId) {
  return { ...publicWallet(wallet), operatorId };
}

function uniqueWallets(...groups) {
  return [...new Map(groups.flat().map((wallet) => [wallet.address, wallet])).values()];
}

test("a snapshot crosses two ordered validator generations and replays only its tail", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-multi-rotation-snapshot-"));
  try {
    const first = Array.from({ length: 4 }, generateWallet);
    const secondNew = Array.from({ length: 2 }, generateWallet);
    const thirdNew = Array.from({ length: 2 }, generateWallet);
    const second = [first[0], first[1], ...secondNew];
    const third = [first[0], secondNew[0], ...thirdNew];
    const all = uniqueWallets(first, second, third);
    const memberByAddress = new Map(all.map((wallet, index) =>
      [wallet.address, member(wallet, `operator-${index}`)]));
    const members = (wallets) => wallets.map(({ address }) => memberByAddress.get(address));
    const transportByAddress = new Map(all.map((wallet) => [wallet.address, generateWallet()]));
    const endpointByAddress = new Map(all.map((wallet, index) =>
      [wallet.address, `http://127.0.0.1:${9700 + index}`]));
    const peer = (wallet) => ({
      tlsCertificateSha256: null,
      transport: publicWallet(transportByAddress.get(wallet.address)),
      url: endpointByAddress.get(wallet.address),
      validatorAddress: wallet.address,
    });
    const treasury = generateWallet();
    const initialRegistry = createPeerRegistry({
      activationHeight: 0,
      epoch: 0,
      networkId: "nir-multi-rotation-snapshot-test",
      peers: first.map(peer),
      previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
    }, first);
    const genesis = {
      beaconAuthorities: Array.from({ length: 4 }, generateWallet)
        .map((wallet, index) => member(wallet, `beacon-${index}`)),
      capabilityReferences: [{
        artifactHash: `sha256:${"1".repeat(64)}`,
        behaviorCommitment: "2".repeat(64),
        capabilitiesBps: { "reasoning-v1": 1 },
      }],
      evaluators: Array.from({ length: 4 }, generateWallet)
        .map((wallet, index) => member(wallet, `evaluator-${index}`)),
      genesisTimestamp: 0,
      networkId: "nir-multi-rotation-snapshot-test",
      peerRegistry: initialRegistry,
      safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
      treasuryAddress: treasury.address,
      validators: members(first),
    };
    const chain = new NirChain(genesis);
    const append = (proposal, signers) => {
      const block = finalizeBlock(proposal, signers);
      chain.appendBlock(block);
      return block;
    };
    const funding = all.map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(),
      networkId: chain.networkId,
      nonce,
      recipient: wallet.address,
      wallet: treasury,
    }));
    append(chain.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS }), first);
    const bonds = all.map((wallet, index) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(),
      networkId: chain.networkId,
      nonce: 0,
      operatorId: index < first.length ? undefined : memberByAddress.get(wallet.address).operatorId,
      wallet,
    }));
    append(chain.buildBlock({ transactions: bonds, timestamp: TREASURY_VESTING_MS + 1 }), first);

    const onboarding1 = createValidatorOnboarding({
      activationHeight: 7,
      currentValidators: members(first),
      networkId: chain.networkId,
      nextValidators: members(second),
      peers: second.map(peer),
    }, first.slice(0, 3), second, second.map(({ address }) => transportByAddress.get(address)));
    append(chain.buildBlock({
      timestamp: TREASURY_VESTING_MS + 2,
      validatorRotation: { activationHeight: 7, onboarding: onboarding1, validators: members(second) },
    }), first);
    for (let height = 4; height <= 6; height += 1) {
      append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }), first);
    }
    const firstActivation = append(
      chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 7 }),
      uniqueWallets(first, second),
    );
    const handoff1 = createValidatorHandoff({
      activationBlockHash: firstActivation.hash,
      activationHeight: 7,
      activationStateRoot: firstActivation.stateRoot,
      networkId: chain.networkId,
      nextValidators: members(second),
      previousValidators: members(first),
    }, first, second);

    const onboarding2 = createValidatorOnboarding({
      activationHeight: 12,
      currentValidators: members(second),
      networkId: chain.networkId,
      nextValidators: members(third),
      peers: third.map(peer),
    }, second.slice(0, 3), third, third.map(({ address }) => transportByAddress.get(address)));
    append(chain.buildBlock({
      timestamp: TREASURY_VESTING_MS + 8,
      validatorRotation: { activationHeight: 12, onboarding: onboarding2, validators: members(third) },
    }), second);
    for (let height = 9; height <= 11; height += 1) {
      append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }), second);
    }
    const secondActivation = append(
      chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 12 }),
      uniqueWallets(second, third),
    );
    const handoff2Fields = {
      activationBlockHash: secondActivation.hash,
      activationHeight: 12,
      activationStateRoot: secondActivation.stateRoot,
      networkId: chain.networkId,
      nextValidators: members(third),
      previousValidators: members(second),
    };
    const handoff2 = createValidatorHandoff(handoff2Fields, second, third);
    const handoffs = [handoff1, handoff2];
    const snapshot = createStateSnapshot(chain, third.slice(0, 3));
    const trustAnchor = {
      expectedNetworkId: chain.networkId,
      handoffs,
      trustedValidators: members(first),
    };
    assert.equal(verifyStateSnapshotWithHandoffs(snapshot, trustAnchor).height, 12);
    const restored = restoreStateSnapshotWithHandoffs(genesis, snapshot, trustAnchor);
    assert.equal(restored.validatorSetId, chain.validatorSetId);
    assert.equal(restored.stateRoot, chain.stateRoot);

    const wrongFinalHandoff = createValidatorHandoff({
      ...handoff2Fields, activationStateRoot: "f".repeat(64),
    }, second, third);
    assert.throws(() => verifyStateSnapshotWithHandoffs(snapshot, {
      ...trustAnchor, handoffs: [handoff1, wrongFinalHandoff],
    }), /activation handoff/);
    assert.throws(() => verifyStateSnapshotWithHandoffs(snapshot, {
      ...trustAnchor, handoffs: [handoff2],
    }), /trust chain|one-third overlap/);

    const tail = append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 13 }), third);
    initializeBlockStore(temporary, new NirChain(genesis));
    const installed = installBlockStoreSnapshot(temporary, genesis, snapshot, {
      handoffs,
      trustedValidators: members(first),
    });
    assert.equal(installed.chain.height, 12);
    const replayed = installed.chain.fork();
    replayed.appendBlock(tail);
    persistBlock(temporary, tail, replayed);
    const loaded = loadBlockStore(temporary, genesis, {
      handoffs,
      trustedValidators: members(first),
    });
    assert.equal(loaded.chain.height, 13);
    assert.equal(loaded.chain.blocks().length, 2);
    assert.equal(loaded.chain.tipHash, chain.tipHash);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
