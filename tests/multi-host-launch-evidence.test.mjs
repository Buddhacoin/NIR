import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  collectMultiHostLaunchEvidence,
  createMultiHostLaunchPlan,
  createMultiHostLaunchEvidencePackage,
  signMultiHostLaunchReceipt,
  signMultiHostLaunchServiceResponse,
  verifyMultiHostLaunchEvidencePackage,
} from "../blockchain/multi-host-launch-evidence.mjs";

const H = (value) => value.repeat(64);
const NOW = 1_800_000_000_000;

async function fixture(t) {
  const roles = [...Array(4).fill("validator"), ...Array(4).fill("beacon"),
    ...Array(2).fill("archive")];
  const wallets = roles.map(() => generateWallet());
  const servers = roles.map(() => createServer());
  await Promise.all(servers.map((server) => new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve))));
  t.after(async () => Promise.all(servers.map((server) => new Promise((resolve) =>
    server.close(resolve)))));
  const topology = roles.map((role, index) => ({ ...publicWallet(wallets[index]),
    endpoint: `http://127.0.0.1:${servers[index].address().port}`,
    operatorId: `${role}-${index}`, role }));
  const context = { drillPlanHash: H("a"), finalizedHeight: 101,
    finalizedTipHash: H("b"), genesisHash: H("c"), networkId: "nir-public-dev",
    peerRegistryHash: H("d"), recoveryStateCommitment: H("e"),
    releaseCheckpointHash: `sha3-256:${H("f")}`, stateRoot: H("1"),
    validatorSetHash: H("2") };
  const plan = createMultiHostLaunchPlan({ context, expiresAt: NOW + 60_000,
    issuedAt: NOW - 1_000, outage: { height: 100, operatorId: "validator-0",
      stateRoot: H("3"), tipHash: H("4") }, runNonce: "5".repeat(32), topology },
  { allowInsecureLocalhost: true });
  const observations = topology.map((identity, index) => {
    if (identity.role === "validator") return {
      current: { height: context.finalizedHeight, peerRegistryHash: context.peerRegistryHash,
        recoveryStateCommitment: context.recoveryStateCommitment, stateRoot: context.stateRoot,
        tipHash: context.finalizedTipHash, validatorSetHash: context.validatorSetHash },
      outageFinality: index === 0 ? null : { height: 100, outageOperatorId: "validator-0",
        stateRoot: H("3"), tipHash: H("4") },
      recovery: index === 0 ? { caughtUp: true, fromHeight: 99,
        newInstanceId: "7".repeat(32), oldInstanceId: "6".repeat(32), toHeight: 101 } : null,
    };
    if (identity.role === "beacon") return { candidateId: H("8"), generation: 2,
      round: 4, shareHash: String(index).padStart(64, "0"), status: "PASS",
      validatorTipHash: context.finalizedTipHash };
    return { inventoryRoot: H("9"), restoreReceiptHash: index === 8 ? H("a") : H("b"),
      restoredHeight: context.finalizedHeight, stateRoot: context.stateRoot, status: "PASS",
      tipHash: context.finalizedTipHash };
  });
  const receipts = observations.map((observation, index) =>
    signMultiHostLaunchReceipt(plan, { expiresAt: NOW + 30_000, observation,
      observedAt: NOW - 500, operatorId: topology[index].operatorId, wallet: wallets[index] },
    { allowInsecureLocalhost: true }));
  let requests = 0;
  servers.forEach((server, index) => server.on("request", async (request, response) => {
    requests += 1; let text = "";
    for await (const chunk of request) text += chunk;
    const challenge = JSON.parse(text);
    const value = signMultiHostLaunchServiceResponse(plan, receipts[index], {
      challengeNonce: challenge.challengeNonce, respondedAt: NOW, wallet: wallets[index],
    }, { allowInsecureLocalhost: true });
    const body = JSON.stringify(value);
    response.writeHead(200, { "content-length": Buffer.byteLength(body),
      "content-type": "application/json" }); response.end(body);
  }));
  return { get requests() { return requests; }, plan, receipts, servers, wallets };
}

