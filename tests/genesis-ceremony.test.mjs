import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NirChain, multisigAddress } from "../blockchain/chain.mjs";
import {
  MIN_EVALUATOR_BOND,
  PROTOCOL_VERSION,
  TREASURY_BPS,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import { createPeerAnnouncement, verifyPeerAnnouncement } from "../blockchain/peer-discovery.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import {
  createReleaseAuthoritySet, createReleaseTransparencyAnchor,
} from "../blockchain/offline-release-governance.mjs";
import {
  compileGenesis,
  createGenesisApprovalEnvelope,
  createGenesisPlan,
  signGenesisPlan,
  signGenesisPeerRegistry,
  verifyGenesisCeremony,
  verifyGenesisPlan,
} from "../blockchain/genesis-ceremony.mjs";
import {
  assembleCeremonyRegistryAnchor,
  createCeremonyRegistryAnchorPayload,
  signCeremonyRegistryAnchor,
  verifyCeremonyRegistryAnchor,
} from "../blockchain/genesis-ceremony-anchor.mjs";
import {
  appendCeremonyRegistry,
  ceremonyRegistryPaths,
  repairCeremonyRegistryOneCopy,
  verifyCeremonyRegistry,
} from "../blockchain/genesis-ceremony-store.mjs";

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

function role(wallets, prefix, port) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet),
    endpoint: `http://127.0.0.1:${port + index}`,
    operatorId: `${prefix}-${index}`,
  }));
}

function validatorRole(wallets, transports, port) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet),
    endpoint: `http://127.0.0.1:${port + index}`,
    operatorId: `validator-${index}`,
    tlsCertificateSha256: null,
    transport: publicWallet(transports[index]),
  }));
}

function fixture(label = "primary", {
  releaseSigner = generateWallet(), releaseVersion = "0.2.0",
} = {}) {
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorTransports = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const operators = Array.from({ length: 4 }, generateWallet);
  const guardians = Array.from({ length: 3 }, generateWallet);
  const memberPublicKeys = guardians.map(({ publicKey }) => publicKey);
  const releasePayload = {
    files: [{
      executable: false,
      path: "package.json",
      sha3_256: digest(`${label}-package-json`),
      size: 32,
    }],
    format: "nir-source-release-v1",
    releaseVersion,
    sourceRevision: digest(`${label}-revision`),
  };
  const releaseManifest = {
    ...releasePayload,
    manifestHash: hashObject(releasePayload, "RELEASE_MANIFEST_HASH"),
  };
  const signedRelease = signReleaseManifest(releaseManifest, releaseSigner);
  const networkId = `nir-${label}-valueless-devnet`;
  const releaseAuthorities = Array.from({ length: 4 }, generateWallet);
  const protocolUpgradeReleaseAnchor = createReleaseTransparencyAnchor({
    initialSet: createReleaseAuthoritySet({
      authorities: releaseAuthorities.map((wallet, index) => ({
        ...publicWallet(wallet), operatorId: `release-${index}`,
      })),
      generation: 1, rotationDelayEntries: 2, threshold: 3,
    }),
    logId: "nir-protocol-releases",
    networkId,
  });
  const input = {
    beaconAuthorities: role(beacons, "beacon", 9300),
    ceremonyOperators: operators.map((wallet, index) => ({
      ...publicWallet(wallet),
      contribution: digest(`${label}-contribution-${index}`),
      nonce: digest(`${label}-nonce-${index}`),
      operatorId: `ceremony-${index}`,
    })),
    evaluators: role(evaluators, "evaluator", 9200),
    evaluatorBondAmount: MIN_EVALUATOR_BOND.toString(),
    genesisTimestamp: 0,
    networkId,
    protocolVersion: PROTOCOL_VERSION,
    protocolUpgradeReleaseAnchor,
    sourceReleaseManifestHash: releaseManifest.manifestHash,
    treasury: {
      address: multisigAddress(memberPublicKeys, 2),
      algorithm: "ml-dsa-65-multisig",
      memberPublicKeys,
      threshold: 2,
      vestingPolicy: {
        allocationBps: Number(TREASURY_BPS),
        durationMs: TREASURY_VESTING_MS,
        model: "linear-from-genesis",
      },
    },
    validators: validatorRole(validators, validatorTransports, 9100),
  };
  return {
    input,
    operators,
    releaseOptions: { signedRelease, trustedAddress: releaseSigner.address },
    releaseSigner,
    validatorTransports,
    validators,
  };
}

