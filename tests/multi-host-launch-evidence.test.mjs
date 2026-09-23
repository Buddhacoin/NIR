import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, hashObject, publicWallet, signObject } from "../blockchain/crypto.mjs";
import {
  collectMultiHostLaunchEvidence,
  createMultiHostLaunchPlan,
  createMultiHostLaunchEvidencePackage,
  signMultiHostArchiveRestoreReceipt,
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
    if (identity.role === "beacon") {
      const payload = { authority: identity.address, candidateId: H("8"), generation: 2,
        networkId: context.networkId, round: 4, value: String(index).padStart(64, "0") };
      return { share: { ...payload, signature: signObject(payload, wallets[index],
        "FALLBACK_RANDOMNESS_SHARE") }, status: "PASS",
      validatorTipHash: context.finalizedTipHash };
    }
    const backupPayload = { checkpointHash: H("6"), createdAt: NOW - 700,
      format: "nir-remote-backup-receipt-v1", height: context.finalizedHeight,
      historyContentRoot: H("7"), historyIndexHash: H("8"), inventoryRoot: H("9"),
      networkId: context.networkId, operatorId: identity.operatorId, privateKeysIncluded: false,
      snapshotHash: null, sourceId: identity.endpoint, stateRoot: context.stateRoot,
      tipHash: context.finalizedTipHash, totalBytes: 1, totalFiles: 1 };
    const receiptHash = hashObject(backupPayload, "REMOTE_BACKUP_RECEIPT");
    const backupReceipt = { payload: { ...backupPayload, receiptHash },
      signature: signObject({ receiptHash }, wallets[index], "REMOTE_BACKUP_RECEIPT"),
      signer: publicWallet(wallets[index]) };
    const restoreReceipt = signMultiHostArchiveRestoreReceipt(plan, {
      backupReceiptHash: receiptHash, completedAt: NOW - 600,
      drillPlanHash: context.drillPlanHash, height: context.finalizedHeight,
      inventoryRoot: backupPayload.inventoryRoot, networkId: context.networkId,
      operatorId: identity.operatorId, stateRoot: context.stateRoot,
      tipHash: context.finalizedTipHash,
    }, wallets[index], { allowInsecureLocalhost: true });
    return { backupReceipt, restoreReceipt, status: "PASS" };
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
    allowInsecureLocalhost: true, expectedChallengeNonce: "c".repeat(32),
    expectedPlanHash: values.plan.planHash,
    expectedRunNonce: values.plan.runNonce, now: NOW,
  });
  assert.deepEqual({ archives: verified.archiveResponders, beacons: verified.beaconResponders,
    physical: verified.physicalIndependenceClaimed, status: verified.status, validators:
      verified.validatorResponders }, { archives: 2, beacons: 4, physical: false,
    status: "EVIDENCE-CONSISTENCY-PASS", validators: 4 });
});

