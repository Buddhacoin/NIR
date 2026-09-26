import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createValidatorJoinBackups, createValidatorJoinWorkspace, loadValidatorJoinInputs,
  loadValidatorCandidateSyncInput, prepareValidatorAdmissionSigningPackage,
  syncValidatorJoinCandidateContext, validatorJoinStatus,
  verifyValidatorJoinWorkspace,
  writeValidatorJoinArtifact,
} from "../blockchain/validator-join.mjs";

test("offline validator join import graph excludes HTTP transports", () => {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../blockchain/validator-join.mjs");
  const visited = new Set();
  const specifiers = new Set();
  const walk = (filename) => {
    if (visited.has(filename)) return;
    visited.add(filename);
    const source = readFileSync(filename, "utf8");
    const imports = /(?:^|\n)\s*import\s+(?!\()(?:(?:[\s\S]*?)\s+from\s+)?["']([^"']+)["']\s*;/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1];
      specifiers.add(specifier);
      if (specifier.startsWith(".")) walk(resolve(dirname(filename), specifier));
    }
  };
  walk(entry);
  assert.equal([...visited].some((filename) => filename.endsWith("/http-client.mjs")), false);
  assert.equal(specifiers.has("node:http"), false);
  assert.equal(specifiers.has("node:https"), false);
});

