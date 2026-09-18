import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createOfflineReleaseBundle } from "../blockchain/offline-release-bundle.mjs";
import {
  appendReleaseTransparencyEntry, approveReleaseLogProposal, contextForReleaseLog,
  createReleaseAuthoritySet, createReleaseProposal, createReleaseTransparencyAnchor,
  loadReleaseTransparencyLog,
} from "../blockchain/offline-release-governance.mjs";
import {
  createReleaseWitnessEquivocationEvidence, createReleaseWitnessReceipt,
  createReleaseWitnessSet, importReleaseWitnessReceipt, loadReleaseWitnessHeadStore,
  selectReleaseWitnessHeadStore, selectReleaseWitnessView, validateReleaseWitnessReceipt,
} from "../blockchain/offline-release-witness.mjs";

const NOW = 2_000_000_000_000;
const TIME_POLICY = { maxAgeMs: 60_000, maxFutureSkewMs: 1_000, now: NOW };

function authoritySet(wallets) {
  return createReleaseAuthoritySet({ authorities: wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `release-${index + 1}`,
  })), generation: 1, rotationDelayEntries: 2, threshold: 2 });
}

function witnessSet(wallets) {
  return createReleaseWitnessSet({ threshold: 3, witnesses: wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `witness-${index + 1}`,
  })) });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-release-witness-"));
  const source = join(root, "source"); mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "payload.txt"), "witnessed release\n");
  const authorities = Array.from({ length: 3 }, generateWallet);
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const releaseSet = authoritySet(authorities);
  const anchor = createReleaseTransparencyAnchor({ initialSet: releaseSet,
    logId: "witnessed-releases", networkId: "nir-witness-test" });
  return { anchor, authorities, releaseSet, root, source, witnessSet: witnessSet(witnesses), witnesses };
}

function appendBranch(values, branch, versions) {
  const log = join(values.root, `log-${branch}`); const checkpoints = join(values.root, `cp-${branch}`);
  mkdirSync(log, { mode: 0o700 }); mkdirSync(checkpoints, { mode: 0o700 });
  let previousBundleHash = null; const results = [];
  for (const version of versions) {
    const state = loadReleaseTransparencyLog(values.anchor, log, checkpoints);
    const bundle = createOfflineReleaseBundle(values.source, ["payload.txt"], {
      networkId: values.anchor.networkId, previousBundleHash, protocolVersion: 24,
      releaseVersion: version, sourceRevision: "c".repeat(40),
    });
    const proposal = createReleaseProposal({ anchor: values.anchor, bundle, state });
    const context = contextForReleaseLog(values.anchor, state);
    const approvals = values.authorities.slice(0, 2).map((wallet, index) =>
      approveReleaseLogProposal(proposal, context, { operatorId: `release-${index + 1}`, wallet }));
    const result = appendReleaseTransparencyEntry({ anchor: values.anchor, approvals,
      checkpointDirectory: checkpoints, logDirectory: log, proposal });
    previousBundleHash = result.state.lastBundleHash; results.push(result);
  }
  return { checkpoints, log, results };
}

function receipt(values, checkpoint, index, observedAt = NOW) {
  return createReleaseWitnessReceipt({ anchor: values.anchor, checkpoint, observedAt,
    operatorId: `witness-${index + 1}`, wallet: values.witnesses[index],
    witnessSet: values.witnessSet });
}

