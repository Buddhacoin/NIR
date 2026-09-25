import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { multisigAddress } from "../blockchain/chain.mjs";
import {
  MIN_EVALUATOR_BOND, PROTOCOL_VERSION, TREASURY_BPS, TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { canonicalJson, generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import {
  runDeveloperTestnetPreflight, serializeDeveloperTestnetPreflightReport,
  validateDeveloperTestnetPreflightReport,
} from "../blockchain/developer-testnet-preflight.mjs";
import { runDeveloperTestnetProductionPreflightFromFiles } from "../blockchain/developer-testnet-production-preflight-files.mjs";
import { validateDeveloperTestnetProductionPreflightReport } from "../blockchain/developer-testnet-production-preflight.mjs";
import {
  compileGenesis, createGenesisApprovalEnvelope, createGenesisPlan, signGenesisPlan,
  signGenesisPeerRegistry,
} from "../blockchain/genesis-ceremony.mjs";
import { createOfflineReleaseBundle } from "../blockchain/offline-release-bundle.mjs";
import {
  appendReleaseTransparencyEntry, approveReleaseLogProposal, contextForReleaseLog,
  createReleaseAuthoritySet, createReleaseProposal, createReleaseTransparencyAnchor,
  loadReleaseTransparencyLog,
} from "../blockchain/offline-release-governance.mjs";
import {
  createReleaseWitnessReceipt, createReleaseWitnessSet,
} from "../blockchain/offline-release-witness.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import {
  acceptRehearsalAttestationQuorum, createRehearsalAttestorSet, signRehearsalStatement,
} from "../blockchain/rehearsal-attestation.mjs";
import { createTestnetPartitionDrillPlan } from "../blockchain/testnet-partition-drill.mjs";

const NOW = 2_000_000_000_000;
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }

