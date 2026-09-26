import assert from "node:assert/strict";
import test from "node:test";

import {
  createValidatorAdmissionReadinessCandidateResponse,
  createValidatorAdmissionReadinessCertificate,
  createValidatorAdmissionReadinessChallenge,
  createValidatorAdmissionReadinessContext,
  createValidatorAdmissionReadinessReceipt,
  validatorAdmissionReadinessObservationFromContext,
  verifyValidatorAdmissionReadinessCandidateResponse,
  verifyValidatorAdmissionReadinessCertificate,
  verifyValidatorAdmissionReadinessChallenge,
  verifyValidatorAdmissionReadinessContext,
  verifyValidatorAdmissionReadinessReceipt,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import { generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

const members = (wallets, prefix) => wallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
}));

function fixture() {
  const candidate = generateWallet();
  const transport = generateWallet();
  const observers = Array.from({ length: 4 }, generateWallet);
  const validators = members(observers, "observer");
  const admission = { address: candidate.address, admissionId: "1".repeat(64),
    algorithm: candidate.algorithm, endpoint: "https://candidate.example", legacy: false,
    operatorId: "candidate-one", publicKey: candidate.publicKey,
    tlsCertificateSha256: "2".repeat(64), transport: publicWallet(transport) };
  const contextFor = ({ blockHash = "4".repeat(64), nonce = 7,
    stateRoot = "5".repeat(64), validatorMembers = validators } = {}) =>
    createValidatorAdmissionReadinessContext({ admission,
      chainIdentityGenesisHash: "3".repeat(64), checkpoint: { blockHash,
        height: 100, stateRoot, validatorSetId: validatorSetId(validatorMembers) },
      expiresAtHeight: 116, networkId: "nir-readiness-auth-test", nonce });
  const context = contextFor();
  const responseFor = (index, challengeNonce = String(index + 5).repeat(64),
    targetContext = context) => {
    const challenge = createValidatorAdmissionReadinessChallenge({ challengeNonce,
      context: targetContext, observerWallet: observers[index], validators });
    return createValidatorAdmissionReadinessCandidateResponse({ challenge, context: targetContext,
      candidateWallet: candidate, transportWallet: transport, validators });
  };
  const receiptFor = (index, targetContext = context) =>
    createValidatorAdmissionReadinessReceipt({
      candidateResponse: responseFor(index, String(index + 5).repeat(64), targetContext),
      observerWallet: observers[index], validators });
  return { candidate, context, contextFor, observers, receiptFor, responseFor, transport,
    validators };
}

test("readiness context and dual-signed live response are exact and domain bound", () => {
  const values = fixture();
  assert.deepEqual(verifyValidatorAdmissionReadinessContext(values.context), values.context);
  assert.deepEqual(validatorAdmissionReadinessObservationFromContext(values.context), {
    admissionId: "1".repeat(64), chainIdentityGenesisHash: "3".repeat(64),
    endpoint: "https://candidate.example", expiresAtHeight: 116,
    networkId: "nir-readiness-auth-test", nonce: 7, observedHeight: 100,
    tlsCertificateSha256: "2".repeat(64), transportAddress: values.transport.address,
    validatorSetId: validatorSetId(values.validators),
  });
  const response = values.responseFor(0);
  assert.deepEqual(verifyValidatorAdmissionReadinessChallenge(response.challenge, {
    context: values.context, validators: values.validators }), response.challenge);
  assert.deepEqual(verifyValidatorAdmissionReadinessCandidateResponse(response, {
    validators: values.validators }), response);

  const wrongContext = structuredClone(values.context);
  wrongContext.nonce += 1;
  assert.throws(() => verifyValidatorAdmissionReadinessContext(wrongContext), /commitment/);
  const unknownField = { ...structuredClone(values.context), authority: "operator" };
  assert.throws(() => verifyValidatorAdmissionReadinessContext(unknownField), /unknown or missing/);
  const forkedCheckpoint = structuredClone(values.context);
  forkedCheckpoint.checkpoint.blockHash = "f".repeat(64);
  assert.throws(() => verifyValidatorAdmissionReadinessContext(forkedCheckpoint), /commitment/);
  const mutatedChallenge = structuredClone(response.challenge);
  mutatedChallenge.challengeNonce = "a".repeat(64);
  assert.throws(() => verifyValidatorAdmissionReadinessChallenge(mutatedChallenge, {
    context: values.context, validators: values.validators }), /signature/);
  const mutatedTransport = structuredClone(response);
  mutatedTransport.transportSignature = response.challenge.signature;
  assert.throws(() => verifyValidatorAdmissionReadinessCandidateResponse(mutatedTransport, {
    validators: values.validators }), /candidate response/);
  const mutatedConsensus = structuredClone(response);
  mutatedConsensus.consensusSignature = response.transportSignature;
  assert.throws(() => verifyValidatorAdmissionReadinessCandidateResponse(mutatedConsensus, {
    validators: values.validators }), /candidate response/);
  assert.throws(() => verifyValidatorAdmissionReadinessCandidateResponse({
    ...structuredClone(response), accepted: true,
  }, { validators: values.validators }), /unknown or missing/);
});

test("a candidate response cannot be replayed under a fresh observer challenge", () => {
  const values = fixture();
  const first = values.responseFor(0, "a".repeat(64));
  const freshChallenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: "b".repeat(64), context: values.context,
    observerWallet: values.observers[0], validators: values.validators });
  const replay = { ...structuredClone(first), challenge: freshChallenge,
    challengeHash: freshChallenge.challengeHash };
  assert.throws(() => verifyValidatorAdmissionReadinessCandidateResponse(replay, {
    validators: values.validators }), /candidate response/);
});

