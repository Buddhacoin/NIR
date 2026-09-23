import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashObject } from "../blockchain/crypto.mjs";
import {
  runLocalTestnetPartitionRehearsal, runLocalTestnetPartitionRehearsalFile,
} from "../blockchain/testnet-drill-rehearsal.mjs";

const CHECKPOINT = `sha3-256:${"c".repeat(64)}`;
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function preflight() {
  const checks = [
    { details: { ageMs: 100, sources: 2 }, id: "backup-restore-freshness", status: "PASS" },
    { details: { eligible: 4, minimumBondAtomic: "1000000000" },
      id: "bonded-validator-eligibility", status: "PASS" },
    { details: { selectionHash: digest("selection"), witnesses: 3 },
      id: "external-witness-quorum", status: "PASS" },
    { details: { genesisHash: digest("genesis"), planCommitment: digest("plan") },
      id: "genesis", status: "PASS" },
    { details: { ingressProfiles: 4, ports: 14 }, id: "host-readiness", status: "PASS" },
    { details: { scannedFiles: 1 }, id: "public-artifact-scan", status: "PASS" },
    { details: { bundleHash: `sha3-256:${"b".repeat(64)}`, checkpointHash: CHECKPOINT,
      sequence: 1 }, id: "release", status: "PASS" },
    { details: { identities: 18, operators: 14, tlsPins: 4 },
      id: "role-and-key-separation", status: "PASS" },
  ];
  const payload = { checks, format: "nir-developer-testnet-preflight-report-v1",
    networkId: "nir-local-rehearsal-devnet", observedAt: Date.now(),
    summary: { failed: 0, passed: 8, status: "PASS" }, version: 1 };
  return { ...payload, reportHash: hashObject(payload, "DEVELOPER_TESTNET_PREFLIGHT_REPORT_V1") };
}

function assertCleanFailure(error) {
  assert.equal(error.cleanupReport?.status, "PASS");
  assert.equal(error.cleanupReport?.rootRemoved, true);
  assert.equal(error.cleanupReport?.attempted, error.cleanupReport?.exited);
  return true;
}

test("local adapter harness emits honest authenticated FAIL evidence and cleans every process", async () => {
  const result = await runLocalTestnetPartitionRehearsal(preflight());
  assert.equal(result.validation.status, "FAIL");
  assert.equal(result.evidence.scenarios.length, 7);
  const messageScenario = result.evidence.scenarios.find(({ id }) =>
    id === "04-delayed-replayed-messages");
  assert.equal(messageScenario.outcome, "FAIL");
  assert.ok(messageScenario.observations.filter(({ id }) =>
    id.startsWith("replay-rejected:")).every(({ result: value }) => value === "PASS"));
  assert.ok(messageScenario.observations.filter(({ id }) =>
    id.startsWith("converged:")).every(({ result: value }) => value === "FAIL"));
  assert.equal(result.rehearsal.harnessStatus, "PASS");
  assert.equal(Object.hasOwn(result.rehearsal, "status"), false);
  assert.equal(result.rehearsal.authenticatedDrillStatus, "FAIL");
  assert.equal(result.rehearsal.adapterCount, 10);
  assert.equal(result.rehearsal.externalNetwork, false);
  assert.equal(result.rehearsal.faultLayer, "application");
  assert.deepEqual(result.cleanup, { attempted: 10, exited: 10, failures: [], forced: 0,
    rootRemoved: true, status: "PASS" });
});

test("controller cannot request PASS for locally unobserved message events", async () => {
  const result = await runLocalTestnetPartitionRehearsal(preflight(), { _skipMessageEvents: true });
  const messages = result.evidence.scenarios.find(({ id }) =>
    id === "04-delayed-replayed-messages");
  assert.equal(messages.outcome, "FAIL");
  assert.ok(messages.observations.every(({ result: observationResult }) =>
    observationResult === "FAIL"));
  assert.equal(result.validation.status, "FAIL");
});

test("crashed adapter fails closed and process group cleanup still completes", async () => {
  await assert.rejects(runLocalTestnetPartitionRehearsal(preflight(), { _crashAfterStart: 3,
    rpcTimeoutMs: 300 }), assertCleanFailure);
});

test("hung scenario is bounded and fails with a cleanup report", async () => {
  const started = Date.now();
  await assert.rejects(runLocalTestnetPartitionRehearsal(preflight(), {
    _hangScenario: "01-validator-outage", scenarioTimeoutMs: 100,
  }), assertCleanFailure);
  assert.ok(Date.now() - started < 10_000);
});

test("partial start failure cleans only processes already owned", async () => {
  await assert.rejects(runLocalTestnetPartitionRehearsal(preflight(), {
    _beforeSpawn({ index }) { if (index === 2) throw new Error("injected partial start"); },
  }), (error) => {
    assert.match(error.message, /partial start/); assert.equal(error.cleanupReport.attempted, 2);
    return assertCleanFailure(error);
  });
});

test("port race cannot redirect or silently reuse an occupied loopback port", async () => {
  let racer;
  try {
    await assert.rejects(runLocalTestnetPartitionRehearsal(preflight(), {
      async _afterPortRelease({ index, port }) {
        if (index !== 0) return;
        racer = createServer();
        await new Promise((resolve, reject) => {
          racer.once("error", reject); racer.listen(port, "127.0.0.1", resolve);
        });
      }, startupTimeoutMs: 300,
    }), assertCleanFailure);
  } finally {
    if (racer?.listening) await new Promise((resolve) => racer.close(resolve));
  }
});

test("CLI input is descriptor-bound and rejects a symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-rehearsal-input-test-"));
  try {
    const real = join(root, "real.json"); const link = join(root, "link.json");
    writeFileSync(real, JSON.stringify(preflight()), { mode: 0o600 }); symlinkSync(real, link);
    await assert.rejects(runLocalTestnetPartitionRehearsalFile(link), /ELOOP|unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
