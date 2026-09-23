import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createReleaseAuthoritySet } from "../blockchain/offline-release-governance.mjs";
import {
  assembleProductionRuntimePolicy, createProductionRuntimePolicy, inspectProductionRuntime,
  signProductionRuntimePolicy, verifyProductionRuntimePolicy,
} from "../blockchain/production-runtime-policy.mjs";

const NOW = 2_000_000;
const binding = { genesisHash: "1".repeat(64), networkId: "nir-runtime-policy-test",
  releaseManifestHash: "2".repeat(64), releaseVersion: "1.2.3",
  sourceRevision: "3".repeat(40), toolPackageHash: "4".repeat(64),
  walletPackageHash: "5".repeat(64) };

function fixture(root) {
  const executable = process.execPath;
  const wallets = Array.from({ length: 4 }, generateWallet);
  const authoritySet = createReleaseAuthoritySet({ generation: 1, rotationDelayEntries: 2,
    threshold: 3, authorities: wallets.map((wallet, index) => ({ ...publicWallet(wallet),
      operatorId: `runtime-${index}` })) });
  const runtime = inspectProductionRuntime(executable);
  const policy = createProductionRuntimePolicy({ authoritySet, binding,
    commands: ["ui", "bridge", "extension"], createdAt: NOW - 100,
    expiresAt: NOW + 10_000, runtime, sequence: 1 });
  const approvals = wallets.slice(0, 3).map((wallet, index) =>
    signProductionRuntimePolicy(policy, authoritySet, { operatorId: `runtime-${index}`, wallet }));
  const envelope = assembleProductionRuntimePolicy(policy, authoritySet, approvals);
  return { approvals, authoritySet, envelope, executable, policy, runtime, wallets };
}

test("threshold runtime policy binds executable, platform, lineage, command, and time", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-runtime-policy-"));
  try {
    const values = fixture(root);
    const verified = verifyProductionRuntimePolicy(values.envelope, { command: "bridge",
      executablePath: values.executable, expectedBinding: binding,
      expectedPolicyHash: values.policy.policyHash, expectedSequence: 1, now: NOW });
    assert.equal(verified.policy.runtime.executableRealpath, values.runtime.executableRealpath);
    assert.throws(() => assembleProductionRuntimePolicy(values.policy, values.authoritySet,
      values.approvals.slice(0, 2)), /quorum/);
    assert.throws(() => assembleProductionRuntimePolicy(values.policy, values.authoritySet,
      [values.approvals[0], values.approvals[0], values.approvals[1]]), /duplicate/);
    assert.throws(() => verifyProductionRuntimePolicy(values.envelope, { command: "bridge",
      executablePath: values.executable, expectedBinding: binding,
      expectedPolicyHash: values.policy.policyHash, expectedSequence: 1, now: NOW + 10_001 }),
    /stale|rolled back/);
    assert.throws(() => verifyProductionRuntimePolicy(values.envelope, { command: "unknown",
      executablePath: values.executable, expectedBinding: binding,
      expectedPolicyHash: values.policy.policyHash, expectedSequence: 1, now: NOW }),
    /stale|rolled back/);
    const mixed = { ...binding, toolPackageHash: "f".repeat(64) };
    assert.throws(() => verifyProductionRuntimePolicy(values.envelope, { command: "ui",
      executablePath: values.executable, expectedBinding: mixed,
      expectedPolicyHash: values.policy.policyHash, expectedSequence: 1, now: NOW }),
    /mixed/);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("runtime substitution, path retarget, version, platform, and rollback fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-runtime-policy-adversarial-"));
  try {
    const values = fixture(root); const link = join(root, "runtime-link");
    symlinkSync(values.executable, link);
    assert.equal(verifyProductionRuntimePolicy(values.envelope, { command: "extension",
      executablePath: link, expectedBinding: binding, expectedPolicyHash: values.policy.policyHash,
      expectedSequence: 1, now: NOW }).policy.sequence, 1);
    unlinkSync(link); const other = join(root, "other-runtime");
    writeFileSync(other, "runtime-v2\n", { mode: 0o755 }); symlinkSync(other, link);
    assert.throws(() => verifyProductionRuntimePolicy(values.envelope, { command: "extension",
      executablePath: link, expectedBinding: binding, expectedPolicyHash: values.policy.policyHash,
      expectedSequence: 1, now: NOW }), /runtime/);
    for (const mutation of [{ executableSha3_256: "f".repeat(64) },
      { version: "v99.0.0" }, { platform: "otheros" }]) {
      const policy = createProductionRuntimePolicy({ authoritySet: values.authoritySet, binding,
        commands: ["ui"], createdAt: NOW - 100, expiresAt: NOW + 10_000,
        runtime: { ...values.runtime, ...mutation }, sequence: 1 });
      const approvals = values.wallets.slice(0, 3).map((wallet, index) =>
        signProductionRuntimePolicy(policy, values.authoritySet,
          { operatorId: `runtime-${index}`, wallet }));
      const envelope = assembleProductionRuntimePolicy(policy, values.authoritySet, approvals);
      assert.throws(() => verifyProductionRuntimePolicy(envelope, { command: "ui",
        executablePath: values.executable, expectedBinding: binding, expectedPolicyHash: policy.policyHash,
        expectedSequence: 1, now: NOW }), /runtime/);
    }
    assert.throws(() => verifyProductionRuntimePolicy(values.envelope, { command: "bridge",
      executablePath: values.executable, expectedBinding: binding,
      expectedPolicyHash: "f".repeat(64), expectedSequence: 2, now: NOW }), /rolled back/);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("offline verify CLI is canonical, no-follow, and writes only after verification", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-runtime-policy-cli-"));
  try {
    const wallets = Array.from({ length: 4 }, generateWallet);
    const authoritySet = createReleaseAuthoritySet({ generation: 1, rotationDelayEntries: 2,
      threshold: 3, authorities: wallets.map((wallet, index) => ({ ...publicWallet(wallet),
        operatorId: `cli-${index}` })) });
    const policy = createProductionRuntimePolicy({ authoritySet, binding,
      commands: ["ui"], createdAt: NOW - 100, expiresAt: NOW + 10_000,
      runtime: inspectProductionRuntime(), sequence: 1 });
    const approvals = wallets.slice(0, 3).map((wallet, index) =>
      signProductionRuntimePolicy(policy, authoritySet, { operatorId: `cli-${index}`, wallet }));
    const envelope = assembleProductionRuntimePolicy(policy, authoritySet, approvals);
    const envelopePath = join(root, "envelope.json"); const bindingPath = join(root, "binding.json");
    writeFileSync(envelopePath, `${canonicalJson(envelope)}\n`);
    writeFileSync(bindingPath, `${canonicalJson(binding)}\n`);
    const cli = new URL("../blockchain/production-runtime-policy-cli.mjs", import.meta.url).pathname;
    const output = join(root, "verified.json");
    const verified = spawnSync(process.execPath, [cli, "verify", envelopePath, bindingPath,
      policy.policyHash, "1", String(NOW), "ui", process.execPath, output], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr); assert.equal(existsSync(output), true);
    const link = join(root, "envelope-link.json"); symlinkSync(envelopePath, link);
    const rejectedOutput = join(root, "rejected.json");
    const rejected = spawnSync(process.execPath, [cli, "verify", link, bindingPath,
      policy.policyHash, "1", String(NOW), "ui", process.execPath, rejectedOutput],
    { encoding: "utf8" });
    assert.equal(rejected.status, 1); assert.equal(existsSync(rejectedOutput), false);
  } finally { rmSync(root, { force: true, recursive: true }); }
});
