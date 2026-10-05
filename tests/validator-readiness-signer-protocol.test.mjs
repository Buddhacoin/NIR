import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, signObject } from "../blockchain/crypto.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import {
  createValidatorReadinessConsensusSignRequest,
  createValidatorReadinessConsensusSignResponse,
  createValidatorReadinessSignerChannelEpoch,
  createValidatorReadinessSignerFrameDecoder,
  createValidatorReadinessTransportSignRequest,
  createValidatorReadinessTransportSignResponse,
  encodeValidatorReadinessSignerFrame,
  VALIDATOR_READINESS_SIGNER_MAX_FRAME_BYTES,
  verifyValidatorReadinessConsensusSignRequest,
  verifyValidatorReadinessConsensusSignResponse,
  verifyValidatorReadinessTransportSignRequest,
  verifyValidatorReadinessTransportSignResponse,
} from "../blockchain/validator-readiness-signer-protocol.mjs";
import {
  READINESS_SIGNER_NOW, validatorReadinessSignerFixture,
} from "./validator-readiness-signer-fixture.mjs";

function options(values, role) {
  return { channelBinding: role === "transport" ? values.transportSignerBinding
    : values.consensusSignerBinding, now: READINESS_SIGNER_NOW };
}

function transportRoundTrip(values) {
  const request = createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
    gatewayRolePackage: values.gatewayRolePackage }, options(values, "transport"));
  const verified = verifyValidatorReadinessTransportSignRequest(request,
    { ...options(values, "transport"), rolePackage: values.transportRolePackage });
  const signature = signObject(verified.signingInput, values.transport,
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN);
  const response = createValidatorReadinessTransportSignResponse({ request,
    rolePackage: values.transportRolePackage, signature }, options(values, "transport"));
  verifyValidatorReadinessTransportSignResponse(response, { gatewayRolePackage:
    values.gatewayRolePackage, ...options(values, "transport"), request });
  return { request, response };
}

test("bounded canonical framing handles fragmentation and coalescing", () => {
  const values = [{ a: 1, b: [true, null] }, { message: "привет" }];
  const encoded = values.map(encodeValidatorReadinessSignerFrame);
  const bytewise = createValidatorReadinessSignerFrameDecoder(); const decoded = [];
  for (const byte of Buffer.concat(encoded)) decoded.push(...bytewise.push(Buffer.of(byte)));
  bytewise.finish(); assert.deepEqual(decoded, values);
  const coalesced = createValidatorReadinessSignerFrameDecoder();
  assert.deepEqual(coalesced.push(Buffer.concat(encoded)), values); coalesced.finish();
});

test("channel epoch is deterministic, role-separated, and bound to every launch anchor", () => {
  const values = validatorReadinessSignerFixture();
  const binding = values.transportSignerBinding;
  const epoch = createValidatorReadinessSignerChannelEpoch(binding,
    { expectedRole: "transport", now: READINESS_SIGNER_NOW });
  assert.equal(epoch, createValidatorReadinessSignerChannelEpoch(structuredClone(binding),
    { expectedRole: "transport", now: READINESS_SIGNER_NOW }));
  assert.notEqual(epoch, createValidatorReadinessSignerChannelEpoch(values.consensusSignerBinding,
    { expectedRole: "consensus", now: READINESS_SIGNER_NOW }));
  assert.throws(() => createValidatorReadinessSignerChannelEpoch({ ...binding, extra: true },
    { expectedRole: "transport", now: READINESS_SIGNER_NOW }),
    /unknown|missing/);
  for (const mutation of [
    { ...binding, expectedLauncherNonce: "0".repeat(64) },
    { ...binding, expectedPid: binding.expectedPid + 1 },
    { ...binding, expectedReleaseProvenanceHash: `sha3-256:${"0".repeat(64)}` },
    { ...binding, expectedSessionHash: `sha3-256:${"0".repeat(64)}` },
    { ...binding, signerReady: { ...binding.signerReady, processNonce: "0".repeat(64) } },
  ]) assert.throws(() => createValidatorReadinessSignerChannelEpoch(mutation,
    { expectedRole: "transport", now: READINESS_SIGNER_NOW }), /invalid/);
  assert.throws(() => createValidatorReadinessSignerChannelEpoch(
    Object.assign(Object.create({ inherited: true }), binding),
  { expectedRole: "transport", now: READINESS_SIGNER_NOW }), /unknown|missing/);
});