test("receipts and the certificate require one canonical exact quorum", () => {
  const values = fixture();
  const receipts = [values.receiptFor(2), values.receiptFor(0), values.receiptFor(1)];
  for (const receipt of receipts) {
    assert.deepEqual(verifyValidatorAdmissionReadinessReceipt(receipt, {
      context: values.context, validators: values.validators }), receipt);
  }
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt({
    ...structuredClone(receipts[0]), status: "ready",
  }, { context: values.context, validators: values.validators }), /receipt is invalid/);
  const legacyOnly = structuredClone(receipts[0]);
  delete legacyOnly.resultSignature;
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt(legacyOnly, {
    context: values.context, validators: values.validators }), /unknown or missing/);
  const substitutedResult = structuredClone(receipts[0]);
  substitutedResult.resultSignature = substitutedResult.observationAttestation.signature;
  const { receiptHash: _receiptHash, ...substitutedPayload } = substitutedResult;
  substitutedResult.receiptHash = hashObject(substitutedPayload, "VALIDATOR_READY_RECEIPT_V1");
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt(substitutedResult, {
    context: values.context, validators: values.validators }), /receipt is invalid/);
  const certificate = createValidatorAdmissionReadinessCertificate({ context: values.context,
    receipts, validators: values.validators });
  assert.equal(certificate.status, "certificate-collected");
  assert.deepEqual(certificate.receipts.map((receipt) =>
    receipt.observationAttestation.validator), [...certificate.readinessAttestations]
    .map(({ validator }) => validator).sort());
  assert.deepEqual(verifyValidatorAdmissionReadinessCertificate(certificate, {
    validators: values.validators }), certificate);

  assert.throws(() => createValidatorAdmissionReadinessCertificate({ context: values.context,
    receipts: receipts.slice(0, 2), validators: values.validators }), /exact quorum/);
  assert.throws(() => createValidatorAdmissionReadinessCertificate({ context: values.context,
    receipts: [...receipts, values.receiptFor(3)], validators: values.validators }), /exact quorum/);
  assert.throws(() => createValidatorAdmissionReadinessCertificate({ context: values.context,
    receipts: [receipts[0], receipts[0], receipts[1]], validators: values.validators }),
  /duplicated/);

  const outOfOrder = structuredClone(certificate);
  outOfOrder.receipts.reverse();
  assert.throws(() => verifyValidatorAdmissionReadinessCertificate(outOfOrder, {
    validators: values.validators }), /certificate is invalid/);
  const mutatedAttestation = structuredClone(certificate);
  mutatedAttestation.readinessAttestations[0].signature =
    mutatedAttestation.readinessAttestations[1].signature;
  assert.throws(() => verifyValidatorAdmissionReadinessCertificate(mutatedAttestation, {
    validators: values.validators }), /certificate is invalid/);
  assert.throws(() => verifyValidatorAdmissionReadinessCertificate({
    ...structuredClone(certificate), selected: false,
  }, { validators: values.validators }), /unknown or missing/);
});

test("observer results reject fork, nonce, and validator-set splicing", () => {
  const values = fixture();
  const receipt = values.receiptFor(0);
  const rehash = (value) => {
    const { receiptHash: _receiptHash, ...payload } = value;
    return { ...payload, receiptHash: hashObject(payload, "VALIDATOR_READY_RECEIPT_V1") };
  };

  // The legacy observation omits blockHash/stateRoot. The distinct result signature must still
  // prevent moving a valid live result onto a same-height fork with the same validator set.
  const forkContext = values.contextFor({ blockHash: "a".repeat(64),
    stateRoot: "b".repeat(64) });
  const forkReceipt = values.receiptFor(0, forkContext);
  const forkSplice = rehash({ ...structuredClone(forkReceipt),
    resultSignature: receipt.resultSignature });
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt(forkSplice, {
    context: forkContext, validators: values.validators }), /receipt is invalid/);
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt(receipt, {
    context: forkContext, validators: values.validators }), /receipt is invalid/);

  const nextNonceContext = values.contextFor({ nonce: values.context.nonce + 1 });
  const nextNonceReceipt = values.receiptFor(0, nextNonceContext);
  const nonceSplice = rehash({ ...structuredClone(nextNonceReceipt),
    resultSignature: receipt.resultSignature });
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt(nonceSplice, {
    context: nextNonceContext, validators: values.validators }), /receipt is invalid/);

  const otherWallets = Array.from({ length: 4 }, generateWallet);
  const otherValidators = members(otherWallets, "other");
  assert.throws(() => createValidatorAdmissionReadinessChallenge({
    challengeNonce: "c".repeat(64), context: values.context,
    observerWallet: otherWallets[0], validators: otherValidators,
  }), /observer set commitment/);
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt(receipt, {
    context: values.context, validators: otherValidators }), /observer set commitment/);
  assert.throws(() => createValidatorAdmissionReadinessCertificate({ context: values.context,
    receipts: [receipt, values.receiptFor(1), values.receiptFor(2)],
    validators: otherValidators }), /observer set commitment/);

  // A -> B -> A may reproduce a set ID, but an old receipt remains pinned to its old checkpoint.
  const returnedAContext = values.contextFor({ blockHash: "d".repeat(64),
    stateRoot: "e".repeat(64), validatorMembers: values.validators });
  assert.equal(returnedAContext.checkpoint.validatorSetId,
    values.context.checkpoint.validatorSetId);
  assert.throws(() => verifyValidatorAdmissionReadinessReceipt(receipt, {
    context: returnedAContext, validators: values.validators }), /receipt is invalid/);
});
