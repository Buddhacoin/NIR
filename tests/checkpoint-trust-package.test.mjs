import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleCheckpointTrustPackage,
  createCheckpointWitnessAttestation,
  createCheckpointWitnessEquivocationEvidence,
  createCheckpointWitnessPolicy,
  MAX_CHECKPOINT_TRUST_PACKAGE_BYTES,
  parseAndVerifyCheckpointTrustPackage,
  serializeCheckpointTrustPackage,
  validateCheckpointWitnessEquivocationEvidence,
  verifyCheckpointTrustPackage,
} from "../blockchain/checkpoint-trust-package.mjs";
import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  SAFETY_POLICY_V1_COMMITMENT,
} from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({ ...publicWallet(wallet), operatorId: `${prefix}-${index}` }));
}

function fixture(networkId = "nir-checkpoint-package-test") {
  const validators = Array.from({ length: 4 }, generateWallet);
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const validatorMembers = members(validators, "validator");
  const chain = new NirChain({
    beaconAuthorities: members(beacons, "beacon"),
    capabilityReferences: [{ artifactHash: `sha256:${"1".repeat(64)}`,
      behaviorCommitment: "2".repeat(64), capabilitiesBps: { "reasoning-v1": 1 } }],
    evaluationEnvironment: {
      adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60,
    },
    evaluators: members(evaluators, "evaluator"),
    genesisProtocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
    genesisTimestamp: 0, networkId,
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: generateWallet().address, validators: validatorMembers,
  });
  const append = (options = {}) => {
    const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1, ...options });
    const block = finalizeBlock(proposal, validators.slice(0, 3));
    chain.appendBlock(block);
    return block;
  };
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append({ protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
    version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION } });
  while (chain.height < activationHeight) append();
  const genesisHash = chain.blocks()[0].hash;
  const policy = createCheckpointWitnessPolicy({ chainIdentityGenesisHash: genesisHash,
    generation: 3, networkId, threshold: 3,
    witnesses: members(witnesses, "witness") });
  return { append, chain, genesisHash, policy, validatorMembers, validators, witnesses };
}

function attestations(value, proof, sequence = 7, observedAt = 10_000) {
  return value.witnesses.slice(0, 3).map((wallet, index) =>
    createCheckpointWitnessAttestation({ finalityProof: proof, observedAt: observedAt + index,
      operatorId: `witness-${index}`, policy: value.policy, sequence,
      validators: value.validatorMembers, wallet }));
}

function packageFixture() {
  const value = fixture();
  const checkpointBlock = value.chain.blocks().at(-1);
  const proof = createFinalityProof(checkpointBlock);
  const packageValue = assembleCheckpointTrustPackage({ attestations: attestations(value, proof),
    finalityProof: proof, policy: value.policy, sequence: 7, validators: value.validatorMembers });
  const options = { expectedChainIdentityGenesisHash: value.genesisHash,
    expectedNetworkId: value.chain.networkId, expectedPolicyId: value.policy.policyId,
    minimumCheckpointHeight: checkpointBlock.height, minimumSequence: 7 };
  return { ...value, checkpointBlock, options, packageValue, proof };
}

test("offline checkpoint package verifies finality plus a pinned 3-of-4 witness policy", () => {
  const value = packageFixture();
  const verified = verifyCheckpointTrustPackage(value.packageValue, value.options);
  assert.equal(verified.checkpoint.tipHash, value.checkpointBlock.hash);
  assert.equal(verified.policyId, value.policy.policyId);
  assert.deepEqual(verified.witnessOperators, ["witness-0", "witness-1", "witness-2"]);
  assert.equal(verified.trustedValidators.length, 4);

  const canonical = serializeCheckpointTrustPackage(value.packageValue);
  assert.ok(Buffer.byteLength(canonical) < MAX_CHECKPOINT_TRUST_PACKAGE_BYTES);
  assert.equal(parseAndVerifyCheckpointTrustPackage(canonical, value.options).packageHash,
    value.packageValue.packageHash);
});

test("pinned policy, chain identity, network, validator set and finality view fail closed", () => {
  const value = packageFixture();
  const attacker = fixture(value.chain.networkId);
  assert.throws(() => verifyCheckpointTrustPackage(value.packageValue, {
    ...value.options, expectedPolicyId: attacker.policy.policyId,
  }), /pinned trust policy/);
  assert.throws(() => verifyCheckpointTrustPackage(value.packageValue, {
    ...value.options, expectedNetworkId: "other-network",
  }), /pinned trust policy/);
  assert.throws(() => verifyCheckpointTrustPackage(value.packageValue, {
    ...value.options, expectedChainIdentityGenesisHash: "0".repeat(64),
  }), /pinned trust policy/);

  const validators = structuredClone(value.packageValue.validators);
  validators[0] = { ...attacker.validatorMembers[0], operatorId: "attacker-validator" };
  assert.throws(() => verifyCheckpointTrustPackage({ ...value.packageValue, validators }, value.options),
    /canonically ordered|validator identity|validator set is not trusted|vote is invalid|view is invalid/);
  assert.throws(() => verifyCheckpointTrustPackage({ ...value.packageValue,
    validators: [...value.packageValue.validators].reverse() }, value.options),
  /canonically ordered/);
  assert.throws(() => verifyCheckpointTrustPackage({
    ...value.packageValue,
    view: { ...value.packageValue.view, checkpointTipHash: "0".repeat(64) },
  }, value.options), /view is invalid/);
  assert.throws(() => verifyCheckpointTrustPackage({
    ...value.packageValue,
    finalityProof: { ...value.packageValue.finalityProof, hash: "0".repeat(64) },
  }, value.options), /header is invalid/);
});

