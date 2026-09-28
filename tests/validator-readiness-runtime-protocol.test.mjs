import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encryptWallet } from "../blockchain/vault.mjs";
import {
  createValidatorReadinessHeightUpdate,
  createValidatorReadinessProcessBootstrapSet,
  createValidatorReadinessSignerReady,
  verifyValidatorReadinessSignerReady,
} from "../blockchain/validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessFatalStatus,
  createValidatorReadinessGatewayRuntimeReady,
  createValidatorReadinessHeightAcknowledgement,
  createValidatorReadinessLaunchActivation,
  createValidatorReadinessRuntimeFrameDecoder,
  createValidatorReadinessRuntimeLaunchEnvelope,
  encodeValidatorReadinessRuntimeFrame,
  verifyValidatorReadinessFatalStatus,
  verifyValidatorReadinessGatewayRuntimeReady,
  verifyValidatorReadinessHeightAcknowledgement,
  verifyValidatorReadinessLaunchActivation,
  verifyValidatorReadinessRuntimeLaunchEnvelope,
} from "../blockchain/validator-readiness-runtime-protocol.mjs";
import {
  READINESS_SIGNER_NOW, validatorReadinessSignerFixture,
} from "./validator-readiness-signer-fixture.mjs";

const PID = 43_210;
const PROCESS_NONCE = "77".repeat(32);

function setup() {
  const values = validatorReadinessSignerFixture();
  const consensusVault = encryptWallet(values.candidate, "runtime-consensus-password",
    { label: "Runtime consensus" });
  const transportVault = encryptWallet(values.transport, "runtime-transport-password",
    { label: "Runtime transport" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({ consensusVault,
    gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256, transportVault,
  }, { now: READINESS_SIGNER_NOW });
  return { ...values, ...bootstraps, consensusVault, transportVault };
}

function pins(values, role, bootstrap = values[`${role}SignerBootstrap`] ??
  values.gatewayBootstrap) {
  return { expectedBootstrapHash: bootstrap.bootstrapHash,
    expectedLauncherNonce: values.launcherNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedRole: role, expectedSessionHash: values.session.sessionHash };
}

function statusPins(values, role, bootstrap) {
  return { ...pins(values, role, bootstrap), expectedPid: PID,
    expectedProcessNonce: PROCESS_NONCE };
}

function runtimeOptions(values, role) {
  return { encryptedVault: role === "consensus" ? values.consensusVault
    : role === "transport" ? values.transportVault : undefined, now: READINESS_SIGNER_NOW };
}

function mutate(value, path, replacement) {
  const result = structuredClone(value); let cursor = result;
  for (const part of path.slice(0, -1)) cursor = cursor[part];
  cursor[path.at(-1)] = replacement; return result;
}

test("role-specific launch envelopes bind external launcher-local pins", () => {
  const values = setup();
  for (const [role, bootstrap] of [["consensus", values.consensusSignerBootstrap],
    ["transport", values.transportSignerBootstrap]]) {
    const envelope = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap },
      pins(values, role, bootstrap), runtimeOptions(values, role));
    const verified = verifyValidatorReadinessRuntimeLaunchEnvelope(envelope,
      pins(values, role, bootstrap), runtimeOptions(values, role));
    assert.equal(verified.bootstrap.bootstrapHash, bootstrap.bootstrapHash);
    assert.equal(verified.role, role);
  }
  const gateway = createValidatorReadinessRuntimeLaunchEnvelope({
    bootstrap: values.gatewayBootstrap,
    consensusSignerBootstrap: values.consensusSignerBootstrap,
    transportSignerBootstrap: values.transportSignerBootstrap,
  }, pins(values, "gateway", values.gatewayBootstrap), runtimeOptions(values, "gateway"));
  const verified = verifyValidatorReadinessRuntimeLaunchEnvelope(gateway,
    pins(values, "gateway", values.gatewayBootstrap), runtimeOptions(values, "gateway"));
  assert.equal(verified.consensusSignerBootstrap.bootstrapHash,
    values.consensusSignerBootstrap.bootstrapHash);
  assert.equal(verified.transportSignerBootstrap.bootstrapHash,
    values.transportSignerBootstrap.bootstrapHash);
});