test("framing fails closed on bad lengths, UTF-8, noncanonical JSON, and partial EOF", () => {
  for (const length of [0, VALIDATOR_READINESS_SIGNER_MAX_FRAME_BYTES + 1]) {
    const decoder = createValidatorReadinessSignerFrameDecoder(); const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    assert.throws(() => decoder.push(header), /length/);
    assert.throws(() => decoder.push(Buffer.from("{}")), /poisoned/);
  }
  for (const body of [Buffer.from([0xff]), Buffer.from('{"b":2, "a":1}'),
    Buffer.from('{"a":1,"a":2}')]) {
    const decoder = createValidatorReadinessSignerFrameDecoder(); const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    assert.throws(() => decoder.push(Buffer.concat([header, body])), /UTF-8|canonical/);
  }
  const headerOnly = createValidatorReadinessSignerFrameDecoder();
  assert.deepEqual(headerOnly.push(Buffer.from([0, 0])), []);
  assert.throws(() => headerOnly.finish(), /before completion/);
  const bodyPartial = createValidatorReadinessSignerFrameDecoder(); const header = Buffer.alloc(4);
  header.writeUInt32BE(4); bodyPartial.push(Buffer.concat([header, Buffer.from("{")]));
  assert.throws(() => bodyPartial.finish(), /before completion/);
});

test("role-specific transport and consensus messages round-trip with fixed signing inputs", () => {
  const values = validatorReadinessSignerFixture();
  const transport = transportRoundTrip(values);
  const request = createValidatorReadinessConsensusSignRequest({ gatewayRolePackage:
    values.gatewayRolePackage, transportResponse: transport.response.transportResponse },
  options(values, "consensus"));
  const verified = verifyValidatorReadinessConsensusSignRequest(request,
    { ...options(values, "consensus"), rolePackage: values.consensusRolePackage });
  const signature = signObject(verified.signingInput, values.candidate,
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN);
  const response = createValidatorReadinessConsensusSignResponse({ request,
    rolePackage: values.consensusRolePackage, signature }, options(values, "consensus"));
  assert.equal(request.format, "nir-validator-readiness-consensus-sign-request-v2");
  assert.equal(request.version, 2);
  assert.equal(response.format, "nir-validator-readiness-consensus-sign-response-v2");
  assert.equal(response.version, 2);
  assert.deepEqual(verifyValidatorReadinessConsensusSignResponse(response, {
    gatewayRolePackage: values.gatewayRolePackage, ...options(values, "consensus"), request }), response);
  assert.throws(() => verifyValidatorReadinessConsensusSignRequest({ ...request,
    format: "nir-validator-readiness-consensus-sign-request-v1", version: 1 },
  { ...options(values, "consensus"), rolePackage: values.consensusRolePackage }), /binding/);
  assert.throws(() => verifyValidatorReadinessConsensusSignResponse({ ...response,
    format: "nir-validator-readiness-consensus-sign-response-v1", version: 1 }, {
    gatewayRolePackage: values.gatewayRolePackage, ...options(values, "consensus"), request,
  }), /binding/);
  for (const mutant of [{ ...request, extra: true },
    (({ transportResponse: _removed, ...rest }) => rest)(request)]) {
    assert.throws(() => verifyValidatorReadinessConsensusSignRequest(mutant,
      { ...options(values, "consensus"), rolePackage: values.consensusRolePackage }),
    /unknown or missing/);
  }
  for (const mutant of [{ ...response, extra: true },
    (({ candidateResponse: _removed, ...rest }) => rest)(response)]) {
    assert.throws(() => verifyValidatorReadinessConsensusSignResponse(mutant,
      { gatewayRolePackage: values.gatewayRolePackage, ...options(values, "consensus"), request }),
    /unknown or missing/);
  }
  for (const field of ["requestHash", "operationHash", "responseHash"]) {
    const mutant = structuredClone(response);
    mutant[field] = `sha3-256:${"0".repeat(64)}`;
    assert.throws(() => verifyValidatorReadinessConsensusSignResponse(mutant, {
      gatewayRolePackage: values.gatewayRolePackage, ...options(values, "consensus"), request,
    }), /binding/);
  }
  assert.notEqual(verified.operationHash,
    verifyValidatorReadinessTransportSignRequest(transport.request,
      { ...options(values, "transport"), rolePackage: values.transportRolePackage }).operationHash);
});

