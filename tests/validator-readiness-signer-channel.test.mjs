import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";

import { signObject } from "../blockchain/crypto.mjs";
import { respondToValidatorAdmissionReadinessChallenge }
  from "../blockchain/validator-admission-readiness-responder.mjs";
import {
  createValidatorAdmissionReadinessChallenge,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
  verifyValidatorAdmissionReadinessCandidateResponse,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import {
  createValidatorReadinessConsensusSignerAdapter,
  createValidatorReadinessConsensusSignerEndpoint,
  createValidatorReadinessTransportSignerAdapter,
  createValidatorReadinessTransportSignerEndpoint,
} from "../blockchain/validator-readiness-signer-channel.mjs";
import {
  createValidatorReadinessConsensusSignRequest,
  createValidatorReadinessSignerFrameDecoder,
  createValidatorReadinessTransportSignRequest,
  createValidatorReadinessTransportSignResponse,
  encodeValidatorReadinessSignerFrame,
  verifyValidatorReadinessTransportSignRequest,
  verifyValidatorReadinessTransportSignResponse,
} from "../blockchain/validator-readiness-signer-protocol.mjs";
import {
  READINESS_SIGNER_NOW, validatorReadinessSignerFixture,
} from "./validator-readiness-signer-fixture.mjs";

class MemoryDuplex extends Duplex {
  blockWrites = false;
  peer = null;
  _read() {}
  _write(chunk, _encoding, callback) {
    if (this.blockWrites) return;
    if (!this.peer || this.peer.destroyed || this.peer.readableEnded) {
      callback(new Error("memory peer is unavailable")); return;
    }
    this.peer.push(Buffer.from(chunk)); callback();
  }
  _final(callback) { if (this.peer && !this.peer.destroyed) this.peer.push(null); callback(); }
  _destroy(error, callback) {
    if (this.peer && !this.peer.destroyed && !this.peer.readableEnded) this.peer.push(null);
    callback(error);
  }
}

function pair() {
  const left = new MemoryDuplex(); const right = new MemoryDuplex();
  left.peer = right; right.peer = left; return { left, right };
}

function transportSigner(values, counter, implementation = null) {
  return { address: values.transport.address, algorithm: values.transport.algorithm,
    publicKey: values.transport.publicKey,
    signReadinessTransportInput(input, options) {
      counter.count += 1;
      return implementation ? implementation(input, options) : signObject(input, values.transport,
        VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN);
    } };
}

function consensusSigner(values, counter, implementation = null) {
  return { address: values.candidate.address, algorithm: values.candidate.algorithm,
    publicKey: values.candidate.publicKey,
    signReadinessConsensusInput(input, options) {
      counter.count += 1;
      return implementation ? implementation(input, options) : signObject(input, values.candidate,
        VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN);
    } };
}

function endpointOptions(values, role, stream, signer, overrides = {}) {
  return { now: () => READINESS_SIGNER_NOW,
    rolePackage: role === "transport" ? values.transportRolePackage : values.consensusRolePackage,
    signer, stream, trustedCurrentHeight: () => values.context.checkpoint.height, ...overrides };
}

test("narrow adapters produce the existing dual-signed readiness response", async () => {
  const values = validatorReadinessSignerFixture();
  const transportPair = pair(); const consensusPair = pair();
  const transportCalls = { count: 0 }; const consensusCalls = { count: 0 };
  const transportEndpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", transportPair.right, transportSigner(values, transportCalls)));
  const consensusEndpoint = createValidatorReadinessConsensusSignerEndpoint(endpointOptions(values,
    "consensus", consensusPair.right, consensusSigner(values, consensusCalls)));
  const transportAdapter = createValidatorReadinessTransportSignerAdapter({
    gatewayRolePackage: values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW,
    stream: transportPair.left });
  const consensusAdapter = createValidatorReadinessConsensusSignerAdapter({
    gatewayRolePackage: values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW,
    stream: consensusPair.left });
  try {
    const response = await respondToValidatorAdmissionReadinessChallenge({
      challenge: values.challenge, consensusSigner: consensusAdapter, context: values.context,
      transportSigner: transportAdapter, validators: values.validators });
    assert.deepEqual(verifyValidatorAdmissionReadinessCandidateResponse(response,
      { validators: values.validators }), response);
    assert.equal(transportCalls.count, 1); assert.equal(consensusCalls.count, 1);
  } finally {
    transportEndpoint.close(); consensusEndpoint.close();
  }
});

test("one hundred semantic duplicates with distinct IDs sign exactly once", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 };
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls), { maxOperations: 16,
      maxRequests: 128 }));
  const requests = Array.from({ length: 100 }, () =>
    createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
      gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW }));
  const decoder = createValidatorReadinessSignerFrameDecoder(); const responses = [];
  const completed = new Promise((resolve, reject) => {
    channel.left.on("data", (chunk) => {
      try {
        responses.push(...decoder.push(chunk));
        if (responses.length === requests.length) resolve();
      } catch (error) { reject(error); }
    });
    channel.left.on("error", reject);
  });
  channel.left.write(Buffer.concat(requests.map(encodeValidatorReadinessSignerFrame)));
  await completed;
  assert.equal(calls.count, 1);
  assert.equal(endpoint.metrics().completedOperations, 1);
  assert.equal(endpoint.metrics().reusedOperations, 99);
  responses.forEach((response, index) => assert.deepEqual(
    verifyValidatorReadinessTransportSignResponse(response, { gatewayRolePackage:
      values.gatewayRolePackage, now: READINESS_SIGNER_NOW, request: requests[index] }), response));
  endpoint.close();
});

