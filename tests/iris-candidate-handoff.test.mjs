import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { generateWallet } from "../blockchain/crypto.mjs";
import { evaluateIrisLinearCandidate, evaluateIrisPostCommitStress } from
  "../blockchain/iris-linear-candidate.mjs";
import { createIrisCandidateHandoffIntent, signIrisCandidateHandoff,
  verifyIrisCandidateHandoff } from "../blockchain/iris-candidate-handoff.mjs";

const root = join(import.meta.dirname, "..");
const sample = readFileSync(join(root, "examples/iris_integer_linear.json"));
const networkId = "nir-handoff-local-a";
const genesisHash = "a".repeat(64);

test("user Iris model handoff binds exact bytes, signed address and target genesis without admission", () => {
  const wallet = generateWallet();
  const record = evaluateIrisPostCommitStress(root, sample, randomBytes(32));
  const intent = createIrisCandidateHandoffIntent({ root, modelBytes: sample,
    postCommitRecord: record, submitter: wallet.address, recipient: wallet.address,
    nonce: "1".repeat(64), networkId, chainIdentityGenesisHash: genesisHash });
  const signed = signIrisCandidateHandoff({ wallet, intent });
  const checked = verifyIrisCandidateHandoff(signed, { root, modelBytes: sample,
    postCommitRecord: record, expectedNetworkId: networkId, expectedGenesisHash: genesisHash });
  assert.equal(checked.signatureValid, true);
  assert.equal(checked.exactModelBytesBound, true);
  assert.equal(checked.localReplayMatched, true);
  for (const key of ["executionVerified", "independentlyVerified", "networkSubmitted",
    "admissionEligible", "rewardEligible"]) assert.equal(checked[key], false);
  assert.equal(signed.scope, "pre-admission-only");
  assert.equal(signed.networkId, networkId);
  assert.equal(signed.chainIdentityGenesisHash, genesisHash);
  assert.equal(signed.recipient, wallet.address);
  assert.equal(signed.seed, undefined);
  assert.equal(signed.postCommitRecord, undefined);
  assert.equal(signed.artifactHash.startsWith("sha256:"), true);
  assert.notEqual(signed.artifactHash, signed.localCommitHash);
  assert.equal(verifyIrisCandidateHandoff(signed, { root, modelBytes: sample,
    postCommitRecord: record, expectedNetworkId: networkId,
    expectedGenesisHash: genesisHash }).rewardEligible, false);
  assert.throws(() => verifyIrisCandidateHandoff(signed, { root, modelBytes: sample,
    postCommitRecord: record, expectedNetworkId: networkId, expectedGenesisHash: "b".repeat(64) }),
  /genesis|context/i);
  assert.throws(() => verifyIrisCandidateHandoff(signed, { root, modelBytes: sample,
    postCommitRecord: record, expectedNetworkId: "nir-handoff-local-b",
    expectedGenesisHash: genesisHash }), /network|context/i);
  assert.throws(() => verifyIrisCandidateHandoff(signed, { root, modelBytes: sample,
    postCommitRecord: record }), /context/i);
});

test("handoff rejects altered model or record, wrong owner, changed flags and public rehearsal", () => {
  const wallet = generateWallet();
  const record = evaluateIrisPostCommitStress(root, sample, randomBytes(32));
  const parameters = { root, modelBytes: sample, postCommitRecord: record,
    submitter: wallet.address, recipient: wallet.address, nonce: "2".repeat(64),
    networkId, chainIdentityGenesisHash: genesisHash };
  const intent = createIrisCandidateHandoffIntent(parameters);
  const signed = signIrisCandidateHandoff({ wallet, intent });
  const context = { root, modelBytes: sample, postCommitRecord: record,
    expectedNetworkId: networkId, expectedGenesisHash: genesisHash };
  const withoutNewline = Buffer.from(sample.toString("utf8").trimEnd());
  assert.equal(evaluateIrisLinearCandidate(root, withoutNewline).modelHash,
    evaluateIrisLinearCandidate(root, sample).modelHash);
  const otherRecordForSameModel = evaluateIrisPostCommitStress(root, withoutNewline,
    Buffer.from(record.seed, "hex"));
  const otherIntent = createIrisCandidateHandoffIntent({ ...parameters,
    modelBytes: withoutNewline, postCommitRecord: otherRecordForSameModel });
  assert.equal(otherIntent.contentHash, intent.contentHash);
  assert.notEqual(otherIntent.artifactHash, intent.artifactHash);
  assert.notEqual(otherIntent.localCommitHash, intent.localCommitHash);
  assert.throws(() => verifyIrisCandidateHandoff(signed,
    { ...context, modelBytes: withoutNewline }), /bytes|record|artifact/i);
  const otherRecord = { ...record, candidateAccuracyBps: record.candidateAccuracyBps - 1 };
  assert.throws(() => verifyIrisCandidateHandoff(signed,
    { ...context, postCommitRecord: otherRecord }), /record|replay/i);
  assert.throws(() => signIrisCandidateHandoff({ wallet: generateWallet(), intent }), /owner|submitter/i);
  assert.throws(() => verifyIrisCandidateHandoff({ ...signed, rewardEligible: true }, context),
    /handoff|flag/i);
  assert.throws(() => verifyIrisCandidateHandoff({ ...signed, recipient: generateWallet().address }, context),
    /signature|handoff/i);
  assert.throws(() => verifyIrisCandidateHandoff({ ...signed, signature: "AAAA" }, context),
    /signature|handoff/i);
  assert.throws(() => createIrisCandidateHandoffIntent({ ...parameters,
    networkId: "x".repeat(65) }), /context/i);
  assert.throws(() => createIrisCandidateHandoffIntent({ ...parameters,
    modelBytes: sample.toString("utf8") }), /exact bytes/i);
  assert.throws(() => createIrisCandidateHandoffIntent({ ...parameters,
    postCommitRecord: { ...record, rewardEligible: true } }), /record/i);
  assert.throws(() => createIrisCandidateHandoffIntent({ ...parameters,
    modelBytes: Buffer.from('{"format":"nir-local-iris-evidence-v1"}') }), /Iris model|data-only/i);
});
