import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeBlockStore, persistBlock } from "../blockchain/block-store.mjs";
import {
  createTransfer,
  createValidatorBond,
  finalizeBlock,
  NirChain,
} from "../blockchain/chain.mjs";
import {
  ATOMIC_UNITS,
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { ValidatorReplica } from "../blockchain/distributed-node.mjs";
import { createPeerRegistry, EMPTY_PEER_REGISTRY_HASH } from "../blockchain/peer-registry.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";

function member(wallet, operatorId) {
  return { ...publicWallet(wallet), operatorId };
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function unusedPorts(count) {
  const ports = [];
  for (let index = 0; index < count; index += 1) {
    const server = createNetServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    ports.push(server.address().port);
    await new Promise((resolve) => server.close(resolve));
  }
  return ports;
}

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function createReplicaDirectory(root, index, genesis, blocks, wallet, transport, coordinator) {
  const directory = join(root, `operator-${index}`);
  for (const name of ["blocks", "commits", "mempool", "prepares", "timeouts"]) {
    mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(directory, "genesis.json"), serialized(genesis), { mode: 0o644 });
  writeFileSync(join(directory, "VALIDATOR-KEY.json"), serialized(wallet), { mode: 0o600 });
  writeFileSync(join(directory, "TRANSPORT-KEY.json"), serialized(transport), { mode: 0o600 });
  writeFileSync(join(directory, "AUTHORIZED-COORDINATOR.json"),
    serialized(publicWallet(coordinator)), { mode: 0o644 });
  const replay = new NirChain(genesis);
  initializeBlockStore(directory, replay);
  for (const block of blocks) {
    replay.appendBlock(block);
    persistBlock(directory, block, replay);
  }
  return directory;
}

test("six live operators complete a dual-quorum 4-to-4 validator rotation", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-live-rotation-test-"));
  const servers = [];
  try {
    const ports = await unusedPorts(6);
    const urls = ports.map((port) => `http://127.0.0.1:${port}`);
    const oldWallets = Array.from({ length: 4 }, generateWallet);
    const newWallets = Array.from({ length: 2 }, generateWallet);
    const oldTransports = Array.from({ length: 4 }, generateWallet);
    const newTransports = Array.from({ length: 2 }, generateWallet);
    const evaluators = Array.from({ length: 4 }, generateWallet);
    const beacons = Array.from({ length: 4 }, generateWallet);
    const treasury = generateWallet();
    const coordinator = generateWallet();
    const currentMembers = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
    const nextWallets = [oldWallets[0], oldWallets[1], ...newWallets];
    const nextMembers = [
      currentMembers[0], currentMembers[1],
      member(newWallets[0], "new-0"), member(newWallets[1], "new-1"),
    ];
    const nextTransports = [oldTransports[0], oldTransports[1], ...newTransports];
    const peerRegistry = createPeerRegistry({
      activationHeight: 0,
      epoch: 0,
      networkId: "nir-live-rotation-test",
      peers: oldWallets.map((wallet, index) => ({
        tlsCertificateSha256: null,
        transport: publicWallet(oldTransports[index]),
        url: urls[index],
        validatorAddress: wallet.address,
      })),
      previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
    }, oldWallets);
    const genesis = {
      beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
      capabilityReferences: [{
        artifactHash: `sha256:${"1".repeat(64)}`,
        behaviorCommitment: "2".repeat(64),
        capabilitiesBps: { "reasoning-v1": 1 },
      }],
      evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
      genesisTimestamp: 0,
      networkId: "nir-live-rotation-test",
      peerRegistry,
      safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
      treasuryAddress: treasury.address,
      validators: currentMembers,
    };
    const chain = new NirChain(genesis);
    const blocks = [];
    const append = (proposal, signers = oldWallets) => {
      const block = finalizeBlock(proposal, signers);
      chain.appendBlock(block);
      blocks.push(block);
      return block;
    };
    const allWallets = [...oldWallets, ...newWallets];
    const funding = allWallets.map((wallet, index) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE +
        (index === 0 ? ATOMIC_UNITS + MIN_TRANSFER_FEE : 0n) +
        (index === 4 ? MIN_TRANSFER_FEE * 2n : 0n)).toString(),
      networkId: chain.networkId,
      nonce: index,
      recipient: wallet.address,
      wallet: treasury,
    }));
    append(chain.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS }));
    const bonds = allWallets.map((wallet, index) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(),
      networkId: chain.networkId,
      nonce: 0,
      operatorId: index < 4 ? undefined : `new-${index - 4}`,
      wallet,
    }));
    append(chain.buildBlock({ transactions: bonds, timestamp: TREASURY_VESTING_MS + 1 }));
    const onboarding = createValidatorOnboarding({
      activationHeight: 7,
      currentValidators: currentMembers,
      networkId: chain.networkId,
      nextValidators: nextMembers,
      peers: nextWallets.map((wallet, index) => ({
        tlsCertificateSha256: null,
        transport: publicWallet(nextTransports[index]),
        url: index < 2 ? urls[index] : urls[index + 2],
        validatorAddress: wallet.address,
      })),
    }, oldWallets.slice(0, 3), nextWallets, nextTransports);
    append(chain.buildBlock({
      timestamp: TREASURY_VESTING_MS + 2,
      validatorRotation: { activationHeight: 7, onboarding, validators: nextMembers },
    }));
    for (let height = 4; height <= 6; height += 1) {
      append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }));
    }
    const operatorWallets = [...oldWallets, ...newWallets];
    const operatorTransports = [...oldTransports, ...newTransports];
    const directories = operatorWallets.map((wallet, index) => createReplicaDirectory(
      temporary, index, genesis, blocks, wallet, operatorTransports[index], coordinator,
    ));
    const replicas = directories.map((directory) => new ValidatorReplica(directory));
    for (const replica of replicas) assert.equal(replica.peerCount, 6);
    for (const replica of replicas) {
      const server = createValidatorHttpServer(replica);
      servers.push(server);
    }
    await Promise.all(servers.map((server, index) =>
      new Promise((resolve) => server.listen(ports[index], "127.0.0.1", resolve))));

    const recipient = generateWallet();
    const transaction = createTransfer({
      amount: ATOMIC_UNITS.toString(),
      networkId: chain.networkId,
      nonce: 1,
      recipient: recipient.address,
      wallet: oldWallets[0],
    });
    const ingress = await fetch(`${urls[0]}/v1/transactions`, {
      body: JSON.stringify(transaction),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(ingress.status, 202);
    assert.equal((await ingress.json()).gossipedPeers, 5);
    const proposerAddress = replicas[0].expectedProposer(7);
    const proposerIndex = replicas.findIndex(({ address }) => address === proposerAddress);
    assert.ok(proposerIndex >= 0);
    const produced = await fetch(`${urls[proposerIndex]}/v1/blocks/produce`, { method: "POST" });
    const result = await produced.json();
    assert.equal(produced.status, 202, result.error);
    assert.equal(result.height, 7);
    assert.ok(result.prepares >= 4);
    assert.ok(result.commits >= 4);
    assert.deepEqual(replicas.map(({ height }) => height), [7, 7, 7, 7, 7, 7]);
    assert.deepEqual(replicas.map(({ peerCount }) => peerCount), [4, 4, 4, 4, 4, 4]);
    assert.ok(directories.every((directory) =>
      existsSync(join(directory, "handoffs", "VALIDATOR-HANDOFFS.json"))));

    const restartedNewcomer = new ValidatorReplica(directories[4]);
    assert.equal(restartedNewcomer.height, 7);
    assert.equal(restartedNewcomer.peerCount, 4);
    assert.throws(() => new ValidatorReplica(directories[2]), /does not belong to this network/);

    const nextTransaction = createTransfer({
      amount: MIN_TRANSFER_FEE.toString(),
      networkId: chain.networkId,
      nonce: 1,
      recipient: recipient.address,
      wallet: newWallets[0],
    });
    replicas[4].submitTransaction(nextTransaction);
    const nextProposal = replicas[4].buildProposal();
    assert.throws(() => replicas[2].vote(nextProposal), /cannot vote at this height/);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});
