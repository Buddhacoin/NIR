import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync,
  unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { canonicalJson, generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import { evaluateDeveloperTestnetProductionPreflight } from "../blockchain/developer-testnet-production-preflight.mjs";
import {
  acceptRehearsalAttestationQuorum, createRehearsalAttestorSet,
  exportRehearsalAttestationStoreTranscript, signRehearsalStatement,
} from "../blockchain/rehearsal-attestation.mjs";
import {
  createProductionReleasePackage, readBoundedPublicJson, verifyProductionReleasePackage,
  installProductionReleasePackage, serializeProductionReleasePackage,
  verifyProductionInstallation, writeProductionPackageExclusive,
} from "../blockchain/production-release-gate.mjs";
import { artifactPaths, createReleaseArtifact, installNodeArtifact,
  verifyNodeInstallation } from "../blockchain/release-artifact.mjs";
import { createReleaseManifest, readReleaseSourceFile,
  signReleaseManifest } from "../blockchain/release-manifest.mjs";
import { createTestnetPartitionDrillPlan } from "../blockchain/testnet-partition-drill.mjs";
import { createWalletFile } from "../blockchain/wallet-files.mjs";
import { createProductionStartupGuard,
  createWalletBridgeProductionGuard } from "../blockchain/production-startup.mjs";
import { validateProductionWalletExtensionArtifact } from "../blockchain/production-wallet-extension.mjs";
import {
  assembleProductionRuntimePolicy, createProductionRuntimePolicy, inspectProductionRuntime,
  signProductionRuntimePolicy,
} from "../blockchain/production-runtime-policy.mjs";
import { signOfflineReleaseBundle } from "../blockchain/offline-release-bundle.mjs";
import { createReleaseAuthoritySet } from "../blockchain/offline-release-governance.mjs";
import {
  assembleProductionWalletExport, createProductionWalletExportBundle,
  importProductionWalletExport, serializeProductionWalletExport, verifyProductionWalletExport,
} from "../blockchain/production-wallet-export.mjs";
import {
  appendWalletReleaseTransparency, assembleWalletReleaseCheckpoint,
  compareWalletReleaseGossipCheckpoints,
  createWalletReleaseCheckpoint, createWalletReleaseConsistencyProof,
  createWalletReleaseInclusionProof, exportWalletReleaseGossipCheckpoint,
  loadWalletReleaseTransparencyStore, signWalletReleaseCheckpoint,
  scheduleWalletReleaseAuthorityTransition,
  verifyWalletReleaseConsistencyProof, verifyWalletReleaseTransparencyEvidence,
} from "../blockchain/production-wallet-transparency.mjs";
import {
  assembleWalletReleaseAuthorityTransition, createWalletReleaseAuthorityTransition,
  signWalletReleaseAuthorityTransition,
} from "../blockchain/production-wallet-authority-rotation.mjs";
import {
  advanceProductionHead, exportProductionHeadAnchor, loadProductionHeadStore,
  repairProductionHeadCopies, verifyProductionStartupFromHead,
} from "../blockchain/production-head-store.mjs";

const NOW = 1_000_000;
const NETWORK = "nir-production-release-gate-testnet";
const CHECKPOINT = `sha3-256:${"7".repeat(64)}`;
const GENESIS = "8".repeat(64);
const TIP = "a".repeat(64);

function identity(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

function developerReport() {
  const checks = [
    { details: { ageMs: 0, sources: 2 }, id: "backup-restore-freshness", status: "PASS" },
    { details: { eligible: 4, minimumBondAtomic: "1000000000" }, id: "bonded-validator-eligibility", status: "PASS" },
    { details: { selectionHash: "1".repeat(64), witnesses: 3 }, id: "external-witness-quorum", status: "PASS" },
    { details: { genesisHash: GENESIS, planCommitment: "2".repeat(64) }, id: "genesis", status: "PASS" },
    { details: { ingressProfiles: 4, ports: 14 }, id: "host-readiness", status: "PASS" },
    { details: { scannedFiles: 1 }, id: "public-artifact-scan", status: "PASS" },
    { details: { bundleHash: `sha3-256:${"3".repeat(64)}`, checkpointHash: CHECKPOINT, sequence: 1 }, id: "release", status: "PASS" },
    { details: { identities: 14, operators: 14, tlsPins: 4 }, id: "role-and-key-separation", status: "PASS" },
  ];
  const payload = { checks, format: "nir-developer-testnet-preflight-report-v1", networkId: NETWORK,
    observedAt: NOW, summary: { failed: 0, passed: 8, status: "PASS" }, version: 1 };
  return { ...payload, reportHash: hashObject(payload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1") };
}

function productionEvidence(root, manifest, storeName = "attestation-store") {
  const report = developerReport();
  const validators = Array.from({ length: 4 }, generateWallet);
  const topology = { archives: Array.from({ length: 2 }, (_, index) => identity(generateWallet(), `archive-${index}`)),
    beacons: Array.from({ length: 4 }, (_, index) => identity(generateWallet(), `beacon-${index}`)),
    certificateRotation: { newPin: "4".repeat(64), oldPin: "5".repeat(64),
      overlapEndHeight: 20, overlapStartHeight: 10, validator: validators[0].address },
    format: "nir-testnet-drill-topology-v1", networkId: NETWORK, releaseCheckpointHash: CHECKPOINT,
    validators: validators.map((wallet, index) => identity(wallet, `validator-${index}`)), version: 1 };
  const plan = createTestnetPartitionDrillPlan(report, topology);
  const attestors = Array.from({ length: 4 }, generateWallet);
  const operatorSet = createRehearsalAttestorSet({ threshold: 3,
    operators: attestors.map((wallet, index) => identity(wallet, `reviewer-${index}`)) });
  const statement = { drillPlanHash: plan.planHash, expiresAt: NOW + 10_000,
    format: "nir-rehearsal-attestation-v1", genesisHash: GENESIS, networkId: NETWORK,
    observedAt: NOW - 100, releaseCheckpointHash: CHECKPOINT,
    releaseManifestHash: manifest.manifestHash, reportHash: `sha3-256:${"6".repeat(64)}`,
    runNonce: "b".repeat(64), setId: operatorSet.setId, validatorTip: TIP, version: 1 };
  const attestations = attestors.slice(0, 3).map((wallet, index) =>
    signRehearsalStatement(statement, { operatorId: `reviewer-${index}`, wallet }, operatorSet));
  const store = join(root, storeName);
  const accepted = acceptRehearsalAttestationQuorum(store, attestations, { now: NOW, operatorSet });
  const context = { finalizedTip: TIP, genesisHash: GENESIS, releaseManifestHash: manifest.manifestHash };
  const productionReport = evaluateDeveloperTestnetProductionPreflight({
    attestationInput: accepted.preflightInput,
    attestationStoreTranscript: exportRehearsalAttestationStoreTranscript(store),
    developerReport: report, drillPlan: plan, expectedContext: context, now: NOW, operatorSet,
  });
  const failedReport = evaluateDeveloperTestnetProductionPreflight({
    attestationInput: undefined,
    attestationStoreTranscript: exportRehearsalAttestationStoreTranscript(store),
    developerReport: report, drillPlan: plan, expectedContext: context, now: NOW, operatorSet,
  });
  const productionTarget = { ...context, format: "nir-production-release-target-v1",
    maxFutureSkewMs: 1_000, maxPreflightAgeMs: 5_000, networkId: NETWORK,
    releaseVersion: manifest.releaseVersion, sourceRevision: manifest.sourceRevision, version: 1 };
  return { failedReport, productionReport, productionTarget };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-production-release-"));
  writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}\n');
  const blockchain = join(root, "blockchain");
  execFileSync("mkdir", ["-p", blockchain]);
  writeFileSync(join(blockchain, "node.mjs"), "export const node = true;\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "gate@nir.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "NIR gate test"]);
  execFileSync("git", ["-C", root, "add", "package.json", "blockchain/node.mjs"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const paths = ["blockchain/node.mjs", "package.json"];
  const manifest = createReleaseManifest(root, paths, { releaseVersion: "1.2.3", sourceRevision: revision });
  const signer = generateWallet(); const signedRelease = signReleaseManifest(manifest, signer);
  const evidence = productionEvidence(root, manifest);
  const artifact = createReleaseArtifact(root, artifactPaths("node", paths), { kind: "node", sourceManifest: manifest });
  return { artifact, manifest, root, signedRelease, signer, ...evidence };
}

function releaseVariant(values, version, suffix) {
  const paths = ["blockchain/node.mjs", "package.json"];
  const manifest = createReleaseManifest(values.root, paths, {
    releaseVersion: version, sourceRevision: values.manifest.sourceRevision,
  });
  const signedRelease = signReleaseManifest(manifest, values.signer);
  const evidence = productionEvidence(values.root, manifest, `attestation-store-${suffix}`);
  const artifact = createReleaseArtifact(values.root, artifactPaths("node", paths), {
    kind: "node", sourceManifest: manifest,
  });
  const packageValue = createProductionReleasePackage(artifact, { now: NOW,
    productionReport: evidence.productionReport, productionTarget: evidence.productionTarget,
    signedRelease, trustedAddress: values.signer.address });
  return { artifact, manifest, packageValue, signedRelease, ...evidence };
}

async function unusedPort(host = "127.0.0.1") {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject); server.listen(0, host, resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

function rawHttpStatus(port, path, { headers = {}, host = "127.0.0.1", method = "GET" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ headers, host, method, path, port }, (response) => {
      response.resume(); response.once("end", () => resolvePromise(response.statusCode));
    });
    request.once("error", reject); request.end();
  });
}

function mutateArtifactText(artifact, path, mutation) {
  const changed = structuredClone(artifact);
  const entry = changed.entries.find((candidate) => candidate.path === `wallet-ui/${path}`);
  const body = mutation(Buffer.from(entry.content, "base64").toString("utf8"));
  entry.content = Buffer.from(body).toString("base64"); entry.size = Buffer.byteLength(body);
  entry.sha3_256 = createHash("sha3-256").update("NIR/ARTIFACT_FILE/v1\0")
    .update(Buffer.from(body)).digest("hex");
  return changed;
}

async function waitForOutput(child, pattern) {
  let output = ""; let errors = "";
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${output} ${errors}`)), 8_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (pattern.test(output)) { clearTimeout(timer); resolvePromise(output); }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("exit", (code) => {
      clearTimeout(timer); reject(new Error(`startup exited ${code}: ${errors}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  child.kill("SIGTERM"); await exited;
}

test("production package is bound to exact signed release, network, genesis and finalized tip", () => {
  const values = fixture();
  try {
    const packageValue = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    assert.equal(verifyProductionReleasePackage(packageValue, { now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address }).packageHash,
    packageValue.packageHash);
    for (const mutation of [
      { networkId: "another-network" }, { genesisHash: "c".repeat(64) },
      { finalizedTip: "d".repeat(64) }, { releaseManifestHash: "e".repeat(64) },
    ]) assert.throws(() => createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport,
      productionTarget: { ...values.productionTarget, ...mutation },
      signedRelease: values.signedRelease, trustedAddress: values.signer.address }), /match|context/);
    assert.throws(() => createProductionReleasePackage(values.artifact, { now: NOW + 5_001,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address }), /stale/);
    assert.throws(() => createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.failedReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address }), /did not pass/);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production JSON read detects path swap and exclusive output preserves an existing target", () => {
  const values = fixture();
  const input = join(values.root, "input.json"); const moved = join(values.root, "moved.json");
  const output = join(values.root, "output.nirprod");
  try {
    writeFileSync(input, `${canonicalJson(values.productionTarget)}\n`);
    assert.throws(() => readBoundedPublicJson(input, { requireCanonical: true, _afterOpen(path) {
      renameSync(path, moved); writeFileSync(path, `${canonicalJson({ replacement: true })}\n`);
    } }), /changed during read/);
    const packageValue = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    writeFileSync(output, "preserve-me\n");
    assert.throws(() => writeProductionPackageExclusive(output, packageValue, { now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address }), /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), "preserve-me\n");
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production output races fail without deleting foreign parent or substituted temporary paths", () => {
  const values = fixture();
  try {
    const packageValue = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const parent = join(values.root, "output-parent"); const savedParent = `${parent}-saved`;
    const target = join(parent, "node.nirprod"); mkdirSync(parent);
    assert.throws(() => writeProductionPackageExclusive(target, packageValue, { now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address,
      _beforeLink() {
        renameSync(parent, savedParent); mkdirSync(parent); writeFileSync(target, "foreign-existing\n");
      },
    }));
    assert.equal(readFileSync(target, "utf8"), "foreign-existing\n");

    const afterParent = join(values.root, "after-parent"); const afterSaved = `${afterParent}-saved`;
    const afterTarget = join(afterParent, "node.nirprod"); mkdirSync(afterParent);
    assert.throws(() => writeProductionPackageExclusive(afterTarget, packageValue, { now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address,
      _afterLink() {
        renameSync(afterParent, afterSaved); mkdirSync(afterParent);
        writeFileSync(afterTarget, "foreign-after-link\n");
      },
    }), /changed|ENOENT/);
    assert.equal(readFileSync(afterTarget, "utf8"), "foreign-after-link\n");

    const tempParent = join(values.root, "temp-parent"); mkdirSync(tempParent);
    const tempTarget = join(tempParent, "node.nirprod");
    const foreign = join(tempParent, "foreign"); writeFileSync(foreign, "foreign\n");
    let substituted;
    assert.throws(() => writeProductionPackageExclusive(tempTarget, packageValue, { now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address,
      _beforeLink({ temporary }) {
        substituted = `${temporary}.owned`; renameSync(temporary, substituted);
        symlinkSync("foreign", temporary);
      },
    }), /changed/);
    assert.equal(lstatSync(substituted).isFile(), true);
    assert.equal(lstatSync(substituted.replace(/\.owned$/, "")).isSymbolicLink(), true);
    assert.equal(readFileSync(foreign, "utf8"), "foreign\n");

    const hardParent = join(values.root, "hard-parent"); mkdirSync(hardParent);
    const hardTarget = join(hardParent, "node.nirprod");
    const hardForeign = join(hardParent, "foreign"); writeFileSync(hardForeign, "hard-foreign\n");
    let owned;
    assert.throws(() => writeProductionPackageExclusive(hardTarget, packageValue, { now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address,
      _beforeLink({ temporary }) {
        owned = `${temporary}.owned`; renameSync(temporary, owned);
        linkSync(hardForeign, temporary);
      },
    }), /changed/);
    assert.equal(readFileSync(hardForeign, "utf8"), "hard-foreign\n");
    assert.equal(readFileSync(owned).length > 100, true);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("release CLI blocks missing/stale production evidence before artifact or install writes", () => {
  const values = fixture(); const cli = new URL("../blockchain/release-cli.mjs", import.meta.url).pathname;
  try {
    const envelope = join(values.root, "signed.json"); const target = join(values.root, "target.json");
    const report = join(values.root, "report.json"); const output = join(values.root, "node.nirprod");
    writeFileSync(envelope, `${JSON.stringify(values.signedRelease, null, 2)}\n`);
    writeFileSync(target, `${canonicalJson(values.productionTarget)}\n`);
    writeFileSync(report, `${canonicalJson(values.productionReport)}\n`);
    const built = spawnSync(process.execPath, [cli, "build-production", "node", values.root,
      envelope, values.signer.address, target, report, String(NOW), output], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const packageValue = readBoundedPublicJson(output, { requireCanonical: true });
    assert.equal(packageValue.format, "nir-production-release-package-v1");
    const verified = spawnSync(process.execPath, [cli, "verify-production-artifact", output,
      envelope, values.signer.address, String(NOW)], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    const missingOutput = join(values.root, "missing.nirprod");
    const missing = spawnSync(process.execPath, [cli, "build-production", "node", values.root,
      envelope, values.signer.address, target, join(values.root, "absent.json"), String(NOW),
      missingOutput], { encoding: "utf8" });
    assert.equal(missing.status, 1); assert.equal(existsSync(missingOutput), false);
    const staleOutput = join(values.root, "stale.nirprod");
    const stale = spawnSync(process.execPath, [cli, "build-production", "node", values.root,
      envelope, values.signer.address, target, report, String(NOW + 5_001), staleOutput],
    { encoding: "utf8" });
    assert.equal(stale.status, 1); assert.equal(existsSync(staleOutput), false);
    const install = join(values.root, "installed-node");
    const staleInstall = spawnSync(process.execPath, [cli, "install-production-node", output,
      envelope, values.signer.address, String(NOW + 5_001), install], { encoding: "utf8" });
    assert.equal(staleInstall.status, 1); assert.equal(existsSync(install), false);
    const validInstall = spawnSync(process.execPath, [cli, "install-production-node", output,
      envelope, values.signer.address, String(NOW), install], { encoding: "utf8" });
    assert.equal(validInstall.status, 0, validInstall.stderr); assert.equal(existsSync(install), true);
    const startup = spawnSync(process.execPath, [cli, "verify-production-node-install", install,
      envelope, values.signer.address, packageValue.packageHash], { encoding: "utf8" });
    assert.equal(startup.status, 0, startup.stderr);
    assert.match(startup.stdout, /production startup gate/);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("deterministic mutant corpus cannot forge report, artifact, target, or package fields", () => {
  const values = fixture();
  try {
    const options = { now: NOW, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address };
    const original = createProductionReleasePackage(values.artifact, { ...options,
      productionReport: values.productionReport, productionTarget: values.productionTarget });
    let state = 0x9e3779b9;
    const random = () => { state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 1) >>> 0; return state; };
    for (let index = 0; index < 48; index += 1) {
      const mutant = structuredClone(original); const choice = random() % 8;
      if (choice === 0) mutant.packageHash = `${mutant.packageHash[0] === "0" ? "1" : "0"}${mutant.packageHash.slice(1)}`;
      else if (choice === 1) mutant.productionTarget.networkId = `mutant-${random()}`;
      else if (choice === 2) mutant.productionTarget.finalizedTip = (random() % 16).toString(16).repeat(64);
      else if (choice === 3) mutant.productionTarget.sourceRevision = "f".repeat(40);
      else if (choice === 4) mutant.productionReport.observedAt += 1;
      else if (choice === 5) mutant.productionReport.evidence.expectedContext.genesisHash = "e".repeat(64);
      else if (choice === 6) mutant.artifact.entries[0].content = Buffer.from(`mutant-${random()}`).toString("base64");
      else mutant.unexpected = true;
      if (choice > 0 && choice < 7) {
        const { packageHash: _old, ...payload } = mutant;
        mutant.packageHash = hashObject(payload, "PRODUCTION_RELEASE_PACKAGE_V1");
      }
      assert.throws(() => verifyProductionReleasePackage(mutant, options));
    }
    assert.equal(serializeProductionReleasePackage(original, options),
      serializeProductionReleasePackage(createProductionReleasePackage(values.artifact, {
        ...options, productionReport: values.productionReport,
        productionTarget: values.productionTarget,
      }), options));
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production readers reject duplicate keys, noncanonical encodings, deep, oversized, FIFO and changed files", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-production-reader-adversarial-"));
  try {
    const duplicate = join(root, "duplicate.json");
    writeFileSync(duplicate, '{"a":1,"\\u0061":2}\n');
    assert.throws(() => readBoundedPublicJson(duplicate), /duplicate/);
    const noncanonical = join(root, "noncanonical.json");
    writeFileSync(noncanonical, '{ "a": 1 }\n');
    assert.throws(() => readBoundedPublicJson(noncanonical, { requireCanonical: true }), /canonical/);
    const deep = join(root, "deep.json"); writeFileSync(deep, `${"[".repeat(66)}0${"]".repeat(66)}\n`);
    assert.throws(() => readBoundedPublicJson(deep), /bounds/);
    const oversized = join(root, "oversized.json"); writeFileSync(oversized, "{}");
    truncateSync(oversized, 1025);
    assert.throws(() => readBoundedPublicJson(oversized, { maximumBytes: 1024 }), /bounded/);
    const changed = join(root, "changed.json"); writeFileSync(changed, '{"value":"original"}\n');
    assert.throws(() => readBoundedPublicJson(changed, { _afterOpen(path) { truncateSync(path, 2); } }),
      /changed/);
    const fifo = join(root, "input.fifo"); execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    assert.throws(() => readBoundedPublicJson(fifo), /bounded regular file/);
    assert.ok(Date.now() - started < 1_000, "FIFO input must fail without blocking");
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("freshness and expiry boundaries are inclusive only at the reviewed limits", () => {
  const values = fixture();
  try {
    const make = (now, productionTarget = values.productionTarget) =>
      createProductionReleasePackage(values.artifact, { now,
        productionReport: values.productionReport, productionTarget,
        signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    assert.doesNotThrow(() => make(NOW + values.productionTarget.maxPreflightAgeMs));
    assert.throws(() => make(NOW + values.productionTarget.maxPreflightAgeMs + 1), /stale/);
    assert.doesNotThrow(() => make(NOW - values.productionTarget.maxFutureSkewMs));
    assert.throws(() => make(NOW - values.productionTarget.maxFutureSkewMs - 1), /future/);
    const expiryTarget = { ...values.productionTarget, maxPreflightAgeMs: 20_000 };
    assert.doesNotThrow(() => make(NOW + 10_000, expiryTarget));
    assert.throws(() => make(NOW + 10_001, expiryTarget), /context/);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production install verifies before writes and interrupted or raced activation cleans only its generation", () => {
  const values = fixture();
  try {
    const options = { kind: "node", now: NOW, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address };
    const packageValue = createProductionReleasePackage(values.artifact, { ...options,
      productionReport: values.productionReport, productionTarget: values.productionTarget });
    const invalid = structuredClone(packageValue); invalid.productionReport.observedAt += 1;
    const invalidTarget = join(values.root, "invalid-install"); let reachedActivation = false;
    assert.throws(() => installProductionReleasePackage(invalid, invalidTarget, { ...options,
      _beforeActivation() { reachedActivation = true; },
    }));
    assert.equal(reachedActivation, false); assert.equal(existsSync(invalidTarget), false);
    assert.equal(readdirSync(values.root).some((name) => name.startsWith(".invalid-install.nir-generation-")), false);

    const interruptedTarget = join(values.root, "interrupted-install");
    assert.throws(() => installProductionReleasePackage(packageValue, interruptedTarget, { ...options,
      _beforeActivation() { throw new Error("simulated interruption"); },
    }), /simulated interruption/);
    assert.equal(existsSync(interruptedTarget), false);
    assert.equal(readdirSync(values.root).some((name) => name.startsWith(".interrupted-install.nir-generation-")), false);

    const racedTarget = join(values.root, "raced-install");
    assert.throws(() => installProductionReleasePackage(packageValue, racedTarget, { ...options,
      _beforeActivation() { mkdirSync(racedTarget); },
    }), /EEXIST/);
    assert.equal(lstatSync(racedTarget).isDirectory(), true);
    assert.equal(readdirSync(values.root).some((name) => name.startsWith(".raced-install.nir-generation-")), false);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("interrupted output activation leaves no package and source/package substitution fails closed", () => {
  const values = fixture();
  try {
    const options = { now: NOW, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address };
    const packageValue = createProductionReleasePackage(values.artifact, { ...options,
      productionReport: values.productionReport, productionTarget: values.productionTarget });
    const output = join(values.root, "interrupted.nirprod");
    assert.throws(() => writeProductionPackageExclusive(output, packageValue, { ...options,
      _afterLink() { throw new Error("simulated output interruption"); },
    }), /simulated output interruption/);
    assert.equal(existsSync(output), false);
    assert.equal(readdirSync(values.root).some((name) => name.startsWith(".interrupted.nirprod.nir-production-")), false);

    const packagePath = join(values.root, "package.nirprod");
    const replacement = join(values.root, "replacement.nirprod");
    writeFileSync(packagePath, serializeProductionReleasePackage(packageValue, options));
    writeFileSync(replacement, `${canonicalJson({ forged: true })}\n`);
    assert.throws(() => readBoundedPublicJson(packagePath, { requireCanonical: true,
      _afterOpen(path) { renameSync(replacement, path); },
    }), /changed/);

    const source = join(values.root, "source-race.mjs");
    const movedSource = join(values.root, "source-race-opened.mjs");
    writeFileSync(source, "export const trusted = true;\n");
    assert.throws(() => readReleaseSourceFile(source, { _afterOpen(path) {
      renameSync(path, movedSource); writeFileSync(path, "export const attacker = true;\n");
    } }), /changed/);
    assert.equal(readFileSync(source, "utf8"), "export const attacker = true;\n");
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production provenance survives restart and binds package, report, target and installed bytes", () => {
  const values = fixture(); const target = join(values.root, "production-runtime");
  try {
    const options = { kind: "node", now: NOW, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address };
    const packageValue = createProductionReleasePackage(values.artifact, { ...options,
      productionReport: values.productionReport, productionTarget: values.productionTarget });
    installProductionReleasePackage(packageValue, target, options);
    for (let restart = 0; restart < 2; restart += 1) {
      const verified = verifyProductionInstallation(target, { ...options,
        expectedPackageHash: packageValue.packageHash });
      assert.equal(verified.packageHash, packageValue.packageHash);
      assert.equal(verified.productionTarget.finalizedTip, TIP);
    }
    assert.throws(() => verifyProductionInstallation(target, { ...options,
      expectedPackageHash: "f".repeat(64) }), /trusted startup package/);
    assert.throws(() => verifyNodeInstallation(target, options), /file set/,
      "developer verifier must not silently accept a production generation");

    const generation = join(values.root, readlinkSync(target));
    const provenancePath = join(generation, "NIR-PRODUCTION.json");
    const originalProvenance = readFileSync(provenancePath, "utf8");
    const mutant = JSON.parse(originalProvenance); mutant.artifactHash = "e".repeat(64);
    writeFileSync(provenancePath, `${canonicalJson(mutant)}\n`);
    assert.throws(() => verifyProductionInstallation(target, { ...options,
      expectedPackageHash: packageValue.packageHash }), /hash|provenance|package/);
    writeFileSync(provenancePath, originalProvenance);
    writeFileSync(join(generation, "blockchain/node.mjs"), "export const mixed = true;\n");
    assert.throws(() => verifyProductionInstallation(target, { ...options,
      expectedPackageHash: packageValue.packageHash }), /contents differ/);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production startup rejects developer installs and update requires exact current head plus upgrade", () => {
  const values = fixture();
  try {
    const devTarget = join(values.root, "developer-node");
    installNodeArtifact(values.artifact, devTarget, { signedRelease: values.signedRelease,
      trustedAddress: values.signer.address });
    assert.throws(() => verifyProductionInstallation(devTarget, { kind: "node",
      expectedPackageHash: "a".repeat(64), signedRelease: values.signedRelease,
      trustedAddress: values.signer.address }), /ENOENT|production provenance/);

    const oldPackage = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const oldTarget = join(values.root, "old-production");
    installProductionReleasePackage(oldPackage, oldTarget, { kind: "node", now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });

    const paths = ["blockchain/node.mjs", "package.json"];
    const newerManifest = createReleaseManifest(values.root, paths, {
      releaseVersion: "1.2.4", sourceRevision: values.manifest.sourceRevision,
    });
    const newerSignedRelease = signReleaseManifest(newerManifest, values.signer);
    const newerEvidence = productionEvidence(values.root, newerManifest, "new-attestation-store");
    const newerArtifact = createReleaseArtifact(values.root, artifactPaths("node", paths), {
      kind: "node", sourceManifest: newerManifest,
    });
    const newerPackage = createProductionReleasePackage(newerArtifact, { now: NOW,
      productionReport: newerEvidence.productionReport,
      productionTarget: newerEvidence.productionTarget,
      signedRelease: newerSignedRelease, trustedAddress: values.signer.address });
    const newTarget = join(values.root, "new-production");
    installProductionReleasePackage(newerPackage, newTarget, { kind: "node", now: NOW,
      previousInstallation: oldTarget, previousSignedRelease: values.signedRelease,
      expectedPreviousPackageHash: oldPackage.packageHash,
      signedRelease: newerSignedRelease, trustedAddress: values.signer.address });
    assert.equal(verifyProductionInstallation(newTarget, { kind: "node",
      expectedPackageHash: newerPackage.packageHash, signedRelease: newerSignedRelease,
      trustedAddress: values.signer.address }).productionTarget.releaseVersion, "1.2.4");

    const rollbackTarget = join(values.root, "rollback-production");
    assert.throws(() => installProductionReleasePackage(oldPackage, rollbackTarget, {
      kind: "node", now: NOW, previousInstallation: newTarget,
      previousSignedRelease: newerSignedRelease,
      expectedPreviousPackageHash: newerPackage.packageHash,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address,
    }), /rollback|downgrade/);
    assert.equal(existsSync(rollbackTarget), false);
    const wrongHeadTarget = join(values.root, "wrong-head-production");
    assert.throws(() => installProductionReleasePackage(newerPackage, wrongHeadTarget, {
      kind: "node", now: NOW, previousInstallation: oldTarget,
      previousSignedRelease: values.signedRelease, expectedPreviousPackageHash: "0".repeat(64),
      signedRelease: newerSignedRelease, trustedAddress: values.signer.address,
    }), /trusted startup package/);
    assert.equal(existsSync(wrongHeadTarget), false);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("monotonic production head survives torn copies and external anchor detects coordinated rollback", () => {
  const values = fixture(); const store = join(values.root, "production-head");
  try {
    const oldPackage = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const oldTarget = join(values.root, "head-old");
    installProductionReleasePackage(oldPackage, oldTarget, { kind: "node", now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const first = advanceProductionHead(store, oldTarget, { kind: "node",
      newPackageHash: oldPackage.packageHash, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address });
    assert.equal(first.count, 1); assert.equal(first.copiesSynchronized, true);
    const oldPrimary = readFileSync(join(store, "HEAD.primary.json"));
    const oldBackup = readFileSync(join(store, "HEAD.backup.json"));

    const newer = releaseVariant(values, "1.2.4", "head-newer");
    const newerTarget = join(values.root, "head-newer");
    installProductionReleasePackage(newer.packageValue, newerTarget, { kind: "node", now: NOW,
      previousInstallation: oldTarget, previousSignedRelease: values.signedRelease,
      expectedPreviousPackageHash: oldPackage.packageHash,
      signedRelease: newer.signedRelease, trustedAddress: values.signer.address });
    const second = advanceProductionHead(store, newerTarget, { kind: "node",
      expectedPreviousPackageHash: oldPackage.packageHash,
      newPackageHash: newer.packageValue.packageHash, signedRelease: newer.signedRelease,
      trustedAddress: values.signer.address });
    const secondAnchor = exportProductionHeadAnchor(store);
    const secondPrimary = readFileSync(join(store, "HEAD.primary.json"));
    const secondBackup = readFileSync(join(store, "HEAD.backup.json"));
    assert.equal(second.count, 2);
    assert.equal(verifyProductionStartupFromHead(store, newerTarget, {
      externalAnchor: secondAnchor, signedRelease: newer.signedRelease,
      trustedAddress: values.signer.address,
    }).packageHash, newer.packageValue.packageHash);

    writeFileSync(join(store, "HEAD.primary.json"), oldPrimary);
    writeFileSync(join(store, "HEAD.backup.json"), oldBackup);
    assert.equal(loadProductionHeadStore(store).count, 1,
      "without an external anchor coordinated local rollback is not detectable");
    assert.throws(() => loadProductionHeadStore(store, { externalAnchor: secondAnchor }),
      /below|prefix/);
    writeFileSync(join(store, "HEAD.primary.json"), secondPrimary);
    writeFileSync(join(store, "HEAD.backup.json"), secondBackup);

    const newest = releaseVariant(values, "1.2.5", "head-newest");
    const newestTarget = join(values.root, "head-newest");
    installProductionReleasePackage(newest.packageValue, newestTarget, { kind: "node", now: NOW,
      previousInstallation: newerTarget, previousSignedRelease: newer.signedRelease,
      expectedPreviousPackageHash: newer.packageValue.packageHash,
      signedRelease: newest.signedRelease, trustedAddress: values.signer.address });
    assert.throws(() => advanceProductionHead(store, newestTarget, { kind: "node",
      expectedPreviousPackageHash: newer.packageValue.packageHash,
      newPackageHash: newest.packageValue.packageHash, signedRelease: newest.signedRelease,
      trustedAddress: values.signer.address,
      _afterFirstCopy() { throw new Error("simulated crash after first durable copy"); },
    }), /simulated crash/);
    const recovered = loadProductionHeadStore(store, { externalAnchor: secondAnchor });
    assert.equal(recovered.count, 3); assert.equal(recovered.copiesSynchronized, false);
    assert.equal(verifyProductionStartupFromHead(store, newestTarget, {
      signedRelease: newest.signedRelease, trustedAddress: values.signer.address,
    }).packageHash, newest.packageValue.packageHash);

    writeFileSync(join(store, "HEAD.primary.json"), "torn\n");
    assert.equal(loadProductionHeadStore(store).copiesValid, 1);
    const repaired = repairProductionHeadCopies(store);
    assert.equal(repaired.copiesSynchronized, true); assert.equal(repaired.count, 3);

    const signedPath = join(values.root, "newest-signed.json");
    writeFileSync(signedPath, `${JSON.stringify(newest.signedRelease, null, 2)}\n`);
    const headCli = new URL("../blockchain/production-head-cli.mjs", import.meta.url).pathname;
    const startup = spawnSync(process.execPath, [headCli, "startup", store, newestTarget,
      signedPath, values.signer.address], { encoding: "utf8" });
    assert.equal(startup.status, 0, startup.stderr);
    assert.equal(JSON.parse(startup.stdout).packageHash, newest.packageValue.packageHash);

    writeFileSync(join(store, ".writer.lock"), "busy\n", { mode: 0o600 });
    assert.throws(() => repairProductionHeadCopies(store), /EEXIST/);
    rmSync(join(store, ".writer.lock"));
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production head rejects divergent copies, replay, symlink roots and deterministic root swaps", () => {
  const values = fixture();
  try {
    const packageValue = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const target = join(values.root, "head-target");
    installProductionReleasePackage(packageValue, target, { kind: "node", now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const store = join(values.root, "head-store");
    advanceProductionHead(store, target, { kind: "node", newPackageHash: packageValue.packageHash,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    assert.throws(() => advanceProductionHead(store, target, { kind: "node",
      expectedPreviousPackageHash: packageValue.packageHash,
      newPackageHash: packageValue.packageHash, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address }), /replay|increase/);

    const racedTarget = join(values.root, "head-raced-target");
    installProductionReleasePackage(packageValue, racedTarget, { kind: "node", now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const racedStore = join(values.root, "head-raced-store");
    assert.throws(() => advanceProductionHead(racedStore, racedTarget, { kind: "node",
      newPackageHash: packageValue.packageHash, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address,
      _afterCandidateVerification() {
        const generation = join(values.root, readlinkSync(racedTarget));
        writeFileSync(join(generation, "blockchain/node.mjs"), "tampered-before-head-commit\n");
      },
    }), /contents differ/);
    assert.equal(loadProductionHeadStore(racedStore).count, 0);

    const different = releaseVariant(values, "1.2.4", "divergent");
    const differentTarget = join(values.root, "different-target");
    installProductionReleasePackage(different.packageValue, differentTarget, { kind: "node", now: NOW,
      signedRelease: different.signedRelease, trustedAddress: values.signer.address });
    const differentStore = join(values.root, "different-store");
    advanceProductionHead(differentStore, differentTarget, { kind: "node",
      newPackageHash: different.packageValue.packageHash, signedRelease: different.signedRelease,
      trustedAddress: values.signer.address });
    writeFileSync(join(store, "HEAD.primary.json"),
      readFileSync(join(differentStore, "HEAD.primary.json")));
    assert.throws(() => loadProductionHeadStore(store), /diverged/);

    const symlinkRoot = join(values.root, "head-link"); symlinkSync("head-store", symlinkRoot, "dir");
    assert.throws(() => loadProductionHeadStore(symlinkRoot), /unsafe|ELOOP/);

    const swapRoot = join(values.root, "swap-store"); const savedRoot = `${swapRoot}-saved`;
    assert.throws(() => advanceProductionHead(swapRoot, target, { kind: "node",
      newPackageHash: packageValue.packageHash, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address,
      _beforeCopyRename({ root }) {
        renameSync(root, savedRoot); mkdirSync(root, { mode: 0o700 });
        writeFileSync(join(root, "foreign"), "preserve\n");
      },
    }), /root changed|writer lock changed|ENOENT/);
    assert.equal(readFileSync(join(swapRoot, "foreign"), "utf8"), "preserve\n");
    assert.equal(existsSync(join(swapRoot, "HEAD.primary.json")), false);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production node guard self-binds active generation and entrypoint refuses to open a port on failure", async () => {
  const values = fixture();
  try {
    const packageValue = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const target = join(values.root, "guarded-node");
    installProductionReleasePackage(packageValue, target, { kind: "node", now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const head = join(values.root, "guarded-head");
    advanceProductionHead(head, target, { kind: "node", newPackageHash: packageValue.packageHash,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const anchorPath = join(values.root, "guarded-head-anchor.json");
    writeFileSync(anchorPath, `${canonicalJson(exportProductionHeadAnchor(head))}\n`);
    const signedPath = join(values.root, "guarded-signed.json");
    writeFileSync(signedPath, `${JSON.stringify(values.signedRelease, null, 2)}\n`);
    const generation = join(values.root, readlinkSync(target));
    assert.throws(() => createProductionStartupGuard({ headStore: head,
      installationTarget: target,
      kind: "node", moduleUrl: pathToFileURL(join(generation, "blockchain/node.mjs")).href,
      signedReleasePath: signedPath, trustedAddress: values.signer.address }), /external monotonic anchor/);
    const guard = createProductionStartupGuard({ externalAnchorPath: anchorPath,
      headStore: head, installationTarget: target,
      kind: "node", moduleUrl: pathToFileURL(join(generation, "blockchain/node.mjs")).href,
      signedReleasePath: signedPath, trustedAddress: values.signer.address });
    assert.equal(guard.initial.packageHash, packageValue.packageHash);
    assert.equal(guard.verifyBeforeOpen().packageHash, packageValue.packageHash);
    unlinkSync(target); symlinkSync("invalid-generation", target, "dir");
    assert.throws(() => guard.verifyBeforeOpen(), /activation|ENOENT/);

    const port = await unusedPort();
    const nodeCli = new URL("../blockchain/node-cli.mjs", import.meta.url).pathname;
    const failed = spawnSync(process.execPath, [nodeCli, "serve-production", target, head,
      signedPath, values.signer.address, join(values.root, "runtime"), String(port), "127.0.0.1",
      anchorPath],
    { encoding: "utf8" });
    assert.equal(failed.status, 1); assert.match(failed.stderr, /Node operation failed/);
    const reservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      reservation.once("error", reject); reservation.listen(port, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => reservation.close(resolvePromise));
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("production wallet bridge and UI verify anchored generations before bind on every restart", async () => {
  const values = fixture(); let child = null;
  try {
    const sourceBlockchain = new URL("../blockchain/", import.meta.url).pathname;
    const runtimeFiles = readdirSync(sourceBlockchain).filter((name) => name.endsWith(".mjs"));
    for (const name of runtimeFiles) {
      copyFileSync(join(sourceBlockchain, name), join(values.root, "blockchain", name));
    }
    copyFileSync(new URL("../package.json", import.meta.url), join(values.root, "package.json"));
    const sourceWalletUi = new URL("../wallet-ui/", import.meta.url).pathname;
    const walletFiles = readdirSync(sourceWalletUi);
    mkdirSync(join(values.root, "wallet-ui"));
    for (const name of walletFiles) {
      copyFileSync(join(sourceWalletUi, name), join(values.root, "wallet-ui", name));
    }
    const paths = ["package.json", ...walletFiles.map((name) => `wallet-ui/${name}`),
      ...runtimeFiles.map((name) => `blockchain/${name}`)];
    const manifest = createReleaseManifest(values.root, paths, {
      releaseVersion: "2.0.0", sourceRevision: values.manifest.sourceRevision,
    });
    const signedRelease = signReleaseManifest(manifest, values.signer);
    const evidence = productionEvidence(values.root, manifest, "wallet-entrypoint-attestations");
    const walletArtifact = createReleaseArtifact(values.root, artifactPaths("wallet", paths), {
      kind: "wallet", sourceManifest: manifest,
    });
    const toolArtifact = createReleaseArtifact(values.root, artifactPaths("node", paths), {
      kind: "node", sourceManifest: manifest,
    });
    assert.equal(validateProductionWalletExtensionArtifact(walletArtifact).files, walletFiles.length);
    const extraArtifact = structuredClone(walletArtifact);
    extraArtifact.entries.push({ content: Buffer.from("extra").toString("base64"),
      executable: false, path: "wallet-ui/background.js", sha3_256: "0".repeat(64), size: 5 });
    assert.throws(() => validateProductionWalletExtensionArtifact(extraArtifact), /extra/);
    const permissionArtifact = mutateArtifactText(walletArtifact, "manifest.json", (text) => {
      const value = JSON.parse(text); value.permissions = ["tabs"]; return JSON.stringify(value);
    });
    assert.throws(() => validateProductionWalletExtensionArtifact(permissionArtifact), /permissions/);
    const backgroundArtifact = mutateArtifactText(walletArtifact, "manifest.json", (text) => {
      const value = JSON.parse(text); value.background = { service_worker: "sw.js" };
      return JSON.stringify(value);
    });
    assert.throws(() => validateProductionWalletExtensionArtifact(backgroundArtifact), /schema/);
    const contentScriptArtifact = mutateArtifactText(walletArtifact, "manifest.json", (text) => {
      const value = JSON.parse(text); value.content_scripts = [{ js: ["app.js"], matches: ["<all_urls>"] }];
      return JSON.stringify(value);
    });
    assert.throws(() => validateProductionWalletExtensionArtifact(contentScriptArtifact), /schema/);
    const remoteCodeArtifact = mutateArtifactText(walletArtifact, "app.js",
      (text) => `import "https://evil.invalid/code.js";\n${text}`);
    assert.throws(() => validateProductionWalletExtensionArtifact(remoteCodeArtifact), /remote/);
    const evalArtifact = mutateArtifactText(walletArtifact, "app.js",
      (text) => `${text}\neval("globalThis.compromised=true");\n`);
    assert.throws(() => validateProductionWalletExtensionArtifact(evalArtifact), /dynamic evaluation/);
    const cspArtifact = mutateArtifactText(walletArtifact, "manifest.json", (text) => {
      const value = JSON.parse(text);
      value.content_security_policy.extension_pages += " https://evil.invalid";
      return JSON.stringify(value);
    });
    assert.throws(() => validateProductionWalletExtensionArtifact(cspArtifact), /permissions or CSP/);
    const traversalArtifact = mutateArtifactText(walletArtifact, "index.html",
      (text) => text.replace("app.js?v=31", "../app.js"));
    assert.throws(() => validateProductionWalletExtensionArtifact(traversalArtifact), /unsafe|unverified/);
    const packageValue = createProductionReleasePackage(walletArtifact, { now: NOW,
      productionReport: evidence.productionReport, productionTarget: evidence.productionTarget,
      signedRelease, trustedAddress: values.signer.address });
    const toolPackage = createProductionReleasePackage(toolArtifact, { now: NOW,
      productionReport: evidence.productionReport, productionTarget: evidence.productionTarget,
      signedRelease, trustedAddress: values.signer.address });
    const releaseAuthorities = Array.from({ length: 4 }, generateWallet);
    const authoritySet = createReleaseAuthoritySet({
      authorities: releaseAuthorities.map((wallet, index) => ({
        ...publicWallet(wallet), operatorId: `wallet-export-${index}`,
      })), generation: 1, rotationDelayEntries: 2, threshold: 3,
    });
    const exportBundleA = createProductionWalletExportBundle({ signedRelease, toolPackage,
      trustedAddress: values.signer.address, walletPackage: packageValue });
    const exportBundleB = createProductionWalletExportBundle({ signedRelease: structuredClone(signedRelease),
      toolPackage: structuredClone(toolPackage), trustedAddress: values.signer.address,
      walletPackage: structuredClone(packageValue) });
    assert.equal(canonicalJson(exportBundleA), canonicalJson(exportBundleB),
      "independent verified build roots must produce identical bundle bytes");
    const exportApprovals = releaseAuthorities.slice(0, 3)
      .map((wallet) => signOfflineReleaseBundle(exportBundleA, wallet));
    const portableExport = assembleProductionWalletExport(exportBundleA, authoritySet, exportApprovals);
    const verifiedExport = verifyProductionWalletExport(portableExport, {
      expectedAuthoritySetId: authoritySet.setId,
      expectedGenesisHash: evidence.productionTarget.genesisHash,
      expectedNetworkId: NETWORK, expectedToolPackageHash: toolPackage.packageHash,
      expectedWalletPackageHash: packageValue.packageHash,
      trustedReleaseAddress: values.signer.address,
    });
    assert.equal(verifiedExport.binding.wallet.packageHash, packageValue.packageHash);
    assert.throws(() => verifyProductionWalletExport(portableExport, {
      expectedAuthoritySetId: `sha3-256:${"f".repeat(64)}`,
      trustedReleaseAddress: values.signer.address,
    }), /authority set/);
    assert.equal(serializeProductionWalletExport(portableExport, {
      expectedAuthoritySetId: authoritySet.setId,
      trustedReleaseAddress: values.signer.address,
    }), `${canonicalJson(portableExport)}\n`);
    const transparencyRoot = join(values.root, "wallet-release-transparency");
    const appendedRelease = appendWalletReleaseTransparency(transparencyRoot, portableExport, {
      expectedAuthoritySetId: authoritySet.setId, trustedReleaseAddress: values.signer.address,
    });
    let latestTransparencyStore = appendedRelease.store;
    let previousPortableBundleHash = exportBundleA.bundleHash;
    const portableVersion = (patch, set = authoritySet, signers = releaseAuthorities) => {
      const nextManifest = createReleaseManifest(values.root, paths, {
        releaseVersion: `2.0.${patch}`, sourceRevision: values.manifest.sourceRevision,
      });
      const nextSigned = signReleaseManifest(nextManifest, values.signer);
      const nextEvidence = productionEvidence(values.root, nextManifest,
        `wallet-transparency-attestations-${patch}`);
      const nextWalletArtifact = createReleaseArtifact(values.root, artifactPaths("wallet", paths), {
        kind: "wallet", sourceManifest: nextManifest,
      });
      const nextToolArtifact = createReleaseArtifact(values.root, artifactPaths("node", paths), {
        kind: "node", sourceManifest: nextManifest,
      });
      const packageOptions = { now: NOW, productionReport: nextEvidence.productionReport,
        productionTarget: nextEvidence.productionTarget, signedRelease: nextSigned,
        trustedAddress: values.signer.address };
      const nextWalletPackage = createProductionReleasePackage(nextWalletArtifact, packageOptions);
      const nextToolPackage = createProductionReleasePackage(nextToolArtifact, packageOptions);
      const nextBundle = createProductionWalletExportBundle({ previousBundleHash: previousPortableBundleHash,
        signedRelease: nextSigned, toolPackage: nextToolPackage,
        trustedAddress: values.signer.address, walletPackage: nextWalletPackage });
      const nextApprovals = signers.slice(0, set.threshold)
        .map((wallet) => signOfflineReleaseBundle(nextBundle, wallet));
      const nextExport = assembleProductionWalletExport(nextBundle, set, nextApprovals);
      return { bundle: nextBundle, export: nextExport, signedRelease: nextSigned,
        toolPackage: nextToolPackage, walletPackage: nextWalletPackage };
    };
    for (let patch = 1; patch <= 3; patch += 1) {
      const next = portableVersion(patch);
      latestTransparencyStore = appendWalletReleaseTransparency(transparencyRoot, next.export, {
        expectedAuthoritySetId: authoritySet.setId, trustedReleaseAddress: values.signer.address,
      }).store;
      previousPortableBundleHash = next.bundle.bundleHash;
    }
    const checkpointPayload = createWalletReleaseCheckpoint(latestTransparencyStore, {
      expiresAt: NOW + 10_000, issuedAt: NOW,
    });
    const checkpointSignatures = releaseAuthorities.slice(0, 3).map((wallet, index) =>
      signWalletReleaseCheckpoint(checkpointPayload, authoritySet, {
        operatorId: `wallet-export-${index}`, wallet,
      }));
    const signedCheckpoint = assembleWalletReleaseCheckpoint(checkpointPayload, authoritySet,
      checkpointSignatures);
    assert.throws(() => assembleWalletReleaseCheckpoint(checkpointPayload, authoritySet,
      [checkpointSignatures[0], checkpointSignatures[0], checkpointSignatures[1]]), /duplicate/);
    const inclusionProof = createWalletReleaseInclusionProof(latestTransparencyStore, 1);
    assert.equal(verifyWalletReleaseTransparencyEvidence(verifiedExport, {
      checkpoint: signedCheckpoint, inclusionProof,
    }, { expectedCheckpointHash: signedCheckpoint.checkpointHash, now: NOW }).verified, true);
    const gossip = exportWalletReleaseGossipCheckpoint(signedCheckpoint);
    assert.equal(gossip.merkleRoot, latestTransparencyStore.merkleRoot);
    assert.equal(compareWalletReleaseGossipCheckpoints(gossip, structuredClone(gossip)).relation,
      "equal");
    const forkedGossip = structuredClone(gossip); forkedGossip.merkleRoot = "f".repeat(64);
    assert.throws(() => compareWalletReleaseGossipCheckpoints(gossip, forkedGossip), /split-view/);
    for (let oldCount = 1; oldCount <= latestTransparencyStore.count; oldCount += 1) {
      verifyWalletReleaseConsistencyProof(
        createWalletReleaseConsistencyProof(latestTransparencyStore, oldCount));
    }
    const extensionProof = createWalletReleaseConsistencyProof(latestTransparencyStore, 1);
    const olderGossip = { ...gossip, checkpointHash: "1".repeat(64), count: 1,
      headHash: latestTransparencyStore.records[0].recordHash,
      latestReleaseManifestHash: latestTransparencyStore.records[0].record.releaseManifestHash,
      merkleRoot: extensionProof.oldRoot };
    assert.equal(compareWalletReleaseGossipCheckpoints(olderGossip, gossip,
      extensionProof).relation, "consistent-extension");
    const brokenConsistency = createWalletReleaseConsistencyProof(latestTransparencyStore, 1);
    brokenConsistency.nodes.reverse();
    assert.throws(() => verifyWalletReleaseConsistencyProof(brokenConsistency), /connect|extra/);
    let mutantSeed = 0x51f15e;
    const consistencyBase = createWalletReleaseConsistencyProof(latestTransparencyStore, 1);
    for (let mutation = 0; mutation < 32; mutation += 1) {
      mutantSeed = (Math.imul(mutantSeed, 1664525) + 1013904223) >>> 0;
      const candidate = structuredClone(consistencyBase);
      const index = mutantSeed % candidate.nodes.length;
      const nibble = (Number.parseInt(candidate.nodes[index][0], 16) ^ 1).toString(16);
      candidate.nodes[index] = `${nibble}${candidate.nodes[index].slice(1)}`;
      assert.throws(() => verifyWalletReleaseConsistencyProof(candidate), /connect|extra/);
    }
    assert.throws(() => appendWalletReleaseTransparency(transparencyRoot, portableExport, {
      expectedAuthoritySetId: authoritySet.setId, trustedReleaseAddress: values.signer.address,
    }), /duplicate|replay|reordered/);
    const crashRoot = join(values.root, "wallet-release-crash");
    assert.throws(() => appendWalletReleaseTransparency(crashRoot, portableExport, {
      _beforeBackupRename: () => { throw new Error("simulated checkpoint crash"); },
      expectedAuthoritySetId: authoritySet.setId, trustedReleaseAddress: values.signer.address,
    }), /simulated checkpoint crash/);
    assert.equal(loadWalletReleaseTransparencyStore(crashRoot).store.count, 1);
    const symlinkRoot = join(values.root, "wallet-release-symlink");
    symlinkSync(crashRoot, symlinkRoot);
    assert.throws(() => loadWalletReleaseTransparencyStore(symlinkRoot), /unsafe/);
    const forkedProof = structuredClone(inclusionProof);
    forkedProof.record.record.walletPackageHash = "e".repeat(64);
    assert.throws(() => verifyWalletReleaseTransparencyEvidence(verifiedExport, {
      checkpoint: signedCheckpoint, inclusionProof: forkedProof,
    }, { expectedCheckpointHash: signedCheckpoint.checkpointHash, now: NOW }), /record|proof/);
    const omittedProof = structuredClone(inclusionProof); omittedProof.nodes.pop();
    assert.throws(() => verifyWalletReleaseTransparencyEvidence(verifiedExport, {
      checkpoint: signedCheckpoint, inclusionProof: omittedProof,
    }, { expectedCheckpointHash: signedCheckpoint.checkpointHash, now: NOW }), /truncated|proof/);
    assert.throws(() => verifyWalletReleaseTransparencyEvidence(verifiedExport, {
      checkpoint: signedCheckpoint, inclusionProof,
    }, { expectedCheckpointHash: "f".repeat(64), now: NOW }), /untrusted/);
    assert.throws(() => verifyWalletReleaseTransparencyEvidence(verifiedExport, {
      checkpoint: signedCheckpoint, inclusionProof,
    }, { expectedCheckpointHash: signedCheckpoint.checkpointHash, now: NOW + 10_001 }), /stale/);
    const nextAuthorityWallets = Array.from({ length: 4 }, generateWallet);
    const nextAuthoritySet = createReleaseAuthoritySet({
      authorities: nextAuthorityWallets.map((wallet, index) => ({
        ...publicWallet(wallet), operatorId: `wallet-export-next-${index}`,
      })), generation: 2, rotationDelayEntries: 2, threshold: 3,
    });
    const skippedAuthoritySet = createReleaseAuthoritySet({
      authorities: nextAuthoritySet.authorities, generation: 3,
      rotationDelayEntries: 2, threshold: 3,
    });
    assert.throws(() => createWalletReleaseAuthorityTransition({ activationDelay: 2,
      createdAt: NOW, genesisHash: evidence.productionTarget.genesisHash, graceRecords: 3,
      networkId: NETWORK, newSet: skippedAuthoritySet, oldCheckpoint: signedCheckpoint,
      oldSet: authoritySet, transitionNonce: "8".repeat(64) }), /generation/);
    const transition = createWalletReleaseAuthorityTransition({ activationDelay: 2, createdAt: NOW,
      genesisHash: evidence.productionTarget.genesisHash, graceRecords: 3, networkId: NETWORK,
      newSet: nextAuthoritySet, oldCheckpoint: signedCheckpoint, oldSet: authoritySet,
      transitionNonce: "9".repeat(64) });
    const oldTransitionSignatures = releaseAuthorities.slice(0, 3).map((wallet, index) =>
      signWalletReleaseAuthorityTransition(transition, authoritySet, {
        operatorId: `wallet-export-${index}`, role: "old", wallet,
      }));
    const newTransitionSignatures = nextAuthorityWallets.slice(0, 3).map((wallet, index) =>
      signWalletReleaseAuthorityTransition(transition, authoritySet, {
        operatorId: `wallet-export-next-${index}`, role: "new", wallet,
      }));
    const transitionEnvelope = assembleWalletReleaseAuthorityTransition(transition, authoritySet,
      oldTransitionSignatures, newTransitionSignatures);
    assert.throws(() => assembleWalletReleaseAuthorityTransition(transition, authoritySet,
      oldTransitionSignatures, newTransitionSignatures.slice(0, 2)), /quorum/);
    const forgedTransition = structuredClone(transition); forgedTransition.networkId = "other-network";
    assert.throws(() => signWalletReleaseAuthorityTransition(forgedTransition, authoritySet, {
      operatorId: "wallet-export-0", role: "old", wallet: releaseAuthorities[0],
    }), /hash/);
    latestTransparencyStore = scheduleWalletReleaseAuthorityTransition(transparencyRoot,
      transitionEnvelope, { expectedOldCheckpointHash: signedCheckpoint.checkpointHash }).store;
    assert.throws(() => scheduleWalletReleaseAuthorityTransition(transparencyRoot,
      transitionEnvelope, { expectedOldCheckpointHash: signedCheckpoint.checkpointHash }), /stale|replayed/);
    const overlapRelease = portableVersion(4);
    latestTransparencyStore = appendWalletReleaseTransparency(transparencyRoot, overlapRelease.export, {
      expectedAuthoritySetId: authoritySet.setId, trustedReleaseAddress: values.signer.address,
    }).store;
    previousPortableBundleHash = overlapRelease.bundle.bundleHash;
    const activatedRelease = portableVersion(5, nextAuthoritySet, nextAuthorityWallets);
    latestTransparencyStore = appendWalletReleaseTransparency(transparencyRoot, activatedRelease.export, {
      expectedAuthoritySetId: nextAuthoritySet.setId, trustedReleaseAddress: values.signer.address,
    }).store;
    assert.throws(() => appendWalletReleaseTransparency(transparencyRoot, overlapRelease.export, {
      expectedAuthoritySetId: authoritySet.setId, trustedReleaseAddress: values.signer.address,
    }), /not active/);
    assert.deepEqual(loadWalletReleaseTransparencyStore(transparencyRoot).store.tombstones,
      [authoritySet.setId]);
    const activatedCheckpointPayload = createWalletReleaseCheckpoint(latestTransparencyStore, {
      expiresAt: NOW + 20_000, issuedAt: NOW + 1,
    });
    const activatedCheckpoint = assembleWalletReleaseCheckpoint(activatedCheckpointPayload,
      nextAuthoritySet, nextAuthorityWallets.slice(0, 3).map((wallet, index) =>
        signWalletReleaseCheckpoint(activatedCheckpointPayload, nextAuthoritySet, {
          operatorId: `wallet-export-next-${index}`, wallet,
        })));
    const rotationProof = createWalletReleaseConsistencyProof(latestTransparencyStore,
      signedCheckpoint.checkpoint.count);
    const rotatedInclusion = createWalletReleaseInclusionProof(latestTransparencyStore, 1);
    assert.equal(verifyWalletReleaseTransparencyEvidence(verifiedExport, {
      checkpoint: activatedCheckpoint, consistencyProof: rotationProof,
      inclusionProof: rotatedInclusion, transition: transitionEnvelope,
    }, { expectedCheckpointHash: activatedCheckpoint.checkpointHash, now: NOW + 1 }).verified, true);
    const activatedVerified = verifyProductionWalletExport(activatedRelease.export, {
      expectedAuthoritySetId: nextAuthoritySet.setId, trustedReleaseAddress: values.signer.address,
    });
    assert.throws(() => verifyWalletReleaseTransparencyEvidence(activatedVerified, {
      checkpoint: activatedCheckpoint,
      inclusionProof: createWalletReleaseInclusionProof(latestTransparencyStore, 6),
    }, { expectedCheckpointHash: activatedCheckpoint.checkpointHash, now: NOW + 1 }), /transition proof/);
    assert.equal(verifyWalletReleaseTransparencyEvidence(activatedVerified, {
      checkpoint: activatedCheckpoint, consistencyProof: rotationProof,
      inclusionProof: createWalletReleaseInclusionProof(latestTransparencyStore, 6),
      transition: transitionEnvelope,
    }, { expectedCheckpointHash: activatedCheckpoint.checkpointHash, now: NOW + 1 }).verified, true);
    const exportCli = new URL("../blockchain/production-wallet-export-cli.mjs", import.meta.url).pathname;
    const rotatedExportPath = join(values.root, "portable-rotated-export.json");
    const rotatedCheckpointPath = join(values.root, "portable-rotated-checkpoint.json");
    const rotatedInclusionPath = join(values.root, "portable-rotated-inclusion.json");
    const transitionPath = join(values.root, "portable-authority-transition.json");
    const consistencyPath = join(values.root, "portable-rotation-consistency.json");
    writeFileSync(rotatedExportPath, `${canonicalJson(activatedRelease.export)}\n`);
    writeFileSync(rotatedCheckpointPath, `${canonicalJson(activatedCheckpoint)}\n`);
    writeFileSync(rotatedInclusionPath,
      `${canonicalJson(createWalletReleaseInclusionProof(latestTransparencyStore, 6))}\n`);
    writeFileSync(transitionPath, `${canonicalJson(transitionEnvelope)}\n`);
    writeFileSync(consistencyPath, `${canonicalJson(rotationProof)}\n`);
    const rotatedVerifyArguments = [rotatedExportPath, values.signer.address,
      nextAuthoritySet.setId, NETWORK, evidence.productionTarget.genesisHash,
      activatedRelease.walletPackage.packageHash, activatedRelease.toolPackage.packageHash,
      rotatedCheckpointPath, rotatedInclusionPath, activatedCheckpoint.checkpointHash,
      String(NOW + 1)];
    const missingRotationProof = spawnSync(process.execPath,
      [exportCli, "verify", ...rotatedVerifyArguments], { encoding: "utf8" });
    assert.equal(missingRotationProof.status, 1);
    assert.match(missingRotationProof.stderr, /transition proof/);
    const rotatedVerify = spawnSync(process.execPath,
      [exportCli, "verify", ...rotatedVerifyArguments, transitionPath, consistencyPath],
      { encoding: "utf8" });
    assert.equal(rotatedVerify.status, 0, rotatedVerify.stderr);
    const rotatedImportTarget = join(values.root, "portable-rotated-import");
    const rotatedImport = spawnSync(process.execPath,
      [exportCli, "import", ...rotatedVerifyArguments, rotatedImportTarget,
        transitionPath, consistencyPath], { encoding: "utf8" });
    assert.equal(rotatedImport.status, 0, rotatedImport.stderr);
    assert.equal(JSON.parse(rotatedImport.stdout).packageHash,
      activatedRelease.walletPackage.packageHash);
    const exportRoots = [join(values.root, "export-root-a"), join(values.root, "export-root-b")];
    for (const root of exportRoots) mkdirSync(root);
    const packageInputs = exportRoots.map((root) => ({
      signed: join(root, "signed-release.json"), tool: join(root, "tool-package.json"),
      wallet: join(root, "wallet-package.json"),
    }));
    const authoritySetPath = join(values.root, "portable-authorities.json");
    const cliBundleA = join(values.root, "portable-a.nirpkg");
    const cliBundleB = join(values.root, "portable-b.nirpkg");
    for (const input of packageInputs) {
      writeFileSync(input.wallet, `${canonicalJson(packageValue)}\n`);
      writeFileSync(input.tool, `${canonicalJson(toolPackage)}\n`);
      writeFileSync(input.signed, `${canonicalJson(signedRelease)}\n`);
    }
    writeFileSync(authoritySetPath, `${canonicalJson(authoritySet)}\n`);
    for (let index = 0; index < 2; index += 1) {
      const input = packageInputs[index]; const output = [cliBundleA, cliBundleB][index];
      const built = spawnSync(process.execPath, [exportCli, "build", input.wallet,
        input.tool, input.signed, values.signer.address, "none", output],
      { encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr);
    }
    assert.deepEqual(readFileSync(cliBundleA), readFileSync(cliBundleB));
    const approvalPaths = exportApprovals.map((approval, index) => {
      const path = join(values.root, `portable-approval-${index}.json`);
      writeFileSync(path, `${canonicalJson(approval)}\n`); return path;
    });
    const cliExport = join(values.root, "portable-export.json");
    const assembledCli = spawnSync(process.execPath, [exportCli, "assemble", cliBundleA,
      authoritySetPath, cliExport, ...approvalPaths], { encoding: "utf8" });
    assert.equal(assembledCli.status, 0, assembledCli.stderr);
    const checkpointPath = join(values.root, "wallet-release-checkpoint.json");
    const inclusionPath = join(values.root, "wallet-release-inclusion.json");
    writeFileSync(checkpointPath, `${canonicalJson(signedCheckpoint)}\n`);
    writeFileSync(inclusionPath, `${canonicalJson(inclusionProof)}\n`);
    const verifiedCli = spawnSync(process.execPath, [exportCli, "verify", cliExport,
      values.signer.address, authoritySet.setId, NETWORK, evidence.productionTarget.genesisHash,
      packageValue.packageHash, toolPackage.packageHash, checkpointPath, inclusionPath,
      signedCheckpoint.checkpointHash, String(NOW)], { encoding: "utf8" });
    assert.equal(verifiedCli.status, 0, verifiedCli.stderr);
    const cliImportedWallet = join(values.root, "portable-cli-import");
    const importedCli = spawnSync(process.execPath, [exportCli, "import", cliExport,
      values.signer.address, authoritySet.setId, NETWORK, evidence.productionTarget.genesisHash,
      packageValue.packageHash, toolPackage.packageHash, checkpointPath, inclusionPath,
      signedCheckpoint.checkpointHash, String(NOW), cliImportedWallet], { encoding: "utf8" });
    assert.equal(importedCli.status, 0, importedCli.stderr);
    assert.equal(JSON.parse(importedCli.stdout).packageHash, packageValue.packageHash);
    const missingTransparencyTarget = join(values.root, "portable-missing-transparency");
    assert.throws(() => importProductionWalletExport(portableExport, missingTransparencyTarget, {
      expectedAuthoritySetId: authoritySet.setId, trustedReleaseAddress: values.signer.address,
    }), /transparency evidence/);
    assert.equal(existsSync(missingTransparencyTarget), false);
    assert.throws(() => assembleProductionWalletExport(exportBundleA, authoritySet,
      [exportApprovals[0], exportApprovals[0], exportApprovals[1]]), /duplicate/);
    assert.throws(() => assembleProductionWalletExport(exportBundleA, authoritySet,
      exportApprovals.slice(0, 2)), /quorum/);
    assert.throws(() => assembleProductionWalletExport(exportBundleA, authoritySet,
      [...exportApprovals.slice(0, 2), signOfflineReleaseBundle(exportBundleA, generateWallet())]),
    /unknown/);
    const mutatedExport = structuredClone(portableExport);
    mutatedExport.bundle.entries.find(({ path }) => path === "wallet/package.json").content =
      Buffer.from("{}\n").toString("base64");
    assert.throws(() => verifyProductionWalletExport(mutatedExport, {
      expectedAuthoritySetId: authoritySet.setId,
      trustedReleaseAddress: values.signer.address,
    }), /manifest|entry/);
    assert.throws(() => verifyProductionWalletExport(portableExport, {
      expectedAuthoritySetId: authoritySet.setId, expectedToolPackageHash: "f".repeat(64),
      trustedReleaseAddress: values.signer.address,
    }), /lineage/);
    const importedWallet = join(values.root, "portable-wallet-import");
    const imported = importProductionWalletExport(portableExport, importedWallet, {
      expectedAuthoritySetId: authoritySet.setId,
      expectedCheckpointHash: signedCheckpoint.checkpointHash,
      expectedGenesisHash: evidence.productionTarget.genesisHash,
      expectedNetworkId: NETWORK, expectedToolPackageHash: toolPackage.packageHash,
      expectedWalletPackageHash: packageValue.packageHash,
      now: NOW, transparencyEvidence: { checkpoint: signedCheckpoint, inclusionProof },
      trustedReleaseAddress: values.signer.address,
    });
    assert.equal(imported.packageHash, packageValue.packageHash);
    const occupiedPortable = join(values.root, "portable-wallet-occupied");
    mkdirSync(occupiedPortable); writeFileSync(join(occupiedPortable, "foreign"), "keep\n");
    assert.throws(() => importProductionWalletExport(portableExport, occupiedPortable, {
      expectedAuthoritySetId: authoritySet.setId,
      expectedCheckpointHash: signedCheckpoint.checkpointHash, now: NOW,
      transparencyEvidence: { checkpoint: signedCheckpoint, inclusionProof },
      trustedReleaseAddress: values.signer.address,
    }), /new directory|exist|target/i);
    assert.equal(readFileSync(join(occupiedPortable, "foreign"), "utf8"), "keep\n");
    assert.throws(() => importProductionWalletExport(portableExport,
      join(values.root, "portable-wallet-rollback"), {
        expectedAuthoritySetId: authoritySet.setId,
        expectedCheckpointHash: signedCheckpoint.checkpointHash,
        expectedPreviousPackageHash: packageValue.packageHash,
        previousInstallation: importedWallet, previousSignedRelease: signedRelease,
        now: NOW, transparencyEvidence: { checkpoint: signedCheckpoint, inclusionProof },
        trustedReleaseAddress: values.signer.address,
      }), /rollback|downgrade/);
    const installation = join(values.root, "wallet-app");
    installProductionReleasePackage(packageValue, installation, { kind: "wallet", now: NOW,
      signedRelease, trustedAddress: values.signer.address });
    const head = join(values.root, "wallet-head");
    advanceProductionHead(head, installation, { kind: "wallet",
      newPackageHash: packageValue.packageHash, signedRelease,
      trustedAddress: values.signer.address });
    const anchorPath = join(values.root, "wallet-head-anchor.json");
    writeFileSync(anchorPath, `${canonicalJson(exportProductionHeadAnchor(head))}\n`);
    const toolInstallation = join(values.root, "bridge-tool");
    installProductionReleasePackage(toolPackage, toolInstallation, { kind: "node", now: NOW,
      signedRelease, trustedAddress: values.signer.address });
    const toolHead = join(values.root, "bridge-tool-head");
    advanceProductionHead(toolHead, toolInstallation, { kind: "node",
      newPackageHash: toolPackage.packageHash, signedRelease,
      trustedAddress: values.signer.address });
    const toolAnchorPath = join(values.root, "bridge-tool-head-anchor.json");
    writeFileSync(toolAnchorPath, `${canonicalJson(exportProductionHeadAnchor(toolHead))}\n`);
    const runtimeNow = Date.now();
    const runtimePolicy = createProductionRuntimePolicy({ authoritySet,
      binding: { genesisHash: evidence.productionTarget.genesisHash, networkId: NETWORK,
        releaseManifestHash: manifest.manifestHash, releaseVersion: manifest.releaseVersion,
        sourceRevision: manifest.sourceRevision, toolPackageHash: toolPackage.packageHash,
        walletPackageHash: packageValue.packageHash },
      commands: ["bridge", "extension", "ui"], createdAt: runtimeNow - 60_000,
      expiresAt: runtimeNow + 3_600_000, runtime: inspectProductionRuntime(), sequence: 1 });
    const runtimePolicyApprovals = releaseAuthorities.slice(0, 3).map((wallet, index) =>
      signProductionRuntimePolicy(runtimePolicy, authoritySet,
        { operatorId: `wallet-export-${index}`, wallet }));
    const runtimePolicyEnvelope = assembleProductionRuntimePolicy(runtimePolicy, authoritySet,
      runtimePolicyApprovals);
    const runtimePolicyPath = join(values.root, "production-runtime-policy.json");
    writeFileSync(runtimePolicyPath, `${canonicalJson(runtimePolicyEnvelope)}\n`);
    const runtimeTrustArguments = [runtimePolicyPath, runtimePolicy.policyHash, "1"];
    const signedPath = join(values.root, "wallet-signed.json");
    writeFileSync(signedPath, `${JSON.stringify(signedRelease, null, 2)}\n`);
    const vault = join(values.root, "wallet.nir");
    createWalletFile({ path: vault, password: "production-wallet-password" });
    const toolGeneration = join(values.root, readlinkSync(toolInstallation));
    const extensionCli = join(toolGeneration, "blockchain/production-wallet-extension-cli.mjs");
    const extensionTarget = join(values.root, "browser-extension");
    const extensionTrustArguments = [installation, head, signedPath, values.signer.address,
      anchorPath, toolInstallation, toolHead, toolAnchorPath, ...runtimeTrustArguments];
    const extensionInstall = spawnSync(process.execPath,
      [extensionCli, "install", ...extensionTrustArguments, extensionTarget], { encoding: "utf8" });
    assert.equal(extensionInstall.status, 0, extensionInstall.stderr);
    const launchRecord = JSON.parse(extensionInstall.stdout);
    assert.equal(launchRecord.packageHash, packageValue.packageHash);
    assert.equal(launchRecord.extensionPath, realpathSync(extensionTarget));
    const extensionVerify = spawnSync(process.execPath,
      [extensionCli, "verify-launch", ...extensionTrustArguments, extensionTarget],
      { encoding: "utf8" });
    assert.equal(extensionVerify.status, 0, extensionVerify.stderr);
    const sourceExtensionCli = new URL(
      "../blockchain/production-wallet-extension-cli.mjs", import.meta.url,
    ).pathname;
    const externalExtension = spawnSync(process.execPath,
      [sourceExtensionCli, "verify-launch", ...extensionTrustArguments, extensionTarget],
      { encoding: "utf8" });
    assert.equal(externalExtension.status, 1);

    const occupiedExtensionTarget = join(values.root, "occupied-extension");
    mkdirSync(occupiedExtensionTarget); writeFileSync(join(occupiedExtensionTarget, "foreign"), "keep\n");
    const occupiedInstall = spawnSync(process.execPath,
      [extensionCli, "install", ...extensionTrustArguments, occupiedExtensionTarget],
      { encoding: "utf8" });
    assert.equal(occupiedInstall.status, 1);
    assert.equal(readFileSync(join(occupiedExtensionTarget, "foreign"), "utf8"), "keep\n");
    const rollbackExtensionTarget = join(values.root, "rollback-extension");
    const rollbackUpdate = spawnSync(process.execPath, [extensionCli, "update",
      ...extensionTrustArguments, extensionTarget, signedPath, packageValue.packageHash,
      rollbackExtensionTarget], { encoding: "utf8" });
    assert.equal(rollbackUpdate.status, 1);
    assert.equal(existsSync(rollbackExtensionTarget), false);

    const extensionGeneration = launchRecord.extensionPath;
    writeFileSync(join(extensionGeneration, "unexpected.js"), "throw new Error('extra');\n");
    const extraVerify = spawnSync(process.execPath,
      [extensionCli, "verify-launch", ...extensionTrustArguments, extensionTarget],
      { encoding: "utf8" });
    assert.equal(extraVerify.status, 1); unlinkSync(join(extensionGeneration, "unexpected.js"));
    const installedApp = join(extensionGeneration, "app.js");
    const installedAppBytes = readFileSync(installedApp); unlinkSync(installedApp);
    symlinkSync(join(values.root, "wallet-ui", "app.js"), installedApp);
    const symlinkVerify = spawnSync(process.execPath,
      [extensionCli, "verify-launch", ...extensionTrustArguments, extensionTarget],
      { encoding: "utf8" });
    assert.equal(symlinkVerify.status, 1); unlinkSync(installedApp);
    writeFileSync(installedApp, installedAppBytes, { mode: 0o644 });
    writeFileSync(installedApp, "throw new Error('tampered extension');\n");
    const tamperedExtension = spawnSync(process.execPath,
      [extensionCli, "verify-launch", ...extensionTrustArguments, extensionTarget],
      { encoding: "utf8" });
    assert.equal(tamperedExtension.status, 1);
    writeFileSync(installedApp, installedAppBytes, { mode: 0o644 });

    const cli = join(toolGeneration, "blockchain/wallet-bridge-cli.mjs");
    const origin = "http://127.0.0.1:8765";
    for (let restart = 0; restart < 2; restart += 1) {
      const port = await unusedPort();
      child = spawn(process.execPath, [cli, "--production", installation, head, signedPath,
        values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
        ...runtimeTrustArguments, vault, String(port), origin],
      { stdio: ["ignore", "pipe", "pipe"] });
      await waitForOutput(child, /Listening only/);
      assert.equal(await fetch(`http://127.0.0.1:${port}/v1/wallet`).then((response) => response.status), 403);
      await stopChild(child); child = null;
    }

    const uiCli = join(toolGeneration, "blockchain/wallet-ui-cli.mjs");
    const appEntry = walletArtifact.entries.find(({ path }) => path === "wallet-ui/app.js");
    const walletGeneration = join(values.root, readlinkSync(installation));
    const walletProvenancePath = join(walletGeneration, "NIR-PRODUCTION.json");
    const originalWalletProvenance = readFileSync(walletProvenancePath);
    const staleRuntimePort = await unusedPort();
    const staleRuntime = spawnSync(process.execPath, [uiCli, installation, head, signedPath,
      values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      runtimePolicyPath, "f".repeat(64), "1", String(staleRuntimePort), "127.0.0.1"],
    { encoding: "utf8" });
    assert.equal(staleRuntime.status, 1); assert.match(staleRuntime.stderr, /runtime policy|startup failed/i);
    const staleRuntimeReservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      staleRuntimeReservation.once("error", reject);
      staleRuntimeReservation.listen(staleRuntimePort, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => staleRuntimeReservation.close(resolvePromise));
    for (let restart = 0; restart < 2; restart += 1) {
      const port = await unusedPort();
      child = spawn(process.execPath, [uiCli, installation, head, signedPath,
        values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
        ...runtimeTrustArguments, String(port), "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
      await waitForOutput(child, /Listening only/);
      const originUrl = `http://127.0.0.1:${port}`;
      const shell = await fetch(`${originUrl}/`);
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.doesNotMatch(shell.headers.get("content-security-policy"), /localhost/);
      assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
      assert.equal(shell.headers.get("cache-control"), "no-store");
      assert.match(await shell.text(), /NIR Wallet/);
      const immutable = await fetch(`${originUrl}/app.js?v=${appEntry.sha3_256}`);
      assert.equal(immutable.status, 200);
      assert.equal(immutable.headers.get("cache-control"),
        "public, max-age=31536000, immutable");
      assert.deepEqual(Buffer.from(await immutable.arrayBuffer()),
        Buffer.from(appEntry.content, "base64"));
      assert.equal((await fetch(`${originUrl}/app.js?v=31`)).headers.get("cache-control"),
        "no-store");
      assert.equal((await fetch(`${originUrl}/..%2fpackage.json`)).status, 400);
      assert.equal((await fetch(`${originUrl}/app.js`, { headers: { range: "bytes=0-1" } })).status,
        416);
      assert.equal((await fetch(`${originUrl}/app.js`, {
        body: "x".repeat(64 * 1024), method: "POST",
      })).status, 413);
      assert.equal(await rawHttpStatus(port, "/", { headers: { host: `evil.invalid:${port}` } }),
        421);
      assert.equal(await rawHttpStatus(port, "/", {
        headers: { origin: "https://evil.invalid" },
      }), 403);
      assert.equal(await rawHttpStatus(port, "/NIR-PRODUCTION.json"), 404);
      assert.equal(await rawHttpStatus(port, "/", {
        headers: { "content-length": "1", expect: "100-continue" }, method: "POST",
      }), 417);
      for (let index = 0; index < 32; index += 1) {
        const hostilePath = index % 4 === 0 ? `/..%2f${index}`
          : index % 4 === 1 ? `//${index}`
          : index % 4 === 2 ? `/%${index.toString(16).padStart(2, "0")}`
          : `/app.js?v=${"a".repeat(64)}&duplicate=${index}`;
        assert.notEqual(await rawHttpStatus(port, hostilePath), 200);
      }
      if (restart === 0) {
        const changed = JSON.parse(originalWalletProvenance.toString("utf8"));
        changed.packageHash = "e".repeat(64);
        writeFileSync(walletProvenancePath, `${canonicalJson(changed)}\n`);
        assert.equal((await fetch(`${originUrl}/`)).status, 400);
        writeFileSync(walletProvenancePath, originalWalletProvenance);
        assert.equal((await fetch(`${originUrl}/`)).status, 200);
      }
      await stopChild(child); child = null;
    }
    const ipv6Port = await unusedPort("::1");
    child = spawn(process.execPath, [uiCli, installation, head, signedPath,
      values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      ...runtimeTrustArguments, String(ipv6Port), "::1"], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForOutput(child, /Listening only/);
    assert.equal((await fetch(`http://[::1]:${ipv6Port}/`)).status, 200);
    await stopChild(child); child = null;
    const sourceUiCli = new URL("../blockchain/wallet-ui-cli.mjs", import.meta.url).pathname;
    const sourceUiPort = await unusedPort();
    const externalUi = spawnSync(process.execPath, [sourceUiCli, installation, head, signedPath,
      values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      ...runtimeTrustArguments, String(sourceUiPort), "127.0.0.1"], { encoding: "utf8" });
    assert.equal(externalUi.status, 1);
    assert.match(externalUi.stderr, /Wallet UI startup failed/);
    const sourceUiReservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      sourceUiReservation.once("error", reject);
      sourceUiReservation.listen(sourceUiPort, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => sourceUiReservation.close(resolvePromise));
    const nonLoopbackPort = await unusedPort();
    const nonLoopback = spawnSync(process.execPath, [uiCli, installation, head, signedPath,
      values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      ...runtimeTrustArguments, String(nonLoopbackPort), "0.0.0.0"], { encoding: "utf8" });
    assert.equal(nonLoopback.status, 1);
    const nonLoopbackReservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      nonLoopbackReservation.once("error", reject);
      nonLoopbackReservation.listen(nonLoopbackPort, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => nonLoopbackReservation.close(resolvePromise));
    const occupied = createNetServer();
    await new Promise((resolvePromise, reject) => {
      occupied.once("error", reject); occupied.listen(0, "127.0.0.1", resolvePromise);
    });
    const occupiedPort = occupied.address().port;
    const portRace = spawnSync(process.execPath, [uiCli, installation, head, signedPath,
      values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      ...runtimeTrustArguments, String(occupiedPort), "127.0.0.1"], { encoding: "utf8" });
    assert.equal(portRace.status, 1);
    assert.match(portRace.stderr, /loopback listener is unavailable/);
    assert.doesNotMatch(portRace.stderr, /node:internal|\/Users\//);
    assert.equal(occupied.listening, true);
    await new Promise((resolvePromise) => occupied.close(resolvePromise));

    const sourceCli = new URL("../blockchain/wallet-bridge-cli.mjs", import.meta.url).pathname;
    const substitutedPort = await unusedPort();
    const substituted = spawnSync(process.execPath, [sourceCli, "--production", installation, head,
      signedPath, values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      ...runtimeTrustArguments, vault, String(substitutedPort), origin], { encoding: "utf8" });
    assert.equal(substituted.status, 1);
    assert.match(substituted.stderr, /Wallet bridge failed/);
    const substitutedReservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      substitutedReservation.once("error", reject);
      substitutedReservation.listen(substitutedPort, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => substitutedReservation.close(resolvePromise));

    const oldToolPackage = createProductionReleasePackage(values.artifact, { now: NOW,
      productionReport: values.productionReport, productionTarget: values.productionTarget,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const oldToolInstallation = join(values.root, "old-bridge-tool");
    installProductionReleasePackage(oldToolPackage, oldToolInstallation, { kind: "node", now: NOW,
      signedRelease: values.signedRelease, trustedAddress: values.signer.address });
    const oldToolHead = join(values.root, "old-bridge-tool-head");
    advanceProductionHead(oldToolHead, oldToolInstallation, { kind: "node",
      newPackageHash: oldToolPackage.packageHash, signedRelease: values.signedRelease,
      trustedAddress: values.signer.address });
    const oldToolAnchorPath = join(values.root, "old-bridge-tool-anchor.json");
    writeFileSync(oldToolAnchorPath,
      `${canonicalJson(exportProductionHeadAnchor(oldToolHead))}\n`);
    const staleExtension = spawnSync(process.execPath, [extensionCli, "verify-launch",
      installation, head, signedPath, values.signer.address, anchorPath, toolInstallation,
      toolHead, oldToolAnchorPath, ...runtimeTrustArguments, extensionTarget], { encoding: "utf8" });
    assert.equal(staleExtension.status, 1);
    const rollbackPort = await unusedPort();
    const rollbackBlocked = spawnSync(process.execPath, [uiCli, installation, head, signedPath,
      values.signer.address, anchorPath, toolInstallation, toolHead, oldToolAnchorPath,
      ...runtimeTrustArguments, String(rollbackPort), "127.0.0.1"], { encoding: "utf8" });
    assert.equal(rollbackBlocked.status, 1);
    assert.match(rollbackBlocked.stderr, /Wallet UI startup failed/);
    const rollbackReservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      rollbackReservation.once("error", reject);
      rollbackReservation.listen(rollbackPort, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => rollbackReservation.close(resolvePromise));
    assert.throws(() => createWalletBridgeProductionGuard({
      moduleUrl: pathToFileURL(join(values.root, readlinkSync(oldToolInstallation),
        "blockchain/node.mjs")).href,
      signedReleasePath: signedPath, toolExternalAnchorPath: oldToolAnchorPath,
      toolHeadStore: oldToolHead, toolInstallationTarget: oldToolInstallation,
      trustedAddress: values.signer.address, walletExternalAnchorPath: anchorPath,
      walletHeadStore: head, walletInstallationTarget: installation,
    }), /release|manifest|artifact|contents/);

    const startupGuard = createWalletBridgeProductionGuard({
      moduleUrl: pathToFileURL(cli).href, signedReleasePath: signedPath,
      toolExternalAnchorPath: toolAnchorPath, toolHeadStore: toolHead,
      toolInstallationTarget: toolInstallation, trustedAddress: values.signer.address,
      walletExternalAnchorPath: anchorPath, walletHeadStore: head,
      walletInstallationTarget: installation,
    });

    const generation = join(values.root, readlinkSync(installation));
    const provenancePath = join(generation, "NIR-PRODUCTION.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    provenance.packageHash = "f".repeat(64);
    writeFileSync(provenancePath, `${canonicalJson(provenance)}\n`);
    const blockedPort = await unusedPort();
    const blocked = spawnSync(process.execPath, [cli, "--production", installation, head,
      signedPath, values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      ...runtimeTrustArguments, vault, String(blockedPort), origin],
    { encoding: "utf8" });
    assert.equal(blocked.status, 1); assert.match(blocked.stderr, /Wallet bridge failed/);
    const blockedUiPort = await unusedPort();
    const blockedUi = spawnSync(process.execPath, [uiCli, installation, head, signedPath,
      values.signer.address, anchorPath, toolInstallation, toolHead, toolAnchorPath,
      ...runtimeTrustArguments, String(blockedUiPort), "127.0.0.1"], { encoding: "utf8" });
    assert.equal(blockedUi.status, 1); assert.match(blockedUi.stderr, /Wallet UI startup failed/);
    const reservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      reservation.once("error", reject);
      reservation.listen(blockedPort, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => reservation.close(resolvePromise));
    const uiReservation = createNetServer();
    await new Promise((resolvePromise, reject) => {
      uiReservation.once("error", reject);
      uiReservation.listen(blockedUiPort, "127.0.0.1", resolvePromise);
    });
    await new Promise((resolvePromise) => uiReservation.close(resolvePromise));
    writeFileSync(cli, "throw new Error('substituted bridge executable');\n");
    assert.throws(() => startupGuard.verifyBeforeOpen(), /contents differ|artifact/);
  } finally {
    if (child !== null) await stopChild(child);
    rmSync(values.root, { force: true, recursive: true });
  }
});
