import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import { certificateHistoryHead, createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH, topologyHistoryCommitment }
  from "../blockchain/certificate-lifecycle.mjs";
import { installCertificateRecord }
  from "../blockchain/certificate-lifecycle-store.mjs";
import { assembleCheckpointTrustPackage, createCheckpointWitnessAttestation,
  createCheckpointWitnessPolicy } from "../blockchain/checkpoint-trust-package.mjs";
import { assembleCheckpointTrustPackageV2, createCheckpointWitnessAttestationV2 }
  from "../blockchain/checkpoint-trust-package-v2.mjs";
import { CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION,
  EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION, MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS }
  from "../blockchain/constants.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { initializeDistributedDevnet } from "../blockchain/distributed-node.mjs";
import { createFinalityProof } from "../blockchain/light-client.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { assertTransactionIngressValidatorSet, createValidatorTransactionCheckpointGate }
  from "../blockchain/validator-transaction-ingress-checkpoint.mjs";
import { createValidatorHandoff, verifyValidatorHandoff }
  from "../blockchain/validator-handoff.mjs";
import { installValidatorHandoff } from "../blockchain/validator-handoff-store.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import { installValidatorTopology } from "../blockchain/validator-topology-history.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";
import { advanceTransactionIngressFloor, initializeTransactionIngressFloor,
  loadTransactionIngressFloor }
  from "../blockchain/validator-transaction-ingress-floor.mjs";

