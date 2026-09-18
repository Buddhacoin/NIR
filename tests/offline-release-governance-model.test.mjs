import assert from "node:assert/strict";
import {
  cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createOfflineReleaseBundle } from "../blockchain/offline-release-bundle.mjs";
import {
  acceptReleaseAuthorityChange, appendReleaseTransparencyEntry, approveReleaseActivationProposal,
  approveReleaseLogProposal, contextForReleaseLog, createReleaseAuthoritySet,
  createReleaseLogEntry, createReleaseProposal, createReleaseTransparencyAnchor,
  loadReleaseTransparencyLog, recoverReleaseTransparencyCheckpoint,
} from "../blockchain/offline-release-governance.mjs";

const SCHEDULES = 200;
const REVISION = "b".repeat(40);

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function setFrom(specification, generation, threshold) {
  return createReleaseAuthoritySet({
    authorities: specification.map(([operatorId, wallet]) => ({
      ...publicWallet(wallet), operatorId,
    })),
    generation, rotationDelayEntries: 2, threshold,
  });
}

function signer(set, walletsByAddress, operatorId) {
  const authority = set.authorities.find((item) => item.operatorId === operatorId);
  return { operatorId, wallet: walletsByAddress.get(authority.address) };
}

function signActive(proposal, context, set, walletsByAddress, operatorIds) {
  return operatorIds.map((operatorId) =>
    approveReleaseLogProposal(proposal, context, signer(set, walletsByAddress, operatorId)));
}

function signAcceptance(proposal, context, set, walletsByAddress, operatorIds) {
  return operatorIds.map((operatorId) =>
    acceptReleaseAuthorityChange(proposal, context, signer(set, walletsByAddress, operatorId)));
}

function signActivation(proposal, context, set, walletsByAddress, operatorIds) {
  return operatorIds.map((operatorId) =>
    approveReleaseActivationProposal(proposal, context, signer(set, walletsByAddress, operatorId)));
}

function modelInitial(anchor) {
  return {
    activeSet: anchor.initialSet, bundleHash: null, head: anchor.anchorHash,
    pending: null, sequence: 0, sequenceHashes: new Map(),
  };
}

function uniqueQuorum(approvals, set, role) {
  assert.ok(Array.isArray(approvals));
  assert.ok(approvals.length >= set.threshold);
  const operators = new Set();
  const addresses = new Set();
  for (const approval of approvals) {
    const authority = set.authorities.find((item) => item.operatorId === approval.operatorId);
    assert.ok(authority);
    assert.equal(approval.address, authority.address);
    assert.equal(approval.setId, set.setId);
    assert.equal(approval.role, role);
    assert.equal(operators.has(approval.operatorId), false);
    assert.equal(addresses.has(approval.address), false);
    operators.add(approval.operatorId); addresses.add(approval.address);
  }
}

function applyModel(modelValue, entry) {
  const model = { ...modelValue };
  let activationSet = null;
  if (model.pending?.activationSequence === model.sequence + 1) {
    activationSet = model.activeSet;
    model.activeSet = model.pending.nextSet;
    model.pending = null;
  }
  assert.equal(entry.sequence, model.sequence + 1);
  assert.equal(entry.previousEntryHash, model.head);
  assert.equal(entry.activeSetId, model.activeSet.setId);
  assert.equal(model.sequenceHashes.has(entry.sequence), false,
    "the model permits only one hash for a sequence");
  uniqueQuorum(entry.approvals, model.activeSet, "active");
  if (activationSet === null) assert.deepEqual(entry.activationApprovals, []);
  else uniqueQuorum(entry.activationApprovals, activationSet, "activation");

  if (entry.type === "authority-change") {
    assert.equal(model.pending, null);
    assert.equal(entry.payload.activationSequence,
      entry.sequence + model.activeSet.rotationDelayEntries);
    uniqueQuorum(entry.nextSetAcceptances, entry.payload.nextSet, "next-set-acceptance");
    model.pending = entry.payload;
  } else {
    assert.deepEqual(entry.nextSetAcceptances, []);
    assert.equal(entry.payload.previousBundleHash, model.bundleHash,
      "release bundle history must be monotonic");
    model.bundleHash = entry.payload.bundleHash;
  }
  model.sequenceHashes.set(entry.sequence, entry.entryHash);
  model.sequence = entry.sequence;
  model.head = entry.entryHash;
  return model;
}