test("launch verification rejects cross-role, session, launch, bootstrap and schema mutations", () => {
  const values = setup(); const bootstrap = values.consensusSignerBootstrap;
  const expected = pins(values, "consensus", bootstrap);
  const options = runtimeOptions(values, "consensus");
  const envelope = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap }, expected, options);
  const mutations = [
    mutate(envelope, ["role"], "transport"),
    mutate(envelope, ["format"], "nir-validator-readiness-transport-runtime-launch-v1"),
    mutate(envelope, ["anchor", "sessionHash"], "sha3-256:" + "11".repeat(32)),
    mutate(envelope, ["anchor", "launcherNonce"], "22".repeat(32)),
    mutate(envelope, ["anchor", "bootstrapHash"], "sha3-256:" + "33".repeat(32)),
    mutate(envelope, ["bootstrap", "bootstrapHash"], "sha3-256:" + "44".repeat(32)),
    { ...envelope, bootstrap: { ...envelope.bootstrap, localVaultPath: "/private/key" } },
    { ...envelope, unexpected: true },
  ];
  for (const item of mutations) {
    assert.throws(() => verifyValidatorReadinessRuntimeLaunchEnvelope(item, expected, options));
  }
  assert.throws(() => verifyValidatorReadinessRuntimeLaunchEnvelope(envelope,
    { ...expected, expectedSessionHash: "sha3-256:" + "55".repeat(32) }, options), /binding|pin/);
  assert.throws(() => verifyValidatorReadinessRuntimeLaunchEnvelope(envelope,
    { ...expected, expectedRole: "transport" }, runtimeOptions(values, "transport")),
  /role|fields|binding/);
  const internallyInconsistent = structuredClone(bootstrap);
  internallyInconsistent.rolePackage.session.sessionId = "a".repeat(64);
  assert.throws(() => createValidatorReadinessRuntimeLaunchEnvelope({
    bootstrap: internallyInconsistent,
  }, expected, options), /session hash|bootstrap/);
});

test("gateway launch cannot swap or omit either signer bootstrap", () => {
  const values = setup(); const expected = pins(values, "gateway", values.gatewayBootstrap);
  const envelope = createValidatorReadinessRuntimeLaunchEnvelope({
    bootstrap: values.gatewayBootstrap,
    consensusSignerBootstrap: values.consensusSignerBootstrap,
    transportSignerBootstrap: values.transportSignerBootstrap,
  }, expected, runtimeOptions(values, "gateway"));
  assert.throws(() => verifyValidatorReadinessRuntimeLaunchEnvelope({ ...envelope,
    consensusSignerBootstrap: values.transportSignerBootstrap }, expected,
  runtimeOptions(values, "gateway")), /binding|role/);
  const missing = structuredClone(envelope); delete missing.transportSignerBootstrap;
  assert.throws(() => verifyValidatorReadinessRuntimeLaunchEnvelope(missing, expected,
    runtimeOptions(values, "gateway")),
    /unknown or missing fields/);
});

test("unsigned gateway READY is exact and pinned to inherited-channel expectations", () => {
  const values = setup(); const expected = pins(values, "gateway", values.gatewayBootstrap);
  const ready = createValidatorReadinessGatewayRuntimeReady({ boundHost: "127.0.0.1",
    boundPort: 9443, bootstrap: values.gatewayBootstrap, pid: PID,
    processNonce: PROCESS_NONCE }, expected);
  const verified = verifyValidatorReadinessGatewayRuntimeReady(ready, {
    ...expected, expectedBoundHost: "127.0.0.1", expectedBoundPort: 9443, expectedPid: PID,
    expectedTlsCertificateSha256: values.gatewayBootstrap.tlsCertificateSha256,
  });
  assert.equal(verified.pid, PID);
  assert.equal(verified.processNonce, PROCESS_NONCE);
  for (const [field, replacement] of [["pid", PID + 1], ["messageType", "fatal"],
    ["boundPort", 9444], ["launcherNonce", "88".repeat(32)],
    ["bootstrapHash", "sha3-256:" + "99".repeat(32)]]) {
    assert.throws(() => verifyValidatorReadinessGatewayRuntimeReady(
      { ...ready, [field]: replacement }, { ...expected, expectedBoundHost: "127.0.0.1",
        expectedBoundPort: 9443, expectedPid: PID,
        expectedTlsCertificateSha256: values.gatewayBootstrap.tlsCertificateSha256 }));
  }
  assert.throws(() => verifyValidatorReadinessGatewayRuntimeReady(ready, {
    ...expected, expectedBoundHost: "127.0.0.1", expectedBoundPort: 9443, expectedPid: PID,
    expectedTlsCertificateSha256: "0".repeat(64),
  }), /certificate pin/);
});