test("expired trusted height rejects queued work before any key operation", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 };
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls), {
      trustedCurrentHeight: () => values.context.expiresAtHeight }));
  const closed = new Promise((resolve) => channel.left.once("end", resolve));
  channel.left.resume();
  channel.left.write(encodeValidatorReadinessSignerFrame(
    createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
      gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW })));
  await closed; assert.equal(calls.count, 0); assert.equal(endpoint.metrics().poisoned, true);
});

test("trusted height cannot move backwards while a signature is in progress", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 }; let reads = 0;
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls), {
      trustedCurrentHeight: () => values.context.checkpoint.height - Math.min(reads++, 1) }));
  const adapter = createValidatorReadinessTransportSignerAdapter({ gatewayRolePackage:
    values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW, stream: channel.left });
  await assert.rejects(() => adapter.signReadinessTransport({ challenge: values.challenge }),
    /ended|failed|unavailable/);
  assert.equal(calls.count, 1); assert.equal(endpoint.metrics().poisoned, true);
});

test("a forged transport proof poisons consensus IPC without invoking its signer", async () => {
  const values = validatorReadinessSignerFixture();
  const transportRequest = createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
    gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW });
  const prepared = verifyValidatorReadinessTransportSignRequest(transportRequest,
    { now: READINESS_SIGNER_NOW, rolePackage: values.transportRolePackage });
  const transportResponse = createValidatorReadinessTransportSignResponse({ request: transportRequest,
    rolePackage: values.transportRolePackage, signature: signObject(prepared.signingInput,
      values.transport, VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN) },
  { now: READINESS_SIGNER_NOW }).transportResponse;
  const valid = createValidatorReadinessConsensusSignRequest({ gatewayRolePackage:
    values.gatewayRolePackage, transportResponse }, { now: READINESS_SIGNER_NOW });
  const forged = structuredClone(valid);
  forged.transportResponse.transportSignature = Buffer.from("forged").toString("base64");
  const channel = pair(); const calls = { count: 0 };
  const endpoint = createValidatorReadinessConsensusSignerEndpoint(endpointOptions(values,
    "consensus", channel.right, consensusSigner(values, calls)));
  const closed = new Promise((resolve) => channel.left.once("end", resolve));
  channel.left.resume();
  channel.left.write(encodeValidatorReadinessSignerFrame(forged));
  await closed; assert.equal(calls.count, 0); assert.equal(endpoint.metrics().poisoned, true);
});