test("online admission proof fetch import graph excludes vault and signer authority", () => {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)),
    "../blockchain/validator-admission-proof-fetch.mjs");
  const visited = new Set();
  const walk = (filename) => {
    if (visited.has(filename)) return;
    visited.add(filename);
    const source = readFileSync(filename, "utf8");
    const imports = /(?:^|\n)\s*import\s+(?!\()(?:(?:[\s\S]*?)\s+from\s+)?["']([^"']+)["']\s*;/g;
    for (const match of source.matchAll(imports)) {
      if (match[1].startsWith(".")) walk(resolve(dirname(filename), match[1]));
    }
  };
  walk(entry);
  assert.equal([...visited].some((filename) => /(?:validator-join|wallet-files|vault)\.mjs$/.test(filename)),
    false);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-validator-join-")); chmodSync(root, 0o700);
  const cert = join(root, "tls-cert.pem"); const key = join(root, "tls-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  chmodSync(cert, 0o600); chmodSync(key, 0o600);
  const fingerprint = new X509Certificate(readFileSync(cert)).fingerprint256.replaceAll(":", "").toLowerCase();
  const config = { candidateContextMaxWitnessAgeMs: 300_000,
    candidateContextMinimumCheckpointHeight: 1, candidateContextMinimumSequence: 0,
    endpoint: "https://localhost", expectedChainIdentityGenesisHash: "a".repeat(64),
    expectedCheckpointPolicyId: `sha3-256:${"b".repeat(64)}`,
    expectedTlsCertificateSha256: fingerprint, format: "nir-validator-join-config-v2",
    networkId: "nir-testnet", operatorId: "operator-one", tlsCertificate: cert,
    tlsPrivateKey: key, version: 2 };
  const configPath = join(root, "config.json"); writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { cert, config, configPath, key, root, workspace: join(root, "workspace") };
}

test("validator join creates two encrypted identities and remains restart-verifiable", () => {
  const f = fixture();
  try {
    const inputs = loadValidatorJoinInputs(f.configPath);
    const plan = createValidatorJoinWorkspace({ directory: f.workspace, ...inputs,
      consensusPassword: "correct horse consensus", transportPassword: "correct horse transport" });
    assert.notEqual(plan.consensus.address, plan.transport.address);
    assert.equal(plan.broadcast, false);
    assert.equal(plan.status, "awaiting-external-v31-candidate-service");
    assert.equal(lstatSync(realpathSync(f.workspace)).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(f.workspace, "join-plan.json")).mode & 0o777, 0o600);
    assert.deepEqual(verifyValidatorJoinWorkspace({ directory: f.workspace,
      consensusPassword: "correct horse consensus", transportPassword: "correct horse transport" }), {
      broadcast: false, consensusAddress: plan.consensus.address, networkId: "nir-testnet",
      status: "awaiting external v31 candidate service / quorum observation",
      transportAddress: plan.transport.address, verified: true,
    });
    assert.match(validatorJoinStatus(f.workspace).status, /awaiting external/);
    assert.throws(() => verifyValidatorJoinWorkspace({ directory: f.workspace,
      consensusPassword: "wrong", transportPassword: "correct horse transport" }), /decrypt|password|vault/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("validator join validates TLS identity and fails atomically", () => {
  const f = fixture(); const otherKey = join(f.root, "other-key.pem"); const otherCert = join(f.root, "other-cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", otherKey,
      "-out", otherCert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    assert.throws(() => createValidatorJoinWorkspace({ directory: f.workspace, config: f.config,
      tlsCertificatePem: readFileSync(f.cert), tlsPrivateKeyPem: readFileSync(otherKey),
      consensusPassword: "one strong password", transportPassword: "another strong password" }), /do not match/);
    assert.throws(() => createValidatorJoinWorkspace({ directory: f.workspace,
      config: { ...f.config, expectedTlsCertificateSha256: "0".repeat(64) },
      tlsCertificatePem: readFileSync(f.cert), tlsPrivateKeyPem: readFileSync(f.key),
      consensusPassword: "one strong password", transportPassword: "another strong password" }), /fingerprint/);
    assert.throws(() => createValidatorJoinWorkspace({ directory: f.workspace, config: f.config,
      tlsCertificatePem: readFileSync(f.cert), tlsPrivateKeyPem: readFileSync(f.key),
      consensusPassword: "same password", transportPassword: "same password" }), /distinct/);
    assert.throws(() => lstatSync(f.workspace), /ENOENT/);
    mkdirSync(f.workspace, { mode: 0o700 });
    assert.throws(() => createValidatorJoinWorkspace({ directory: f.workspace, config: f.config,
      tlsCertificatePem: readFileSync(f.cert), tlsPrivateKeyPem: readFileSync(f.key),
      consensusPassword: "one strong password", transportPassword: "another strong password" }), /EEXIST/);
    assert.equal(lstatSync(f.workspace).isDirectory(), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("validator join backups are encrypted and public artifacts are atomic", () => {
  const f = fixture();
  try {
    createValidatorJoinWorkspace({ directory: f.workspace, ...loadValidatorJoinInputs(f.configPath),
      consensusPassword: "consensus password", transportPassword: "transport password" });
    const backup = createValidatorJoinBackups({ directory: f.workspace,
      backupDirectory: join(f.root, "backups"), consensusPassword: "consensus password",
      transportPassword: "transport password", generation: 1 });
    assert.equal(backup.consensus.verified, true); assert.equal(backup.transport.verified, true);
    const artifact = join(f.root, "public.json"); writeValidatorJoinArtifact(artifact, { ok: true });
    assert.equal(readFileSync(artifact, "utf8"), '{"ok":true}\n');
    assert.throws(() => writeValidatorJoinArtifact(artifact, { replaced: true }), /EEXIST/);
    const target = join(f.root, "symlink.json"); symlinkSync(artifact, target);
    assert.throws(() => writeValidatorJoinArtifact(target, { bad: true }), /EEXIST/);
    const actual = join(f.root, "actual"); mkdirSync(actual, { mode: 0o700 });
    const alias = join(f.root, "alias"); symlinkSync(actual, alias, "dir");
    writeValidatorJoinArtifact(join(alias, "bound.json"), { bound: true });
    assert.equal(readFileSync(join(actual, "bound.json"), "utf8"), '{"bound":true}\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("validator join CLI refuses secrets from a non-interactive stdin", () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, ["blockchain/validator-join-cli.mjs", "init",
      f.workspace, f.configPath], { cwd: process.cwd(), encoding: "utf8", input: "password\n" });
    assert.equal(result.status, 1); assert.match(result.stderr, /interactive terminal/);
    assert.throws(() => lstatSync(f.workspace), /ENOENT/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Slice-A v1 workspaces remain readable but cannot silently acquire B1 anchors", async () => {
  const f = fixture();
  try {
    const config = { ...f.config, format: "nir-validator-join-config-v1", version: 1 };
    delete config.candidateContextMaxWitnessAgeMs;
    delete config.candidateContextMinimumCheckpointHeight;
    delete config.candidateContextMinimumSequence;
    const plan = createValidatorJoinWorkspace({ directory: f.workspace, config,
      tlsCertificatePem: readFileSync(f.cert), tlsPrivateKeyPem: readFileSync(f.key),
      consensusPassword: "legacy consensus password", transportPassword: "legacy transport password" });
    assert.equal(plan.format, "nir-validator-join-plan-v1");
    assert.match(validatorJoinStatus(f.workspace).status, /awaiting external/);
    assert.equal(verifyValidatorJoinWorkspace({ directory: f.workspace,
      consensusPassword: "legacy consensus password",
      transportPassword: "legacy transport password" }).verified, true);
    assert.equal(createValidatorJoinBackups({ directory: f.workspace,
      backupDirectory: join(f.root, "legacy-backup"),
      consensusPassword: "legacy consensus password", transportPassword: "legacy transport password",
      generation: 1 }).consensus.verified, true);
    await assert.rejects(() => syncValidatorJoinCandidateContext({ directory: f.workspace,
      syncInput: { checkpointTrustPackage: {}, format: "nir-validator-candidate-sync-v1",
        peers: [], version: 1 }, request: async () => assert.fail("network must not be queried") }),
    /join plan|v2|invalid/i);
    assert.throws(() => prepareValidatorAdmissionSigningPackage({ directory: f.workspace,
      outputPath: join(f.root, "legacy-admission.json") }), /v2 join workspace/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("candidate sync input uses its dedicated bounded reader", () => {
  const f = fixture();
  try {
    const within = join(f.root, "large-public-sync.json");
    writeFileSync(within, JSON.stringify({ checkpointTrustPackage: {},
      format: "nir-validator-candidate-sync-v1", padding: "x".repeat(4 * 1024 * 1024),
      peers: [], version: 1 }), { mode: 0o600 });
    assert.throws(() => loadValidatorCandidateSyncInput(within), /unknown or missing fields/);
    const beyond = join(f.root, "oversized-public-sync.json");
    writeFileSync(beyond, JSON.stringify({ padding: "x".repeat(6 * 1024 * 1024) }),
      { mode: 0o600 });
    assert.throws(() => loadValidatorCandidateSyncInput(beyond), /unsafe/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