function role(wallets, prefix, port) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), endpoint: `https://127.0.0.1:${port + index}`,
    operatorId: `${prefix}-${index}`,
  }));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-preflight-"));
  const networkId = "nir-public-preflight-devnet";
  const releaseSigner = generateWallet();
  const sourcePayload = {
    files: [{ executable: false, path: "package.json", sha3_256: digest("package"), size: 7 }],
    format: "nir-source-release-v1", releaseVersion: "0.9.0",
    sourceRevision: "a".repeat(64),
  };
  const sourceManifest = { ...sourcePayload,
    manifestHash: hashObject(sourcePayload, "RELEASE_MANIFEST_HASH") };
  const signedRelease = signReleaseManifest(sourceManifest, releaseSigner);

  const source = join(root, "release-source"); mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "payload.txt"), "public developer release\n", { mode: 0o600 });
  const authorities = Array.from({ length: 3 }, generateWallet);
  const authoritySet = createReleaseAuthoritySet({
    authorities: authorities.map((wallet, index) => ({
      ...publicWallet(wallet), operatorId: `release-${index}`,
    })), generation: 1, rotationDelayEntries: 2, threshold: 2,
  });
  const releaseAnchor = createReleaseTransparencyAnchor({
    initialSet: authoritySet, logId: "developer-release-log", networkId,
  });
  const releaseBundle = createOfflineReleaseBundle(source, ["payload.txt"], {
    networkId, previousBundleHash: null, protocolVersion: PROTOCOL_VERSION,
    releaseVersion: "0.9.0", sourceRevision: "b".repeat(40),
  });
  const log = join(root, "release-log"); const checkpoints = join(root, "release-checkpoints");
  mkdirSync(log, { mode: 0o700 }); mkdirSync(checkpoints, { mode: 0o700 });
  const state = loadReleaseTransparencyLog(releaseAnchor, log, checkpoints);
  const proposal = createReleaseProposal({ anchor: releaseAnchor, bundle: releaseBundle, state });
  const governanceContext = contextForReleaseLog(releaseAnchor, state);
  const approvals = authorities.slice(0, 2).map((wallet, index) =>
    approveReleaseLogProposal(proposal, governanceContext,
      { operatorId: `release-${index}`, wallet }));
  const releaseCheckpoint = appendReleaseTransparencyEntry({
    anchor: releaseAnchor, approvals, checkpointDirectory: checkpoints, logDirectory: log, proposal,
  }).checkpoint;
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const witnessSet = createReleaseWitnessSet({ threshold: 3,
    witnesses: witnesses.map((wallet, index) => ({
      ...publicWallet(wallet), operatorId: `witness-${index}`,
    })) });
  const witnessReceipts = witnesses.slice(0, 3).map((wallet, index) =>
    createReleaseWitnessReceipt({ anchor: releaseAnchor, checkpoint: releaseCheckpoint,
      observedAt: NOW, operatorId: `witness-${index}`, wallet, witnessSet }));
  rmSync(source, { recursive: true });
  rmSync(log, { recursive: true });
  rmSync(checkpoints, { recursive: true });

  const validators = Array.from({ length: 4 }, generateWallet);
  const transports = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const ceremony = Array.from({ length: 4 }, generateWallet);
  const guardians = Array.from({ length: 3 }, generateWallet);
  const releaseOptions = { signedRelease, trustedAddress: releaseSigner.address };
  const input = {
    beaconAuthorities: role(beacons, "beacon", 9300),
    ceremonyOperators: ceremony.map((wallet, index) => ({
      ...publicWallet(wallet), contribution: digest(`contribution-${index}`),
      nonce: digest(`nonce-${index}`), operatorId: `ceremony-${index}`,
    })),
    evaluators: role(evaluators, "evaluator", 9200),
    evaluatorBondAmount: MIN_EVALUATOR_BOND.toString(), genesisTimestamp: 0, networkId,
    protocolVersion: PROTOCOL_VERSION, sourceReleaseManifestHash: sourceManifest.manifestHash,
    protocolUpgradeReleaseAnchor: releaseAnchor,
    treasury: {
      address: multisigAddress(guardians.map(({ publicKey }) => publicKey), 2),
      algorithm: "ml-dsa-65-multisig", memberPublicKeys: guardians.map(({ publicKey }) => publicKey),
      threshold: 2, vestingPolicy: { allocationBps: Number(TREASURY_BPS),
        durationMs: TREASURY_VESTING_MS, model: "linear-from-genesis" },
    },
    validators: validators.map((wallet, index) => ({
      ...publicWallet(wallet), endpoint: `https://127.0.0.1:${9100 + index}`,
      operatorId: `validator-${index}`, tlsCertificateSha256: digest(`validator-tls-${index}`),
      transport: publicWallet(transports[index]),
    })),
  };
  const genesisPlan = createGenesisPlan(input, releaseOptions);
  const genesisEnvelope = createGenesisApprovalEnvelope(genesisPlan,
    ceremony.slice(0, 3).map((wallet) => signGenesisPlan(genesisPlan, wallet, releaseOptions)),
    validators.slice(0, 3).map((wallet) => signGenesisPeerRegistry(
      genesisPlan, wallet, releaseOptions)), releaseOptions);
  const { genesis, genesisHash } = compileGenesis(genesisPlan, genesisEnvelope, releaseOptions);
  const archives = Array.from({ length: 2 }, generateWallet);
  const backupDrill = {
    checkpointHash: "1".repeat(64), completedAt: NOW - 1_000,
    downloadedFrom: "https://backup-a.invalid", format: "nir-backup-restore-drill-v1",
    height: 10, inventoryRoot: "2".repeat(64), networkId, privateKeysIncluded: false,
    sources: ["https://backup-a.invalid", "https://backup-b.invalid"],
    stateRoot: "3".repeat(64), tipHash: "4".repeat(64), workspace: "/isolated/drill",
  };
  const artifacts = {
    backupDrill: "backup-drill.json", genesis: "genesis.json",
    genesisEnvelope: "genesis-envelope.json", genesisPlan: "genesis-plan.json",
    releaseAnchor: "release-anchor.json", releaseBundle: "release-bundle.json",
    releaseCheckpoint: "release-checkpoint.json", signedRelease: "signed-release.json",
    witnessReceipts: "witness-receipts.json", witnessSet: "witness-set.json",
  };
  const values = { backupDrill, genesis, genesisEnvelope, genesisPlan, releaseAnchor, releaseBundle,
    releaseCheckpoint, signedRelease, witnessReceipts, witnessSet };
  for (const [key, name] of Object.entries(artifacts)) writeJson(join(root, name), values[key]);
  writeJson(join(root, "public-operator-config.json"), { networkId, publicOnly: true });
  const archiveOperators = archives.map((wallet, index) => ({
    ...publicWallet(wallet), endpoint: `https://127.0.0.1:${9400 + index}`,
    operatorId: `archive-${index}`,
  }));
  const endpointRecords = [
    ...genesisPlan.validators.map((entry) => ({ endpoint: entry.endpoint, role: "validator",
      tlsCertificateSha256: entry.tlsCertificateSha256 })),
    ...genesisPlan.beaconAuthorities.map((entry, index) => ({ endpoint: entry.endpoint,
      role: "beacon", tlsCertificateSha256: digest(`beacon-tls-${index}`) })),
    ...genesisPlan.evaluators.map((entry, index) => ({ endpoint: entry.endpoint,
      role: "evaluator", tlsCertificateSha256: digest(`evaluator-tls-${index}`) })),
    ...archiveOperators.map((entry, index) => ({ endpoint: entry.endpoint,
      role: "archive", tlsCertificateSha256: digest(`archive-tls-${index}`) })),
  ].sort((left, right) => left.endpoint.localeCompare(right.endpoint));
  const preflight = {
    archiveOperators, artifacts,
    bondedValidators: validators.map((wallet) => ({
      address: wallet.address, bondAtomic: "1000000000",
    })),
    format: "nir-developer-testnet-preflight-v1",
    host: {
      clockOffsetMs: 100, diskFreeBytes: 20_000_000_000, fileDescriptorLimit: 4096,
      ingressProfiles: ["validator", "beacon", "evaluator", "archive"].map((role) => ({
        bodyIdleTimeoutMs: 5_000, maxBodyBytes: role === "validator" ? 2_097_152 : 65_536,
        maxConnections: 64, maxHeaderBytes: 16_384, maxUrlBytes: 2_048,
        requestTimeoutMs: 10_000, role,
      })),
      observedAt: NOW,
      ports: endpointRecords.map(({ endpoint, role }) => ({
        available: true, host: new URL(endpoint).hostname, port: Number(new URL(endpoint).port), role,
      })),
      tlsEndpoints: endpointRecords,
    },
    networkId, operatorRoots: ["public-operator-config.json"],
    policy: { maxClockOffsetMs: 1_000, maxDrillAgeMs: 60_000, maxFutureSkewMs: 1_000,
      maxWitnessAgeMs: 60_000, minDiskFreeBytes: 1_000_000_000, minFileDescriptors: 1024 },
    release: { anchorHash: releaseAnchor.anchorHash, bundleHash: releaseBundle.bundleHash,
      checkpointHash: releaseCheckpoint.checkpointHash,
      sourceManifestHash: sourceManifest.manifestHash, trustedSignerAddress: releaseSigner.address,
      witnessSetId: witnessSet.witnessSetId },
    version: 1,
  };
  writeJson(join(root, "preflight.json"), preflight);
  return { archives, artifacts, beacons, genesisHash, preflight, root, sourceManifest,
    values, validators };
}

