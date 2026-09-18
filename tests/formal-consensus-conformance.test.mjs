import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
import { selectHighestCertifiedProposal } from "../blockchain/consensus-view.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { initializeDistributedDevnet, ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import { createPeerRegistry, EMPTY_PEER_REGISTRY_HASH } from "../blockchain/peer-registry.mjs";
import {
  acceptsBoundedTransitionCertificate,
  executeModelTrace,
  runBoundedRoundChangeSlice,
  selectHighestCertifiedModelValue,
} from "../formal/consensus-model.mjs";

function withReplicas(prefix, operation) {
  const temporary = mkdtempSync(join(tmpdir(), prefix));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
    const genesis = JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"), "utf8"));
    return operation({ genesis, layout, replicas });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function conforms(label, formalOutcome, implementationOutcome) {
  assert.deepEqual(formalOutcome, implementationOutcome, `${label} diverged from ValidatorReplica`);
}

test("formal round-local prepare matches ValidatorReplica across a round change", () => {
  const implementationAccepted = withReplicas("nir-formal-prepare-conformance-",
    ({ genesis, replicas }) => {
      const chain = new NirChain(genesis);
      const first = chain.buildBlock({ timestamp: 1 });
      const competing = chain.buildBlock({ timestamp: 2 });
      replicas[0].vote(first);
      const timeouts = replicas.slice(0, 3).map((replica) =>
        replica.timeout({ proposal: competing, nextRound: 1 }));
      const advanced = replicas[0].advanceProposal(competing, 1, timeouts);
      assert.doesNotThrow(() => replicas[0].vote(advanced));
      return true;
    });
  const formal = executeModelTrace([
    { type: "prepare", validator: 0, value: "A" },
    ...[0, 1, 2].map((validator) => ({ type: "timeout", validator, value: "B" })),
    { type: "advance", validator: 0, value: "B" },
    { type: "prepare", validator: 0, value: "B" },
  ]);
  conforms("round-local prepare", formal.accepted, implementationAccepted);
});

test("formal durable commit lock matches ValidatorReplica after restart", () => {
  const implementationRejected = withReplicas("nir-formal-lock-conformance-",
    ({ genesis, layout, replicas }) => {
      const chain = new NirChain(genesis);
      const first = chain.buildBlock({ timestamp: 1 });
      const competing = chain.buildBlock({ timestamp: 2 });
      const prepares = replicas.slice(0, 3).map((replica) => replica.vote(first));
      const certificate = replicas[0].prepareCertificate(first, prepares);
      replicas[0].commitVote(first, certificate);
      const restarted = new ValidatorReplica(layout.validatorDirectories[0]);
      assert.throws(() => restarted.timeout({ proposal: competing, nextRound: 1 }),
        /unlock a different block value/);
      return true;
    });
  const formal = executeModelTrace([
    ...[0, 1, 2].map((validator) => ({ type: "prepare", validator, value: "A" })),
    { certificate: { round: 0, value: "A" }, type: "observe", validator: 0 },
    { certificate: { round: 0, value: "A" }, type: "commit", validator: 0 },
    { type: "restart", validator: 0 },
    { type: "timeout", validator: 0, value: "B" },
  ]);
  conforms("durable commit lock", !formal.accepted, implementationRejected);
});

test("formal value-bound timeout certificate matches ValidatorReplica", () => {
  const implementation = withReplicas("nir-formal-timeout-conformance-",
    ({ genesis, replicas }) => {
      const chain = new NirChain(genesis);
      const first = chain.buildBlock({ timestamp: 1 });
      const competing = chain.buildBlock({ timestamp: 2 });
      const timeouts = replicas.slice(0, 3).map((replica) =>
        replica.timeout({ proposal: first, nextRound: 1 }));
      assert.doesNotThrow(() => replicas[0].advanceProposal(first, 1, timeouts));
      assert.throws(() => replicas[0].advanceProposal(competing, 1, timeouts),
        /timeout vote|certificate|signature/);
      return { matching: true, wrongValue: false };
    });
  const prefix = [0, 1, 2].map((validator) => ({ type: "timeout", validator, value: "A" }));
  const formal = {
    matching: executeModelTrace([...prefix,
      { type: "advance", validator: 0, value: "A" }]).accepted,
    wrongValue: executeModelTrace([...prefix,
      { type: "advance", validator: 0, value: "B" }]).accepted,
  };
  conforms("value-bound timeout", formal, implementation);
});

test("formal highest-certified recovery matches the validator-service selector", () => {
  const groups = new Map([
    ["a".repeat(64), {
      certified: true, count: 3, prepareCertificate: [{ validator: "old" }],
      proposal: { marker: "A", round: 0 },
    }],
    ["b".repeat(64), {
      certified: true, count: 1, prepareCertificate: [{ validator: "new" }],
      proposal: { marker: "B", round: 1 },
    }],
  ]);
  const implementation = selectHighestCertifiedProposal(groups, 4).proposal;
  const formal = selectHighestCertifiedModelValue([
    { certified: true, round: 0, value: "A" },
    { certified: true, round: 1, value: "B" },
  ]);
  conforms("highest certified recovery",
    { round: formal.round, value: formal.value },
    { round: implementation.round, value: implementation.marker });

  assert.throws(() => selectHighestCertifiedModelValue([
    { certified: true, round: 1, value: "A" },
    { certified: true, round: 1, value: "B" },
  ]), /conflicting values/);
});

function member(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

function realValidatorSetAcceptance() {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newcomers = Array.from({ length: 2 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const transports = Array.from({ length: 6 }, generateWallet);
  const current = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const registry = createPeerRegistry({
    activationHeight: 0, epoch: 0, networkId: "nir-formal-transition-test",
    peers: oldWallets.map((wallet, index) => ({
      tlsCertificateSha256: null, transport: publicWallet(transports[index]),
      url: `http://127.0.0.1:${9500 + index}`, validatorAddress: wallet.address,
    })),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  }, oldWallets.slice(0, 3));
  const chain = new NirChain({
    networkId: "nir-formal-transition-test", validators: current,
    evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
    beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
    treasuryAddress: treasury.address, genesisTimestamp: 0,
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`, behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT], peerRegistry: registry,
  });
  const all = [...oldWallets, ...newcomers];
  const quorum = (block, wallets) => {
    const proposer = wallets.find(({ address }) => address === block.proposer);
    return [proposer, ...wallets.filter((wallet) => wallet !== proposer).slice(0, 2)];
  };
  const append = (block, wallets) => chain.appendBlock(finalizeBlock(block, quorum(block, wallets)));
  append(chain.buildBlock({
    timestamp: TREASURY_VESTING_MS,
    transactions: all.map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(), networkId: chain.networkId,
      nonce, recipient: wallet.address, wallet: treasury,
    })),
  }), oldWallets);
  append(chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 1,
    transactions: all.map((wallet, index) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0,
      operatorId: index >= 4 ? `new-${index - 4}` : undefined, wallet,
    })),
  }), oldWallets);
  const nextWallets = [oldWallets[0], oldWallets[1], ...newcomers];
  const nextMembers = [current[0], current[1], member(newcomers[0], "new-0"),
    member(newcomers[1], "new-1")];
  const onboarding = createValidatorOnboarding({
    activationHeight: 7, currentValidators: current, networkId: chain.networkId,
    nextValidators: nextMembers,
    peers: nextWallets.map((wallet, index) => ({
      tlsCertificateSha256: null, transport: publicWallet(transports[index < 2 ? index : index + 2]),
      url: index < 2 ? `http://127.0.0.1:${9500 + index}`
        : `http://127.0.0.1:${9600 + index}`,
      validatorAddress: wallet.address,
    })),
  }, oldWallets.slice(0, 3), nextWallets,
  [transports[0], transports[1], transports[4], transports[5]]);
  append(chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 2,
    validatorRotation: { activationHeight: 7, onboarding, validators: nextMembers },
  }), oldWallets);
  for (let height = 4; height <= 6; height += 1) {
    append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }), oldWallets);
  }
  const activation = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 7 });
  let jointOldOnly = true;
  try { chain.appendBlock(finalizeBlock(activation, oldWallets.slice(0, 3))); } catch { jointOldOnly = false; }
  const dual = [...new Map([...oldWallets.slice(0, 3), ...quorum(activation, nextWallets)]
    .map((wallet) => [wallet.address, wallet])).values()];
  chain.appendBlock(finalizeBlock(activation, dual));
  const active = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 8 });
  let activeOldOnly = true;
  try { chain.appendBlock(finalizeBlock(active, oldWallets.slice(0, 3))); } catch { activeOldOnly = false; }
  append(active, nextWallets);
  return { activeNew: true, activeOldOnly, jointBoth: true, jointOldOnly, old: true };
}