test("M-of-N witnesses select one exact checkpoint while split 2/2 and minority fail safely", () => {
  const values = fixture();
  try {
    const first = appendBranch(values, "a", ["1.0.0"]).results[0].checkpoint;
    const second = appendBranch(values, "b", ["1.0.1"]).results[0].checkpoint;
    const majority = [0, 1, 2].map((index) => receipt(values, first, index));
    const selected = selectReleaseWitnessView(majority, { anchor: values.anchor,
      sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY });
    assert.equal(selected.entryHash, first.entryHash);
    assert.deepEqual(selected.witnesses, ["witness-1", "witness-2", "witness-3"]);

    const split = [receipt(values, first, 0), receipt(values, first, 1),
      receipt(values, second, 2), receipt(values, second, 3)];
    assert.throws(() => selectReleaseWitnessView(split, { anchor: values.anchor,
      sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY }), /no unique exact view/);

    const threeOne = [...majority, receipt(values, second, 3)];
    assert.equal(selectReleaseWitnessView(threeOne, { anchor: values.anchor,
      sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY }).entryHash, first.entryHash);
    assert.throws(() => selectReleaseWitnessView(majority.slice(0, 2), { anchor: values.anchor,
      sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY }), /no unique exact view/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("receipts reject replay identities, stale/future time, tampering, and mixed context", () => {
  const values = fixture();
  try {
    const checkpoint = appendBranch(values, "a", ["1.0.0"]).results[0].checkpoint;
    const current = receipt(values, checkpoint, 0);
    assert.throws(() => validateReleaseWitnessReceipt({ ...current, unknown: true }, {
      anchor: values.anchor, witnessSet: values.witnessSet,
    }), /unknown/);
    assert.throws(() => selectReleaseWitnessView([current, current], { anchor: values.anchor,
      sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY }), /duplicate/);
    assert.throws(() => validateReleaseWitnessReceipt(receipt(values, checkpoint, 1,
      NOW - TIME_POLICY.maxAgeMs - 1), { anchor: values.anchor,
      witnessSet: values.witnessSet, ...TIME_POLICY }), /stale/);
    assert.throws(() => validateReleaseWitnessReceipt(receipt(values, checkpoint, 1,
      NOW + TIME_POLICY.maxFutureSkewMs + 1), { anchor: values.anchor,
      witnessSet: values.witnessSet, ...TIME_POLICY }), /future/);
    assert.throws(() => validateReleaseWitnessReceipt({ ...current, networkId: "wrong-network" }, {
      anchor: values.anchor, witnessSet: values.witnessSet,
    }), /context|hash|signature/);
    const otherAnchor = createReleaseTransparencyAnchor({ initialSet: values.releaseSet,
      logId: "other-release-log", networkId: values.anchor.networkId });
    assert.throws(() => validateReleaseWitnessReceipt(current, { anchor: otherAnchor,
      witnessSet: values.witnessSet }), /context/);
    const duplicate = values.witnessSet.witnesses.map((witness) => ({ ...witness }));
    duplicate[1].operatorId = duplicate[0].operatorId;
    assert.throws(() => createReleaseWitnessSet({ threshold: 3, witnesses: duplicate }),
      /duplicate|unordered/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("two signed views from one witness produce portable forensic equivocation evidence", () => {
  const values = fixture();
  try {
    const first = appendBranch(values, "a", ["1.0.0"]).results[0].checkpoint;
    const second = appendBranch(values, "b", ["1.0.1"]).results[0].checkpoint;
    const left = receipt(values, first, 0); const right = receipt(values, second, 0);
    const evidence = createReleaseWitnessEquivocationEvidence(left, right, {
      anchor: values.anchor, witnessSet: values.witnessSet,
    });
    assert.equal(evidence.operatorId, "witness-1");
    assert.equal(evidence.sequence, 1);
    assert.equal(evidence.receipts.length, 2);
    let thrown;
    try {
      selectReleaseWitnessView([left, right], { anchor: values.anchor,
        sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY });
    } catch (error) { thrown = error; }
    assert.match(thrown.message, /equivocation/);
    assert.equal(thrown.evidence.evidenceHash, evidence.evidenceHash);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("bounded head store survives restart and rejects replay, rollback, links, and directory swap", () => {
  const values = fixture();
  try {
    const branchA = appendBranch(values, "a", ["1.0.0", "1.0.1"]);
    const branchB = appendBranch(values, "b", ["1.1.0"]);
    const store = join(values.root, "witness-store");
    const first = receipt(values, branchA.results[0].checkpoint, 0, NOW - 100);
    const second = receipt(values, branchA.results[1].checkpoint, 0, NOW);
    assert.equal(importReleaseWitnessReceipt(store, first, { anchor: values.anchor,
      witnessSet: values.witnessSet, ...TIME_POLICY }).status, "imported");
    assert.throws(() => importReleaseWitnessReceipt(store, first, { anchor: values.anchor,
      witnessSet: values.witnessSet, ...TIME_POLICY }), /replayed/);
    importReleaseWitnessReceipt(store, second, { anchor: values.anchor,
      witnessSet: values.witnessSet, ...TIME_POLICY });
    assert.equal(loadReleaseWitnessHeadStore(store, { anchor: values.anchor,
      witnessSet: values.witnessSet }).heads.get("witness-1").sequence, 2);
    assert.throws(() => importReleaseWitnessReceipt(store,
      receipt(values, branchB.results[0].checkpoint, 0), { anchor: values.anchor,
        witnessSet: values.witnessSet, ...TIME_POLICY }), /rolls.*back/);

    const stored = join(store, readdirSync(store)[0]);
    linkSync(stored, join(values.root, "linked-receipt"));
    assert.throws(() => loadReleaseWitnessHeadStore(store, { anchor: values.anchor,
      witnessSet: values.witnessSet }), /unsafe/);
    rmSync(join(values.root, "linked-receipt"));

    const original = `${store}-original`; const replacement = `${store}-replacement`;
    mkdirSync(replacement, { mode: 0o700 });
    assert.throws(() => loadReleaseWitnessHeadStore(store, { anchor: values.anchor,
      witnessSet: values.witnessSet }, { _afterDirectoryOpen: () => {
        renameSync(store, original); symlinkSync(replacement, store);
      } }), /changed|unsafe/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("store selection excludes an equivocator but accepts three independent matching heads", () => {
  const values = fixture();
  try {
    const first = appendBranch(values, "a", ["1.0.0"]).results[0].checkpoint;
    const second = appendBranch(values, "b", ["1.0.1"]).results[0].checkpoint;
    const store = join(values.root, "store");
    for (const index of [0, 1, 2]) importReleaseWitnessReceipt(store, receipt(values, first, index), {
      anchor: values.anchor, witnessSet: values.witnessSet, ...TIME_POLICY,
    });
    assert.equal(selectReleaseWitnessHeadStore(store, { anchor: values.anchor,
      sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY }).entryHash, first.entryHash);
    const outcome = importReleaseWitnessReceipt(store, receipt(values, second, 0), {
      anchor: values.anchor, witnessSet: values.witnessSet, ...TIME_POLICY,
    });
    assert.equal(outcome.status, "equivocation");
    assert.ok(outcome.evidence.evidenceHash);
    assert.throws(() => selectReleaseWitnessHeadStore(store, { anchor: values.anchor,
      sequence: 1, witnessSet: values.witnessSet, ...TIME_POLICY }), /no unique exact view/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("offline CLI exports, imports, and selects an exact witnessed checkpoint", () => {
  const values = fixture();
  try {
    const checkpoint = appendBranch(values, "a", ["1.0.0"]).results[0].checkpoint;
    const anchorPath = join(values.root, "anchor.json");
    const setPath = join(values.root, "witness-set.json");
    const checkpointPath = join(values.root, "checkpoint.json");
    writeFileSync(anchorPath, `${canonicalJson(values.anchor)}\n`, { mode: 0o600 });
    writeFileSync(setPath, `${canonicalJson(values.witnessSet)}\n`, { mode: 0o600 });
    writeFileSync(checkpointPath, `${canonicalJson(checkpoint)}\n`, { mode: 0o600 });
    const exported = join(values.root, "exported-checkpoint.json");
    execFileSync(process.execPath, ["blockchain/offline-release-witness-cli.mjs", "export",
      anchorPath, checkpointPath, exported], { cwd: new URL("..", import.meta.url) });
    assert.deepEqual(JSON.parse(readFileSync(exported, "utf8")), checkpoint);

    const store = join(values.root, "cli-store");
    for (const index of [0, 1, 2]) {
      const receiptPath = join(values.root, `receipt-${index}.json`);
      writeFileSync(receiptPath, `${canonicalJson(receipt(values, checkpoint, index))}\n`, { mode: 0o600 });
      execFileSync(process.execPath, ["blockchain/offline-release-witness-cli.mjs", "import",
        anchorPath, setPath, store, receiptPath, String(NOW), String(TIME_POLICY.maxAgeMs),
        String(TIME_POLICY.maxFutureSkewMs)], { cwd: new URL("..", import.meta.url) });
    }
    const selectionPath = join(values.root, "selection.json");
    execFileSync(process.execPath, ["blockchain/offline-release-witness-cli.mjs", "select",
      anchorPath, setPath, store, "1", String(NOW), String(TIME_POLICY.maxAgeMs),
      String(TIME_POLICY.maxFutureSkewMs), selectionPath], { cwd: new URL("..", import.meta.url) });
    assert.equal(JSON.parse(readFileSync(selectionPath, "utf8")).entryHash, checkpoint.entryHash);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});