function compareState(model, production) {
  assert.equal(production.sequence, model.sequence);
  assert.equal(production.entryHash, model.head);
  assert.equal(production.lastBundleHash, model.bundleHash);
  assert.equal(production.activeSet.setId, model.activeSet.setId);
  assert.equal(production.pendingChange?.nextSet.setId ?? null, model.pending?.nextSet.setId ?? null);
  assert.equal(production.pendingChange?.activationSequence ?? null,
    model.pending?.activationSequence ?? null);
}

function releaseBundle(source, anchor, version, previousBundleHash) {
  return createOfflineReleaseBundle(source, ["payload.txt"], {
    networkId: anchor.networkId, previousBundleHash, protocolVersion: 24,
    releaseVersion: version, sourceRevision: REVISION,
  });
}

function appendAndModel(environment, model, proposal, groups) {
  const before = loadReleaseTransparencyLog(environment.anchor, environment.log, environment.checkpoints);
  const result = appendReleaseTransparencyEntry({
    activationApprovals: groups.activation ?? [], anchor: environment.anchor,
    approvals: groups.active, checkpointDirectory: environment.checkpoints,
    logDirectory: environment.log, nextSetAcceptances: groups.acceptance ?? [], proposal,
  });
  const nextModel = applyModel(model, result.entry);
  compareState(nextModel, result.state);
  compareState(nextModel,
    loadReleaseTransparencyLog(environment.anchor, environment.log, environment.checkpoints));
  assert.equal(before.sequence + 1, result.state.sequence);
  return { model: nextModel, result };
}

