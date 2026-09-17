#!/usr/bin/env node
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { NirChain, finalizeBlock } from "../blockchain/chain.mjs";
import { SAFETY_POLICY_V1_COMMITMENT } from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  finalizeBlockPruning,
  initializeBlockStore,
  installBlockStoreSnapshot,
  loadBlockStore,
  persistBlock,
  planBlockPruning,
  stageBlockPruning,
  verifyStagedBlockPruning,
} from "../blockchain/block-store.mjs";
import { createStateSnapshot } from "../blockchain/state-snapshot.mjs";

function integer(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} is invalid`);
  return parsed;
}

function elapsed(operation) {
  const started = performance.now();
  const value = operation();
  return { milliseconds: performance.now() - started, value };
}

function directoryBytes(path) {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const metadata = lstatSync(child);
    if (metadata.isSymbolicLink()) throw new Error("benchmark directory contains a symbolic link");
    bytes += entry.isDirectory() ? directoryBytes(child) : metadata.size;
  }
  return bytes;
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

const { values } = parseArgs({
  options: {
    blocks: { default: "100", type: "string" },
    "snapshot-height": { default: "80", type: "string" },
  },
});
const blocks = integer(values.blocks, "blocks");
const snapshotHeight = integer(values["snapshot-height"], "snapshot-height");
if (snapshotHeight >= blocks) throw new Error("snapshot-height must be below blocks");

const validators = Array.from({ length: 4 }, generateWallet);
const genesis = {
  beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
  capabilityReferences: [{
    artifactHash: `sha256:${"1".repeat(64)}`,
    behaviorCommitment: "2".repeat(64),
    capabilitiesBps: { "reasoning-v1": 1 },
  }],
  evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
  genesisTimestamp: 0,
  networkId: "nir-storage-lifecycle-benchmark",
  safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
  treasuryAddress: generateWallet().address,
  validators: members(validators, "validator"),
};
const directory = mkdtempSync(join(tmpdir(), "nir-storage-lifecycle-"));

try {
  const chain = new NirChain(genesis);
  initializeBlockStore(directory, chain);
  let snapshot = null;
  const build = elapsed(() => {
    for (let height = 1; height <= blocks; height += 1) {
      const block = finalizeBlock(
        chain.buildBlock({ timestamp: height }), validators.slice(0, 3),
      );
      chain.appendBlock(block);
      persistBlock(directory, block, chain);
      if (height === snapshotHeight) snapshot = createStateSnapshot(chain, validators.slice(0, 3));
    }
  });
  const bytesBefore = directoryBytes(directory);
  const install = elapsed(() => installBlockStoreSnapshot(directory, genesis, snapshot));
  const plan = elapsed(() => planBlockPruning(directory, genesis));
  if (!plan.value.eligible) throw new Error(`benchmark pruning plan failed: ${plan.value.reasons}`);
  const stage = elapsed(() => stageBlockPruning(directory, genesis));
  const verify = elapsed(() => verifyStagedBlockPruning(directory, genesis));
  const finalize = elapsed(() => finalizeBlockPruning(directory, genesis));
  const restart = elapsed(() => loadBlockStore(directory, genesis));
  if (restart.value.chain.tipHash !== chain.tipHash) {
    throw new Error("benchmark pruning changed the finalized chain");
  }
  console.log(JSON.stringify({
    blocks,
    buildMs: Number(build.milliseconds.toFixed(3)),
    bytesAfter: directoryBytes(directory),
    bytesBefore,
    finalizeMs: Number(finalize.milliseconds.toFixed(3)),
    installSnapshotMs: Number(install.milliseconds.toFixed(3)),
    plan: plan.value,
    planMs: Number(plan.milliseconds.toFixed(3)),
    restartMs: Number(restart.milliseconds.toFixed(3)),
    snapshotHeight,
    stageMs: Number(stage.milliseconds.toFixed(3)),
    verifyMs: Number(verify.milliseconds.toFixed(3)),
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
