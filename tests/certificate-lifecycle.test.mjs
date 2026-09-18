import assert from "node:assert/strict";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  certificatePinsAtHeight,
  createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH,
  selectCertificateHistoryCandidates,
  verifyCertificateHistory,
  verifyCertificateRecord,
} from "../blockchain/certificate-lifecycle.mjs";
import { requestValidatorJson } from "../blockchain/http-client.mjs";

const NETWORK = "nir-certificate-test";
const REGISTRY = "a".repeat(64);
const TOPOLOGY = "b".repeat(64);
const wallets = Array.from({ length: 4 }, generateWallet);
const validators = wallets.map(publicWallet);
const operator = wallets[0].address;

function record({
  activationHeight,
  certificate,
  history = [],
  operation,
  overlapUntilHeight = activationHeight,
  signers = wallets.slice(0, 3),
  peerRegistryHash = REGISTRY,
  topologyHistoryHash = TOPOLOGY,
}) {
  const previous = history.filter(({ validatorAddress }) =>
    validatorAddress === operator).at(-1);
  return createCertificateRecord({
    activationHeight,
    certificate,
    networkId: NETWORK,
    operation,
    overlapUntilHeight,
    peerRegistryHash,
    previousRecordHash: previous?.recordHash ?? EMPTY_CERTIFICATE_RECORD_HASH,
    sequence: previous ? previous.sequence + 1 : 0,
    topologyHistoryHash,
    validatorAddress: operator,
  }, signers);
}

const firstCertificate = { serial: "1a", sha256: "1".repeat(64) };
const secondCertificate = { serial: "2b", sha256: "2".repeat(64) };

test("certificate renewal has a bounded old/new overlap and then drops the old pin", () => {
  const issued = record({
    activationHeight: 10, certificate: firstCertificate, operation: "issue",
  });
  const renewed = record({
    activationHeight: 20,
    certificate: secondCertificate,
    history: [issued],
    operation: "renew",
    overlapUntilHeight: 24,
  });
  const history = verifyCertificateHistory([issued, renewed], {
    networkId: NETWORK, validators,
  });
  assert.deepEqual(certificatePinsAtHeight(history, operator, 9), []);
  assert.deepEqual(certificatePinsAtHeight(history, operator, 19), [firstCertificate.sha256]);
  assert.deepEqual(certificatePinsAtHeight(history, operator, 20), [
    secondCertificate.sha256, firstCertificate.sha256,
  ]);
  assert.deepEqual(certificatePinsAtHeight(history, operator, 25), [secondCertificate.sha256]);
});

test("stale, minority, forged, replayed, and topology-detached records fail closed", () => {
  const issued = record({
    activationHeight: 10, certificate: firstCertificate, operation: "issue",
  });
  assert.throws(() => verifyCertificateRecord(issued, {
    currentHeight: 9,
    history: [],
    minimumActivationDelay: 2,
    networkId: NETWORK,
    peerRegistryHash: REGISTRY,
    topologyHistoryHash: TOPOLOGY,
    validators,
  }), /stale|required delay/);

  const minority = record({
    activationHeight: 10,
    certificate: firstCertificate,
    operation: "issue",
    signers: wallets.slice(0, 2),
  });
  assert.throws(() => verifyCertificateHistory([minority], { networkId: NETWORK, validators }),
    /quorum/);

  const forged = structuredClone(issued);
  forged.activationHeight = 11;
  forged.overlapUntilHeight = 11;
  forged.recordHash = "f".repeat(64);
  assert.throws(() => verifyCertificateHistory([forged], { networkId: NETWORK, validators }),
    /hash|forged/);

  const reused = record({
    activationHeight: 20,
    certificate: { serial: firstCertificate.serial, sha256: "3".repeat(64) },
    history: [issued],
    operation: "renew",
  });
  assert.throws(() => verifyCertificateHistory([issued, reused], {
    networkId: NETWORK, validators,
  }), /already used/);

  const detached = record({
    activationHeight: 30,
    certificate: secondCertificate,
    history: [issued],
    operation: "renew",
    topologyHistoryHash: "c".repeat(64),
  });
  assert.throws(() => verifyCertificateRecord(detached, {
    currentHeight: 20,
    history: [issued],
    networkId: NETWORK,
    peerRegistryHash: REGISTRY,
    topologyHistoryHash: TOPOLOGY,
    validators,
  }), /different network topology/);
});

