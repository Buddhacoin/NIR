import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  acceptCheckpointTrustPackage, createCheckpointTrustStore, loadCheckpointTrustStore,
} from "../blockchain/checkpoint-trust-store.mjs";
import {
  assembleCheckpointTrustPackage, createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy, serializeCheckpointTrustPackage,
} from "../blockchain/checkpoint-trust-package.mjs";
import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION, EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS, SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function fixture() {
  const networkId = `trust-store-${Date.now()}-${Math.random()}`;
  const validators = Array.from({ length: 4 }, generateWallet);
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const chain = new NirChain({
    beaconAuthorities: members(Array.from({ length: 4 }, generateWallet), "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 },
    evaluators: members(Array.from({ length: 4 }, generateWallet), "evaluator"),
    genesisProtocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    genesisTimestamp: 0, networkId, safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address, validators: members(validators, "validator"),
  });
  const append = () => {
    const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
    const block = finalizeBlock(proposal, validators.slice(0, 3));
    chain.appendBlock(block); return block;
  };
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  const proposal = chain.buildBlock({ protocolUpgrade: { activationHeight,
    format: "nir-protocol-upgrade-v1", version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION },
  timestamp: 1 });
  chain.appendBlock(finalizeBlock(proposal, validators.slice(0, 3)));
  while (chain.height < activationHeight) append();
  const genesisHash = chain.blocks()[0].hash;
  const policy = createCheckpointWitnessPolicy({ chainIdentityGenesisHash: genesisHash,
    generation: 1, networkId, threshold: 3, witnesses: members(witnesses, "witness") });
  const validatorMembers = members(validators, "validator");
  const buildPackage = (sequence, block = chain.blocks().at(-1)) => {
    const finalityProof = createFinalityProof(block);
    const attestations = witnesses.slice(0, 3).map((wallet, index) =>
      createCheckpointWitnessAttestation({ finalityProof, observedAt: 10_000 + sequence + index,
        operatorId: `witness-${index}`, policy, sequence, validators: validatorMembers, wallet }));
    return assembleCheckpointTrustPackage({ attestations, finalityProof, policy, sequence,
      validators: validatorMembers });
  };
  const options = { expectedChainIdentityGenesisHash: genesisHash, expectedNetworkId: networkId,
    expectedPolicyId: policy.policyId };
  return { append, buildPackage, chain, options };
}

function location(name) {
  const root = mkdtempSync(join(tmpdir(), `nir-${name}-`));
  return { path: join(root, "checkpoint-trust"), root };
}

test("verified checkpoint trust state survives restart-shaped reload and advances monotonically", () => {
  const value = fixture(); const target = location("trust-state");
  try {
    const firstPackage = value.buildPackage(7);
    const created = createCheckpointTrustStore(target.path, firstPackage, value.options);
    assert.equal(created.record.sequence, 7);
    assert.equal(loadCheckpointTrustStore(target.path, value.options).record.recordHash,
      created.record.recordHash);

    const nextPackage = value.buildPackage(8, value.append());
    const advanced = acceptCheckpointTrustPackage(target.path, nextPackage);
    assert.equal(advanced.record.sequence, 8);
    assert.equal(advanced.record.revision, 1);
    assert.equal(advanced.record.previousRecordHash, created.record.recordHash);
    assert.deepEqual(loadCheckpointTrustStore(target.path).record, advanced.record);
    assert.deepEqual(acceptCheckpointTrustPackage(target.path, nextPackage).record, advanced.record);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

test("verification happens before creation or mutation and rollback/divergence fail closed", () => {
  const value = fixture(); const target = location("trust-replay");
  try {
    const first = value.buildPackage(4);
    const forged = structuredClone(first); forged.packageHash = `sha3-256:${"0".repeat(64)}`;
    assert.throws(() => createCheckpointTrustStore(target.path, forged, value.options), /hash/);
    assert.throws(() => loadCheckpointTrustStore(target.path), /ENOENT/);
    const created = createCheckpointTrustStore(target.path, first, value.options);
    const laterAtSameSequence = value.buildPackage(4, value.append());
    assert.throws(() => acceptCheckpointTrustPackage(target.path, laterAtSameSequence),
      /sequence divergence/);
    assert.equal(loadCheckpointTrustStore(target.path).record.recordHash, created.record.recordHash);
    assert.throws(() => acceptCheckpointTrustPackage(target.path, forged), /view|hash|replayed/);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

test("redundant linked copies recover an interrupted second-copy replacement but reject rollback", () => {
  const value = fixture(); const target = location("trust-copies");
  try {
    const old = createCheckpointTrustStore(target.path, value.buildPackage(1), value.options);
    const oldBytes = readFileSync(`${target.path}.secondary`);
    const next = acceptCheckpointTrustPackage(target.path, value.buildPackage(2, value.append()));
    unlinkSync(`${target.path}.secondary`);
    writeFileSync(`${target.path}.secondary`, oldBytes, { mode: 0o600 });
    assert.equal(loadCheckpointTrustStore(target.path).record.recordHash, next.record.recordHash);
    unlinkSync(`${target.path}.primary`);
    writeFileSync(`${target.path}.primary`, oldBytes, { mode: 0o600 });
    assert.throws(() => loadCheckpointTrustStore(target.path), /rollback|replacement/);
    assert.notEqual(old.record.recordHash, next.record.recordHash);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

test("symlinks and hardlinks are rejected", () => {
  for (const attack of ["symlink", "hardlink"]) {
    const value = fixture(); const target = location(`trust-${attack}`);
    try {
      createCheckpointTrustStore(target.path, value.buildPackage(1), value.options);
      if (attack === "symlink") {
        unlinkSync(`${target.path}.secondary`);
        symlinkSync(`${target.path}.primary`, `${target.path}.secondary`);
        assert.throws(() => loadCheckpointTrustStore(target.path), /unsafe/);
      } else if (attack === "hardlink") {
        linkSync(`${target.path}.primary`, join(target.root, "stolen"));
        assert.throws(() => loadCheckpointTrustStore(target.path), /unsafe/);
      }
    } finally { rmSync(target.root, { recursive: true, force: true }); }
  }
});

function lockOwner(pid, token = "a".repeat(64)) {
  return `${JSON.stringify({ format: "nir-checkpoint-trust-store-lock-v1", pid, token,
    version: 1 })}\n`;
}

test("a canonical dead-owner lock is recovered after a crash", () => {
  const value = fixture(); const target = location("trust-dead-lock");
  try {
    createCheckpointTrustStore(target.path, value.buildPackage(1), value.options);
    writeFileSync(`${target.path}.lock`, lockOwner(2_147_483_647), { mode: 0o600 });
    const advanced = acceptCheckpointTrustPackage(target.path, value.buildPackage(2, value.append()));
    assert.equal(advanced.record.sequence, 2);
    assert.throws(() => readFileSync(`${target.path}.lock`), /ENOENT/);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});

test("malformed and live-owner locks fail closed", () => {
  for (const attack of ["malformed", "live"]) {
    const value = fixture(); const target = location(`trust-${attack}-lock`);
    try {
      createCheckpointTrustStore(target.path, value.buildPackage(1), value.options);
      writeFileSync(`${target.path}.lock`, attack === "live" ? lockOwner(process.pid) : "broken\n",
        { mode: 0o600 });
      assert.throws(() => acceptCheckpointTrustPackage(
        target.path, value.buildPackage(2, value.append())),
      attack === "live" ? /live owner/ : /not valid JSON|owner is invalid/);
      assert.ok(readFileSync(`${target.path}.lock`).length > 0);
    } finally { rmSync(target.root, { recursive: true, force: true }); }
  }
});

test("group/world-accessible roots or copies fail closed", () => {
  for (const attack of ["root-mode", "copy-mode"]) {
    const value = fixture(); const target = location(`trust-${attack}`);
    try {
      createCheckpointTrustStore(target.path, value.buildPackage(1), value.options);
      if (attack === "root-mode") chmodSync(target.root, 0o770);
      else chmodSync(`${target.path}.primary`, 0o660);
      assert.throws(() => loadCheckpointTrustStore(target.path), /root changed|unsafe/);
    } finally {
      try { chmodSync(target.root, 0o700); } catch {}
      rmSync(target.root, { recursive: true, force: true });
    }
  }
});

test("new store roots and copies are created private", () => {
  const value = fixture();
  const parent = mkdtempSync(join(tmpdir(), "nir-trust-private-"));
  const root = join(parent, "private-root");
  const path = join(root, "checkpoint-trust");
  try {
    createCheckpointTrustStore(path, value.buildPackage(1), value.options);
    assert.equal(statSync(root).mode & 0o077, 0);
    assert.equal(statSync(`${path}.primary`).mode & 0o077, 0);
    assert.equal(statSync(`${path}.secondary`).mode & 0o077, 0);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("replacement of a pinned trust-store root is detected", () => {
  const value = fixture(); const target = location("trust-root");
  const moved = `${target.root}-moved`;
  try {
    createCheckpointTrustStore(target.path, value.buildPackage(1), value.options);
    renameSync(target.root, moved);
    mkdirSync(target.root, { mode: 0o700 });
    copyFileSync(`${moved}/checkpoint-trust.primary`, `${target.path}.primary`);
    copyFileSync(`${moved}/checkpoint-trust.secondary`, `${target.path}.secondary`);
    assert.throws(() => loadCheckpointTrustStore(target.path), /root changed|root was replaced/);
  } finally {
    rmSync(target.root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test("bounded CLI initializes, displays and advances the verified store", () => {
  const value = fixture(); const target = location("trust-cli");
  try {
    const firstPath = join(target.root, "first.json");
    const secondPath = join(target.root, "second.json");
    writeFileSync(firstPath, serializeCheckpointTrustPackage(value.buildPackage(11)));
    const init = spawnSync(process.execPath, ["blockchain/checkpoint-trust-store-cli.mjs", "init",
      target.path, firstPath, value.options.expectedNetworkId,
      value.options.expectedChainIdentityGenesisHash, value.options.expectedPolicyId],
    { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(JSON.parse(init.stdout).sequence, 11);
    const show = spawnSync(process.execPath,
      ["blockchain/checkpoint-trust-store-cli.mjs", "show", target.path],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).revision, 0);
    writeFileSync(secondPath,
      serializeCheckpointTrustPackage(value.buildPackage(12, value.append())));
    const accept = spawnSync(process.execPath,
      ["blockchain/checkpoint-trust-store-cli.mjs", "accept", target.path, secondPath],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).revision, 1);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});