function approved(values, count = 3) {
  const plan = createGenesisPlan(values.input, values.releaseOptions);
  const approvals = values.operators.slice(0, count)
    .map((wallet) => signGenesisPlan(plan, wallet, values.releaseOptions));
  const registryApprovals = values.validators.slice(0, count)
    .map((wallet) => signGenesisPeerRegistry(plan, wallet, values.releaseOptions));
  return {
    approvals,
    envelope: createGenesisApprovalEnvelope(
      plan, approvals, registryApprovals, values.releaseOptions,
    ),
    plan,
    registryApprovals,
  };
}

test("public genesis plans are canonical, exact, public-only commitments", () => {
  const values = fixture();
  const plan = createGenesisPlan(values.input, values.releaseOptions);
  const reordered = structuredClone(values.input);
  reordered.validators.reverse();
  reordered.evaluators.reverse();
  reordered.beaconAuthorities.reverse();
  reordered.ceremonyOperators.reverse();
  reordered.treasury.memberPublicKeys.reverse();
  assert.deepEqual(createGenesisPlan(reordered, values.releaseOptions), plan);
  assert.deepEqual(verifyGenesisPlan(plan, values.releaseOptions), plan);
  assert.equal(JSON.stringify(plan).includes("privateKey"), false);

  assert.throws(() => createGenesisPlan(
    { ...values.input, privateKey: "forbidden" }, values.releaseOptions,
  ),
    /secret or private/);
  assert.throws(() => createGenesisPlan(
    { ...values.input, unknown: true }, values.releaseOptions,
  ), /unknown fields/);
  assert.throws(() => createGenesisPlan(
    { ...values.input, protocolVersion: PROTOCOL_VERSION + 1 }, values.releaseOptions,
  ),
    /unsupported/);
  const omittedAnchor = structuredClone(values.input);
  delete omittedAnchor.protocolUpgradeReleaseAnchor;
  assert.throws(() => createGenesisPlan(omittedAnchor, values.releaseOptions), /schema/);
  const wrongNetworkAnchor = structuredClone(values.input);
  wrongNetworkAnchor.protocolUpgradeReleaseAnchor.networkId = "nir-foreign-valueless-devnet";
  assert.throws(() => createGenesisPlan(wrongNetworkAnchor, values.releaseOptions),
    /another network|anchor/);
  const tamperedAnchor = structuredClone(values.input);
  tamperedAnchor.protocolUpgradeReleaseAnchor.anchorHash = `sha3-256:${"0".repeat(64)}`;
  assert.throws(() => createGenesisPlan(tamperedAnchor, values.releaseOptions), /anchor hash/);
  const duplicate = structuredClone(values.input);
  duplicate.ceremonyOperators[1].contribution = duplicate.ceremonyOperators[0].contribution;
  assert.throws(() => createGenesisPlan(duplicate, values.releaseOptions), /duplicated/);
  const badTreasury = structuredClone(values.input);
  badTreasury.treasury.threshold = 3;
  assert.throws(() => createGenesisPlan(badTreasury, values.releaseOptions), /2-of-3/);
});