test("atomic activation binds every verified READY before any role may become active", () => {
  const values = setup();
  const consensus = createValidatorReadinessSignerReady({
    bootstrap: values.consensusSignerBootstrap, pid: PID + 1, wallet: values.candidate,
  }, { now: READINESS_SIGNER_NOW });
  const gateway = createValidatorReadinessGatewayRuntimeReady({ boundHost: "127.0.0.1",
    boundPort: 9443, bootstrap: values.gatewayBootstrap, pid: PID,
    processNonce: PROCESS_NONCE }, pins(values, "gateway", values.gatewayBootstrap));
  const transport = createValidatorReadinessSignerReady({
    bootstrap: values.transportSignerBootstrap, pid: PID + 2, wallet: values.transport,
  }, { now: READINESS_SIGNER_NOW });
  const readiness = {
    consensus: verifyValidatorReadinessSignerReady(consensus, {
      bootstrap: values.consensusSignerBootstrap, expectedRole: "consensus",
      expectedLauncherNonce: values.launcherNonce, expectedPid: PID + 1,
      expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
      expectedSessionHash: values.session.sessionHash, now: READINESS_SIGNER_NOW,
    }),
    gateway: verifyValidatorReadinessGatewayRuntimeReady(gateway, {
      ...pins(values, "gateway", values.gatewayBootstrap), expectedBoundHost: "127.0.0.1",
      expectedBoundPort: 9443, expectedPid: PID,
      expectedTlsCertificateSha256: values.gatewayBootstrap.tlsCertificateSha256,
    }),
    transport: verifyValidatorReadinessSignerReady(transport, {
      bootstrap: values.transportSignerBootstrap, expectedRole: "transport",
      expectedLauncherNonce: values.launcherNonce, expectedPid: PID + 2,
      expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
      expectedSessionHash: values.session.sessionHash, now: READINESS_SIGNER_NOW,
    }),
  };
  for (const [role, ready, bootstrap] of [["consensus", consensus,
    values.consensusSignerBootstrap], ["gateway", gateway, values.gatewayBootstrap],
  ["transport", transport, values.transportSignerBootstrap]]) {
    const expected = { ...pins(values, role, bootstrap), expectedPid: ready.pid,
      expectedProcessNonce: ready.processNonce };
    const activation = createValidatorReadinessLaunchActivation({ readiness }, expected);
    assert.deepEqual(verifyValidatorReadinessLaunchActivation(activation, {
      ...expected, expectedReadiness: readiness,
    }), activation);
    const incomplete = structuredClone(readiness); delete incomplete.transport;
    assert.throws(() => createValidatorReadinessLaunchActivation({ readiness: incomplete }, expected));
    assert.throws(() => verifyValidatorReadinessLaunchActivation({
      ...activation, cohort: { ...activation.cohort,
        gateway: { ...activation.cohort.gateway, readyHash: consensus.readyHash } },
    }, { ...expected, expectedReadiness: readiness }), /binding/);
  }
});

