import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encryptWallet } from "../blockchain/vault.mjs";
import {
  createValidatorReadinessProcessBootstrapSet,
  createValidatorReadinessSignerReady,
} from "../blockchain/validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessGatewayRuntimeReady,
  createValidatorReadinessLaunchActivation,
  createValidatorReadinessRuntimeLaunchEnvelope,
} from "../blockchain/validator-readiness-runtime-protocol.mjs";
import {
  createValidatorReadinessSignerActivationAcknowledgement,
  createValidatorReadinessSignerActivationCommand,
  createValidatorReadinessSignerChildFrameDecoder,
  createValidatorReadinessSignerChildInput,
  encodeValidatorReadinessSignerChildFrame,
  verifyValidatorReadinessSignerActivationAcknowledgement,
  verifyValidatorReadinessSignerActivationCommand,
  verifyValidatorReadinessSignerChildInput,
} from "../blockchain/validator-readiness-signer-child-protocol.mjs";
import {
  READINESS_SIGNER_NOW, validatorReadinessSignerFixture,
} from "./validator-readiness-signer-fixture.mjs";

const PIDS = Object.freeze({ consensus: 43_211, gateway: 43_210, transport: 43_212 });
const GATEWAY_NONCE = "77".repeat(32);

function setup(role = "consensus") {
  const values = validatorReadinessSignerFixture();
  const consensusVault = encryptWallet(values.candidate, "child-consensus-password",
    { label: "Child consensus" });
  const transportVault = encryptWallet(values.transport, "child-transport-password",
    { label: "Child transport" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({ consensusVault,
    gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256, transportVault,
  }, { now: READINESS_SIGNER_NOW });
  const all = { ...values, ...bootstraps, consensusVault, transportVault };
  const bootstrap = role === "consensus" ? all.consensusSignerBootstrap
    : all.transportSignerBootstrap;
  const encryptedVault = role === "consensus" ? consensusVault : transportVault;
  const pins = { expectedBootstrapHash: bootstrap.bootstrapHash,
    expectedLauncherNonce: all.launcherNonce,
    expectedReleaseProvenanceHash: all.session.releaseProvenanceHash,
    expectedRole: role, expectedSessionHash: all.session.sessionHash };
  const launchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap }, pins,
    { encryptedVault, now: READINESS_SIGNER_NOW });
  const cohortBootstraps = { consensus: all.consensusSignerBootstrap,
    gateway: all.gatewayBootstrap, transport: all.transportSignerBootstrap };
  const signerInput = createValidatorReadinessSignerChildInput({ cohortBootstraps,
    encryptedVault, launchEnvelope }, pins, { now: READINESS_SIGNER_NOW });
  return { ...all, bootstrap, cohortBootstraps, encryptedVault, launchEnvelope, pins, role,
    signerInput };
}

function readiness(values) {
  return {
    consensus: createValidatorReadinessSignerReady({
      bootstrap: values.consensusSignerBootstrap, pid: PIDS.consensus, wallet: values.candidate,
    }, { now: READINESS_SIGNER_NOW }),
    gateway: createValidatorReadinessGatewayRuntimeReady({ boundHost: "candidate.example",
      boundPort: 443, bootstrap: values.gatewayBootstrap, pid: PIDS.gateway,
      processNonce: GATEWAY_NONCE }, {
      expectedBootstrapHash: values.gatewayBootstrap.bootstrapHash,
      expectedLauncherNonce: values.launcherNonce,
      expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
      expectedRole: "gateway", expectedSessionHash: values.session.sessionHash,
    }),
    transport: createValidatorReadinessSignerReady({
      bootstrap: values.transportSignerBootstrap, pid: PIDS.transport, wallet: values.transport,
    }, { now: READINESS_SIGNER_NOW }),
  };
}

function statusPins(values, ready) {
  return { ...values.pins, expectedPid: ready.pid, expectedProcessNonce: ready.processNonce };
}

function activation(values, set) {
  return createValidatorReadinessLaunchActivation({ readiness: set },
    statusPins(values, set[values.role]));
}

function mutate(value, path, replacement) {
  const result = structuredClone(value); let cursor = result;
  for (const part of path.slice(0, -1)) cursor = cursor[part];
  cursor[path.at(-1)] = replacement; return result;
}

test("trusted signer child input binds launch, vault, external pins and the complete cohort", () => {
  for (const role of ["consensus", "transport"]) {
    const values = setup(role);
    const verified = verifyValidatorReadinessSignerChildInput(values.signerInput,
      { expectedRole: role, now: READINESS_SIGNER_NOW });
    assert.equal(verified.role, role);
    assert.equal(verified.launchEnvelope.bootstrap.bootstrapHash, values.bootstrap.bootstrapHash);
    assert.equal(verified.cohortBootstraps.gateway.bootstrapHash,
      values.gatewayBootstrap.bootstrapHash);
    assert.equal(JSON.stringify(verified).includes("privateKey"), false);
  }
});