function rewrite(values, mutate) {
  const next = structuredClone(values.preflight); mutate(next);
  writeJson(join(values.root, "preflight.json"), next); values.preflight = next;
}

function check(report, id) { return report.checks.find((entry) => entry.id === id); }

test("public developer-testnet preflight emits deterministic signed-free PASS JSON", () => {
  const values = fixture();
  try {
    const first = runDeveloperTestnetPreflight(values.root);
    const second = runDeveloperTestnetPreflight(values.root);
    assert.deepEqual(second, first);
    assert.equal(first.summary.status, "PASS");
    assert.equal(first.summary.failed, 0);
    const serialized = serializeDeveloperTestnetPreflightReport(first);
    assert.equal(serialized.includes("signature"), false);
    assert.equal(serialized.includes("privateKey"), false);
    assert.deepEqual(validateDeveloperTestnetPreflightReport(first), first);
    assert.throws(() => validateDeveloperTestnetPreflightReport({
      ...first, observedAt: first.observedAt + 1,
    }), /hash/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("duplicate cross-role keys and unbonded validators fail without stopping other checks", () => {
  const values = fixture();
  try {
    rewrite(values, (input) => {
      const endpoint = input.archiveOperators[0].endpoint;
      input.archiveOperators[0] = {
        ...values.values.genesisPlan.beaconAuthorities[0], endpoint,
      };
      input.bondedValidators[0].bondAtomic = "999999999";
    });
    const report = runDeveloperTestnetPreflight(values.root);
    assert.equal(report.summary.status, "FAIL");
    assert.equal(check(report, "role-and-key-separation").status, "FAIL");
    assert.equal(check(report, "bonded-validator-eligibility").status, "FAIL");
    assert.equal(check(report, "genesis").status, "PASS");
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("stale drill, wrong network/release, and missing external witness quorum fail closed", () => {
  const values = fixture();
  try {
    writeJson(join(values.root, values.artifacts.backupDrill), {
      ...values.values.backupDrill, completedAt: NOW - 60_001,
    });
    writeJson(join(values.root, values.artifacts.witnessReceipts),
      values.values.witnessReceipts.slice(0, 2));
    rewrite(values, (input) => {
      input.networkId = "nir-wrong-public-devnet";
      input.release.bundleHash = `sha3-256:${"f".repeat(64)}`;
    });
    const report = runDeveloperTestnetPreflight(values.root);
    assert.equal(check(report, "backup-restore-freshness").status, "FAIL");
    assert.equal(check(report, "external-witness-quorum").status, "FAIL");
    assert.equal(check(report, "release").status, "FAIL");
    assert.equal(check(report, "genesis").status, "FAIL");
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("symlink artifacts, unsafe paths, and root replacement are rejected", () => {
  const linked = fixture();
  try {
    const target = join(linked.root, linked.artifacts.backupDrill);
    rmSync(target); symlinkSync("genesis.json", target);
    assert.equal(check(runDeveloperTestnetPreflight(linked.root),
      "backup-restore-freshness").status, "FAIL");
  } finally { rmSync(linked.root, { recursive: true, force: true }); }

  const unsafe = fixture();
  try {
    rewrite(unsafe, (input) => { input.artifacts.genesis = "../genesis.json"; });
    assert.throws(() => runDeveloperTestnetPreflight(unsafe.root), /path is unsafe/);
  } finally { rmSync(unsafe.root, { recursive: true, force: true }); }

  const swapped = fixture();
  const moved = `${swapped.root}-moved`;
  try {
    let done = false;
    assert.throws(() => runDeveloperTestnetPreflight(swapped.root, {
      _afterFileOpen: ({ name }) => {
        if (!done && name === "preflight.json") {
          done = true; renameSync(swapped.root, moved); mkdirSync(swapped.root, { mode: 0o700 });
          writeJson(join(swapped.root, "preflight.json"), swapped.preflight);
        }
      },
    }), /root changed/);
  } finally {
    rmSync(swapped.root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test("unsafe host snapshot and plaintext operator artifact produce explicit FAIL checks", () => {
  const values = fixture();
  try {
    rewrite(values, (input) => {
      input.host.ports[1].available = false;
      input.host.ingressProfiles[0].maxBodyBytes = 10_000_000;
    });
    writeJson(join(values.root, "public-operator-config.json"), { privateKey: "plaintext" });
    const report = runDeveloperTestnetPreflight(values.root);
    assert.equal(check(report, "host-readiness").status, "FAIL");
    assert.equal(check(report, "public-artifact-scan").status, "FAIL");
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("missing TLS pin and incomplete exact endpoint port coverage cannot PASS", () => {
  const values = fixture();
  try {
    rewrite(values, (input) => {
      const validatorTls = input.host.tlsEndpoints.find(({ role }) => role === "validator");
      validatorTls.tlsCertificateSha256 = null;
      input.host.ports.pop();
    });
    const report = runDeveloperTestnetPreflight(values.root);
    assert.equal(check(report, "host-readiness").status, "FAIL");
    assert.equal(report.summary.status, "FAIL");
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

function publicIdentity(wallet, operatorId) { return { ...publicWallet(wallet), operatorId }; }

function productionFixture() {
  const developer = fixture(); const externalRoot = mkdtempSync(join(tmpdir(), "nir-production-flow-"));
  const developerReport = runDeveloperTestnetPreflight(developer.root);
  const topology = {
    archives: developer.archives.map((wallet, index) => publicIdentity(wallet, `archive-${index}`)),
    beacons: developer.beacons.map((wallet, index) => publicIdentity(wallet, `beacon-${index}`)),
    certificateRotation: { newPin: "8".repeat(64), oldPin: "9".repeat(64),
      overlapEndHeight: 20, overlapStartHeight: 10,
      validator: developer.validators[0].address },
    format: "nir-testnet-drill-topology-v1", networkId: developer.preflight.networkId,
    releaseCheckpointHash: developer.values.releaseCheckpoint.checkpointHash,
    validators: developer.validators.map((wallet, index) => publicIdentity(wallet, `validator-${index}`)),
    version: 1,
  };
  const plan = createTestnetPartitionDrillPlan(developerReport, topology);
  const attestors = Array.from({ length: 4 }, generateWallet);
  const operatorSet = createRehearsalAttestorSet({ threshold: 3,
    operators: attestors.map((wallet, index) => publicIdentity(wallet, `reviewer-${index}`)) });
  const statement = { drillPlanHash: plan.planHash, expiresAt: NOW + 60_000,
    format: "nir-rehearsal-attestation-v1", genesisHash: developer.genesisHash,
    networkId: developer.preflight.networkId, observedAt: NOW,
    releaseCheckpointHash: developer.values.releaseCheckpoint.checkpointHash,
    releaseManifestHash: developer.sourceManifest.manifestHash,
    reportHash: `sha3-256:${"a".repeat(64)}`, runNonce: "b".repeat(64),
    setId: operatorSet.setId, validatorTip: developer.values.backupDrill.tipHash, version: 1 };
  const attestations = attestors.slice(0, 3).map((wallet, index) =>
    signRehearsalStatement(statement, { operatorId: `reviewer-${index}`, wallet }, operatorSet));
  const storePath = join(externalRoot, "store");
  const accepted = acceptRehearsalAttestationQuorum(storePath, attestations,
    { now: NOW, operatorSet });
  const paths = { attestationInputPath: join(externalRoot, "attestation-input.json"),
    drillPlanPath: join(externalRoot, "drill-plan.json"),
    operatorSetPath: join(externalRoot, "operator-set.json"), storePath };
  writeFileSync(paths.attestationInputPath, `${canonicalJson(accepted.preflightInput)}\n`, { mode: 0o600 });
  writeFileSync(paths.drillPlanPath, `${canonicalJson(plan)}\n`, { mode: 0o600 });
  writeFileSync(paths.operatorSetPath, `${canonicalJson(operatorSet)}\n`, { mode: 0o600 });
  return { developer, externalRoot, paths };
}

function productionRun(values, changes = {}, options = {}) {
  return runDeveloperTestnetProductionPreflightFromFiles({
    attestationInputPath: values.paths.attestationInputPath,
    attestationStorePath: values.paths.storePath, developerRoot: values.developer.root,
    drillPlanPath: values.paths.drillPlanPath, maxFutureSkewMs: 1_000, now: NOW,
    operatorSetPath: values.paths.operatorSetPath, ...changes,
  }, options);
}

function cleanupProduction(values) {
  rmSync(values.developer.root, { force: true, recursive: true });
  rmSync(values.externalRoot, { force: true, recursive: true });
}

test("explicit production filesystem flow and CLI require exact external evidence", () => {
  const values = productionFixture();
  try {
    const report = productionRun(values);
    assert.equal(report.readiness, "EXTERNAL-EVIDENCE-PASS");
    assert.deepEqual(validateDeveloperTestnetProductionPreflightReport(report), report);
    const productionCli = spawnSync(process.execPath,
      ["blockchain/developer-testnet-preflight-cli.mjs", "production", values.developer.root,
        values.paths.drillPlanPath, values.paths.attestationInputPath, values.paths.operatorSetPath,
        values.paths.storePath, String(NOW), "1000"], {
        cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      });
    assert.equal(productionCli.status, 0);
    assert.equal(JSON.parse(productionCli.stdout).readiness, "EXTERNAL-EVIDENCE-PASS");
    assert.equal(productionCli.stderr, "");
    const developerCli = spawnSync(process.execPath,
      ["blockchain/developer-testnet-preflight-cli.mjs", values.developer.root], {
        cwd: new URL("..", import.meta.url), encoding: "utf8",
      });
    assert.equal(developerCli.status, 0);
    assert.equal(JSON.parse(developerCli.stdout).format, "nir-developer-testnet-preflight-report-v1");
  } finally { cleanupProduction(values); }
});

test("missing, symlinked, stale, and TOCTOU-swapped production inputs are explicit pathless FAIL", () => {
  const missing = productionFixture();
  try {
    const absent = join(missing.externalRoot, "missing.json");
    const report = productionRun(missing, { attestationInputPath: absent });
    assert.equal(report.summary.status, "FAIL");
    assert.equal(check(report, "external-operator-attestation").status, "FAIL");
    assert.equal(canonicalJson(report).includes(absent), false);
    const cli = spawnSync(process.execPath,
      ["blockchain/developer-testnet-preflight-cli.mjs", "production", missing.developer.root,
        missing.paths.drillPlanPath, absent, missing.paths.operatorSetPath, missing.paths.storePath,
        String(NOW)], { cwd: new URL("..", import.meta.url), encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024 });
    assert.equal(cli.status, 2); assert.equal(cli.stderr, "");
    const linked = join(missing.externalRoot, "linked-input.json");
    symlinkSync(missing.paths.attestationInputPath, linked);
    const linkedReport = productionRun(missing, { attestationInputPath: linked });
    assert.equal(check(linkedReport, "external-operator-attestation").status, "FAIL");
  } finally { cleanupProduction(missing); }

  const raced = productionFixture(); const original = `${raced.paths.attestationInputPath}.original`;
  try {
    const stale = productionRun(raced, { now: NOW + 60_001 });
    assert.equal(check(stale, "external-operator-attestation").status, "FAIL");
    let swapped = false;
    const report = productionRun(raced, {}, { _afterFileOpen: ({ kind, path }) => {
      if (!swapped && kind === "attestation-input") {
        swapped = true; renameSync(path, original); writeFileSync(path, "{}\n", { mode: 0o600 });
      }
    } });
    assert.equal(check(report, "external-operator-attestation").status, "FAIL");
  } finally { cleanupProduction(raced); }
});
