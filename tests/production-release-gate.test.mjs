import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  writeProductionPackageExclusive,
} from "../blockchain/production-release-gate.mjs";
import { artifactPaths, createReleaseArtifact } from "../blockchain/release-artifact.mjs";
import { createReleaseManifest, signReleaseManifest } from "../blockchain/release-manifest.mjs";
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

function productionEvidence(root, manifest) {
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
  const store = join(root, "attestation-store");
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
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});