test("sequence, height and observation floors reject replay and stale packages", () => {
  const value = packageFixture();
  assert.throws(() => verifyCheckpointTrustPackage(value.packageValue, {
    ...value.options, minimumSequence: 8,
  }), /anti-replay floor|replayed/);
  assert.throws(() => verifyCheckpointTrustPackage(value.packageValue, {
    ...value.options, minimumCheckpointHeight: value.checkpointBlock.height + 1,
  }), /replayed/);
  assert.throws(() => verifyCheckpointTrustPackage(value.packageValue, {
    ...value.options, maxAgeMs: 100, maxFutureSkewMs: 0, now: 20_000,
  }), /time policy/);
  assert.equal(verifyCheckpointTrustPackage(value.packageValue, {
    ...value.options, maxAgeMs: 10, maxFutureSkewMs: 5, now: 10_005,
  }).sequence, 7);
});

test("witness quorum rejects duplicates, mixed views, reordering and signature forgery", () => {
  const value = packageFixture();
  assert.throws(() => createCheckpointWitnessPolicy({
    chainIdentityGenesisHash: value.genesisHash, networkId: value.chain.networkId, threshold: 2,
    witnesses: members(value.witnesses, "witness"),
  }), /policy is invalid/);
  const duplicate = [value.packageValue.attestations[0], value.packageValue.attestations[0],
    value.packageValue.attestations[2]];
  assert.throws(() => verifyCheckpointTrustPackage({ ...value.packageValue,
    attestations: duplicate }, value.options), /quorum/);
  assert.throws(() => verifyCheckpointTrustPackage({ ...value.packageValue,
    attestations: [...value.packageValue.attestations].reverse() }, value.options), /quorum/);
  const forged = structuredClone(value.packageValue.attestations);
  forged[0].signature = forged[1].signature;
  assert.throws(() => verifyCheckpointTrustPackage({ ...value.packageValue,
    attestations: forged }, value.options), /signature|hash/);

  const nextProof = createFinalityProof(value.append());
  const mixed = createCheckpointWitnessAttestation({ finalityProof: nextProof,
    observedAt: 10_004, operatorId: "witness-3", policy: value.policy, sequence: 7,
    validators: value.validatorMembers, wallet: value.witnesses[3] });
  assert.throws(() => assembleCheckpointTrustPackage({
    attestations: [value.packageValue.attestations[0], value.packageValue.attestations[1], mixed],
    finalityProof: value.proof, policy: value.policy, sequence: 7,
    validators: value.validatorMembers,
  }), /context/);
});

test("same witness signing two views at one sequence yields portable equivocation evidence", () => {
  const value = packageFixture();
  const nextProof = createFinalityProof(value.append());
  const conflicting = createCheckpointWitnessAttestation({ finalityProof: nextProof,
    observedAt: 10_010, operatorId: "witness-0", policy: value.policy, sequence: 7,
    validators: value.validatorMembers, wallet: value.witnesses[0] });
  const evidence = createCheckpointWitnessEquivocationEvidence(
    value.packageValue.attestations[0], conflicting, { policy: value.policy });
  assert.equal(validateCheckpointWitnessEquivocationEvidence(evidence, {
    policy: value.policy,
  }).operatorId, "witness-0");
  assert.throws(() => createCheckpointWitnessEquivocationEvidence(
    value.packageValue.attestations[0], value.packageValue.attestations[0],
    { policy: value.policy }), /do not prove/);
});

test("bounded canonical parser rejects malleability, unknown fields and oversized input", () => {
  const value = packageFixture();
  const canonical = serializeCheckpointTrustPackage(value.packageValue);
  assert.throws(() => parseAndVerifyCheckpointTrustPackage(JSON.stringify(value.packageValue),
    value.options), /canonical UTF-8/);
  assert.throws(() => parseAndVerifyCheckpointTrustPackage(` ${canonical}`, value.options),
    /not canonical/);
  assert.throws(() => parseAndVerifyCheckpointTrustPackage(
    `${JSON.stringify({ ...value.packageValue, surprise: true })}\n`, value.options),
    /not canonical|unknown/);
  const tooDeep = `${"[".repeat(66)}null${"]".repeat(66)}\n`;
  assert.throws(() => parseAndVerifyCheckpointTrustPackage(tooDeep, value.options),
    /not valid JSON/);
  assert.throws(() => parseAndVerifyCheckpointTrustPackage(
    Buffer.alloc(MAX_CHECKPOINT_TRUST_PACKAGE_BYTES + 1, 0x20), value.options), /bounded limit/);
});