test(`seeded model matches production over ${SCHEDULES} adversarial schedules`, () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "nir-governance-model-source-"));
  writeFileSync(join(sourceRoot, "payload.txt"), "model-checked release payload\n");
  const wallets = Array.from({ length: 6 }, generateWallet);
  const walletsByAddress = new Map(wallets.map((wallet) => [wallet.address, wallet]));
  const oldSet = setFrom([
    ["alpha", wallets[0]], ["bravo", wallets[1]], ["charlie", wallets[2]], ["delta", wallets[3]],
  ], 1, 3);
  try {
    for (let seed = 1; seed <= SCHEDULES; seed += 1) {
      const choose = random(seed);
      const root = mkdtempSync(join(tmpdir(), `nir-governance-model-${seed}-`));
      const log = join(root, "log");
      const checkpoints = join(root, "checkpoints");
      mkdirSync(log, { mode: 0o700 }); mkdirSync(checkpoints, { mode: 0o700 });
      const anchor = createReleaseTransparencyAnchor({
        initialSet: oldSet, logId: "model-release-log", networkId: "nir-model-net",
      });
      const environment = { anchor, checkpoints, log };
      let model = modelInitial(anchor);
      let version = 0;
      try {
        if (choose() < 0.5) {
          const state = loadReleaseTransparencyLog(anchor, log, checkpoints);
          const proposal = createReleaseProposal({ anchor,
            bundle: releaseBundle(sourceRoot, anchor, `1.0.${version++}`, model.bundleHash), state });
          const context = contextForReleaseLog(anchor, state);
          const active = signActive(proposal, context, oldSet, walletsByAddress,
            ["alpha", "bravo", "charlie"]);
          assert.throws(() => appendReleaseTransparencyEntry({ anchor, approvals: active.slice(0, 2),
            checkpointDirectory: checkpoints, logDirectory: log, proposal }), /quorum/);
          assert.throws(() => appendReleaseTransparencyEntry({ anchor,
            approvals: [active[0], active[0], active[1]], checkpointDirectory: checkpoints,
            logDirectory: log, proposal }), /duplicate/);
          ({ model } = appendAndModel(environment, model, proposal,
            { active: choose() < 0.5 ? active : [...active].reverse() }));
          assert.throws(() => appendReleaseTransparencyEntry({ anchor, approvals: active,
            checkpointDirectory: checkpoints, logDirectory: log, proposal }), /stale|context/);
        }

        const revocation = choose() < 0.5;
        const nextSet = revocation
          ? setFrom([["alpha", wallets[0]], ["bravo", wallets[1]], ["charlie", wallets[2]]], 2, 2)
          : setFrom([["alpha", wallets[0]], ["bravo", wallets[1]], ["charlie", wallets[2]],
            ["delta", wallets[4]]], 2, 3);
        let state = loadReleaseTransparencyLog(anchor, log, checkpoints);
        const change = createReleaseProposal({ anchor, nextSet,
          reason: revocation ? "revocation" : "rotation", state });
        let context = contextForReleaseLog(anchor, state);
        const oldApprovals = signActive(change, context, oldSet, walletsByAddress,
          ["alpha", "bravo", "charlie"]);
        const nextOperators = nextSet.authorities.slice(0, nextSet.threshold).map((item) => item.operatorId);
        const acceptances = signAcceptance(change, context, nextSet, walletsByAddress, nextOperators);
        assert.throws(() => appendReleaseTransparencyEntry({ anchor, approvals: oldApprovals,
          checkpointDirectory: checkpoints, logDirectory: log, proposal: change }), /quorum/);
        assert.throws(() => appendReleaseTransparencyEntry({ anchor,
          approvals: oldApprovals.slice(0, oldSet.threshold - 1), checkpointDirectory: checkpoints,
          logDirectory: log, nextSetAcceptances: acceptances, proposal: change }), /quorum/);
        assert.throws(() => approveReleaseLogProposal(change, context,
          { operatorId: "delta", wallet: wallets[4] }), /not an authority/,
        "a new-only key cannot authorize its own set");
        assert.deepEqual(
          createReleaseLogEntry(change, oldApprovals, context, { nextSetAcceptances: acceptances }),
          createReleaseLogEntry(change, [...oldApprovals].reverse(), context,
            { nextSetAcceptances: [...acceptances].reverse() }),
          "approval arrival order must not change the entry hash");
        ({ model } = appendAndModel(environment, model, change,
          { acceptance: choose() < 0.5 ? acceptances : [...acceptances].reverse(),
            active: choose() < 0.5 ? oldApprovals : [...oldApprovals].reverse() }));

        state = loadReleaseTransparencyLog(anchor, log, checkpoints);
        const intermediate = createReleaseProposal({ anchor,
          bundle: releaseBundle(sourceRoot, anchor, `1.0.${version++}`, model.bundleHash), state });
        context = contextForReleaseLog(anchor, state);
        const intermediateApprovals = signActive(intermediate, context, oldSet, walletsByAddress,
          ["alpha", "bravo", "charlie"]);
        ({ model } = appendAndModel(environment, model, intermediate,
          { active: intermediateApprovals }));

        state = loadReleaseTransparencyLog(anchor, log, checkpoints);
        const boundary = createReleaseProposal({ anchor,
          bundle: releaseBundle(sourceRoot, anchor, `1.0.${version++}`, model.bundleHash), state });
        context = contextForReleaseLog(anchor, state);
        assert.equal(context.currentSet.setId, nextSet.setId);
        assert.equal(context.activationSet.setId, oldSet.setId);
        const newApprovals = signActive(boundary, context, nextSet, walletsByAddress, nextOperators);
        const activation = signActivation(boundary, context, oldSet, walletsByAddress,
          ["alpha", "bravo", "charlie"]);
        assert.throws(() => appendReleaseTransparencyEntry({ anchor, approvals: newApprovals,
          checkpointDirectory: checkpoints, logDirectory: log, proposal: boundary }), /quorum/,
        "the first new-set entry also requires the old quorum");
        ({ model } = appendAndModel(environment, model, boundary,
          { activation: choose() < 0.5 ? activation : [...activation].reverse(),
            active: newApprovals }));

        if (choose() < 0.7) {
          const checkpointName = readdirSync(checkpoints).at(-1);
          const checkpointBytes = readFileSync(join(checkpoints, checkpointName));
          rmSync(join(checkpoints, checkpointName));
          compareState(model, loadReleaseTransparencyLog(anchor, log, checkpoints));
          const recovered = recoverReleaseTransparencyCheckpoint({ anchor,
            checkpointDirectory: checkpoints, logDirectory: log });
          assert.deepEqual(readFileSync(join(checkpoints, readdirSync(checkpoints).at(-1))), checkpointBytes);
          assert.equal(recoverReleaseTransparencyCheckpoint({ anchor,
            checkpointDirectory: checkpoints, logDirectory: log }).checkpointHash,
          recovered.checkpointHash);
        }

        const failure = Math.floor(choose() * 3);
        if (failure === 0) {
          rmSync(join(log, readdirSync(log).at(-1)));
          assert.throws(() => loadReleaseTransparencyLog(anchor, log, checkpoints), /rolled back|forked/);
        } else if (failure === 1) {
          const entry = join(log, readdirSync(log)[0]);
          linkSync(entry, join(log, `000000000001-${"f".repeat(64)}.json`));
          assert.throws(() => loadReleaseTransparencyLog(anchor, log, checkpoints),
            /split|duplicate|unsafe/);
        } else {
          const checkpoint = join(checkpoints, readdirSync(checkpoints).at(-1));
          const value = JSON.parse(readFileSync(checkpoint, "utf8"));
          value.entryHash = `sha3-256:${"e".repeat(64)}`;
          writeFileSync(checkpoint, `${JSON.stringify(value)}\n`);
          assert.throws(() => loadReleaseTransparencyLog(anchor, log, checkpoints),
            /canonical|invalid|forked/);
        }
      } finally { rmSync(root, { force: true, recursive: true }); }
    }
  } finally { rmSync(sourceRoot, { force: true, recursive: true }); }
});

