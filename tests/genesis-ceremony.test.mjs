import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  compileGenesis,
  createGenesisApprovalEnvelope,
  createGenesisPlan,
  signGenesisPlan,
  verifyGenesisCeremony,
  verifyGenesisPlan,
} from "../blockchain/genesis-ceremony.mjs";

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

function fixture(label = "primary") {
  const validators = Array.from({ length: 4 }, generateWallet);
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
    validators: role(validators, "validator", 9100),
  };
  return { input, operators };
}

function approved(values, count = 3) {
  const plan = createGenesisPlan(values.input);
  const approvals = values.operators.slice(0, count).map((wallet) => signGenesisPlan(plan, wallet));
  return { approvals, envelope: createGenesisApprovalEnvelope(plan, approvals), plan };
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
  const { approvals, envelope, plan } = approved(values);
  assert.deepEqual(verifyGenesisCeremony(plan, envelope), {
    commitment: plan.commitment,
    quorum: 3,
    signers: ["ceremony-0", "ceremony-1", "ceremony-2"],
    verified: true,
  });
  const insufficient = createGenesisApprovalEnvelope(plan, approvals.slice(0, 2));
  assert.throws(() => verifyGenesisCeremony(plan, insufficient), /quorum/);
  const duplicated = createGenesisApprovalEnvelope(plan, [approvals[0], approvals[0], approvals[1]]);
  assert.throws(() => verifyGenesisCeremony(plan, duplicated), /duplicated/);
  const unknown = createGenesisApprovalEnvelope(plan, [
    ...approvals.slice(0, 2), { ...approvals[2], operatorId: "unknown-operator" },
  ]);
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
  assert.equal(first.genesis.peerRegistry, null);
  assert.equal("protocolVersion" in first.genesis, false);
  assert.equal(JSON.stringify(first.genesis).includes("endpoint"), false);
  assert.equal(JSON.stringify(first.genesis).includes("contribution"), false);
  assert.equal(new NirChain(first.genesis).blocks()[0].hash, first.genesisHash);
  assert.equal(first.planCommitment, plan.commitment);
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
    writeFileSync(inputPath, JSON.stringify(values.input));
    const planned = spawnSync(process.execPath, [cli, "plan", inputPath, planPath], {
      encoding: "utf8",
    });
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const approvals = values.operators.slice(0, 3).map((wallet) => signGenesisPlan(plan, wallet));
    writeFileSync(approvalsPath, JSON.stringify(approvals));
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
