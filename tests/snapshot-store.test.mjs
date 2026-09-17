import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NirChain, finalizeBlock } from "../blockchain/chain.mjs";
import { SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  installStateSnapshot,
  loadInstalledStateSnapshot,
} from "../blockchain/snapshot-store.mjs";
import { createStateSnapshot, selectStateSnapshot } from "../blockchain/state-snapshot.mjs";
import {
  initializeBlockStore,
  exportBlockStoreBackup,
  finalizeBlockPruning,
  installBlockStoreSnapshot,
  loadBlockStore,
  planBlockPruning,
  persistBlock,
  stageBlockPruning,
  verifyStagedBlockPruning,
} from "../blockchain/block-store.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function fixture(timestamp = 1) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorMembers = members(validators, "validator");
  const genesisConfig = {
    beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${digest("store-baseline")}`,
      behaviorCommitment: digest("store-behavior"),
      capabilitiesBps: { "reasoning-v1": 7_000 },
    }],
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisTimestamp: 0,
    networkId: "nir-snapshot-store-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address,
    validators: validatorMembers,
  };
  const chain = new NirChain(genesisConfig);
  const block = chain.buildBlock({ timestamp });
  chain.appendBlock(finalizeBlock(block, validators.slice(0, 3)));
  const trustAnchor = { expectedNetworkId: chain.networkId, trustedValidators: validatorMembers };
  return { chain, genesisConfig, trustAnchor, validators };
}

test("snapshot selection requires matching data from independent sources", () => {
  const { chain, trustAnchor, validators } = fixture();
  const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
  const tampered = structuredClone(snapshot);
  tampered.state.burned = "1";
  const selected = selectStateSnapshot([
    { source: "validator-a", snapshot },
    { source: "validator-b", snapshot: structuredClone(snapshot) },
    { source: "byzantine-c", snapshot: tampered },
  ], trustAnchor);
  assert.equal(selected.verified.snapshotHash, snapshot.snapshotHash);
  assert.deepEqual(selected.sources, ["validator-a", "validator-b"]);
  assert.throws(() => selectStateSnapshot([
    { source: "validator-a", snapshot },
    { source: "byzantine-c", snapshot: tampered },
  ], trustAnchor), /enough independent sources/);
});

test("selection fails closed when trusted validators sign conflicting snapshots", () => {
  const first = fixture(1);
  const alternateChain = new NirChain(first.genesisConfig);
  const alternate = alternateChain.buildBlock({ timestamp: 2 });
  alternateChain.appendBlock(finalizeBlock(alternate, first.validators.slice(0, 3)));
  const left = createStateSnapshot(first.chain, first.validators.slice(0, 3));
  const right = createStateSnapshot(alternateChain, first.validators.slice(0, 3));
  assert.throws(() => selectStateSnapshot([
    { source: "a", snapshot: left },
    { source: "b", snapshot: left },
    { source: "c", snapshot: right },
    { source: "d", snapshot: right },
  ], first.trustAnchor), /conflicting quorum snapshots/);
});

test("installed snapshots are atomic, redundant, repairable, and rollback protected", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-snapshot-store-"));
  const { chain, genesisConfig, trustAnchor, validators } = fixture();
  try {
    const first = createStateSnapshot(chain, validators.slice(0, 3));
    installStateSnapshot(root, genesisConfig, first, trustAnchor);
    const primary = join(root, "STATE-SNAPSHOT.json");
    const backup = join(root, "STATE-SNAPSHOT.backup.json");
    writeFileSync(primary, "{broken", "utf8");
    const repaired = loadInstalledStateSnapshot(root, genesisConfig, trustAnchor);
    assert.equal(repaired.recoveredCopies, 1);
    assert.equal(repaired.chain.stateRoot, chain.stateRoot);
    assert.equal(readFileSync(primary, "utf8"), readFileSync(backup, "utf8"));

    const next = chain.buildBlock({ timestamp: 2 });
    chain.appendBlock(finalizeBlock(next, validators.slice(0, 3)));
    const newer = createStateSnapshot(chain, validators.slice(0, 3));
    installStateSnapshot(root, genesisConfig, newer, trustAnchor);
    assert.throws(() => installStateSnapshot(root, genesisConfig, first, trustAnchor),
      /rollback is not allowed/);
    assert.equal(loadInstalledStateSnapshot(root, genesisConfig, trustAnchor).chain.height, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a joining node starts at a verified snapshot and replays only the journal tail", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-snapshot-join-"));
  const { chain, genesisConfig, trustAnchor, validators } = fixture();
  try {
    const snapshot = createStateSnapshot(chain, validators.slice(0, 3));
    initializeBlockStore(root, new NirChain(genesisConfig));
    const installed = installBlockStoreSnapshot(root, genesisConfig, snapshot, {
      trustedValidators: trustAnchor.trustedValidators,
    });
    assert.equal(installed.chain.height, 1);
    assert.equal(installed.chain.blocks().length, 1);

    const proposal = chain.buildBlock({ timestamp: 2 });
    const tail = finalizeBlock(proposal, validators.slice(0, 3));
    chain.appendBlock(tail);
    installed.chain.appendBlock(tail);
    persistBlock(root, tail, installed.chain);

    const restarted = loadBlockStore(root, genesisConfig);
    assert.equal(restarted.chain.height, 2);
    assert.equal(restarted.chain.tipHash, chain.tipHash);
    assert.equal(restarted.chain.stateRoot, chain.stateRoot);
    assert.equal(restarted.chain.blocks().length, 2);
    const checkpoint = JSON.parse(readFileSync(join(root, "STORE-CHECKPOINT.json"), "utf8"));
    assert.equal(checkpoint.baseHeight, 1);
    assert.equal(checkpoint.blocks.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old journal blocks are quarantined and deleted only after restart verification", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-snapshot-prune-"));
  const { chain, genesisConfig, trustAnchor, validators } = fixture();
  try {
    const block1 = chain.blocks().at(-1);
    initializeBlockStore(root, new NirChain(genesisConfig));
    const replay = new NirChain(genesisConfig);
    replay.appendBlock(block1);
    persistBlock(root, block1, replay);
    const snapshot = createStateSnapshot(chain, validators.slice(0, 3));

    const proposal = chain.buildBlock({ timestamp: 2 });
    const block2 = finalizeBlock(proposal, validators.slice(0, 3));
    chain.appendBlock(block2);
    replay.appendBlock(block2);
    persistBlock(root, block2, replay);
    installBlockStoreSnapshot(root, genesisConfig, snapshot);

    const plan = planBlockPruning(root, genesisConfig);
    assert.equal(plan.eligible, true);
    assert.equal(plan.prunableBlocks, 1);
    assert.ok(plan.prunableBytes > 0);
    assert.equal(plan.projectedLiveBytes, plan.snapshotBytes + plan.tailBytes);
    assert.equal(planBlockPruning(root, genesisConfig, {
      pruningPolicy: { minimumPrunableBytes: plan.prunableBytes + 1 },
    }).eligible, false);
    const staged = stageBlockPruning(root, genesisConfig);
    assert.equal(staged.baseHeight, 1);
    assert.equal(staged.movedFiles, 2);
    assert.throws(() => finalizeBlockPruning(root, genesisConfig), /restart verification/);
    assert.equal(loadBlockStore(root, genesisConfig).chain.tipHash, chain.tipHash);

    const manifestPath = join(staged.quarantine, "PRUNE-MANIFEST.json");
    const realManifestPath = `${manifestPath}.real`;
    renameSync(manifestPath, realManifestPath);
    symlinkSync(realManifestPath, manifestPath);
    assert.throws(() => verifyStagedBlockPruning(root, genesisConfig), /manifest is invalid/);
    rmSync(manifestPath);
    renameSync(realManifestPath, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath));
    const firstTarget = join(
      staged.quarantine, manifest.files[0].folder, manifest.files[0].name,
    );
    const original = readFileSync(firstTarget, "utf8");
    writeFileSync(firstTarget, "corrupt\n", "utf8");
    assert.throws(() => verifyStagedBlockPruning(root, genesisConfig), /checksum mismatch/);
    writeFileSync(firstTarget, original, "utf8");
    const verified = verifyStagedBlockPruning(root, genesisConfig);
    assert.equal(verified.verifiedHeight, 2);

    const block3 = finalizeBlock(chain.buildBlock({ timestamp: 3 }), validators.slice(0, 3));
    chain.appendBlock(block3);
    replay.appendBlock(block3);
    persistBlock(root, block3, replay);
    assert.throws(() => finalizeBlockPruning(root, genesisConfig), /stale or invalid/);
    assert.equal(verifyStagedBlockPruning(root, genesisConfig).verifiedHeight, 3);
    const verificationPath = join(staged.quarantine, "PRUNE-VERIFIED.json");
    const realVerificationPath = `${verificationPath}.real`;
    renameSync(verificationPath, realVerificationPath);
    symlinkSync(realVerificationPath, verificationPath);
    assert.throws(() => finalizeBlockPruning(root, genesisConfig), /restart verification/);
    rmSync(verificationPath);
    renameSync(realVerificationPath, verificationPath);
    const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
    writeFileSync(join(staged.quarantine, "PRUNE-FINALIZING.json"), JSON.stringify({
      checkpointHash: verification.checkpointHash,
      format: "nir-prune-finalizing-v1",
      manifestHash: verification.manifestHash,
    }), "utf8");
    rmSync(firstTarget);
    const finalized = finalizeBlockPruning(root, genesisConfig);
    assert.equal(finalized.deletedFiles, 1);
    assert.equal(finalized.plannedFiles, 2);
    assert.equal(loadBlockStore(root, genesisConfig).chain.tipHash, chain.tipHash);
    const backup = join(root, "portable-backup");
    exportBlockStoreBackup(root, backup, genesisConfig);
    assert.equal(loadBlockStore(backup, genesisConfig).chain.tipHash, chain.tipHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator CLI installs a snapshot and enforces the three pruning phases", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-snapshot-cli-"));
  const { chain, genesisConfig, validators } = fixture();
  try {
    initializeBlockStore(root, new NirChain(genesisConfig));
    const replay = new NirChain(genesisConfig);
    replay.appendBlock(chain.blocks().at(-1));
    persistBlock(root, chain.blocks().at(-1), replay);
    writeFileSync(join(root, "genesis.json"), JSON.stringify(genesisConfig), "utf8");
    const snapshotPath = join(root, "incoming-snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(
      createStateSnapshot(chain, validators.slice(0, 3)),
    ), "utf8");
    const run = (...arguments_) => JSON.parse(execFileSync(process.execPath, [
      "blockchain/node-cli.mjs", ...arguments_,
    ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(run("snapshot-install", root, snapshotPath).height, 1);
    const plan = run("prune-plan", root);
    assert.equal(plan.eligible, true);
    assert.equal(plan.prunableBlocks, 1);
    assert.ok(plan.prunableBytes > 0);
    assert.equal(run("prune-stage", root).baseHeight, 1);
    assert.throws(() => run("prune-finalize", root), /restart verification/);
    assert.equal(run("prune-verify", root).verifiedHeight, 1);
    assert.equal(run("prune-finalize", root).baseHeight, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
