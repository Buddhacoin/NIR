import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJson } from "../blockchain/crypto.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";
import {
  createValidatorReadinessProcessBootstrapSet,
  createValidatorReadinessSignerReady,
} from "../blockchain/validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessGatewayRuntimeReady,
  createValidatorReadinessRuntimeLaunchEnvelope,
} from "../blockchain/validator-readiness-runtime-protocol.mjs";
import {
  createValidatorReadinessGatewayActivationController,
  createValidatorReadinessGatewayChildFrameDecoder,
  createValidatorReadinessGatewayChildInput,
  createValidatorReadinessGatewayCommitAcknowledgement,
  createValidatorReadinessGatewayCommitCommand,
  createValidatorReadinessGatewayPrepareAcknowledgement,
  createValidatorReadinessGatewayPrepareCommand,
  encodeValidatorReadinessGatewayChildFrame,
  verifyValidatorReadinessGatewayChildInput,
  verifyValidatorReadinessGatewayCommitAcknowledgement,
  verifyValidatorReadinessGatewayCommitCommand,
  verifyValidatorReadinessGatewayPrepareAcknowledgement,
  verifyValidatorReadinessGatewayPrepareCommand,
} from "../blockchain/validator-readiness-gateway-child-protocol.mjs";
import { createValidatorReadinessSignerActivationAcknowledgement }
  from "../blockchain/validator-readiness-signer-child-protocol.mjs";
import {
  READINESS_SIGNER_NOW, validatorReadinessSignerFixture,
} from "./validator-readiness-signer-fixture.mjs";

const PIDS = Object.freeze({ consensus: 51_101, gateway: 51_100, transport: 51_102 });
const GATEWAY_PROCESS_NONCE = "71".repeat(32);