test("exact schemas and role/session/request bindings reject mutation", () => {
  const values = validatorReadinessSignerFixture();
  const { request, response } = transportRoundTrip(values);
  for (const mutate of [
    (copy) => { copy.extra = true; },
    (copy) => { delete copy.challenge; },
    (copy) => { copy.requestId = "0".repeat(63); },
    (copy) => { copy.sessionHash = `sha3-256:${"0".repeat(64)}`; },
    (copy) => { copy.signerRolePackageHash = values.consensusRolePackage.rolePackageHash; },
    (copy) => { copy.challenge.challengeNonce = "0".repeat(64); },
  ]) {
    const copy = structuredClone(request); mutate(copy);
    assert.throws(() => verifyValidatorReadinessTransportSignRequest(copy,
      { ...options(values, "transport"), rolePackage: values.transportRolePackage }));
  }
  const wrongId = structuredClone(response); wrongId.requestId = "1".repeat(64);
  assert.throws(() => verifyValidatorReadinessTransportSignResponse(wrongId,
    { gatewayRolePackage: values.gatewayRolePackage, ...options(values, "transport"), request }),
  /binding/);
  for (const field of ["requestHash", "operationHash", "responseHash"]) {
    const wrongHash = structuredClone(response); wrongHash[field] = `sha3-256:${"0".repeat(64)}`;
    assert.throws(() => verifyValidatorReadinessTransportSignResponse(wrongHash,
      { gatewayRolePackage: values.gatewayRolePackage, ...options(values, "transport"), request }),
    /binding/);
  }
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(request,
    { ...options(values, "transport"), rolePackage: values.consensusRolePackage }), /identity/);
  for (const mutant of [{ ...response, extra: true },
    (({ transportResponse: _removed, ...rest }) => rest)(response)]) {
    assert.throws(() => verifyValidatorReadinessTransportSignResponse(mutant,
      { gatewayRolePackage: values.gatewayRolePackage, ...options(values, "transport"), request }),
    /unknown or missing/);
  }
  const exotic = Object.assign(Object.create({ inherited: true }), request);
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(exotic,
    { ...options(values, "transport"), rolePackage: values.transportRolePackage }), /unknown|missing/);
});

test("old and foreign launch epochs fail closed in requests and responses", () => {
  const values = validatorReadinessSignerFixture();
  const { request, response } = transportRoundTrip(values);
  assert.equal(request.format, "nir-validator-readiness-transport-sign-request-v2");
  assert.equal(request.version, 2);
  assert.equal(response.format, "nir-validator-readiness-transport-sign-response-v2");
  assert.equal(response.version, 2);
  const old = structuredClone(request); delete old.channelEpoch;
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(old,
    { ...options(values, "transport"), rolePackage: values.transportRolePackage }),
  /unknown or missing/);
  const v1 = { ...request,
    format: "nir-validator-readiness-transport-sign-request-v1", version: 1 };
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(v1,
    { ...options(values, "transport"), rolePackage: values.transportRolePackage }), /binding/);
  const v1Response = { ...response,
    format: "nir-validator-readiness-transport-sign-response-v1", version: 1 };
  assert.throws(() => verifyValidatorReadinessTransportSignResponse(v1Response, {
    gatewayRolePackage: values.gatewayRolePackage, ...options(values, "transport"), request,
  }), /binding/);
  const foreignBinding = values.consensusSignerBinding;
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(
    { ...request, channelEpoch: values.consensusChannelEpoch },
    { ...options(values, "transport"), rolePackage: values.transportRolePackage }), /binding/);
  assert.throws(() => verifyValidatorReadinessTransportSignResponse(
    { ...response, channelEpoch: values.consensusChannelEpoch }, {
      gatewayRolePackage: values.gatewayRolePackage, ...options(values, "transport"), request,
    }), /binding/);
  const current = verifyValidatorReadinessTransportSignRequest(request,
    { ...options(values, "transport"), rolePackage: values.transportRolePackage });
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(request, {
    channelBinding: foreignBinding, now: READINESS_SIGNER_NOW,
    rolePackage: values.transportRolePackage }), /role|identity|binding/);
  assert.match(current.requestHash, /^sha3-256:/);
});

test("forged transport proof cannot reach a consensus signing input", () => {
  const values = validatorReadinessSignerFixture();
  const { response } = transportRoundTrip(values);
  const forged = structuredClone(response.transportResponse);
  forged.transportSignature = Buffer.from("forged").toString("base64");
  assert.throws(() => createValidatorReadinessConsensusSignRequest({ gatewayRolePackage:
    values.gatewayRolePackage, transportResponse: forged }, options(values, "consensus")),
  /transport response/);
});

test("encoded wire objects remain canonical and within their explicit bound", () => {
  const values = validatorReadinessSignerFixture();
  const { request, response } = transportRoundTrip(values);
  for (const value of [request, response]) {
    const frame = encodeValidatorReadinessSignerFrame(value);
    assert.equal(frame.readUInt32BE(0), Buffer.byteLength(canonicalJson(value)));
    assert.ok(frame.length <= VALIDATOR_READINESS_SIGNER_MAX_FRAME_BYTES + 4);
  }
});