const NOW = 1_800_000_000_000;
const PIN_A = "a".repeat(64);
const PIN_B = "b".repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-ingress-checkpoint-gate-"));
  const layout = initializeDistributedDevnet(join(root, "network"), {
    tlsCertificateSha256: PIN_A,
  });
  const genesis = {
    ...JSON.parse(readFileSync(join(layout.coordinatorDirectory, "genesis.json"))),
    evaluationEnvironment: { adapter_protocol: "nir-application-adapter-v1", cpu_limit: 2,
      format: "nir-evaluation-environment-v1", image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30, runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60 },
    genesisProtocolVersion: EXTENDED_EVALUATION_ASSIGNMENT_PROTOCOL_VERSION,
  };
  const validatorWallets = layout.validatorDirectories.map((directory) =>
    JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"))));
  const chain = new NirChain(genesis);
  const append = (options = {}) => {
    const proposal = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1,
      ...options });
    const block = finalizeBlock(proposal, validatorWallets.slice(0, 3));
    chain.appendBlock(block);
    return block;
  };
  const activationHeight = 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append({ protocolUpgrade: { activationHeight, format: "nir-protocol-upgrade-v1",
    version: CHAIN_IDENTITY_CHECKPOINT_PROTOCOL_VERSION } });
  while (chain.height < activationHeight) append();
  const genesisHash = chain.blocks()[0].hash;
  const checkpoint = chain.blocks().at(-1);
  const finalityProof = createFinalityProof(checkpoint);
  const fork = new NirChain(genesis);
  for (const block of chain.blocks().slice(1, -1)) fork.appendBlock(block);
  const alternateCheckpoint = finalizeBlock(fork.buildBlock({
    timestamp: checkpoint.timestamp + 1,
  }), validatorWallets.slice(0, 3));
  fork.appendBlock(alternateCheckpoint);
  const alternateFinalityProof = createFinalityProof(alternateCheckpoint);
  const witnesses = Array.from({ length: 4 }, generateWallet);
  const policy = createCheckpointWitnessPolicy({ chainIdentityGenesisHash: genesisHash,
    generation: 1, networkId: genesis.networkId, threshold: 3,
    witnesses: witnesses.map((wallet, index) =>
      ({ ...publicWallet(wallet), operatorId: `witness-${index}` })) });
  const v1PackageFor = (sequence, observedAt = NOW - 100, proof = finalityProof) => {
    const attestations = witnesses.slice(0, 3).map((wallet, index) =>
      createCheckpointWitnessAttestation({ finalityProof: proof,
        observedAt: observedAt + index, operatorId: `witness-${index}`,
        policy, sequence, validators: genesis.validators, wallet }));
    return assembleCheckpointTrustPackage({ attestations, finalityProof: proof,
      policy, sequence, validators: genesis.validators });
  };
  const packageFor = (sequence, observedAt = NOW - 100, proof = finalityProof,
    history = [issue], commitmentOverride = null, validators = genesis.validators) => {
    const commitment = commitmentOverride ?? {
      certificateHistoryHead: certificateHistoryHead(history, context),
      certificateRecordCount: history.length,
    };
    const attestations = witnesses.slice(0, 3).map((wallet, index) =>
      createCheckpointWitnessAttestationV2({ ...commitment, finalityProof: proof,
        observedAt: observedAt + index, operatorId: `witness-${index}`,
        policy, sequence, validators, wallet }));
    return assembleCheckpointTrustPackageV2({ ...commitment, attestations,
      finalityProof: proof, policy, sequence, validators });
  };
  const context = { currentHeight: 0, minimumActivationDelay: 0,
    networkId: genesis.networkId, peerRegistryHash: peerRegistryHash(genesis.peerRegistry),
    topologyHistoryHash: topologyHistoryCommitment(), validators: genesis.validators };
  const address = validatorWallets[0].address;
  const issue = createCertificateRecord({ activationHeight: 0,
    certificate: { serial: "10", sha256: PIN_A }, networkId: genesis.networkId,
    operation: "issue", overlapUntilHeight: 0,
    peerRegistryHash: context.peerRegistryHash,
    previousRecordHash: EMPTY_CERTIFICATE_RECORD_HASH, sequence: 0,
    topologyHistoryHash: context.topologyHistoryHash, validatorAddress: address,
  }, validatorWallets.slice(0, 3));
  const certificateDirectory = layout.coordinatorDirectory;
  installCertificateRecord(join(certificateDirectory, "certificates"), issue, context);
  const certificateHeadAnchorPath = join(root, "certificate-anchor.json");
  const writeAnchor = (history) => writeFileSync(certificateHeadAnchorPath, JSON.stringify({
    format: "nir-certificate-history-anchor-v1",
    headHash: certificateHistoryHead(history, context), networkId: genesis.networkId,
    recordCount: history.length, version: 1,
  }));
  writeAnchor([issue]);
  const checkpointPackagePath = join(root, "checkpoint-package.json");
  const floorDirectory = join(root, "ingress-floor");
  const floorIdentity = { expectedGenesisHash: genesisHash,
    expectedNetworkId: genesis.networkId, expectedPolicyId: policy.policyId,
    validatorAddress: address };
  initializeTransactionIngressFloor(floorDirectory, floorIdentity);
  const writePackage = (value) => writeFileSync(checkpointPackagePath, JSON.stringify(value));
  writePackage(packageFor(8));
  const options = { certificateDirectory, certificateHeadAnchorPath,
    checkpointPackagePath, expectedGenesisHash: genesisHash,
    expectedNetworkId: genesis.networkId, expectedPolicyId: policy.policyId,
    floorDirectory, genesis, maxWitnessAgeMs: 30_000, minimumCheckpointHeight: 1,
    minimumSequence: 8, now: () => NOW, tlsCertificateSha256: PIN_A,
    validatorAddress: address };
  return { address, alternateFinalityProof, certificateDirectory, checkpoint,
    context, floorIdentity, genesis, issue,
    layout, options, packageFor, root, v1PackageFor, validatorWallets, writeAnchor, writePackage };
}