function setup() {
  const values = validatorReadinessSignerFixture();
  const consensusVault = encryptWallet(values.candidate, "gateway-protocol-consensus",
    { label: "Gateway protocol consensus" });
  const transportVault = encryptWallet(values.transport, "gateway-protocol-transport",
    { label: "Gateway protocol transport" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({ consensusVault,
    gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256, transportVault,
  }, { now: READINESS_SIGNER_NOW });
  const all = { ...values, ...bootstraps };
  const cohortBootstraps = { consensus: all.consensusSignerBootstrap,
    gateway: all.gatewayBootstrap, transport: all.transportSignerBootstrap };
  const inputPins = { expectedBootstrapHash: all.gatewayBootstrap.bootstrapHash,
    expectedBoundHost: "candidate.example", expectedBoundPort: 443,
    expectedLauncherNonce: all.launcherNonce,
    expectedReleaseProvenanceHash: all.session.releaseProvenanceHash,
    expectedSessionHash: all.session.sessionHash };
  const launchEnvelope = createValidatorReadinessRuntimeLaunchEnvelope({
    bootstrap: all.gatewayBootstrap,
    consensusSignerBootstrap: all.consensusSignerBootstrap,
    transportSignerBootstrap: all.transportSignerBootstrap,
  }, { expectedBootstrapHash: inputPins.expectedBootstrapHash,
    expectedLauncherNonce: inputPins.expectedLauncherNonce,
    expectedReleaseProvenanceHash: inputPins.expectedReleaseProvenanceHash,
    expectedRole: "gateway", expectedSessionHash: inputPins.expectedSessionHash,
  }, { now: READINESS_SIGNER_NOW });
  const gatewayInput = createValidatorReadinessGatewayChildInput({ cohortBootstraps,
    launchEnvelope }, inputPins, { now: READINESS_SIGNER_NOW });
  const readiness = {
    consensus: createValidatorReadinessSignerReady({ bootstrap: all.consensusSignerBootstrap,
      pid: PIDS.consensus, wallet: all.candidate }, { now: READINESS_SIGNER_NOW }),
    gateway: createValidatorReadinessGatewayRuntimeReady({ boundHost: inputPins.expectedBoundHost,
      boundPort: inputPins.expectedBoundPort, bootstrap: all.gatewayBootstrap, pid: PIDS.gateway,
      processNonce: GATEWAY_PROCESS_NONCE }, {
      expectedBootstrapHash: all.gatewayBootstrap.bootstrapHash,
      expectedLauncherNonce: all.launcherNonce,
      expectedReleaseProvenanceHash: all.session.releaseProvenanceHash,
      expectedRole: "gateway", expectedSessionHash: all.session.sessionHash,
    }),
    transport: createValidatorReadinessSignerReady({ bootstrap: all.transportSignerBootstrap,
      pid: PIDS.transport, wallet: all.transport }, { now: READINESS_SIGNER_NOW }),
  };
  const protocolPins = { ...inputPins, expectedConsensusPid: PIDS.consensus,
    expectedGatewayPid: PIDS.gateway, expectedTransportPid: PIDS.transport };
  return { ...all, cohortBootstraps, gatewayInput, inputPins, launchEnvelope, protocolPins,
    readiness };
}

function statusPins(values, role) {
  const ready = values.readiness[role];
  return { expectedBootstrapHash: values.cohortBootstraps[role].bootstrapHash,
    expectedLauncherNonce: values.launcherNonce, expectedPid: ready.pid,
    expectedProcessNonce: ready.processNonce,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedRole: role, expectedSessionHash: values.session.sessionHash };
}

function flow(values = setup()) {
  const prepare = createValidatorReadinessGatewayPrepareCommand({
    gatewayInput: values.gatewayInput, gatewayReady: values.readiness.gateway,
    readiness: values.readiness,
  }, values.protocolPins, { now: READINESS_SIGNER_NOW });
  const prepareAcknowledgement = createValidatorReadinessGatewayPrepareAcknowledgement({ prepare }, {
    gatewayInput: values.gatewayInput, gatewayReady: values.readiness.gateway,
    ...values.protocolPins,
  }, { now: READINESS_SIGNER_NOW });
  const signerAcknowledgements = Object.fromEntries(["consensus", "transport"].map((role) => [role,
    createValidatorReadinessSignerActivationAcknowledgement({ activation: prepare.activations[role] },
      statusPins(values, role))]));
  const commit = createValidatorReadinessGatewayCommitCommand({ gatewayInput: values.gatewayInput,
    gatewayReady: values.readiness.gateway, prepare, prepareAcknowledgement,
    signerAcknowledgements }, values.protocolPins, { now: READINESS_SIGNER_NOW });
  const commitAcknowledgement = createValidatorReadinessGatewayCommitAcknowledgement({ commit }, {
    expectedPrepare: prepare, expectedPrepareAcknowledgement: prepareAcknowledgement,
    gatewayInput: values.gatewayInput, gatewayReady: values.readiness.gateway,
    ...values.protocolPins,
  }, { now: READINESS_SIGNER_NOW });
  return { commit, commitAcknowledgement, prepare, prepareAcknowledgement,
    signerAcknowledgements, values };
}

function mutate(value, path, replacement) {
  const result = structuredClone(value); let cursor = result;
  for (const part of path.slice(0, -1)) cursor = cursor[part];
  cursor[path.at(-1)] = replacement;
  return result;
}

test("gateway child input binds the verified launch envelope, complete bootstrap cohort and local pins", () => {
  const values = setup();
  const verified = verifyValidatorReadinessGatewayChildInput(values.gatewayInput,
    values.inputPins, { now: READINESS_SIGNER_NOW });
  assert.equal(verified.inputHash, values.gatewayInput.inputHash);
  assert.equal(verified.cohortBootstraps.gateway.bootstrapHash,
    values.gatewayBootstrap.bootstrapHash);
  for (const mutation of [
    { ...values.gatewayInput, extra: true },
    mutate(values.gatewayInput, ["expectedBoundPort"], 444),
    mutate(values.gatewayInput, ["version"], 2),
    mutate(values.gatewayInput, ["expectedLauncherNonce"], "11".repeat(32)),
    mutate(values.gatewayInput, ["cohortBootstraps", "transport", "bootstrapHash"],
      `sha3-256:${"22".repeat(32)}`),
    mutate(values.gatewayInput, ["launchEnvelope", "envelopeHash"],
      `sha3-256:${"33".repeat(32)}`),
  ]) assert.throws(() => verifyValidatorReadinessGatewayChildInput(mutation,
    values.inputPins, { now: READINESS_SIGNER_NOW }));
  assert.throws(() => verifyValidatorReadinessGatewayChildInput(values.gatewayInput,
    { ...values.inputPins, expectedBoundPort: 444 }, { now: READINESS_SIGNER_NOW }), /binding/);
});

test("PREPARE and COMMIT bind independently verified READY, all activations and exact signer ACKs", () => {
  const result = flow();
  assert.deepEqual(verifyValidatorReadinessGatewayPrepareCommand(result.prepare, {
    gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
    ...result.values.protocolPins,
  }, { now: READINESS_SIGNER_NOW }), result.prepare);
  assert.deepEqual(verifyValidatorReadinessGatewayPrepareAcknowledgement(
    result.prepareAcknowledgement, { expectedPrepare: result.prepare,
      gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
      ...result.values.protocolPins }, { now: READINESS_SIGNER_NOW }),
  result.prepareAcknowledgement);
  assert.deepEqual(verifyValidatorReadinessGatewayCommitCommand(result.commit, {
    expectedPrepare: result.prepare,
    expectedPrepareAcknowledgement: result.prepareAcknowledgement,
    gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
    ...result.values.protocolPins,
  }, { now: READINESS_SIGNER_NOW }), result.commit);
  assert.deepEqual(verifyValidatorReadinessGatewayCommitAcknowledgement(
    result.commitAcknowledgement, { expectedCommit: result.commit,
      expectedPrepare: result.prepare,
      expectedPrepareAcknowledgement: result.prepareAcknowledgement,
      gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
      ...result.values.protocolPins }, { now: READINESS_SIGNER_NOW }),
  result.commitAcknowledgement);
  assert.deepEqual(Object.keys(result.commit.activationHashes).sort(),
    ["consensus", "gateway", "transport"]);
  assert.deepEqual(Object.keys(result.commit.signerAcknowledgementHashes).sort(),
    ["consensus", "transport"]);
});

test("prepare rejects foreign READY, PID, role, activation, hash and schema mutations", () => {
  const result = flow();
  const verify = (value, pins = result.values.protocolPins) =>
    verifyValidatorReadinessGatewayPrepareCommand(value, {
      gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
      ...pins,
    }, { now: READINESS_SIGNER_NOW });
  const mutations = [
    { ...result.prepare, extra: true },
    mutate(result.prepare, ["readiness", "consensus", "pid"], PIDS.consensus + 9),
    mutate(result.prepare, ["readiness", "gateway", "processNonce"], "44".repeat(32)),
    mutate(result.prepare, ["activations", "transport", "role"], "consensus"),
    mutate(result.prepare, ["activationHashes", "gateway"], `sha3-256:${"55".repeat(32)}`),
    mutate(result.prepare, ["readinessHash"], `sha3-256:${"66".repeat(32)}`),
    mutate(result.prepare, ["prepareHash"], `sha3-256:${"77".repeat(32)}`),
    mutate(result.prepare, ["version"], 2),
  ];
  for (const value of mutations) assert.throws(() => verify(value));
  assert.throws(() => verify(result.prepare,
    { ...result.values.protocolPins, expectedConsensusPid: PIDS.consensus + 1 }), /PID|binding/);
});

test("commit rejects shallow cohorts, substituted activations, ACKs, hashes and replays", () => {
  const result = flow();
  const verify = (value, prepare = result.prepare,
    prepareAcknowledgement = result.prepareAcknowledgement) =>
    verifyValidatorReadinessGatewayCommitCommand(value, { expectedPrepare: prepare,
      expectedPrepareAcknowledgement: prepareAcknowledgement,
      gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
      ...result.values.protocolPins,
    }, { now: READINESS_SIGNER_NOW });
  const mutations = [
    { ...result.commit, extra: true },
    mutate(result.commit, ["readiness", "transport", "pid"], PIDS.transport + 1),
    mutate(result.commit, ["activationHashes", "consensus"], `sha3-256:${"12".repeat(32)}`),
    mutate(result.commit, ["signerAcknowledgements", "transport", "activationHash"],
      result.prepare.activationHashes.consensus),
    mutate(result.commit, ["signerAcknowledgementHashes", "consensus"],
      `sha3-256:${"13".repeat(32)}`),
    mutate(result.commit, ["prepareAcknowledgementHash"], `sha3-256:${"14".repeat(32)}`),
    mutate(result.commit, ["commitHash"], `sha3-256:${"15".repeat(32)}`),
    mutate(result.commit, ["messageType"], "prepare"),
    mutate(result.commit, ["version"], 2),
  ];
  for (const value of mutations) assert.throws(() => verify(value));
  const foreign = flow();
  assert.throws(() => verify(result.commit, foreign.prepare,
    foreign.prepareAcknowledgement));
});

test("both gateway acknowledgements are exact, phase-specific and bound to retained commands", () => {
  const result = flow();
  const prepareOptions = { expectedPrepare: result.prepare,
    gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
    ...result.values.protocolPins };
  for (const mutation of [
    { ...result.prepareAcknowledgement, extra: true },
    mutate(result.prepareAcknowledgement, ["prepareHash"], `sha3-256:${"21".repeat(32)}`),
    mutate(result.prepareAcknowledgement, ["processNonce"], "22".repeat(32)),
    mutate(result.prepareAcknowledgement, ["messageType"], "commit-ack"),
    mutate(result.prepareAcknowledgement, ["version"], 2),
    mutate(result.prepareAcknowledgement, ["acknowledgementHash"],
      `sha3-256:${"23".repeat(32)}`),
  ]) assert.throws(() => verifyValidatorReadinessGatewayPrepareAcknowledgement(mutation,
    prepareOptions, { now: READINESS_SIGNER_NOW }));

  const commitOptions = { expectedCommit: result.commit, expectedPrepare: result.prepare,
    expectedPrepareAcknowledgement: result.prepareAcknowledgement,
    gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
    ...result.values.protocolPins };
  for (const mutation of [
    { ...result.commitAcknowledgement, extra: true },
    mutate(result.commitAcknowledgement, ["commitHash"], `sha3-256:${"24".repeat(32)}`),
    mutate(result.commitAcknowledgement, ["activationHash"],
      result.commit.activationHashes.consensus),
    mutate(result.commitAcknowledgement, ["pid"], PIDS.gateway + 1),
    mutate(result.commitAcknowledgement, ["messageType"], "prepare-ack"),
    mutate(result.commitAcknowledgement, ["version"], 2),
    mutate(result.commitAcknowledgement, ["acknowledgementHash"],
      `sha3-256:${"25".repeat(32)}`),
  ]) assert.throws(() => verifyValidatorReadinessGatewayCommitAcknowledgement(mutation,
    commitOptions, { now: READINESS_SIGNER_NOW }));
});

test("stateful gateway controller rejects commit-before-prepare and every duplicate or replay", () => {
  const result = flow();
  const controller = () => createValidatorReadinessGatewayActivationController({
    gatewayInput: result.values.gatewayInput, gatewayReady: result.values.readiness.gateway,
  }, result.values.protocolPins, { now: () => READINESS_SIGNER_NOW });

  const earlyCommit = controller();
  assert.throws(() => earlyCommit.commit(result.commit), /out of order/);
  assert.equal(earlyCommit.phase(), "closed");
  assert.throws(() => earlyCommit.prepare(result.prepare), /out of order/);

  const badPrepareFlush = controller();
  const badPrepareAck = badPrepareFlush.prepare(result.prepare);
  assert.equal(badPrepareFlush.phase(), "prepare-ack-pending");
  assert.throws(() => badPrepareFlush.commit(result.commit), /out of order/);
  assert.equal(badPrepareFlush.phase(), "closed");
  assert.throws(() => badPrepareFlush.prepareAcknowledgementFlushed(badPrepareAck),
    /out of order/);

  const forgedPrepareFlush = controller();
  const forgedPrepareAck = forgedPrepareFlush.prepare(result.prepare);
  assert.throws(() => forgedPrepareFlush.prepareAcknowledgementFlushed({ ...forgedPrepareAck,
    acknowledgementHash: `sha3-256:${"98".repeat(32)}` }), /out of order/);
  assert.equal(forgedPrepareFlush.phase(), "closed");
  assert.throws(() => forgedPrepareFlush.prepareAcknowledgementFlushed(forgedPrepareAck),
    /out of order/);

  const duplicatePrepare = controller();
  const duplicatePrepareAck = duplicatePrepare.prepare(result.prepare);
  assert.equal(duplicatePrepare.prepareAcknowledgementFlushed(duplicatePrepareAck), true);
  assert.throws(() => duplicatePrepare.prepare(result.prepare), /out of order/);
  assert.equal(duplicatePrepare.phase(), "closed");
  assert.throws(() => duplicatePrepare.commit(result.commit), /out of order/);

  const badCommitFlush = controller();
  const prepareAck = badCommitFlush.prepare(result.prepare);
  badCommitFlush.prepareAcknowledgementFlushed(prepareAck);
  const commitAck = badCommitFlush.commit(result.commit);
  assert.throws(() => badCommitFlush.commitAcknowledgementFlushed({ ...commitAck,
    acknowledgementHash: `sha3-256:${"99".repeat(32)}` }), /out of order/);
  assert.equal(badCommitFlush.phase(), "closed");
  assert.throws(() => badCommitFlush.commitAcknowledgementFlushed(commitAck), /out of order/);

  const success = controller();
  const successPrepareAck = success.prepare(result.prepare);
  assert.deepEqual(successPrepareAck, result.prepareAcknowledgement);
  assert.equal(success.prepareAcknowledgementFlushed(successPrepareAck), true);
  const successCommitAck = success.commit(result.commit);
  assert.deepEqual(successCommitAck, result.commitAcknowledgement);
  assert.equal(success.phase(), "commit-ack-pending");
  assert.equal(success.commitAcknowledgementFlushed(successCommitAck), true);
  assert.equal(success.phase(), "committed");
  success.close();
  assert.equal(success.phase(), "closed");
});

test("gateway child framing is canonical, bounded, fragmented and fail-closed on partial EOF", () => {
  const { prepare, commit } = flow();
  const frames = [prepare, commit].map(encodeValidatorReadinessGatewayChildFrame);
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.readUInt32BE(0), Buffer.byteLength(canonicalJson([prepare, commit][index])));
  }
  const decoder = createValidatorReadinessGatewayChildFrameDecoder(); const values = [];
  for (const byte of Buffer.concat(frames)) values.push(...decoder.push(Buffer.of(byte)));
  decoder.finish(); assert.deepEqual(values, [prepare, commit]);
  const partial = createValidatorReadinessGatewayChildFrameDecoder();
  partial.push(frames[0].subarray(0, 7));
  assert.throws(() => partial.finish(), /before completion/);
});

test("gateway child protocol has no process, network, filesystem, TLS-key or signer-key custody", () => {
  const source = readFileSync(new URL(
    "../blockchain/validator-readiness-gateway-child-protocol.mjs", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:net", "node:https", "node:fs",
    "process.env", "privateKey", "encryptedVault", "spawn("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
