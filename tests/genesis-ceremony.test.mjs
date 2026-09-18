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
  PROTOCOL_VERSION,
  TREASURY_BPS,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createPeerAnnouncement, verifyPeerAnnouncement } from "../blockchain/peer-discovery.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
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

function fixture(label = "primary") {
  const validators = Array.from({ length: 4 }, generateWallet);
  const validatorTransports = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const operators = Array.from({ length: 4 }, generateWallet);
  const guardians = Array.from({ length: 3 }, generateWallet);
  const memberPublicKeys = guardians.map(({ publicKey }) => publicKey);
  const input = {
    beaconAuthorities: role(beacons, "beacon", 9300),
    ceremonyOperators: operators.map((wallet, index) => ({
      ...publicWallet(wallet),
      contribution: digest(`${label}-contribution-${index}`),
      nonce: digest(`${label}-nonce-${index}`),
      operatorId: `ceremony-${index}`,
    })),
    evaluators: role(evaluators, "evaluator", 9200),
    genesisTimestamp: 0,
    networkId: `nir-${label}-valueless-devnet`,
    protocolVersion: PROTOCOL_VERSION,
    sourceReleaseManifestHash: digest(`${label}-release`),
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
  return { input, operators, validatorTransports, validators };
}

function approved(values, count = 3) {
  const plan = createGenesisPlan(values.input);
  const approvals = values.operators.slice(0, count).map((wallet) => signGenesisPlan(plan, wallet));
  const registryApprovals = values.validators.slice(0, count)
    .map((wallet) => signGenesisPeerRegistry(plan, wallet));
  return {
    approvals,
    envelope: createGenesisApprovalEnvelope(plan, approvals, registryApprovals),
    plan,
    registryApprovals,
  };
}

test("public genesis plans are canonical, exact, public-only commitments", () => {
  const values = fixture();
  const plan = createGenesisPlan(values.input);
  const reordered = structuredClone(values.input);
  reordered.validators.reverse();
  reordered.evaluators.reverse();
  reordered.beaconAuthorities.reverse();
  reordered.ceremonyOperators.reverse();
  reordered.treasury.memberPublicKeys.reverse();
  assert.deepEqual(createGenesisPlan(reordered), plan);
  assert.deepEqual(verifyGenesisPlan(plan), plan);
  assert.equal(JSON.stringify(plan).includes("privateKey"), false);

  assert.throws(() => createGenesisPlan({ ...values.input, privateKey: "forbidden" }),
    /secret or private/);
  assert.throws(() => createGenesisPlan({ ...values.input, unknown: true }), /unknown fields/);
  assert.throws(() => createGenesisPlan({ ...values.input, protocolVersion: PROTOCOL_VERSION + 1 }),
    /unsupported/);
  const duplicate = structuredClone(values.input);
  duplicate.ceremonyOperators[1].contribution = duplicate.ceremonyOperators[0].contribution;
  assert.throws(() => createGenesisPlan(duplicate), /duplicated/);
  const badTreasury = structuredClone(values.input);
  badTreasury.treasury.threshold = 3;
  assert.throws(() => createGenesisPlan(badTreasury), /2-of-3/);
});

test("ceremony verification requires unique known operator quorum on unchanged commitment", () => {
  const values = fixture();
  const { approvals, envelope, plan, registryApprovals } = approved(values);
  assert.deepEqual(verifyGenesisCeremony(plan, envelope), {
    commitment: plan.commitment,
    peerRegistrySigners: registryApprovals.map(({ validator }) => validator).sort(),
    quorum: 3,
    registryQuorum: 3,
    signers: ["ceremony-0", "ceremony-1", "ceremony-2"],
    verified: true,
  });
  const insufficient = createGenesisApprovalEnvelope(
    plan, approvals.slice(0, 2), registryApprovals,
  );
  assert.throws(() => verifyGenesisCeremony(plan, insufficient), /quorum/);
  const duplicated = createGenesisApprovalEnvelope(
    plan, [approvals[0], approvals[0], approvals[1]], registryApprovals,
  );
  assert.throws(() => verifyGenesisCeremony(plan, duplicated), /duplicated/);
  const unknown = createGenesisApprovalEnvelope(plan, [
    ...approvals.slice(0, 2), { ...approvals[2], operatorId: "unknown-operator" },
  ], registryApprovals);
  assert.throws(() => verifyGenesisCeremony(plan, unknown), /unknown/);
  const mutated = structuredClone(plan);
  mutated.validators[0].endpoint = "http://127.0.0.1:9999";
  assert.throws(() => verifyGenesisCeremony(mutated, envelope), /commitment/);
  assert.throws(() => signGenesisPlan(plan, generateWallet()), /not a ceremony operator/);
});

test("prior public plans reject reused network ids and operator contributions", () => {
  const firstValues = fixture("first");
  const first = approved(firstValues);

  const sameNetworkValues = fixture("second");
  sameNetworkValues.input.networkId = first.plan.networkId;
  const sameNetwork = approved(sameNetworkValues);
  assert.throws(() => verifyGenesisCeremony(
    sameNetwork.plan, sameNetwork.envelope, { priorPlans: [first.plan] },
  ), /network id/);

  const reusedContributionValues = fixture("third");
  reusedContributionValues.input.ceremonyOperators[0].contribution =
    first.plan.ceremonyOperators[0].contribution;
  const reusedContribution = approved(reusedContributionValues);
  assert.throws(() => verifyGenesisCeremony(
    reusedContribution.plan, reusedContribution.envelope, { priorPlans: [first.plan] },
  ), /contribution/);
});

test("compile emits the existing deterministic genesis config and round-trips its chain hash", () => {
  const values = fixture();
  const { envelope, plan } = approved(values);
  const first = compileGenesis(plan, envelope);
  const second = compileGenesis(plan, envelope);
  assert.deepEqual(first, second);
  const reorderedEnvelope = structuredClone(envelope);
  reorderedEnvelope.peerRegistryApprovals.reverse();
  assert.deepEqual(compileGenesis(plan, reorderedEnvelope), first);
  assert.equal(first.genesis.peerRegistry.signatures.length, 3);
  assert.equal(first.genesis.peerRegistry.peers.length, 4);
  assert.equal("protocolVersion" in first.genesis, false);
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
    const first = approved(fixture("registry-first"));
    const second = approved(fixture("registry-second"));
    appendCeremonyRegistry(registry, first.plan, first.envelope);
    const oneRecord = verifyCeremonyRegistry(registry).records;
    appendCeremonyRegistry(registry, second.plan, second.envelope);
    assert.equal(verifyCeremonyRegistry(registry).count, 2);
    assert.throws(() => appendCeremonyRegistry(registry, first.plan, first.envelope),
      /already used/);

    const paths = ceremonyRegistryPaths(registry);
    writeFileSync(paths.primary, `${JSON.stringify(oneRecord)}\n`);
    assert.throws(() => verifyCeremonyRegistry(registry), /rolled back/);
    assert.equal(repairCeremonyRegistryOneCopy(registry).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry).count, 2);

    rmSync(paths.primary);
    symlinkSync(paths.backup, paths.primary);
    assert.throws(() => verifyCeremonyRegistry(registry), /invalid/);
    assert.equal(repairCeremonyRegistryOneCopy(registry).repaired, true);
    assert.equal(verifyCeremonyRegistry(registry).count, 2);

    mkdirSync(join(registry, ".GENESIS-CEREMONY.writer.lock"));
    assert.throws(() => repairCeremonyRegistryOneCopy(registry), /EEXIST/);
    rmSync(join(registry, ".GENESIS-CEREMONY.writer.lock"), { recursive: true });

    const registryLink = join(root, "registry-link");
    symlinkSync(registry, registryLink);
    assert.throws(() => verifyCeremonyRegistry(registryLink), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ceremony registry refuses ambiguous valid divergence", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-genesis-divergence-"));
  try {
    const left = join(root, "left");
    const right = join(root, "right");
    const first = approved(fixture("divergence-first"));
    const second = approved(fixture("divergence-second"));
    const third = approved(fixture("divergence-third"));
    appendCeremonyRegistry(left, first.plan, first.envelope);
    appendCeremonyRegistry(right, first.plan, first.envelope);
    appendCeremonyRegistry(left, second.plan, second.envelope);
    appendCeremonyRegistry(right, third.plan, third.envelope);
    const leftPaths = ceremonyRegistryPaths(left);
    const rightPaths = ceremonyRegistryPaths(right);
    writeFileSync(leftPaths.primary, readFileSync(rightPaths.primary));
    assert.throws(() => verifyCeremonyRegistry(left), /diverged/);
    assert.throws(() => repairCeremonyRegistryOneCopy(left), /ambiguous/);
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
    const first = approved(fixture("root-swap-first"));
    const second = approved(fixture("root-swap-second"));
    appendCeremonyRegistry(registry, first.plan, first.envelope);
    mkdirSync(decoy);
    assert.throws(() => appendCeremonyRegistry(
      registry, second.plan, second.envelope, {
        _afterRootOpen({ root: openedRoot }) {
          assert.equal(openedRoot, registry);
          renameSync(registry, moved);
          symlinkSync(decoy, registry);
        },
      },
    ), /root changed/);
    assert.deepEqual(readdirSync(decoy), []);
    assert.equal(verifyCeremonyRegistry(moved).count, 1);
    rmSync(registry);
    renameSync(moved, registry);
    assert.equal(verifyCeremonyRegistry(registry).count, 1);
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
    const planPath = join(root, "plan.json");
    const approvalsPath = join(root, "approvals.json");
    const envelopePath = join(root, "envelope.json");
    const genesisPath = join(root, "genesis.json");
    const registryPath = join(root, "registry");
    writeFileSync(inputPath, JSON.stringify(values.input));
    const planned = spawnSync(process.execPath, [cli, "plan", inputPath, planPath], {
      encoding: "utf8",
    });
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const approvals = values.operators.slice(0, 3).map((wallet) => signGenesisPlan(plan, wallet));
    const peerRegistryApprovals = values.validators.slice(0, 3)
      .map((wallet) => signGenesisPeerRegistry(plan, wallet));
    writeFileSync(approvalsPath, JSON.stringify({ approvals, peerRegistryApprovals }));
    const assembled = spawnSync(process.execPath, [
      cli, "assemble", planPath, approvalsPath, envelopePath,
    ], { encoding: "utf8" });
    assert.equal(assembled.status, 0, assembled.stderr);
    const verified = spawnSync(process.execPath, [cli, "verify", planPath, envelopePath], {
      encoding: "utf8",
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /valueless developer testnet ceremony verified/i);
    const compiled = spawnSync(process.execPath, [
      cli, "compile", planPath, envelopePath, genesisPath,
    ], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(compiled.stdout, /valueless developer testnet only/i);
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8"));
    assert.match(new NirChain(genesis).blocks()[0].hash, /^[0-9a-f]{64}$/);
    const appended = spawnSync(process.execPath, [
      cli, "registry-append", registryPath, planPath, envelopePath,
    ], { encoding: "utf8" });
    assert.equal(appended.status, 0, appended.stderr);
    const registryPaths = ceremonyRegistryPaths(registryPath);
    rmSync(registryPaths.primary);
    symlinkSync(registryPaths.backup, registryPaths.primary);
    const failedVerify = spawnSync(process.execPath, [
      cli, "registry-verify", registryPath,
    ], { encoding: "utf8" });
    assert.equal(failedVerify.status, 1);
    const repaired = spawnSync(process.execPath, [
      cli, "registry-repair-one-copy", registryPath,
    ], { encoding: "utf8" });
    assert.equal(repaired.status, 0, repaired.stderr);
    const registryVerified = spawnSync(process.execPath, [
      cli, "registry-verify", registryPath,
    ], { encoding: "utf8" });
    assert.equal(registryVerified.status, 0, registryVerified.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
