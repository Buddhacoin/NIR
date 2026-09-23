import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