test("ceremony verification requires unique known operator quorum on unchanged commitment", () => {
  const values = fixture();
  const { approvals, envelope, plan, registryApprovals } = approved(values);
  assert.deepEqual(verifyGenesisCeremony(plan, envelope, values.releaseOptions), {
    commitment: plan.commitment,
    peerRegistrySigners: registryApprovals.map(({ validator }) => validator).sort(),
    quorum: 3,
    registryQuorum: 3,
    signers: ["ceremony-0", "ceremony-1", "ceremony-2"],
    verified: true,
  });
  const insufficient = createGenesisApprovalEnvelope(
    plan, approvals.slice(0, 2), registryApprovals, values.releaseOptions,
  );
  assert.throws(() => verifyGenesisCeremony(plan, insufficient, values.releaseOptions), /quorum/);
  const duplicated = createGenesisApprovalEnvelope(
    plan, [approvals[0], approvals[0], approvals[1]], registryApprovals, values.releaseOptions,
  );
  assert.throws(() => verifyGenesisCeremony(plan, duplicated, values.releaseOptions), /duplicated/);
  const unknown = createGenesisApprovalEnvelope(plan, [
    ...approvals.slice(0, 2), { ...approvals[2], operatorId: "unknown-operator" },
  ], registryApprovals, values.releaseOptions);
  assert.throws(() => verifyGenesisCeremony(plan, unknown, values.releaseOptions), /unknown/);
  const mutated = structuredClone(plan);
  mutated.validators[0].endpoint = "http://127.0.0.1:9999";
  assert.throws(() => verifyGenesisCeremony(mutated, envelope, values.releaseOptions), /commitment/);
  assert.throws(() => signGenesisPlan(
    plan, generateWallet(), values.releaseOptions,
  ), /not a ceremony operator/);
});

test("every ceremony stage is bound to one trusted signed source release", () => {
  const values = fixture("release-binding");
  const { approvals, envelope, plan, registryApprovals } = approved(values);
  assert.deepEqual(plan.sourceRelease, {
    manifestHash: values.releaseOptions.signedRelease.manifest.manifestHash,
    releaseVersion: values.releaseOptions.signedRelease.manifest.releaseVersion,
    signerAddress: values.releaseOptions.trustedAddress,
    sourceRevision: values.releaseOptions.signedRelease.manifest.sourceRevision,
  });
  assert.throws(() => verifyGenesisCeremony(plan, envelope), /requires a signed release/);
  assert.throws(() => createGenesisApprovalEnvelope(
    plan, approvals, registryApprovals,
  ), /requires a signed release/);
  assert.throws(() => compileGenesis(plan, envelope), /requires a signed release/);
  assert.throws(() => verifyGenesisCeremony(plan, envelope, {
    ...values.releaseOptions, trustedAddress: generateWallet().address,
  }), /not trusted/);

  const other = fixture("valid-other-release", { releaseSigner: values.releaseSigner });
  assert.throws(() => verifyGenesisCeremony(plan, envelope, other.releaseOptions),
    /does not match/);
  const mutatedRelease = structuredClone(values.releaseOptions.signedRelease);
  mutatedRelease.manifest.releaseVersion = "0.2.1";
  assert.throws(() => verifyGenesisCeremony(plan, envelope, {
    signedRelease: mutatedRelease, trustedAddress: values.releaseOptions.trustedAddress,
  }), /manifest hash|not trusted/);
  const leakedRelease = structuredClone(values.releaseOptions.signedRelease);
  leakedRelease.signer.privateKey = "forbidden";
  assert.throws(() => verifyGenesisCeremony(plan, envelope, {
    signedRelease: leakedRelease, trustedAddress: values.releaseOptions.trustedAddress,
  }), /secret or private/);
  const mutatedPlan = structuredClone(plan);
  mutatedPlan.sourceRelease.sourceRevision = "f".repeat(64);
  assert.throws(() => verifyGenesisCeremony(mutatedPlan, envelope, values.releaseOptions),
    /does not match/);
  const prerelease = fixture("prerelease", { releaseVersion: "0.2.0-alpha.10" });
  assert.throws(() => createGenesisPlan(prerelease.input, prerelease.releaseOptions),
    /major\.minor\.patch/);
});