test("revocation removes all pins and replay cannot roll the lineage back", async () => {
  const issued = record({
    activationHeight: 10, certificate: firstCertificate, operation: "issue",
  });
  const revoked = record({
    activationHeight: 20, certificate: null, history: [issued], operation: "revoke",
  });
  const history = verifyCertificateHistory([issued, revoked], {
    networkId: NETWORK, validators,
  });
  assert.deepEqual(certificatePinsAtHeight(history, operator, 19), [firstCertificate.sha256]);
  assert.deepEqual(certificatePinsAtHeight(history, operator, 20), []);
  await assert.rejects(() => requestValidatorJson("https://127.0.0.1:1/health", {
    certificateContext: { networkId: NETWORK, validators },
    certificateHistory: history,
    height: 20,
    validatorAddress: operator,
  }), /no active authenticated TLS certificate/);
  assert.throws(() => verifyCertificateHistory([issued, revoked, issued], {
    networkId: NETWORK, validators,
  }), /lineage|sequence/);
});

test("unknown fields and unauthenticated certificate history fail closed", async () => {
  const issued = record({
    activationHeight: 10, certificate: firstCertificate, operation: "issue",
  });
  assert.throws(() => verifyCertificateHistory([
    { ...issued, unexpected: true },
  ], { networkId: NETWORK, validators }), /shape/);
  assert.throws(() => verifyCertificateHistory([
    { ...issued, certificate: { ...issued.certificate, unexpected: true } },
  ], { networkId: NETWORK, validators }), /shape/);
  assert.throws(() => verifyCertificateHistory([
    { ...issued, approvals: issued.approvals.map((approval, index) =>
      index === 0 ? { ...approval, unexpected: true } : approval) },
  ], { networkId: NETWORK, validators }), /shape/);
  await assert.rejects(() => requestValidatorJson("https://127.0.0.1:1/health", {
    certificateHistory: [issued], height: 10, validatorAddress: operator,
  }), /context is required/);

  const reversed = { ...issued, approvals: [...issued.approvals].reverse() };
  const normalized = verifyCertificateHistory([reversed], { networkId: NETWORK, validators });
  assert.deepEqual(normalized[0].approvals, issued.approvals);
});

test("certificate propagation selects one quorum head and ignores stale or forged histories", () => {
  const issued = record({
    activationHeight: 10, certificate: firstCertificate, operation: "issue",
  });
  const renewed = record({
    activationHeight: 20, certificate: secondCertificate, history: [issued], operation: "renew",
  });
  const alternate = record({
    activationHeight: 20,
    certificate: { serial: "3c", sha256: "3".repeat(64) },
    history: [issued],
    operation: "renew",
  });
  const context = { networkId: NETWORK, validators };
  const forged = structuredClone([issued, renewed]);
  forged[1].recordHash = "f".repeat(64);
  const selected = selectCertificateHistoryCandidates([
    { history: [issued, renewed], source: validators[0].address },
    { history: [issued, renewed], source: validators[1].address },
    { history: [issued, renewed], source: validators[2].address },
    { history: forged, source: validators[3].address },
  ], { context, localHistory: [issued], trustedSources: validators });
  assert.equal(selected.status, "selected");
  assert.equal(selected.history.length, 2);
  assert.equal(selected.matchingSources.length, 3);

  const stale = selectCertificateHistoryCandidates(validators.map(({ address }) => ({
    history: [issued], source: address,
  })), { context, localHistory: [issued, renewed], trustedSources: validators });
  assert.equal(stale.status, "known");
  assert.equal(stale.history.length, 2);

  assert.throws(() => selectCertificateHistoryCandidates([
    { history: [issued, renewed], source: validators[0].address },
    { history: [issued, renewed], source: validators[1].address },
    { history: [issued, alternate], source: validators[2].address },
    { history: [issued, alternate], source: validators[3].address },
  ], { context, localHistory: [issued], trustedSources: validators }), /quorum not reached/);

  assert.throws(() => selectCertificateHistoryCandidates([
    { history: [issued, renewed], source: validators[0].address },
    { history: [issued, renewed], source: validators[1].address },
    { history: [issued, renewed], source: validators[2].address },
    { history: [issued, alternate], source: validators[3].address },
  ], { context, localHistory: [issued, alternate], trustedSources: validators }),
  /conflicts with the local verified head/);
});
