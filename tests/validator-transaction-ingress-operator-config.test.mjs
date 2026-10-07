import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../blockchain/crypto.mjs";
import { readTransactionIngressOperatorConfig,
  validateTransactionIngressOperatorConfig }
  from "../blockchain/validator-transaction-ingress-operator-config.mjs";

function value(root) {
  return { certificateDirectory: root,
    certificateHeadAnchorPath: join(root, "certificate-anchor.json"),
    ceremonyAnchorPath: join(root, "ceremony-anchor.json"),
    checkpointPackagePath: join(root, "checkpoint.json"),
    expectedGenesisHash: "a".repeat(64), expectedNetworkId: "nir-valueless-testnet",
    expectedPolicyId: `sha3-256:${"b".repeat(64)}`,
    expectedTlsCertificateSha256: "c".repeat(64),
    expectedUpstreamOrigin: "https://127.0.0.1:8791",
    floorDirectory: join(root, "floor"),
    format: "nir-transaction-ingress-operator-config-v1",
    listenHost: "127.0.0.1", listenPort: 8789, maxWitnessAgeMs: 30_000,
    registryDirectory: join(root, "registry"),
    trustedReleaseSignerAddress: `nir1${"d".repeat(64)}`,
    validatorAddress: `nir1${"e".repeat(64)}`, version: 1, walletOrigin: null };
}

test("operator config is exact, canonical, owned and mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-operator-config-"));
  try {
    const config = value(root); const path = join(root, "operator.json");
    writeFileSync(path, `${canonicalJson(config)}\n`, { mode: 0o600 });
    assert.deepEqual(readTransactionIngressOperatorConfig(path), config);
    assert.throws(() => validateTransactionIngressOperatorConfig({ ...config,
      noCheckpointGate: true }), /schema/);
    assert.throws(() => validateTransactionIngressOperatorConfig({ ...config,
      expectedPolicyId: "b".repeat(64) }), /pins/);
    assert.throws(() => validateTransactionIngressOperatorConfig({ ...config,
      maxWitnessAgeMs: 120_001 }), /pins/);
    assert.throws(() => validateTransactionIngressOperatorConfig({ ...config,
      listenHost: "0.0.0.0" }), /pins/);
    const link = join(root, "alias.json"); symlinkSync(path, link);
    assert.throws(() => readTransactionIngressOperatorConfig(link), /unsafe/);
    chmodSync(path, 0o644);
    assert.throws(() => readTransactionIngressOperatorConfig(path), /unsafe/);
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    assert.throws(() => readTransactionIngressOperatorConfig(path), /canonical/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("offline prepare canonicalizes a reviewed public draft without overwriting", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-operator-config-prepare-"));
  try {
    const draft = join(root, "draft.json"); const output = join(root, "operator.json");
    const cli = fileURLToPath(new URL(
      "../blockchain/validator-transaction-ingress-config-cli.mjs", import.meta.url));
    const sample = JSON.parse(readFileSync(new URL(
      "../docs/examples/transaction-ingress-operator-config.example.json", import.meta.url)));
    writeFileSync(draft, JSON.stringify(sample, null, 2));
    const placeholder = spawnSync(process.execPath, [cli, "prepare", draft, output],
      { encoding: "utf8" });
    assert.equal(placeholder.status, 1);
    assert.match(placeholder.stderr, /schema or pins/);
    assert.throws(() => statSync(output), /ENOENT/);
    writeFileSync(draft, JSON.stringify(value(root), null, 2));
    const prepared = spawnSync(process.execPath, [cli, "prepare", draft, output],
      { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(output, "utf8"), `${canonicalJson(value(root))}\n`);
    const checked = spawnSync(process.execPath, [cli, "check", output],
      { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    chmodSync(root, 0o755);
    assert.throws(() => readTransactionIngressOperatorConfig(output), /parent is unsafe/);
    const sharedParent = spawnSync(process.execPath,
      [cli, "prepare", draft, join(root, "shared.json")], { encoding: "utf8" });
    assert.equal(sharedParent.status, 1);
    assert.match(sharedParent.stderr, /parent is unsafe/);
    chmodSync(root, 0o700);
    const extraCheckArgument = spawnSync(process.execPath,
      [cli, "check", output, "ignored"], { encoding: "utf8" });
    assert.equal(extraCheckArgument.status, 1);
    const repeated = spawnSync(process.execPath, [cli, "prepare", draft, output],
      { encoding: "utf8" });
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), `${canonicalJson(value(root))}\n`);
    const extra = { ...value(root), privateKey: "must-not-be-saved" };
    writeFileSync(draft, JSON.stringify(extra));
    const rejected = spawnSync(process.execPath, [cli, "prepare", draft,
      join(root, "unsafe.json")], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.throws(() => statSync(join(root, "unsafe.json")), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