test("prior public plans reject reused network ids and operator contributions", () => {
  const firstValues = fixture("first");
  const first = approved(firstValues);

  const sameNetworkValues = fixture("second");
  sameNetworkValues.input.networkId = first.plan.networkId;
  sameNetworkValues.input.protocolUpgradeReleaseAnchor = createReleaseTransparencyAnchor({
    initialSet: sameNetworkValues.input.protocolUpgradeReleaseAnchor.initialSet,
    logId: sameNetworkValues.input.protocolUpgradeReleaseAnchor.logId,
    networkId: first.plan.networkId,
  });
  const sameNetwork = approved(sameNetworkValues);
  assert.throws(() => verifyGenesisCeremony(
    sameNetwork.plan, sameNetwork.envelope, {
      ...sameNetworkValues.releaseOptions, priorPlans: [first.plan],
    },
  ), /network id/);

  const reusedContributionValues = fixture("third");
  reusedContributionValues.input.ceremonyOperators[0].contribution =
    first.plan.ceremonyOperators[0].contribution;
  const reusedContribution = approved(reusedContributionValues);
  assert.throws(() => verifyGenesisCeremony(
    reusedContribution.plan, reusedContribution.envelope, {
      ...reusedContributionValues.releaseOptions, priorPlans: [first.plan],
    },
  ), /contribution/);
});

test("compile emits the existing deterministic genesis config and round-trips its chain hash", () => {
  const values = fixture();
  const { envelope, plan } = approved(values);
  const first = compileGenesis(plan, envelope, values.releaseOptions);
  const second = compileGenesis(plan, envelope, values.releaseOptions);
  assert.deepEqual(first, second);
  const reorderedEnvelope = structuredClone(envelope);
  reorderedEnvelope.peerRegistryApprovals.reverse();
  assert.deepEqual(compileGenesis(plan, reorderedEnvelope, values.releaseOptions), first);
  assert.equal(first.genesis.peerRegistry.signatures.length, 3);
  assert.equal(first.genesis.peerRegistry.peers.length, 4);
  assert.equal("protocolVersion" in first.genesis, false);
  assert.deepEqual(first.genesis.protocolUpgradeReleaseAnchor,
    plan.protocolUpgradeReleaseAnchor);
  assert.equal(JSON.stringify(first.genesis).includes("endpoint"), false);
  assert.equal(JSON.stringify(first.genesis).includes("contribution"), false);
  const chain = new NirChain(first.genesis);
  assert.equal(chain.blocks()[0].hash, first.genesisHash);
  const announcement = createPeerAnnouncement({
    height: 0,
    networkId: first.genesis.networkId,
    registry: first.genesis.peerRegistry,
    tipHash: first.genesisHash,
  }, values.validatorTransports[0]);
  const trustedTransport = first.genesis.peerRegistry.peers.find(
    ({ transport }) => transport.address === values.validatorTransports[0].address,
  ).transport;
  assert.equal(verifyPeerAnnouncement(announcement, {
    expectedNetworkId: first.genesis.networkId,
    expectedRegistryHash: peerRegistryHash(first.genesis.peerRegistry),
    trustedTransport,
  }).tipHash, first.genesisHash);
  assert.equal(first.planCommitment, plan.commitment);
});

