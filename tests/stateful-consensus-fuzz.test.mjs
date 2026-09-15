import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  blockHash,
  createTransfer,
  createValidatorBond,
  finalizeBlock,
  NirChain,
  voteForBlock,
} from "../blockchain/chain.mjs";
import {
  MIN_TRANSFER_FEE,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffle(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function member(wallet, operatorId) {
  return { ...publicWallet(wallet), operatorId };
}

function corruptSignature(signature) {
  return `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
}

test("stateful schedules recover across heights, partitions, replays, corruption, and restarts", () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const random = randomSource(seed);
    const temporary = mkdtempSync(join(tmpdir(), `nir-stateful-${seed}-`));
    try {
      const layout = initializeDistributedDevnet(join(temporary, "network"), {
        networkId: `nir-stateful-${seed}`,
      });
      let replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
      const genesis = JSON.parse(readFileSync(
        join(layout.coordinatorDirectory, "genesis.json"), "utf8",
      ));
      const wallets = layout.validatorDirectories.map((directory) =>
        JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"), "utf8")));
      const canonical = new NirChain(genesis);

      for (let step = 1; step <= 8; step += 1) {
        const first = canonical.buildBlock({ timestamp: step * 2 });
        const second = canonical.buildBlock({ timestamp: step * 2 + 1 });
        const proposerIndex = wallets.findIndex(({ address }) => address === first.proposer);
        const honest = shuffle([0, 1, 2, 3].filter((index) => index !== proposerIndex), random);
        const proposals = { first, second };
        const prepares = {
          first: new Map([[first.proposer, voteForBlock(first, wallets[proposerIndex])]]),
          second: new Map([[second.proposer, voteForBlock(second, wallets[proposerIndex])]]),
        };

        for (const index of honest) {
          const value = random() < 0.5 ? "first" : "second";
          const vote = replicas[index].vote(proposals[value]);
          prepares[value].set(vote.validator, vote);
          if (random() < 0.5) prepares[value].set(vote.validator, vote); // replay
        }

        let value = prepares.first.size >= 3 ? "first" :
          prepares.second.size >= 3 ? "second" : null;
        let proposal;
        let prepareCertificate;
        if (value === null) {
          value = random() < 0.5 ? "first" : "second";
          const base = proposals[value];
          const timeouts = honest.map((index) =>
            replicas[index].timeout({ proposal: base, nextRound: 1 }));
          proposal = replicas[honest[0]].advanceProposal(base, 1, shuffle(timeouts, random));
          const nextPrepares = shuffle([0, 1, 2, 3], random).slice(0, 3)
            .map((index) => replicas[index].vote(proposal));
          prepareCertificate = replicas[honest[0]].prepareCertificate(
            proposal, shuffle([...nextPrepares, nextPrepares[0]], random),
          );
        } else {
          proposal = proposals[value];
          prepareCertificate = replicas[honest[0]].prepareCertificate(
            proposal, shuffle([...prepares[value].values()], random),
          );
        }

        const damagedPrepare = structuredClone(prepareCertificate);
        damagedPrepare[0].signature = corruptSignature(damagedPrepare[0].signature);
        assert.throws(() => replicas[honest[0]].commitVote(proposal, damagedPrepare),
          /prepare signature is invalid/);

        const restarted = Math.floor(random() * replicas.length);
        replicas[restarted] = new ValidatorReplica(layout.validatorDirectories[restarted]);
        const commitOrder = shuffle([0, 1, 2, 3], random);
        const commits = commitOrder.map((index) =>
          replicas[index].commitVote(proposal, prepareCertificate));
        const finalizer = commitOrder[0];
        const finalized = replicas[finalizer].finalizeProposal(
          proposal, prepareCertificate, shuffle([...commits, commits[0]], random),
        );

        canonical.appendBlock(finalized);
        for (let index = 0; index < replicas.length; index += 1) {
          if (index !== finalizer) replicas[index].commit(finalized);
        }
        const diskRestart = Math.floor(random() * replicas.length);
        replicas[diskRestart] = new ValidatorReplica(layout.validatorDirectories[diskRestart]);
        assert.ok(replicas.every((replica) => replica.height === canonical.height));
        assert.equal(new Set(replicas.map(({ tipHash }) => tipHash)).size, 1);
        assert.equal(replicas[0].tipHash, canonical.tipHash);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test("stateful validator rotations survive randomized quorums, stale votes, and replay", () => {
  const oldWallets = Array.from({ length: 4 }, generateWallet);
  const newWallets = Array.from({ length: 2 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const oldMembers = oldWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const genesis = {
    beaconAuthorities: beacons.map((wallet, index) => member(wallet, `beacon-${index}`)),
    capabilityReferences: [{
      artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64),
      capabilitiesBps: { "reasoning-v1": 1 },
    }],
    evaluators: evaluators.map((wallet, index) => member(wallet, `evaluator-${index}`)),
    genesisTimestamp: 0,
    networkId: "nir-stateful-rotation",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: oldMembers,
  };

  for (let seed = 1; seed <= 8; seed += 1) {
    const random = randomSource(seed * 7919);
    let chain = new NirChain(genesis);
    const history = [];
    const allWallets = [...oldWallets, ...newWallets];
    const retained = shuffle(oldWallets, random).slice(0, 2);
    const nextWallets = [...retained, ...newWallets];
    const nextMembers = nextWallets.map((wallet) => oldWallets.includes(wallet)
      ? oldMembers[oldWallets.indexOf(wallet)]
      : member(wallet, `new-${newWallets.indexOf(wallet)}`));

    const append = (block, signers) => {
      const finalized = finalizeBlock(block, shuffle(signers, random));
      if (random() < 0.35) {
        const corrupted = structuredClone(finalized);
        corrupted.certificate[0].signature =
          corruptSignature(corrupted.certificate[0].signature);
        assert.throws(() => chain.appendBlock(corrupted), /invalid validator signature/);
      }
      chain.appendBlock(finalized);
      history.push(finalized);
      if (random() < 0.5) {
        const replayed = new NirChain(genesis);
        for (const recorded of history) replayed.appendBlock(recorded);
        chain = replayed;
      }
    };
    const quorum = (wallets) => shuffle(wallets, random).slice(0, 3);

    const funding = allWallets.map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(),
      networkId: chain.networkId,
      nonce,
      recipient: wallet.address,
      wallet: treasury,
    }));
    append(chain.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS }),
      quorum(oldWallets));
    const bonds = allWallets.map((wallet, index) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(),
      networkId: chain.networkId,
      nonce: 0,
      operatorId: index < oldWallets.length ? undefined : `new-${index - oldWallets.length}`,
      wallet,
    }));
    append(chain.buildBlock({ transactions: bonds, timestamp: TREASURY_VESTING_MS + 1 }),
      quorum(oldWallets));
    append(chain.buildBlock({
      timestamp: TREASURY_VESTING_MS + 2,
      validatorRotation: { activationHeight: 8, validators: nextMembers },
    }), quorum(oldWallets));

    for (let height = 4; height <= 7; height += 1) {
      append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }), quorum(oldWallets));
    }
    const activation = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 8 });
    assert.throws(() => chain.appendBlock(finalizeBlock(activation, quorum(oldWallets))),
      /unknown validator|prepare quorum|finality quorum|old-set/);
    const joint = [...new Map([
      ...quorum(oldWallets), ...quorum(nextWallets),
    ].map((wallet) => [wallet.address, wallet])).values()];
    append(activation, joint);
    for (let height = 9; height <= 11; height += 1) {
      append(chain.buildBlock({ timestamp: TREASURY_VESTING_MS + height }), quorum(nextWallets));
    }
    assert.equal(chain.height, 11);
    assert.equal(chain.validatorSetId,
      validatorSetId(nextMembers.sort((left, right) => left.address.localeCompare(right.address))));
  }
});
