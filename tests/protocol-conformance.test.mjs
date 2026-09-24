import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson, hashObject } from "../blockchain/crypto.mjs";
import {
  buildProtocolConformanceManifest, validateProtocolConformanceManifest,
  verifyProtocolConformanceManifest,
} from "../blockchain/protocol-conformance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function committed() {
  return JSON.parse(readFileSync(new URL("../protocol/conformance-manifest.json", import.meta.url), "utf8"));
}

function rehash(value) {
  const { manifestHash: ignored, ...payload } = value;
  return { ...payload, manifestHash:
    `sha3-256:${hashObject(payload, "PROTOCOL_CONFORMANCE_MANIFEST_V1")}` };
}

function copyInventoryRoot() {
  const root = mkdtempSync(join(tmpdir(), "nir-conformance-"));
  for (const directory of ["blockchain", "formal", "docs", "rust"]) {
    cpSync(new URL(`../${directory}`, import.meta.url), join(root, directory), { recursive: true });
  }
  mkdirSync(join(root, "tests"));
  cpSync(new URL("./vectors", import.meta.url), join(root, "tests", "vectors"), { recursive: true });
  mkdirSync(join(root, "protocol"));
  writeFileSync(join(root, "protocol", "conformance-manifest.json"),
    `${canonicalJson(committed())}\n`);
  return root;
}

test("committed canonical inventory exactly matches schemas, domains, limits, bindings, and gates", () => {
  const manifest = verifyProtocolConformanceManifest(committed(), ROOT);
  assert.ok(manifest.schemas.length >= 75);
  assert.ok(manifest.domainSeparators.length >= 140);
  assert.ok(manifest.securityParameters.length >= 140);
  assert.ok(manifest.networkBindings.length >= 190);
  assert.ok(manifest.featureGates.length >= 230);
  const schemas = new Set(manifest.schemas.map(({ id }) => id));
  const domains = new Set(manifest.domainSeparators.map(({ id }) => id));
  const parameters = new Set(manifest.securityParameters.map(({ id }) => id));
  for (const id of ["nir-finality-proof-v3", "nir-protocol-upgrade-v1",
    "nir-release-transparency-entry-v1", "nir-release-witness-receipt-v1",
    "nir-state-snapshot-v1"]) assert.ok(schemas.has(id), id);
  for (const id of ["BLOCK_PREPARE", "BLOCK_COMMIT", "CHAIN_STATE_V1", "NATIVE_ASSET_CREATE",
    "RELEASE_GOVERNANCE_APPROVAL_V1", "RELEASE_WITNESS_RECEIPT_V1",
    "VALIDATOR_HANDOFF_NEW"]) assert.ok(domains.has(id), id);
  for (const id of ["PROTOCOL_VERSION", "SUPPORTED_PROTOCOL_VERSIONS", "MAX_BLOCK_BYTES",
    "MAX_FUTURE_DRIFT_MS", "MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS"]) assert.ok(parameters.has(id), id);
});

test("manifest hash, missing inventory, duplicate IDs, and reordered IDs fail closed", () => {
  const original = committed();
  assert.throws(() => validateProtocolConformanceManifest({ ...original, unexpected: true }), /unknown/);
  assert.throws(() => validateProtocolConformanceManifest({ ...original,
    manifestHash: `sha3-256:${"0".repeat(64)}` }), /hash/);

  const missing = structuredClone(original); missing.schemas.splice(1, 1);
  assert.throws(() => verifyProtocolConformanceManifest(rehash(missing), ROOT), /drift/);

  const duplicate = structuredClone(original); duplicate.schemas.splice(1, 0,
    structuredClone(duplicate.schemas[0]));
  assert.throws(() => validateProtocolConformanceManifest(rehash(duplicate)), /duplicate|unordered/);

  const reordered = structuredClone(original);
  [reordered.domainSeparators[0], reordered.domainSeparators[1]] =
    [reordered.domainSeparators[1], reordered.domainSeparators[0]];
  assert.throws(() => validateProtocolConformanceManifest(rehash(reordered)), /unordered/);

  const sourceLess = structuredClone(original); sourceLess.schemas[0].sources = [];
  assert.throws(() => validateProtocolConformanceManifest(rehash(sourceLess)), /no source/);

  const duplicateFile = structuredClone(original);
  duplicateFile.sourceFiles.splice(1, 0, structuredClone(duplicateFile.sourceFiles[0]));
  assert.throws(() => validateProtocolConformanceManifest(rehash(duplicateFile)), /duplicate|unordered/);

  const forgedDrift = structuredClone(original);
  forgedDrift.sourceFiles[0].sha3_256 = `sha3-256:${"1".repeat(64)}`;
  assert.throws(() => verifyProtocolConformanceManifest(rehash(forgedDrift), ROOT), /drift/);
});

test("manifest ordering is locale-independent code-point order", () => {
  const generated = buildProtocolConformanceManifest(ROOT);
  const ids = generated.domainSeparators.map(({ id }) => id);
  const developer = ids.indexOf("DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1");
  const devPlaceholder = ids.indexOf("DEV_TESTNET_CAPABILITY_PLACEHOLDER_V1");
  assert.ok(developer >= 0 && devPlaceholder >= 0);
  assert.ok(developer < devPlaceholder,
    "DEVELOPER... must precede DEV_TESTNET... in locale-independent code-point order");
  assert.doesNotThrow(() => validateProtocolConformanceManifest(generated));
});

test("source and security-document drift are independently detected", () => {
  const sourceRoot = copyInventoryRoot();
  const docsRoot = copyInventoryRoot();
  try {
    writeFileSync(join(sourceRoot, "blockchain", "constants.mjs"),
      `${readFileSync(join(sourceRoot, "blockchain", "constants.mjs"), "utf8")}\n// drift\n`);
    assert.throws(() => verifyProtocolConformanceManifest(committed(), sourceRoot), /drift/);

    writeFileSync(join(docsRoot, "docs", "offline-release-governance.md"),
      `${readFileSync(join(docsRoot, "docs", "offline-release-governance.md"), "utf8")}\nStale edit.\n`);
    assert.throws(() => verifyProtocolConformanceManifest(committed(), docsRoot), /drift/);
  } finally {
    rmSync(sourceRoot, { force: true, recursive: true });
    rmSync(docsRoot, { force: true, recursive: true });
  }
});

test("inventory generation rejects prohibited external-currency references", () => {
  const root = copyInventoryRoot();
  try {
    const encoded = Buffer.from("WW1sMFkyOXBiZz09", "base64").toString("utf8");
    const prohibited = Buffer.from(encoded, "base64").toString("utf8");
    writeFileSync(join(root, "docs", "forbidden.md"), `# Network\n\n${prohibited}\n`);
    assert.throws(() => buildProtocolConformanceManifest(root), /prohibited/);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("offline CLI verification succeeds without network access", () => {
  const output = execFileSync(process.execPath,
    ["blockchain/protocol-conformance-cli.mjs", "verify", ".",
      "protocol/conformance-manifest.json"], { cwd: ROOT, encoding: "utf8" });
  assert.match(output, /verified/);
});
