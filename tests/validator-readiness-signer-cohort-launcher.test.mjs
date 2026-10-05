import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encryptWallet } from "../blockchain/vault.mjs";
import { createValidatorReadinessProcessBootstrapSet }
  from "../blockchain/validator-readiness-process-protocol.mjs";
import { createValidatorReadinessRuntimeLaunchEnvelope }
  from "../blockchain/validator-readiness-runtime-protocol.mjs";
import { createValidatorReadinessSignerChildInput }
  from "../blockchain/validator-readiness-signer-child-protocol.mjs";
import * as cohortLauncher from "../blockchain/validator-readiness-signer-cohort-launcher.mjs";
import { validatorReadinessSignerFixture } from "./validator-readiness-signer-fixture.mjs";

const TEST_TIMEOUT_MS = 8_000;
const { launchValidatorReadinessSignerCohort } = cohortLauncher;

function timeout(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), TEST_TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));
}

function pins(values, role, bootstrap) {
  return { expectedBootstrapHash: bootstrap.bootstrapHash,
    expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedRole: role, expectedSessionHash: values.session.sessionHash };
}

function fixture() {
  const now = Date.now(); const values = validatorReadinessSignerFixture({ now });
  const consensusPasswordText = "cohort-consensus-password";
  const transportPasswordText = "cohort-transport-password";
  const consensusPassword = Buffer.from(consensusPasswordText);
  const transportPassword = Buffer.from(transportPasswordText);
  const consensusVault = encryptWallet(values.candidate, consensusPasswordText,
    { label: "Cohort consensus child" });
  const transportVault = encryptWallet(values.transport, transportPasswordText,
    { label: "Cohort transport child" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({ consensusVault,
    gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256, transportVault,
  }, { now });
  Object.assign(values, bootstraps);
  const inputs = {};
  for (const [role, bootstrap, encryptedVault] of [
    ["consensus", values.consensusSignerBootstrap, consensusVault],
    ["transport", values.transportSignerBootstrap, transportVault],
  ]) {
    const expected = pins(values, role, bootstrap);
    const launchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap }, expected,
      { encryptedVault, now });
    inputs[role] = createValidatorReadinessSignerChildInput({ cohortBootstraps: {
      consensus: values.consensusSignerBootstrap, gateway: values.gatewayBootstrap,
      transport: values.transportSignerBootstrap,
    }, encryptedVault, launchEnvelope }, expected, { now });
  }
  return { consensusInput: inputs.consensus, consensusPasswordBuffer: consensusPassword,
    transportInput: inputs.transport, transportPasswordBuffer: transportPassword };
}

function allZero(value) { return value.every((byte) => byte === 0); }

test("real signer cohort launches both roles, verifies signed READY, and closes atomically", async () => {
  const input = fixture();
  const consensusPassword = input.consensusPasswordBuffer;
  const transportPassword = input.transportPasswordBuffer;
  const cohort = await timeout(launchValidatorReadinessSignerCohort(input), "cohort launch");
  assert.equal(cohort.productionActivated, false);
  assert.equal(cohort.state(), "signers-ready-awaiting-gateway");
  assert.notEqual(cohort.pids.consensus, cohort.pids.transport);
  assert.deepEqual(Reflect.ownKeys(cohort).sort(),
    ["close", "pids", "productionActivated", "readiness", "state", "waitForTermination"]);
  assert.equal(cohort.readiness.consensus.pid, cohort.pids.consensus);
  assert.equal(cohort.readiness.transport.pid, cohort.pids.transport);
  assert.ok(Object.isFrozen(cohort.readiness));
  assert.equal(allZero(consensusPassword), true);
  assert.equal(allZero(transportPassword), true);
  const firstClose = cohort.close(); const secondClose = cohort.close();
  assert.strictEqual(firstClose, secondClose);
  await timeout(firstClose, "cohort close");
  assert.equal(cohort.state(), "closed");
  assert.deepEqual(await cohort.waitForTermination(), { reason: "closed" });
});

test("one signer crash tears down the entire retained cohort", async () => {
  const cohort = await timeout(launchValidatorReadinessSignerCohort(fixture()), "cohort launch");
  process.kill(cohort.pids.transport, "SIGKILL");
  assert.deepEqual(await timeout(cohort.waitForTermination(), "cohort failure teardown"),
    { reason: "failed" });
  assert.equal(cohort.state(), "failed");
  assert.throws(() => process.kill(cohort.pids.consensus, 0), { code: "ESRCH" });
});

test("wrong password fails the whole launch, zeros both secrets, and returns no partial cohort", async () => {
  const input = fixture();
  input.transportPasswordBuffer.fill(0x78);
  const consensusPassword = input.consensusPasswordBuffer;
  const transportPassword = input.transportPasswordBuffer;
  await assert.rejects(timeout(launchValidatorReadinessSignerCohort(input), "bad cohort launch"),
    /cohort launch failed/);
  assert.equal(allZero(consensusPassword), true);
  assert.equal(allZero(transportPassword), true);
});

test("caller mutation after invocation cannot race the owned password writes", async () => {
  const input = fixture();
  const launch = launchValidatorReadinessSignerCohort(input);
  input.consensusPasswordBuffer.fill(0x78);
  input.transportPasswordBuffer.fill(0x79);
  const cohort = await timeout(launch, "owned-password cohort launch");
  await timeout(cohort.close(), "owned-password cohort close");
});

test("aliased password storage is rejected and zeroed before any process can launch", async () => {
  const input = fixture(); const shared = Buffer.from("aliased-cohort-password");
  input.consensusPasswordBuffer = shared.subarray(0);
  input.transportPasswordBuffer = shared.subarray(2);
  await assert.rejects(launchValidatorReadinessSignerCohort(input), /cohort launch failed/);
  assert.equal(allZero(shared), true);
});

test("launcher rejects an expanded caller-controlled process surface and zeros secrets", async () => {
  const input = fixture();
  const consensusPassword = input.consensusPasswordBuffer;
  const transportPassword = input.transportPasswordBuffer;
  input.env = { NODE_OPTIONS: "--require=attacker" };
  await assert.rejects(launchValidatorReadinessSignerCohort(input), /cohort launch failed/);
  assert.equal(allZero(consensusPassword), true);
  assert.equal(allZero(transportPassword), true);
});

test("cohort launcher has a fixed child path and no gateway or generic IPC claim", () => {
  assert.deepEqual(Object.keys(cohortLauncher), ["launchValidatorReadinessSignerCohort"]);
  const source = readFileSync(new URL(
    "../blockchain/validator-readiness-signer-cohort-launcher.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source,
    /process\.env|\b(?:exec|execFile|fork)\s*\(|["']ipc["']|password.*(?:argv|env)|gateway.*spawn/iu);
  assert.match(source, /productionActivated:\s*false/u);
  assert.match(source, /messagesSeen\s*!==\s*0/u);
  assert.match(source, /decoder\.hasPendingFrame\(\)/u);
  assert.match(source, /Promise\.allSettled\s*\(\s*\[/u);
  assert.match(source, /intentionally has no activation\s*\n\s*\* method/u);
  assert.equal((source.match(/export\s+(?:async\s+)?function/g) ?? []).length, 1);
});