test("two-copy ceremony registry detects rollback, repairs one copy, and rejects reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-registry-"));
  try {
    const registry = join(root, "registry");
    const releaseSigner = generateWallet();
    const firstValues = fixture("registry-first", { releaseSigner, releaseVersion: "0.2.0" });
    const secondValues = fixture("registry-second", { releaseSigner, releaseVersion: "0.3.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    appendCeremonyRegistry(registry, first.plan, first.envelope, firstValues.releaseOptions);
    const trust = { trustedAddress: releaseSigner.address };
    const oneRecord = verifyCeremonyRegistry(registry, trust).records;
    appendCeremonyRegistry(registry, second.plan, second.envelope, secondValues.releaseOptions);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 2);
    assert.throws(() => appendCeremonyRegistry(
      registry, first.plan, first.envelope, firstValues.releaseOptions,
    ),
      /already used/);
    const olderValues = fixture("registry-older", {
      releaseSigner, releaseVersion: "0.1.0",
    });
    const older = approved(olderValues);
    assert.throws(() => appendCeremonyRegistry(
      registry, older.plan, older.envelope, olderValues.releaseOptions,
    ), /version rolled back/);

    const paths = ceremonyRegistryPaths(registry);
    writeFileSync(paths.primary, `${JSON.stringify(oneRecord)}\n`);
    assert.throws(() => verifyCeremonyRegistry(registry, trust), /rolled back/);
    assert.equal(repairCeremonyRegistryOneCopy(registry, trust).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 2);

    rmSync(paths.primary);
    symlinkSync(paths.backup, paths.primary);
    assert.throws(() => verifyCeremonyRegistry(registry, trust), /invalid/);
    assert.equal(repairCeremonyRegistryOneCopy(registry, trust).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 2);

    mkdirSync(join(registry, ".GENESIS-CEREMONY.writer.lock"));
    assert.throws(() => repairCeremonyRegistryOneCopy(registry, trust), /EEXIST/);
    rmSync(join(registry, ".GENESIS-CEREMONY.writer.lock"), { recursive: true });

    const registryLink = join(root, "registry-link");
    symlinkSync(registry, registryLink);
    assert.throws(() => verifyCeremonyRegistry(registryLink, trust), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ceremony registry refuses ambiguous valid divergence", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-divergence-"));
  try {
    const left = join(root, "left");
    const right = join(root, "right");
    const releaseSigner = generateWallet();
    const firstValues = fixture("divergence-first", { releaseSigner, releaseVersion: "0.2.0" });
    const secondValues = fixture("divergence-second", { releaseSigner, releaseVersion: "0.3.0" });
    const thirdValues = fixture("divergence-third", { releaseSigner, releaseVersion: "0.3.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    const third = approved(thirdValues);
    const trust = { trustedAddress: releaseSigner.address };
    appendCeremonyRegistry(left, first.plan, first.envelope, firstValues.releaseOptions);
    appendCeremonyRegistry(right, first.plan, first.envelope, firstValues.releaseOptions);
    appendCeremonyRegistry(left, second.plan, second.envelope, secondValues.releaseOptions);
    appendCeremonyRegistry(right, third.plan, third.envelope, thirdValues.releaseOptions);
    const leftPaths = ceremonyRegistryPaths(left);
    const rightPaths = ceremonyRegistryPaths(right);
    writeFileSync(leftPaths.primary, readFileSync(rightPaths.primary));
    assert.throws(() => verifyCeremonyRegistry(left, trust), /diverged/);
    assert.throws(() => repairCeremonyRegistryOneCopy(left, trust), /ambiguous/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ceremony registry pins its root descriptor against a post-open symlink swap", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-root-swap-"));
  try {
    const registry = join(root, "registry");
    const moved = join(root, "registry-original");
    const decoy = join(root, "decoy");
    const releaseSigner = generateWallet();
    const firstValues = fixture("root-swap-first", { releaseSigner });
    const secondValues = fixture("root-swap-second", { releaseSigner, releaseVersion: "0.3.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    appendCeremonyRegistry(registry, first.plan, first.envelope, firstValues.releaseOptions);
    mkdirSync(decoy);
    assert.throws(() => appendCeremonyRegistry(
      registry, second.plan, second.envelope, {
        ...secondValues.releaseOptions,
        _afterRootOpen({ root: openedRoot }) {
          assert.equal(openedRoot, registry);
          renameSync(registry, moved);
          symlinkSync(decoy, registry);
        },
      },
    ), /root changed/);
    assert.deepEqual(readdirSync(decoy), []);
    const trust = { trustedAddress: releaseSigner.address };
    assert.equal(verifyCeremonyRegistry(moved, trust).count, 1);
    rmSync(registry);
    renameSync(moved, registry);
    assert.equal(verifyCeremonyRegistry(registry, trust).count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external operator anchor detects coordinated rollback and permits anchored extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-anchor-"));
  try {
    const registry = join(root, "registry");
    const releaseSigner = generateWallet();
    const firstValues = fixture("anchor-first", { releaseSigner, releaseVersion: "0.2.0" });
    const secondValues = fixture("anchor-second", { releaseSigner, releaseVersion: "0.3.0" });
    const thirdValues = fixture("anchor-third", { releaseSigner, releaseVersion: "0.4.0" });
    const first = approved(firstValues);
    const second = approved(secondValues);
    const third = approved(thirdValues);
    const trust = { trustedAddress: releaseSigner.address };
    appendCeremonyRegistry(registry, first.plan, first.envelope, firstValues.releaseOptions);
    const firstRecords = verifyCeremonyRegistry(registry, trust).records;
    appendCeremonyRegistry(registry, second.plan, second.envelope, secondValues.releaseOptions);
    const state = verifyCeremonyRegistry(registry, trust);
    const payload = createCeremonyRegistryAnchorPayload(state);
    const approvals = secondValues.operators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(payload, second.plan, wallet, secondValues.releaseOptions));
    const anchor = assembleCeremonyRegistryAnchor(
      payload, second.plan, approvals, secondValues.releaseOptions,
    );
    assert.equal(verifyCeremonyRegistryAnchor(anchor, state.records, trust).verified, true);

    assert.throws(() => assembleCeremonyRegistryAnchor(
      payload, second.plan, approvals.slice(0, 2), secondValues.releaseOptions,
    ), /quorum/);
    assert.throws(() => assembleCeremonyRegistryAnchor(
      payload, second.plan, [approvals[0], approvals[0], approvals[1]],
      secondValues.releaseOptions,
    ), /duplicated/);
    assert.throws(() => assembleCeremonyRegistryAnchor(
      payload, second.plan, [
        approvals[0], approvals[1], { ...approvals[2], operatorId: "unknown-anchor" },
      ], secondValues.releaseOptions,
    ), /unknown/);

    appendCeremonyRegistry(registry, third.plan, third.envelope, {
      ...thirdValues.releaseOptions, anchor,
    });
    const extended = verifyCeremonyRegistry(registry, { ...trust, anchor });
    assert.equal(extended.count, 3);
    assert.equal(verifyCeremonyRegistryAnchor(anchor, extended.records, trust).localCount, 3);

    const paths = ceremonyRegistryPaths(registry);
    const extendedContents = readFileSync(paths.primary);
    const rolledBackContents = Buffer.from(`${JSON.stringify(firstRecords)}\n`);
    writeFileSync(paths.primary, rolledBackContents);
    writeFileSync(paths.backup, rolledBackContents);
    assert.throws(() => verifyCeremonyRegistry(registry, { ...trust, anchor }), /behind/);
    assert.throws(() => appendCeremonyRegistry(
      registry, third.plan, third.envelope, { ...thirdValues.releaseOptions, anchor },
    ), /behind/);
    assert.throws(() => repairCeremonyRegistryOneCopy(registry, { ...trust, anchor }), /behind/);
    writeFileSync(paths.primary, extendedContents);
    writeFileSync(paths.backup, extendedContents);

    const wrongHead = structuredClone(anchor);
    wrongHead.payload.registryHead = "f".repeat(64);
    assert.throws(() => verifyCeremonyRegistry(registry, { ...trust, anchor: wrongHead }),
      /not a prefix/);
    const mutated = structuredClone(anchor);
    mutated.payload.latestGenesisHash = "e".repeat(64);
    assert.throws(() => verifyCeremonyRegistry(registry, { ...trust, anchor: mutated }),
      /not a prefix/);

    rmSync(paths.primary);
    symlinkSync(paths.backup, paths.primary);
    assert.equal(repairCeremonyRegistryOneCopy(registry, { ...trust, anchor }).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry, { ...trust, anchor }).count, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("genesis ceremony CLI plans, assembles, verifies, and compiles public artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-ceremony-"));
  const cli = new URL("../blockchain/genesis-ceremony-cli.mjs", import.meta.url).pathname;
  try {
    const values = fixture("cli");
    const inputPath = join(root, "input.json");
    const releasePath = join(root, "signed-release.json");
    const planPath = join(root, "plan.json");
    const approvalsPath = join(root, "approvals.json");
    const envelopePath = join(root, "envelope.json");
    const genesisPath = join(root, "genesis.json");
    const registryPath = join(root, "registry");
    const anchorPayloadPath = join(root, "anchor-payload.json");
    const anchorApprovalsPath = join(root, "anchor-approvals.json");
    const anchorPath = join(root, "anchor.json");
    writeFileSync(inputPath, JSON.stringify(values.input));
    writeFileSync(releasePath, JSON.stringify(values.releaseOptions.signedRelease));
    const planned = spawnSync(process.execPath, [
      cli, "plan", inputPath, releasePath, values.releaseOptions.trustedAddress, planPath,
    ], {
      encoding: "utf8",
    });
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const approvals = values.operators.slice(0, 3)
      .map((wallet) => signGenesisPlan(plan, wallet, values.releaseOptions));
    const peerRegistryApprovals = values.validators.slice(0, 3)
      .map((wallet) => signGenesisPeerRegistry(plan, wallet, values.releaseOptions));
    writeFileSync(approvalsPath, JSON.stringify({ approvals, peerRegistryApprovals }));
    const assembled = spawnSync(process.execPath, [
      cli, "assemble", planPath, releasePath, values.releaseOptions.trustedAddress,
      approvalsPath, envelopePath,
    ], { encoding: "utf8" });
    assert.equal(assembled.status, 0, assembled.stderr);
    const verified = spawnSync(process.execPath, [
      cli, "verify", planPath, envelopePath, releasePath, values.releaseOptions.trustedAddress,
    ], {
      encoding: "utf8",
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /valueless developer testnet ceremony verified/i);
    const compiled = spawnSync(process.execPath, [
      cli, "compile", planPath, envelopePath, releasePath,
      values.releaseOptions.trustedAddress, genesisPath,
    ], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(compiled.stdout, /valueless developer testnet only/i);
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
    assert.match(new NirChain(genesis).blocks()[0].hash, /^[0-9a-f]{64}$/);
    const appended = spawnSync(process.execPath, [
      cli, "registry-append", registryPath, planPath, envelopePath, releasePath,
      values.releaseOptions.trustedAddress,
    ], { encoding: "utf8" });
    assert.equal(appended.status, 0, appended.stderr);
    const exportedAnchor = spawnSync(process.execPath, [
      cli, "export-anchor-payload", registryPath, values.releaseOptions.trustedAddress,
      anchorPayloadPath,
    ], { encoding: "utf8" });
    assert.equal(exportedAnchor.status, 0, exportedAnchor.stderr);
    const anchorPayload = JSON.parse(readFileSync(anchorPayloadPath, "utf8"));
    const anchorApprovals = values.operators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(anchorPayload, plan, wallet, values.releaseOptions));
    writeFileSync(anchorApprovalsPath, JSON.stringify(anchorApprovals));
    const assembledAnchor = spawnSync(process.execPath, [
      cli, "assemble-anchor", anchorPayloadPath, planPath, releasePath,
      values.releaseOptions.trustedAddress, anchorApprovalsPath, anchorPath,
    ], { encoding: "utf8" });
    assert.equal(assembledAnchor.status, 0, assembledAnchor.stderr);
    const anchoredVerify = spawnSync(process.execPath, [
      cli, "verify-with-anchor", registryPath, values.releaseOptions.trustedAddress, anchorPath,
    ], { encoding: "utf8" });
    assert.equal(anchoredVerify.status, 0, anchoredVerify.stderr);
    const registryPaths = ceremonyRegistryPaths(registryPath);
    rmSync(registryPaths.primary);
    symlinkSync(registryPaths.backup, registryPaths.primary);
    const failedVerify = spawnSync(process.execPath, [
      cli, "registry-verify", registryPath, values.releaseOptions.trustedAddress,
    ], { encoding: "utf8" });
    assert.equal(failedVerify.status, 1);
    const repaired = spawnSync(process.execPath, [
      cli, "registry-repair-one-copy", registryPath, values.releaseOptions.trustedAddress,
      anchorPath,
    ], { encoding: "utf8" });
    assert.equal(repaired.status, 0, repaired.stderr);
    const registryVerified = spawnSync(process.execPath, [
      cli, "registry-verify", registryPath, values.releaseOptions.trustedAddress,
      anchorPath,
    ], { encoding: "utf8" });
    assert.equal(registryVerified.status, 0, registryVerified.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