test("height acknowledgements are role-specific and bind the exact update and process", () => {
  const values = setup(); const bootstrap = values.consensusSignerBootstrap;
  const heightUpdate = createValidatorReadinessHeightUpdate({ bootstrap,
    height: bootstrap.initialHeight + 1 }, { now: READINESS_SIGNER_NOW });
  const expected = statusPins(values, "consensus", bootstrap);
  const ack = createValidatorReadinessHeightAcknowledgement({ heightUpdate }, expected);
  assert.equal(verifyValidatorReadinessHeightAcknowledgement(ack,
    { ...expected, expectedHeightUpdate: heightUpdate }).height, heightUpdate.height);
  assert.throws(() => verifyValidatorReadinessHeightAcknowledgement(ack,
    { ...expected, expectedRole: "transport", expectedHeightUpdate: heightUpdate }),
  /role|format|binding/);
  assert.throws(() => verifyValidatorReadinessHeightAcknowledgement(ack,
    { ...expected, expectedProcessNonce: "aa".repeat(32), expectedHeightUpdate: heightUpdate }),
  /binding/);
  assert.throws(() => verifyValidatorReadinessHeightAcknowledgement(ack,
    { ...expected, expectedHeightUpdate: { ...heightUpdate, height: heightUpdate.height + 1 } }),
  /binding/);
  assert.throws(() => verifyValidatorReadinessHeightAcknowledgement(
    { ...ack, messageType: "ready" }, { ...expected, expectedHeightUpdate: heightUpdate }),
  /binding/);
});

test("fatal status exposes only a bounded code and exact role/process pins", () => {
  const values = setup(); const bootstrap = values.transportSignerBootstrap;
  const expected = statusPins(values, "transport", bootstrap);
  const fatal = createValidatorReadinessFatalStatus({ code: "channel-failed" }, expected);
  assert.equal(verifyValidatorReadinessFatalStatus(fatal, expected).code, "channel-failed");
  assert.equal(verifyValidatorReadinessFatalStatus(fatal,
    { ...expected, expectedCode: "channel-failed" }).code, "channel-failed");
  assert.throws(() => createValidatorReadinessFatalStatus(
    { code: "arbitrary secret-bearing detail" }, expected), /binding/);
  assert.throws(() => verifyValidatorReadinessFatalStatus(fatal,
    { ...expected, expectedCode: "shutdown" }), /binding/);
  assert.throws(() => verifyValidatorReadinessFatalStatus({ ...fatal, detail: "leak" },
    { ...expected, expectedCode: "channel-failed" }), /unknown or missing fields/);
  assert.throws(() => verifyValidatorReadinessFatalStatus(fatal,
    { ...expected, expectedPid: PID + 1, expectedCode: "channel-failed" }), /binding/);
});

test("runtime framing handles fragmentation/coalescing and poisons partial EOF", () => {
  const values = setup(); const bootstrap = values.transportSignerBootstrap;
  const expected = pins(values, "transport", bootstrap);
  const launch = createValidatorReadinessRuntimeLaunchEnvelope({ bootstrap }, expected,
    runtimeOptions(values, "transport"));
  const fatal = createValidatorReadinessFatalStatus({ code: "shutdown" },
    statusPins(values, "transport", bootstrap));
  const bytes = Buffer.concat([encodeValidatorReadinessRuntimeFrame(launch),
    encodeValidatorReadinessRuntimeFrame(fatal)]);
  const decoder = createValidatorReadinessRuntimeFrameDecoder(); const messages = [];
  for (let index = 0; index < bytes.length; index += 7) {
    messages.push(...decoder.push(bytes.subarray(index, index + 7)));
  }
  decoder.finish();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].messageType, "launch");
  assert.equal(messages[1].messageType, "fatal");

  const partial = createValidatorReadinessRuntimeFrameDecoder();
  partial.push(bytes.subarray(0, 9));
  assert.throws(() => partial.finish(), /ended before completion/);
  assert.throws(() => partial.push(Buffer.from("x")), /poisoned/);
});

test("runtime protocol source cannot read secrets, paths, environment, or launch processes", () => {
  const source = readFileSync(new URL(
    "../blockchain/validator-readiness-runtime-protocol.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source,
    /from\s+["']node:(?:fs|child_process|process)["']|process\.env|decryptWallet|privateKey/);
});