test("declared-only, duplicate, forged, mixed, stale, and replayed evidence fail closed", async (t) => {
  const values = await fixture(t);
  const evidence = await collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "d".repeat(32), now: NOW,
  });
  const options = { allowInsecureLocalhost: true, expectedChallengeNonce: "d".repeat(32),
    expectedPlanHash: values.plan.planHash,
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
    expectedChallengeNonce: "0".repeat(32) }), /replayed/);
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(evidence, { ...options,
    maxEvidenceAgeMs: 100, now: NOW + 101 }), /stale/);
  assert.throws(() => createMultiHostLaunchEvidencePackage({ challengeNonce: "d".repeat(32),
    collectedAt: NOW, hostReceipts: values.receipts, plan: values.plan,
    serviceResponses: evidence.serviceResponses }, { allowInsecureLocalhost: true,
    maxObservationAgeMs: 100 }), /host receipt is stale/);
  assert.throws(() => verifyMultiHostLaunchEvidencePackage(evidence, { ...options,
    now: values.plan.expiresAt + 1 }), /stale/);
  await assert.rejects(() => collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: values.plan.runNonce, now: NOW,
  }), /collector policy/);
  const alternateKey = structuredClone(values.plan);
  alternateKey.topology[0].publicKey += "\n";
  assert.throws(() => createMultiHostLaunchPlan({ context: alternateKey.context,
    expiresAt: alternateKey.expiresAt, issuedAt: alternateKey.issuedAt,
    outage: alternateKey.outage, runNonce: alternateKey.runNonce,
    topology: alternateKey.topology }, { allowInsecureLocalhost: true }), /identity is invalid/);
  const duplicateOrigin = structuredClone(values.plan);
  duplicateOrigin.topology[1].endpoint = duplicateOrigin.topology[0].endpoint;
  assert.throws(() => createMultiHostLaunchPlan({ context: duplicateOrigin.context,
    expiresAt: duplicateOrigin.expiresAt, issuedAt: duplicateOrigin.issuedAt,
    outage: duplicateOrigin.outage, runNonce: duplicateOrigin.runNonce,
    topology: duplicateOrigin.topology }, { allowInsecureLocalhost: true }), /unique required operators/);
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
  assert.throws(() => resign(0, (observation) => { observation.recovery.fromHeight = -1; }),
    /restart and catch-up/);
  assert.throws(() => resign(1, (observation) => { observation.outageFinality.tipHash = H("0"); }),
    /outage finality/);
  assert.throws(() => resign(4, (observation) => { observation.status = "FAIL"; }),
    /beacon observation/);
  assert.throws(() => resign(4, (observation) => { observation.share.signature += "A"; }),
    /beacon observation/);
  const forgedArchive = resign(8, (observation) => { observation.restoreReceipt.signature += "A"; });
  const replace = (receipt, index) => {
    const receipts = structuredClone(evidence.hostReceipts);
    const responses = structuredClone(evidence.serviceResponses);
    const receiptIndex = receipts.findIndex(({ operatorId }) => operatorId === receipt.operatorId);
    const responseIndex = responses.findIndex(({ operatorId }) => operatorId === receipt.operatorId);
    receipts[receiptIndex] = receipt;
    responses[responseIndex] = signMultiHostLaunchServiceResponse(values.plan, receipt, {
      challengeNonce: "e".repeat(32), respondedAt: NOW, wallet: values.wallets[index],
    }, { allowInsecureLocalhost: true });
    return { receipts, responses };
  };
  const forgedArchiveSet = replace(forgedArchive, 8);
  assert.throws(() => createMultiHostLaunchEvidencePackage({ challengeNonce: "e".repeat(32),
    collectedAt: NOW, hostReceipts: forgedArchiveSet.receipts, plan: values.plan,
    serviceResponses: forgedArchiveSet.responses }, { allowInsecureLocalhost: true }),
  /archive restore receipt signature/);
  const forgedBackup = resign(8, (observation) => { observation.backupReceipt.signature += "A"; });
  const forgedBackupSet = replace(forgedBackup, 8);
  assert.throws(() => createMultiHostLaunchEvidencePackage({ challengeNonce: "e".repeat(32),
    collectedAt: NOW, hostReceipts: forgedBackupSet.receipts, plan: values.plan,
    serviceResponses: forgedBackupSet.responses }, { allowInsecureLocalhost: true }),
  /archive backup receipt encoding/);

  const beaconReceipt = structuredClone(values.receipts[5]);
  beaconReceipt.observation.share.value = values.receipts[4].observation.share.value;
  const sharePayload = { ...beaconReceipt.observation.share };
  delete sharePayload.signature;
  beaconReceipt.observation.share.signature = signObject(sharePayload, values.wallets[5],
    "FALLBACK_RANDOMNESS_SHARE");
  const duplicateShareReceipt = signMultiHostLaunchReceipt(values.plan, {
    expiresAt: beaconReceipt.expiresAt, observation: beaconReceipt.observation,
    observedAt: beaconReceipt.observedAt, operatorId: beaconReceipt.operatorId,
    wallet: values.wallets[5],
  }, { allowInsecureLocalhost: true });
  const duplicateShareSet = replace(duplicateShareReceipt, 5);
  assert.throws(() => createMultiHostLaunchEvidencePackage({ challengeNonce: "e".repeat(32),
    collectedAt: NOW, hostReceipts: duplicateShareSet.receipts, plan: values.plan,
    serviceResponses: duplicateShareSet.responses }, { allowInsecureLocalhost: true }),
  /beacon quorum/);
  assert.equal(evidence.plan.context.recoveryStateCommitment, H("e"));
});

test("collector bounds tiny-chunk bodies and rejects compression and ambiguous JSON", async (t) => {
  const values = await fixture(t);
  const challengeNonce = "a".repeat(32);
  const responseByOrigin = new Map(values.plan.topology.map((identity) => {
    const index = values.receipts.findIndex(({ operatorId }) => operatorId === identity.operatorId);
    const response = signMultiHostLaunchServiceResponse(values.plan, values.receipts[index], {
      challengeNonce, respondedAt: NOW, wallet: values.wallets[index],
    }, { allowInsecureLocalhost: true });
    return [identity.endpoint, JSON.stringify(response)];
  }));
  const tinyFetch = async (url) => {
    const text = responseByOrigin.get(new URL(url).origin);
    const encoded = new TextEncoder().encode(text); let offset = 0;
    const body = new ReadableStream({ pull(controller) {
      if (offset === encoded.length) controller.close();
      else controller.enqueue(encoded.subarray(offset, ++offset));
    } });
    return new Response(body, { status: 200 });
  };
  const evidence = await collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce, fetchImpl: tinyFetch, now: NOW,
  });
  assert.equal(evidence.serviceResponses.length, 10);
  const compressed = async () => new Response("{}", { status: 200,
    headers: { "content-encoding": "gzip" } });
  await assert.rejects(() => collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "b".repeat(32), fetchImpl: compressed, now: NOW,
  }), /compression is forbidden/);
  const ambiguous = async () => new Response('{"format":1,"format":2}', { status: 200 });
  await assert.rejects(() => collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "b".repeat(32), fetchImpl: ambiguous, now: NOW,
  }), /invalid JSON/);
  values.servers[0].removeAllListeners("request");
  values.servers[0].on("request", (_request, response) => {
    response.writeHead(302, { location: `${values.plan.topology[1].endpoint}/v1/launch-evidence` });
    response.end();
  });
  await assert.rejects(() => collectMultiHostLaunchEvidence(values.plan, values.receipts, {
    allowInsecureLocalhost: true, challengeNonce: "b".repeat(32), now: NOW,
  }), /fetch|redirect/i);
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
    "verify", path, values.plan.planHash, values.plan.runNonce, "f".repeat(32), String(NOW),
    "--allow-insecure-localhost"],
  { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /"status":"EVIDENCE-CONSISTENCY-PASS"/);
  const replay = spawnSync(process.execPath, ["blockchain/multi-host-launch-evidence-cli.mjs",
    "verify", path, values.plan.planHash, "0".repeat(32), "f".repeat(32), String(NOW),
    "--allow-insecure-localhost"],
  { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(replay.status, 0); assert.match(replay.stderr, /replayed/);
});