test("collector fetches every authenticated service and emits offline-verifiable PASS", async (t) => {
  const values = await fixture(t);
  const evidence = await collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "c".repeat(32), now: NOW,
  });
  assert.equal(values.requests, 10);
  const verified = verifyMultiHostLaunchEvidencePackage(evidence, {
    allowInsecureLocalhost: true, expectedPlanHash: values.plan.planHash,
    expectedRunNonce: values.plan.runNonce, now: NOW,
  });
  assert.deepEqual({ archives: verified.archiveResponders, beacons: verified.beaconResponders,
    physical: verified.physicalIndependenceClaimed, status: verified.status, validators:
      verified.validatorResponders }, { archives: 2, beacons: 4, physical: false,
    status: "PASS", validators: 4 });
});

test("declared-only, duplicate, forged, mixed, stale, and replayed evidence fail closed", async (t) => {
  const values = await fixture(t);
  const evidence = await collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "d".repeat(32), now: NOW,
  });
  const options = { allowInsecureLocalhost: true, expectedPlanHash: values.plan.planHash,
    expectedRunNonce: values.plan.runNonce, now: NOW };
  assert.throws(() => createMultiHostLaunchEvidencePackage({ challengeNonce: "d".repeat(32),
    collectedAt: NOW, hostReceipts: values.receipts, plan: values.plan, serviceResponses: [] },
  { allowInsecureLocalhost: true }), /declared-only/);
  const duplicate = structuredClone(evidence);
  duplicate.hostReceipts[1] = duplicate.hostReceipts[0];
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(duplicate, options), /repeats an operator|mutated/);
  const forged = structuredClone(evidence);
  forged.serviceResponses[0].signature += "A";
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(forged, options), /mutated|signature/);
  const mixed = structuredClone(evidence);
  const validatorIndex = mixed.hostReceipts.findIndex(({ role }) => role === "validator");
  mixed.hostReceipts[validatorIndex].observation.current.tipHash = H("0");
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(mixed, options), /mutated|mixed or stale/);
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(evidence, { ...options,
    expectedRunNonce: "0".repeat(32) }), /replayed/);
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(evidence, { ...options,
    expectedPlanHash: H("0") }), /replayed/);
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(evidence, { ...options,
    now: values.plan.expiresAt + 1 }), /stale/);
});

test("outage, catch-up, beacon quorum, and archive restore claims are mandatory", async (t) => {
  const values = await fixture(t);
  const evidence = await collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "e".repeat(32), now: NOW,
  });
  const resign = (index, mutate) => {
    const receipt = structuredClone(values.receipts[index]); mutate(receipt.observation);
    return signMultiHostLaunchReceipt(values.plan, { expiresAt: receipt.expiresAt,
      observation: receipt.observation, observedAt: receipt.observedAt,
      operatorId: receipt.operatorId, wallet: values.wallets[index] },
    { allowInsecureLocalhost: true });
  };
  assert.throws(() => resign(0, (observation) => { observation.recovery.caughtUp = false; }),
    /restart and catch-up/);
  assert.throws(() => resign(1, (observation) => { observation.outageFinality.tipHash = H("0"); }),
    /outage finality/);
  assert.throws(() => resign(4, (observation) => { observation.status = "FAIL"; }),
    /beacon observation/);
  assert.throws(() => resign(8, (observation) => { observation.tipHash = H("0"); }),
    /archive restore/);
  assert.equal(evidence.plan.context.recoveryStateCommitment, H("e"));
});

test("offline CLI verifies a canonical package and rejects the wrong run nonce", async (t) => {
  const values = await fixture(t);
  const evidence = await collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "f".repeat(32), now: NOW,
  });
  const directory = mkdtempSync(join(tmpdir(), "nir-launch-evidence-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "evidence.json"); writeFileSync(path, JSON.stringify(evidence));
  const ok = spawnSync(process.execPath, ["blockchain/multi-host-launch-evidence-cli.mjs",
    "verify", path, values.plan.planHash, values.plan.runNonce, String(NOW),
    "--allow-insecure-localhost"],
  { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /"status":"PASS"/);
  const replay = spawnSync(process.execPath, ["blockchain/multi-host-launch-evidence-cli.mjs",
    "verify", path, values.plan.planHash, "0".repeat(32), String(NOW),
    "--allow-insecure-localhost"],
  { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(replay.status, 0); assert.match(replay.stderr, /replayed/);
});