test("signer child input rejects role, pin, vault, cohort and exact-schema mutations", () => {
  const values = setup("consensus");
  const foreign = setup("consensus");
  const mutations = [
    mutate(values.signerInput, ["role"], "transport"),
    mutate(values.signerInput, ["expectedSessionHash"], "sha3-256:" + "11".repeat(32)),
    mutate(values.signerInput, ["expectedLauncherNonce"], "22".repeat(32)),
    mutate(values.signerInput, ["encryptedVault", "label"], "Substituted vault"),
    mutate(values.signerInput, ["cohortBootstraps", "transport", "bootstrapHash"],
      "sha3-256:" + "33".repeat(32)),
    // A complete, internally valid bootstrap from a different launch must not be hidden inside
    // an otherwise unchanged package; the gateway bootstrap commits the exact three-role cohort.
    mutate(values.signerInput, ["cohortBootstraps", "transport"],
      foreign.transportSignerBootstrap),
    { ...values.signerInput, vaultPath: "/private/vault" },
  ];
  for (const item of mutations) assert.throws(() => verifyValidatorReadinessSignerChildInput(item,
    { expectedRole: "consensus", now: READINESS_SIGNER_NOW }));
  assert.throws(() => verifyValidatorReadinessSignerChildInput(values.signerInput,
    { expectedRole: "transport", now: READINESS_SIGNER_NOW }), /role/);
});

test("activation command verifies a separately supplied cryptographic READY set", () => {
  for (const role of ["consensus", "transport"]) {
    const values = setup(role); const set = readiness(values);
    const active = activation(values, set);
    const command = createValidatorReadinessSignerActivationCommand({ activation: active,
      readiness: set }, { expectedRole: role, signerInput: values.signerInput,
      now: READINESS_SIGNER_NOW });
    const verified = verifyValidatorReadinessSignerActivationCommand(command, {
      expectedOwnReady: set[role], expectedRole: role, signerInput: values.signerInput,
      now: READINESS_SIGNER_NOW,
    });
    assert.equal(verified.activation.activationHash, active.activationHash);
    assert.deepEqual(verified.readiness[role], set[role]);
  }
});

test("activation cannot use its own cohort as a tautological readiness authority", () => {
  const values = setup("consensus"); const set = readiness(values);
  const active = activation(values, set);
  const command = createValidatorReadinessSignerActivationCommand({ activation: active,
    readiness: set }, { expectedRole: "consensus", signerInput: values.signerInput,
    now: READINESS_SIGNER_NOW });
  assert.throws(() => verifyValidatorReadinessSignerActivationCommand(command, {
    expectedOwnReady: { ...set.consensus, processNonce: "44".repeat(32) },
    expectedRole: "consensus", signerInput: values.signerInput, now: READINESS_SIGNER_NOW,
  }), /own readiness/);

  const forgedReadiness = mutate(command, ["readiness", "transport", "pid"],
    PIDS.transport + 99);
  forgedReadiness.activation.cohort.transport.pid = PIDS.transport + 99;
  assert.throws(() => verifyValidatorReadinessSignerActivationCommand(forgedReadiness, {
    expectedOwnReady: set.consensus, expectedRole: "consensus",
    signerInput: values.signerInput, now: READINESS_SIGNER_NOW,
  }), /PID|proof|signature|command/);
  assert.throws(() => verifyValidatorReadinessSignerActivationCommand(
    { ...command, readiness: command.activation.cohort }, {
      expectedOwnReady: set.consensus, expectedRole: "consensus",
      signerInput: values.signerInput, now: READINESS_SIGNER_NOW,
    }));
});

test("role-specific activation acknowledgement binds activation, PID and process nonce", () => {
  const values = setup("transport"); const set = readiness(values);
  const active = activation(values, set); const pins = statusPins(values, set.transport);
  const acknowledgement = createValidatorReadinessSignerActivationAcknowledgement(
    { activation: active }, pins);
  assert.deepEqual(verifyValidatorReadinessSignerActivationAcknowledgement(acknowledgement,
    { ...pins, expectedActivation: active }), acknowledgement);
  for (const changed of [
    { ...pins, expectedPid: pins.expectedPid + 1, expectedActivation: active },
    { ...pins, expectedProcessNonce: "55".repeat(32), expectedActivation: active },
    { ...pins, expectedRole: "consensus", expectedActivation: active },
    { ...pins, expectedActivation: { ...active, activationHash: "sha3-256:" + "66".repeat(32) } },
  ]) assert.throws(() => verifyValidatorReadinessSignerActivationAcknowledgement(
    acknowledgement, changed));
  assert.throws(() => verifyValidatorReadinessSignerActivationAcknowledgement(
    { ...acknowledgement, messageType: "height-ack" },
    { ...pins, expectedActivation: active }), /binding/);
});

test("signer child framing accepts fragmentation/coalescing and poisons partial EOF", () => {
  const values = setup("transport"); const set = readiness(values);
  const active = activation(values, set);
  const command = createValidatorReadinessSignerActivationCommand({ activation: active,
    readiness: set }, { expectedRole: "transport", signerInput: values.signerInput,
    now: READINESS_SIGNER_NOW });
  const bytes = Buffer.concat([encodeValidatorReadinessSignerChildFrame(values.signerInput),
    encodeValidatorReadinessSignerChildFrame(command)]);
  const decoder = createValidatorReadinessSignerChildFrameDecoder(); const messages = [];
  for (let offset = 0; offset < bytes.length; offset += 11) {
    messages.push(...decoder.push(bytes.subarray(offset, offset + 11)));
  }
  decoder.finish(); assert.equal(messages.length, 2);
  const partial = createValidatorReadinessSignerChildFrameDecoder();
  partial.push(bytes.subarray(0, 13));
  assert.throws(() => partial.finish(), /ended before completion/);
  assert.throws(() => partial.push(Buffer.from("x")), /poisoned/);
});

test("signer child protocol cannot spawn, network, read paths, environment, or private keys", () => {
  const source = readFileSync(new URL(
    "../blockchain/validator-readiness-signer-child-protocol.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source,
    /from\s+["']node:(?:child_process|net|http|https|fs)["']|process\.env|privateKey|decryptWallet|readFile/);
});
