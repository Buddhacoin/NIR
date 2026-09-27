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

function transportRoundTrip(values) {
  const request = createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
    gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW });
  const verified = verifyValidatorReadinessTransportSignRequest(request,
    { now: READINESS_SIGNER_NOW, rolePackage: values.transportRolePackage });
  const signature = signObject(verified.signingInput, values.transport,
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN);
  const response = createValidatorReadinessTransportSignResponse({ request,
    rolePackage: values.transportRolePackage, signature }, { now: READINESS_SIGNER_NOW });
  verifyValidatorReadinessTransportSignResponse(response, { gatewayRolePackage:
    values.gatewayRolePackage, now: READINESS_SIGNER_NOW, request });
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
  { now: READINESS_SIGNER_NOW });
  const verified = verifyValidatorReadinessConsensusSignRequest(request,
    { now: READINESS_SIGNER_NOW, rolePackage: values.consensusRolePackage });
  const signature = signObject(verified.signingInput, values.candidate,
    VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN);
  const response = createValidatorReadinessConsensusSignResponse({ request,
    rolePackage: values.consensusRolePackage, signature }, { now: READINESS_SIGNER_NOW });
  assert.deepEqual(verifyValidatorReadinessConsensusSignResponse(response, {
    gatewayRolePackage: values.gatewayRolePackage, now: READINESS_SIGNER_NOW, request }), response);
  for (const mutant of [{ ...request, extra: true },
    (({ transportResponse: _removed, ...rest }) => rest)(request)]) {
    assert.throws(() => verifyValidatorReadinessConsensusSignRequest(mutant,
      { now: READINESS_SIGNER_NOW, rolePackage: values.consensusRolePackage }),
    /unknown or missing/);
  }
  for (const mutant of [{ ...response, extra: true },
    (({ candidateResponse: _removed, ...rest }) => rest)(response)]) {
    assert.throws(() => verifyValidatorReadinessConsensusSignResponse(mutant,
      { gatewayRolePackage: values.gatewayRolePackage, now: READINESS_SIGNER_NOW, request }),
    /unknown or missing/);
  }
  assert.notEqual(verified.operationHash,
    verifyValidatorReadinessTransportSignRequest(transport.request,
      { now: READINESS_SIGNER_NOW, rolePackage: values.transportRolePackage }).operationHash);
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
      { now: READINESS_SIGNER_NOW, rolePackage: values.transportRolePackage }));
  }
  const wrongId = structuredClone(response); wrongId.requestId = "1".repeat(64);
  assert.throws(() => verifyValidatorReadinessTransportSignResponse(wrongId,
    { gatewayRolePackage: values.gatewayRolePackage, now: READINESS_SIGNER_NOW, request }),
  /binding/);
  for (const field of ["requestHash", "operationHash"]) {
    const wrongHash = structuredClone(response); wrongHash[field] = `sha3-256:${"0".repeat(64)}`;
    assert.throws(() => verifyValidatorReadinessTransportSignResponse(wrongHash,
      { gatewayRolePackage: values.gatewayRolePackage, now: READINESS_SIGNER_NOW, request }),
    /binding/);
  }
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(request,
    { now: READINESS_SIGNER_NOW, rolePackage: values.consensusRolePackage }), /identity/);
  for (const mutant of [{ ...response, extra: true },
    (({ transportResponse: _removed, ...rest }) => rest)(response)]) {
    assert.throws(() => verifyValidatorReadinessTransportSignResponse(mutant,
      { gatewayRolePackage: values.gatewayRolePackage, now: READINESS_SIGNER_NOW, request }),
    /unknown or missing/);
  }
  const exotic = Object.assign(Object.create({ inherited: true }), request);
  assert.throws(() => verifyValidatorReadinessTransportSignRequest(exotic,
    { now: READINESS_SIGNER_NOW, rolePackage: values.transportRolePackage }), /unknown|missing/);
});

test("forged transport proof cannot reach a consensus signing input", () => {
  const values = validatorReadinessSignerFixture();
  const { response } = transportRoundTrip(values);
  const forged = structuredClone(response.transportResponse);
  forged.transportSignature = Buffer.from("forged").toString("base64");
  assert.throws(() => createValidatorReadinessConsensusSignRequest({ gatewayRolePackage:
    values.gatewayRolePackage, transportResponse: forged }, { now: READINESS_SIGNER_NOW }),
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