test("client abort during signing poisons both sides and aborts the key operation", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  let startedResolve; let abortedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const aborted = new Promise((resolve) => { abortedResolve = resolve; });
  const calls = { count: 0 };
  const signer = transportSigner(values, calls, (_input, { signal }) => new Promise((_, reject) => {
    startedResolve(); signal.addEventListener("abort", () => {
      abortedResolve(true); reject(new Error("signing aborted"));
    }, { once: true });
  }));
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, signer, { timeoutMs: 1_000 }));
  const adapter = createValidatorReadinessTransportSignerAdapter({ gatewayRolePackage:
    values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW, stream: channel.left,
  timeoutMs: 1_000 });
  const controller = new AbortController();
  const operation = adapter.signReadinessTransport({ challenge: values.challenge,
    signal: controller.signal });
  await started; controller.abort(new Error("caller cancelled"));
  await assert.rejects(operation, /cancelled/);
  assert.equal(await aborted, true); assert.equal(calls.count, 1);
  assert.equal(endpoint.metrics().poisoned, true);
});

test("an exact request-id replay returns the cached signature without signing twice", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 };
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls)));
  const request = createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
    gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW });
  const decoder = createValidatorReadinessSignerFrameDecoder(); const responses = [];
  await new Promise((resolve, reject) => {
    channel.left.once("data", (chunk) => {
      try { responses.push(...decoder.push(chunk)); resolve(); } catch (error) { reject(error); }
    });
    channel.left.write(encodeValidatorReadinessSignerFrame(request));
  });
  await new Promise((resolve, reject) => {
    channel.left.once("data", (chunk) => {
      try { responses.push(...decoder.push(chunk)); resolve(); } catch (error) { reject(error); }
    });
    channel.left.write(encodeValidatorReadinessSignerFrame(request));
  });
  assert.equal(calls.count, 1); assert.equal(endpoint.metrics().poisoned, false);
  assert.equal(endpoint.metrics().reusedOperations, 1);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].transportResponse.transportSignature,
    responses[1].transportResponse.transportSignature);
  endpoint.close();
});

test("the same request id with different canonical input is fatal before a second signature", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 };
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls)));
  const first = createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
    gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW });
  const secondChallenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: "e".repeat(64), context: values.context,
    observerWallet: values.validatorWallets[0], validators: values.validators });
  const second = createValidatorReadinessTransportSignRequest({ challenge: secondChallenge,
    gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW });
  second.requestId = first.requestId;
  const decoder = createValidatorReadinessSignerFrameDecoder();
  await new Promise((resolve, reject) => {
    channel.left.once("data", (chunk) => {
      try { assert.equal(decoder.push(chunk).length, 1); resolve(); } catch (error) { reject(error); }
    });
    channel.left.write(encodeValidatorReadinessSignerFrame(first));
  });
  const ended = new Promise((resolve) => channel.left.once("end", resolve));
  channel.left.resume(); channel.left.write(encodeValidatorReadinessSignerFrame(second));
  await ended;
  assert.equal(calls.count, 1); assert.equal(endpoint.metrics().poisoned, true);
});

test("key timeout and partial-frame EOF are fatal and never permit late reuse", async () => {
  const values = validatorReadinessSignerFixture(); const timeoutPair = pair();
  const timeoutCalls = { count: 0 };
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", timeoutPair.right, transportSigner(values, timeoutCalls,
      () => new Promise(() => {})), { timeoutMs: 20 }));
  const adapter = createValidatorReadinessTransportSignerAdapter({ gatewayRolePackage:
    values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW, stream: timeoutPair.left,
  timeoutMs: 100 });
  await assert.rejects(() => adapter.signReadinessTransport({ challenge: values.challenge }),
    /ended|timed out|failed/);
  assert.equal(timeoutCalls.count, 1); assert.equal(endpoint.metrics().poisoned, true);

  const partialPair = pair(); const partialCalls = { count: 0 };
  const partial = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", partialPair.right, transportSigner(values, partialCalls)));
  const partialEnded = new Promise((resolve) => partialPair.left.once("end", resolve));
  partialPair.left.resume(); partialPair.left.write(Buffer.from([0, 0])); partialPair.left.end();
  await partialEnded;
  assert.equal(partialCalls.count, 0); assert.equal(partial.metrics().poisoned, true);
});

