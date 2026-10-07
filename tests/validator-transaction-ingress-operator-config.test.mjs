import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