test("a new-set checkpoint at handoff activation cannot substitute another finalized block", () => {
  const values = fixture();
  try {
    const oldWallets = values.validatorWallets.slice(0, 2);
    const nextWallets = [...oldWallets, generateWallet(), generateWallet()];
    const nextValidators = [
      ...oldWallets.map(({ address }) => values.genesis.validators.find(
        (entry) => entry.address === address)),
      ...nextWallets.slice(2).map((wallet, index) =>
        ({ ...publicWallet(wallet), operatorId: `rotation-${index}` })),
    ];
    const oldTransports = values.layout.validatorDirectories.map((directory) =>
      JSON.parse(readFileSync(join(directory, "TRANSPORT-KEY.json"))));
    const transportByAddress = new Map(values.validatorWallets.map((wallet, index) =>
      [wallet.address, oldTransports[index]]));
    const nextTransports = nextWallets.map((wallet) =>
      transportByAddress.get(wallet.address) ?? generateWallet());
    const oldPeers = new Map(values.genesis.peerRegistry.peers.map((peer) =>
      [peer.validatorAddress, peer]));
    const peers = nextWallets.map((wallet, index) => oldPeers.get(wallet.address) ?? {
      tlsCertificateSha256: null, transport: publicWallet(nextTransports[index]),
      url: `http://127.0.0.1:${9900 + index}`, validatorAddress: wallet.address,
    });
    const height = values.checkpoint.height;
    const handoff = createValidatorHandoff({
      activationBlockHash: values.checkpoint.hash, activationHeight: height,
      activationStateRoot: values.checkpoint.stateRoot,
      networkId: values.genesis.networkId, nextValidators,
      previousValidators: values.genesis.validators,
    }, values.validatorWallets.slice(0, 3), nextWallets.slice(0, 3));
    const trustAnchor = { expectedNetworkId: values.genesis.networkId,
      trustedValidators: values.genesis.validators };
    installValidatorHandoff(join(values.certificateDirectory, "handoffs"), handoff, trustAnchor);
    const onboarding = createValidatorOnboarding({ activationHeight: height,
      currentValidators: values.genesis.validators, networkId: values.genesis.networkId,
      nextValidators, peers }, values.validatorWallets.slice(0, 3), nextWallets,
    nextTransports);
    installValidatorTopology(join(values.certificateDirectory, "topologies"), onboarding, {
      genesisPeerRegistry: values.genesis.peerRegistry,
      genesisValidators: values.genesis.validators, handoffs: [handoff],
      networkId: values.genesis.networkId,
    });
    const alternate = finalizeBlock({ ...values.checkpoint,
      stateRoot: "f".repeat(64), validatorSetId: validatorSetId(nextValidators) },
    nextWallets.slice(0, 3));
    assert.notEqual(alternate.hash, handoff.activationBlockHash);
    values.writePackage(values.packageFor(8, NOW - 100, createFinalityProof(alternate),
      undefined, null, nextValidators));
    const gate = createValidatorTransactionCheckpointGate(values.options);
    assert.throws(gate, /handoff activation requires a full finality chain proof/);
    const floor = loadTransactionIngressFloor(values.options.floorDirectory, values.floorIdentity);
    assert.equal(floor.height, 0);
    assert.equal(floor.sequence, 0);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("a witness package cannot supply its own unrelated finality validator quorum", () => {
  const values = fixture();
  try {
    const replacements = Array.from({ length: 3 }, generateWallet);
    const fakeWallets = [values.validatorWallets[0], ...replacements];
    const fakeValidators = [values.genesis.validators.find(({ address }) =>
      address === values.address), ...replacements.map((wallet, index) =>
      ({ ...publicWallet(wallet), operatorId: `fabricated-${index}` }))]
      .sort((left, right) => left.address.localeCompare(right.address));
    const forgedBlock = finalizeBlock({ ...values.checkpoint,
      validatorSetId: validatorSetId(fakeValidators) }, fakeWallets.slice(0, 3));
    values.writePackage(values.packageFor(8, NOW - 100, createFinalityProof(forgedBlock),
      undefined, null, fakeValidators));
    const gate = createValidatorTransactionCheckpointGate(values.options);
    assert.throws(gate, /validator set does not match verified topology/);
    const floor = loadTransactionIngressFloor(values.options.floorDirectory, values.floorIdentity);
    assert.equal(floor.height, 0);
    assert.equal(floor.sequence, 0);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("validator set binding selects signed topology at the checkpoint height", () => {
  const values = fixture();
  try {
    const nextWallets = [values.validatorWallets[0], values.validatorWallets[1],
      generateWallet(), generateWallet()];
    const nextValidators = [
      ...nextWallets.slice(0, 2).map((wallet) => values.genesis.validators.find(
        ({ address }) => address === wallet.address)),
      ...nextWallets.slice(2).map((wallet, index) =>
        ({ ...publicWallet(wallet), operatorId: `rotated-${index}` }))];
    const activationHeight = values.checkpoint.height + 2;
    const handoff = createValidatorHandoff({
      activationBlockHash: "c".repeat(64), activationHeight,
      activationStateRoot: "d".repeat(64), networkId: values.genesis.networkId,
      nextValidators, previousValidators: values.genesis.validators,
    }, values.validatorWallets.slice(0, 3), nextWallets.slice(0, 3));
    const trusted = verifyValidatorHandoff(handoff, {
      expectedNetworkId: values.genesis.networkId,
      trustedValidators: values.genesis.validators,
    });
    assert.deepEqual(trusted.trustedValidators, [...nextValidators]
      .sort((left, right) => left.address.localeCompare(right.address)));
    const context = { handoffs: [handoff] };
    const verified = (height, validators) => ({ checkpoint: { height,
      validatorSetId: validatorSetId(validators) }, trustedValidators: validators });
    assert.doesNotThrow(() => assertTransactionIngressValidatorSet(
      verified(activationHeight - 1, values.genesis.validators), values.genesis.validators, context));
    assert.throws(() => assertTransactionIngressValidatorSet(
      verified(activationHeight, nextValidators), values.genesis.validators, context),
    /handoff activation requires a full finality chain proof/);
    assert.doesNotThrow(() => assertTransactionIngressValidatorSet(
      verified(activationHeight + 1, nextValidators), values.genesis.validators, context));
    assert.throws(() => assertTransactionIngressValidatorSet(
      verified(activationHeight, values.genesis.validators), values.genesis.validators, context),
    /handoff activation requires a full finality chain proof/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("fresh signed checkpoint and anchored active certificate admit repeatedly", () => {
  const values = fixture();
  try {
    const gate = createValidatorTransactionCheckpointGate(values.options);
    assert.deepEqual(gate(), { checkpointHeight: values.checkpoint.height,
      checkpointSequence: 8 });
    assert.deepEqual(gate(), { checkpointHeight: values.checkpoint.height,
      checkpointSequence: 8 });
    values.writePackage(values.packageFor(9));
    assert.equal(gate().checkpointSequence, 9);
    const restarted = createValidatorTransactionCheckpointGate(values.options);
    assert.equal(restarted().checkpointSequence, 9);
    values.writePackage(values.packageFor(8));
    assert.throws(restarted, /anti-replay|rolled back|invalid/);
    const durable = loadTransactionIngressFloor(values.options.floorDirectory,
      values.floorIdentity);
    assert.equal(durable.sequence, 9);
    assert.equal(durable.height, values.checkpoint.height);
    assert.equal(durable.tipHash, values.checkpoint.hash);
    assert.equal(durable.observedAt, NOW);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("a higher witness sequence cannot switch to another valid finalized tip at the same height", () => {
  const values = fixture();
  try {
    const gate = createValidatorTransactionCheckpointGate(values.options);
    gate();
    const alternate = values.packageFor(9, NOW - 100, values.alternateFinalityProof);
    assert.notEqual(alternate.view.checkpointTipHash, values.checkpoint.hash);
    values.writePackage(alternate);
    assert.throws(gate, /rolled back or diverged/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("foreign identity, tampering, stale witness and clock rollback fail closed", () => {
  const values = fixture();
  try {
    assert.throws(() => createValidatorTransactionCheckpointGate({ ...values.options,
      expectedGenesisHash: "f".repeat(64) }), /genesis configuration/);
    assert.throws(() => createValidatorTransactionCheckpointGate({ ...values.options,
      expectedNetworkId: "foreign-network" }), /pinned identity/);
    const gate = createValidatorTransactionCheckpointGate(values.options);
    const tampered = values.packageFor(8);
    tampered.attestations[0].signature = "not-a-signature";
    values.writePackage(tampered);
    assert.throws(gate);
    values.writePackage(values.packageFor(8, NOW - 60_000));
    assert.throws(gate, /witness time policy/);
    values.writePackage(values.packageFor(8));
    assert.equal(gate().checkpointSequence, 8);
    let clock = NOW;
    const clockGate = createValidatorTransactionCheckpointGate({ ...values.options,
      now: () => clock });
    clockGate(); clock -= 1;
    assert.throws(clockGate, /clock moved backwards/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("renewal cannot be bypassed with a fresh re-attestation of an old checkpoint", () => {
  const values = fixture();
  try {
    const gate = createValidatorTransactionCheckpointGate(values.options);
    const originalPackage = JSON.parse(readFileSync(values.options.checkpointPackagePath));
    gate();
    const renewed = createCertificateRecord({ activationHeight: values.checkpoint.height + 1,
      certificate: { serial: "11", sha256: PIN_B }, networkId: values.genesis.networkId,
      operation: "renew", overlapUntilHeight: values.checkpoint.height + 1,
      peerRegistryHash: values.context.peerRegistryHash,
      previousRecordHash: values.issue.recordHash, sequence: 1,
      topologyHistoryHash: values.context.topologyHistoryHash,
      validatorAddress: values.address,
    }, values.validatorWallets.slice(0, 3));
    installCertificateRecord(join(values.certificateDirectory, "certificates"), renewed,
      values.context);
    values.writeAnchor([values.issue, renewed]);
    values.writePackage(values.packageFor(9));
    assert.throws(gate, /certificate head or count/);
    values.writePackage(values.packageFor(10, NOW - 100, undefined,
      [values.issue, renewed]));
    assert.throws(gate, /TLS pin is not active/);
    assert.equal(loadTransactionIngressFloor(values.options.floorDirectory,
      values.floorIdentity).sequence, 8);
    const restarted = createValidatorTransactionCheckpointGate(values.options);
    values.writePackage(originalPackage);
    assert.throws(restarted, /certificate head or count/);
    values.writePackage(values.packageFor(10, NOW - 100, undefined,
      [values.issue, renewed]));
    values.writeAnchor([values.issue]);
    assert.throws(gate, /external anchor|rolled back|conflicts/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("a finalized-height revocation and unsafe evidence path fail closed", () => {
  const values = fixture();
  try {
    const gate = createValidatorTransactionCheckpointGate(values.options);
    gate();
    const revoked = createCertificateRecord({
      activationHeight: values.checkpoint.height,
      certificate: null, networkId: values.genesis.networkId,
      operation: "revoke", overlapUntilHeight: values.checkpoint.height,
      peerRegistryHash: values.context.peerRegistryHash,
      previousRecordHash: values.issue.recordHash, sequence: 1,
      topologyHistoryHash: values.context.topologyHistoryHash,
      validatorAddress: values.address,
    }, values.validatorWallets.slice(0, 3));
    installCertificateRecord(join(values.certificateDirectory, "certificates"), revoked,
      values.context);
    values.writeAnchor([values.issue, revoked]);
    values.writePackage(values.packageFor(9));
    assert.throws(gate, /certificate head or count/);
    values.writePackage(values.packageFor(10, NOW - 100, undefined,
      [values.issue, revoked]));
    assert.throws(gate, /TLS pin is not active/);
    const linked = join(values.root, "linked-package.json");
    symlinkSync(values.options.checkpointPackagePath, linked);
    const unsafeGate = createValidatorTransactionCheckpointGate({ ...values.options,
      checkpointPackagePath: linked });
    assert.throws(unsafeGate, /file is unsafe/);
    rmSync(values.options.checkpointPackagePath);
    assert.throws(gate, /ENOENT/);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("ceremony gate rejects V1 and migrates a retained V1 floor only with a newer V2 package", () => {
  const values = fixture();
  try {
    const old = values.v1PackageFor(8);
    advanceTransactionIngressFloor(values.options.floorDirectory, values.floorIdentity, {
      height: values.checkpoint.height, historyCount: 1,
      historyHead: certificateHistoryHead([values.issue], values.context),
      observedAt: NOW - 1, packageHash: old.packageHash,
      sequence: 8, tipHash: values.checkpoint.hash,
    });
    values.writePackage(old);
    const gate = createValidatorTransactionCheckpointGate(values.options);
    assert.throws(gate, /checkpoint v2 package envelope/);
    assert.equal(loadTransactionIngressFloor(values.options.floorDirectory,
      values.floorIdentity).sequence, 8);
    values.writePackage(values.packageFor(8));
    assert.throws(gate, /rolled back or diverged/);
    values.writePackage(values.packageFor(9));
    assert.equal(gate().checkpointSequence, 9);
    const restarted = createValidatorTransactionCheckpointGate(values.options);
    values.writePackage(old);
    assert.throws(restarted, /checkpoint v2 package envelope/);
    assert.equal(loadTransactionIngressFloor(values.options.floorDirectory,
      values.floorIdentity).sequence, 9);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});

test("V2 head and count must exactly match all externally anchored lifecycle records", () => {
  const values = fixture();
  try {
    const gate = createValidatorTransactionCheckpointGate(values.options);
    values.writePackage(values.packageFor(8, NOW - 100, undefined, undefined, {
      certificateHistoryHead: "f".repeat(64), certificateRecordCount: 1,
    }));
    assert.throws(gate, /certificate head or count/);
    values.writePackage(values.packageFor(9, NOW - 100, undefined, undefined, {
      certificateHistoryHead: certificateHistoryHead([values.issue], values.context),
      certificateRecordCount: 2,
    }));
    assert.throws(gate, /certificate head or count/);
    values.writePackage(values.packageFor(10));
    assert.equal(gate().checkpointSequence, 10);
  } finally { rmSync(values.root, { recursive: true, force: true }); }
});