test("a late key result after timeout is discarded and the channel stays poisoned", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 }; let resolveLate;
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls, () =>
      new Promise((resolve) => { resolveLate = resolve; })), { timeoutMs: 20 }));
  const adapter = createValidatorReadinessTransportSignerAdapter({ gatewayRolePackage:
    values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW, stream: channel.left,
  timeoutMs: 100 });
  const operation = adapter.signReadinessTransport({ challenge: values.challenge });
  while (!resolveLate) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(operation, /ended|timed out|failed/);
  resolveLate("late-result-must-not-escape");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.count, 1); assert.equal(endpoint.metrics().completedOperations, 0);
  assert.equal(endpoint.metrics().poisoned, true);
  await assert.rejects(() => adapter.signReadinessTransport({ challenge: values.challenge }),
    /unavailable/);
});

test("output backpressure timeout poisons the endpoint after one key operation", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 }; channel.right.blockWrites = true;
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls), { timeoutMs: 20 }));
  const adapter = createValidatorReadinessTransportSignerAdapter({ gatewayRolePackage:
    values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW, stream: channel.left,
  timeoutMs: 100 });
  await assert.rejects(() => adapter.signReadinessTransport({ challenge: values.challenge }),
    /ended|timed out|failed/);
  assert.equal(calls.count, 1); assert.equal(endpoint.metrics().completedOperations, 1);
  assert.equal(endpoint.metrics().poisoned, true);
});

test("endpoint refuses a generic signing capability", () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  assert.throws(() => createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, { address: values.transport.address,
      algorithm: values.transport.algorithm, publicKey: values.transport.publicKey,
      sign() {}, signReadinessTransportInput() {} })), /signer is invalid/);
  channel.left.destroy(); channel.right.destroy();
});

test("endpoint refuses an inherited generic signing capability", () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const inherited = Object.assign(Object.create({ sign() {} }),
    transportSigner(values, { count: 0 }));
  assert.throws(() => createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, inherited)), /signer is invalid/);
  channel.left.destroy(); channel.right.destroy();
});

test("height expiry after the key operation poisons the endpoint without a response", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 }; let reads = 0;
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls), {
      trustedCurrentHeight: () => reads++ === 0
        ? values.context.expiresAtHeight - 1 : values.context.expiresAtHeight }));
  const adapter = createValidatorReadinessTransportSignerAdapter({ gatewayRolePackage:
    values.gatewayRolePackage, now: () => READINESS_SIGNER_NOW, stream: channel.left });
  await assert.rejects(() => adapter.signReadinessTransport({ challenge: values.challenge }),
    /ended|failed|unavailable/);
  assert.equal(calls.count, 1); assert.equal(endpoint.metrics().completedOperations, 0);
  assert.equal(endpoint.metrics().poisoned, true);
});

test("coalesced input cannot enqueue beyond the explicit request bound", async () => {
  const values = validatorReadinessSignerFixture(); const channel = pair();
  const calls = { count: 0 };
  const endpoint = createValidatorReadinessTransportSignerEndpoint(endpointOptions(values,
    "transport", channel.right, transportSigner(values, calls), {
      maxOperations: 16, maxRequests: 16 }));
  const requests = Array.from({ length: 17 }, () =>
    createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
      gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW }));
  const ended = new Promise((resolve) => channel.left.once("end", resolve));
  channel.left.resume();
  channel.left.write(Buffer.concat(requests.map(encodeValidatorReadinessSignerFrame)));
  await ended;
  assert.equal(calls.count, 0); assert.equal(endpoint.metrics().poisoned, true);
});

test("signer IPC source boundary has no launcher, vault, filesystem, process, or environment access", () => {
  for (const name of ["validator-readiness-signer-channel.mjs",
    "validator-readiness-signer-protocol.mjs"]) {
    const source = readFileSync(join(process.cwd(), "blockchain", name), "utf8");
    assert.doesNotMatch(source,
      /node:(?:child_process|fs)|process\.env|(?:read|write)File|privateKey|vault|launcher/i);
  }
});
