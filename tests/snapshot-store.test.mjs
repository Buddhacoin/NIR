import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