test("exchanging checkpoints detects two independently valid split views", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-governance-split-view-"));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 }); writeFileSync(join(source, "payload.txt"), "split view\n");
  const wallets = Array.from({ length: 3 }, generateWallet);
  const set = setFrom([["alpha", wallets[0]], ["bravo", wallets[1]], ["charlie", wallets[2]]], 1, 2);
  const byAddress = new Map(wallets.map((wallet) => [wallet.address, wallet]));
  const anchor = createReleaseTransparencyAnchor({ initialSet: set,
    logId: "split-view-log", networkId: "nir-model-net" });
  try {
    const heads = [];
    for (const branch of ["a", "b"]) {
      const log = join(root, `log-${branch}`); const checkpoints = join(root, `checkpoints-${branch}`);
      mkdirSync(log, { mode: 0o700 }); mkdirSync(checkpoints, { mode: 0o700 });
      const state = loadReleaseTransparencyLog(anchor, log, checkpoints);
      const proposal = createReleaseProposal({ anchor,
        bundle: releaseBundle(source, anchor, branch === "a" ? "2.0.0" : "2.0.1", null), state });
      const context = contextForReleaseLog(anchor, state);
      const active = signActive(proposal, context, set, byAddress, ["alpha", "bravo"]);
      heads.push(appendReleaseTransparencyEntry({ anchor, approvals: active,
        checkpointDirectory: checkpoints, logDirectory: log, proposal }));
    }
    assert.notEqual(heads[0].entry.entryHash, heads[1].entry.entryHash);
    const foreign = join(root, "checkpoints-a", readdirSync(join(root, "checkpoints-a"))[0]);
    cpSync(foreign, join(root, "checkpoints-b", readdirSync(join(root, "checkpoints-a"))[0]));
    assert.throws(() => loadReleaseTransparencyLog(anchor, join(root, "log-b"),
      join(root, "checkpoints-b")), /forked|duplicate/);
  } finally { rmSync(root, { force: true, recursive: true }); }
});