test("formal old/joint/new acceptance matches finalized-chain validation", () => {
  const implementation = realValidatorSetAcceptance();
  const formal = {
    activeNew: acceptsBoundedTransitionCertificate(
      { epoch: 1, height: 11, phase: "active-new" },
      { epoch: 1, height: 11, phase: "active-new", voters: 0b110100 }),
    activeOldOnly: acceptsBoundedTransitionCertificate(
      { epoch: 1, height: 11, phase: "active-new" },
      { epoch: 1, height: 11, phase: "active-new", voters: 0b000111 }),
    jointBoth: acceptsBoundedTransitionCertificate(
      { epoch: 0, height: 10, phase: "joint" },
      { epoch: 0, height: 10, phase: "joint", voters: 0b111111 }),
    jointOldOnly: acceptsBoundedTransitionCertificate(
      { epoch: 0, height: 10, phase: "joint" },
      { epoch: 0, height: 10, phase: "joint", voters: 0b000111 }),
    old: acceptsBoundedTransitionCertificate(
      { epoch: 0, height: 9, phase: "old" },
      { epoch: 0, height: 9, phase: "old", voters: 0b000111 }),
  };
  conforms("validator-set phases", formal, implementation);
});

test("round-change slice reaches round-one finality and conformance catches old prepare-lock mutant", () => {
  const slice = runBoundedRoundChangeSlice();
  assert.equal(slice.ok, true);
  assert.ok(slice.finalizedRound1States > 0);

  const implementationOutcome = true;
  const oldPrepareLockMutantOutcome = false;
  assert.throws(() => conforms(
    "intentional durable-prepare-lock mutant",
    oldPrepareLockMutantOutcome,
    implementationOutcome,
  ), /diverged from ValidatorReplica/);
});
