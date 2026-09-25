import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NirChain,
  blockHeader,
  blockHeaderHash,
  blockHash,
  computeChainStateRoot,
  commitVoteForBlock,
  createTransfer,
  createValidatorBond,
  finalizeBlock,
  timeoutForRound,
  voteForBlock,
} from "../blockchain/chain.mjs";
import {
  MIN_TRANSFER_FEE,
  MAX_BLOCK_BYTES,
  HISTORICAL_VALIDATOR_EVIDENCE_PROTOCOL_VERSION,
  MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS,
  SAFETY_POLICY_V1_COMMITMENT,
  TREASURY_VESTING_MS,
} from "../blockchain/constants.mjs";
import {
  canonicalJson, generateWallet, hashObject, publicWallet, signObject,
} from "../blockchain/crypto.mjs";
import {
  createValidatorEquivocationTransaction,
  assembleValidatorPrepareEquivocationEvidence,
  MAX_EQUIVOCATION_EVIDENCE_BYTES,
  proveValidatorPrepareEquivocation,
  verifyValidatorPrepareEquivocationEvidence,
} from "../blockchain/validator-equivocation.mjs";
import { MIN_VALIDATOR_BOND } from "../blockchain/validator-staking.mjs";
import { createFinalityProof, verifyFinalityProofChain } from "../blockchain/light-client.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import {
  createReleaseAuthoritySet, createReleaseTransparencyAnchor,
} from "../blockchain/offline-release-governance.mjs";
import {
  approveProtocolUpgradeAuthorization, assembleProtocolUpgradeAuthorization,
  createProtocolUpgradeAuthorizationPayload,
} from "../blockchain/protocol-upgrade-authorization.mjs";
import {
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";

function fingerprint(label) {
  return createHash("sha256").update(label).digest("hex");
}

function members(wallets, prefix) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `${prefix}-${index}`,
  }));
}

function authorizedUpgrade(chain, authoritySet, releaseWallets, activationHeight) {
  const payload = {
    bundleHash: `sha3-256:${"a".repeat(64)}`,
    manifestHash: `sha3-256:${"b".repeat(64)}`,
    networkId: chain.networkId,
    previousBundleHash: null,
    protocolVersion: HISTORICAL_VALIDATOR_EVIDENCE_PROTOCOL_VERSION,
    releaseVersion: "0.3.0",
    sourceRevision: "c".repeat(40),
  };
  const proposal = {
    activeSetId: authoritySet.setId,
    format: "nir-release-log-proposal-v1",
    logId: "nir-protocol-releases",
    networkId: chain.networkId,
    payload,
    previousEntryHash: chain.protocolReleaseHead.entryHash,
    sequence: chain.protocolReleaseHead.sequence + 1,
    type: "release",
    version: 1,
  };
  proposal.proposalHash = `sha3-256:${hashObject(proposal, "RELEASE_LOG_PROPOSAL_V1")}`;
  const entryApprovals = releaseWallets.slice(0, authoritySet.threshold).map((wallet, index) => ({
    address: wallet.address,
    format: "nir-release-governance-approval-v1",
    operatorId: `release-${index}`,
    proposalHash: proposal.proposalHash,
    role: "active",
    setId: authoritySet.setId,
    signature: signObject({ proposalHash: proposal.proposalHash, sequence: proposal.sequence,
      role: "active", setId: authoritySet.setId }, wallet, "RELEASE_GOVERNANCE_APPROVAL_V1"),
    version: 1,
  }));
  const unsignedEntry = {
    activeSetId: authoritySet.setId,
    activationApprovals: [],
    approvals: entryApprovals,
    format: "nir-release-transparency-entry-v1",
    logId: proposal.logId,
    networkId: chain.networkId,
    nextSetAcceptances: [],
    payload,
    previousEntryHash: proposal.previousEntryHash,
    proposalHash: proposal.proposalHash,
    sequence: proposal.sequence,
    type: "release",
    version: 1,
  };
  const entry = { ...unsignedEntry,
    entryHash: `sha3-256:${hashObject(unsignedEntry, "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
  const authorizationPayload = createProtocolUpgradeAuthorizationPayload({
    activationHeight,
    authoritySetId: authoritySet.setId,
    baseHeight: chain.height,
    baseTipHash: chain.tipHash,
    bundleHash: payload.bundleHash,
    chainIdentityGenesisHash: chain.blocks()[0].hash,
    currentVersion: chain.protocolVersion,
    entryHash: entry.entryHash,
    manifestHash: payload.manifestHash,
    networkId: chain.networkId,
    releaseVersion: payload.releaseVersion,
    sourceRevision: payload.sourceRevision,
    targetVersion: HISTORICAL_VALIDATOR_EVIDENCE_PROTOCOL_VERSION,
  });
  const approvals = releaseWallets.slice(0, authoritySet.threshold).map((wallet, index) =>
    approveProtocolUpgradeAuthorization(authorizationPayload, authoritySet, {
      operatorId: `release-${index}`, wallet,
    })).sort((left, right) => left.operatorId.localeCompare(right.operatorId));
  return {
    activationHeight,
    authorization: assembleProtocolUpgradeAuthorization(authorizationPayload, entry, approvals),
    format: "nir-protocol-upgrade-v2",
    version: HISTORICAL_VALIDATOR_EVIDENCE_PROTOCOL_VERSION,
  };
}

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beaconAuthorities = Array.from({ length: 4 }, generateWallet);
  const treasury = generateWallet();
  const genesisConfig = {
    beaconAuthorities: members(beaconAuthorities, "beacon"),
    capabilityReferences: [{
      artifactHash: `sha256:${fingerprint("equivocation-baseline")}`,
      behaviorCommitment: fingerprint("equivocation-behavior"),
      capabilitiesBps: { "consensus-v1": 8_000 },
      contentHash: `sha256:${fingerprint("equivocation-content")}`,
    }],
    evaluators: members(evaluators, "evaluator"),
    genesisTimestamp: 0,
    networkId: "nir-equivocation-transition-test",
    safetyPolicyCommitments: [SAFETY_POLICY_V1_COMMITMENT],
    treasuryAddress: treasury.address,
    validators: members(validators, "validator"),
  };
  return { chain: new NirChain(genesisConfig), genesisConfig, treasury, validators };
}

function quorumFor(block, wallets) {
  const proposer = wallets.find(({ address }) => address === block.proposer);
  assert.ok(proposer, "the active proposer wallet must be available");
  return [proposer, ...wallets.filter((wallet) => wallet !== proposer)]
    .slice(0, Math.floor((wallets.length * 2) / 3) + 1);
}

function append(chain, proposal, wallets) {
  const finalized = finalizeBlock(proposal, quorumFor(proposal, wallets));
  chain.appendBlock(finalized);
  return finalized;
}

function restoreAtHead(chain, genesisConfig) {
  const snapshot = chain.consensusSnapshot();
  return NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: snapshot.capabilityMemory,
    checkpoint: chain.blocks().at(-1),
    ...(chain.protocolVersion >= 28 ? {
      chainIdentityGenesisHash: chain.blocks()[0].hash,
      validatorSetId: chain.validatorSetId,
    } : {}),
    height: chain.height,
    networkId: chain.networkId,
    ...(chain.protocolVersion >= 26 ? {
      evaluationAssignmentRoot: chain.evaluationAssignmentRoot,
    } : {}),
    ...(chain.protocolVersion >= 25 ? { recoveryStateCommitment: chain.recoveryStateCommitment } : {}),
    state: snapshot.state,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
  });
}

function prepareEvidence(chain, validators, offender, timestamp) {
  const first = chain.buildBlock({ timestamp });
  const second = chain.buildBlock({ timestamp: timestamp + 1 });
  assert.notEqual(blockHash(first), blockHash(second));
  const evidence = proveValidatorPrepareEquivocation({
    chain,
    first: { proposal: first, vote: voteForBlock(first, offender) },
    second: { proposal: second, vote: voteForBlock(second, offender) },
  });
  return { evidence, first, second };
}

function evidenceForProposals(chain, first, second, offender) {
  return assembleValidatorPrepareEquivocationEvidence({
    first: {
      blockHash: blockHash(first),
      header: chain.finalityHeaderForProposal(first),
      signature: voteForBlock(first, offender).signature,
    },
    second: {
      blockHash: blockHash(second),
      header: chain.finalityHeaderForProposal(second),
      signature: voteForBlock(second, offender).signature,
    },
    height: first.height,
    networkId: chain.networkId,
    round: first.round,
    validator: offender.address,
  });
}

function fundAndBond(chain, treasury, validators, extra = []) {
  const wallets = [...validators, ...extra];
  const funding = wallets.map((wallet, nonce) => createTransfer({
    amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(),
    networkId: chain.networkId,
    nonce,
    recipient: wallet.address,
    wallet: treasury,
  }));
  append(chain, chain.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS }), validators);
  const bonds = wallets.map((wallet, index) => createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(),
    networkId: chain.networkId,
    nonce: 0,
    ...(index >= validators.length ? { operatorId: `recovery-${index}` } : {}),
    wallet,
  }));
  append(chain, chain.buildBlock({
    transactions: bonds, timestamp: TREASURY_VESTING_MS + 1,
  }), validators);
}

function assertRejectedAtomically(chain, transaction, validators, pattern) {
  const root = chain.stateRoot;
  const nonce = chain.nextNonce(transaction.sender);
  const proposal = chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
    transactions: [transaction],
  });
  assert.throws(
    () => chain.appendBlock(finalizeBlock(proposal, quorumFor(proposal, validators))),
    pattern,
  );
  assert.equal(chain.stateRoot, root);
  assert.equal(chain.nextNonce(transaction.sender), nonce);
}

test("native prepare equivocation burns the bond and survives fork snapshot and replay", () => {
  const { chain, genesisConfig, treasury, validators } = fixture();
  const newcomer = generateWallet();
  fundAndBond(chain, treasury, validators, [newcomer]);
  const offender = validators[0];
  const { evidence, first } = prepareEvidence(
    chain, validators, offender, TREASURY_VESTING_MS + 2,
  );
  const alternate = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 3 });
  const inactiveEvidence = assembleValidatorPrepareEquivocationEvidence({
    first: {
      blockHash: blockHash(first),
      header: chain.finalityHeaderForProposal(first),
      signature: voteForBlock(first, newcomer).signature,
    },
    second: {
      blockHash: blockHash(alternate),
      header: chain.finalityHeaderForProposal(alternate),
      signature: voteForBlock(alternate, newcomer).signature,
    },
    height: first.height,
    networkId: chain.networkId,
    round: first.round,
    validator: newcomer.address,
  });
  const changedRound = structuredClone(evidence);
  changedRound.round += 1;
  const { evidenceHash: _oldHash, ...changedRoundPayload } = changedRound;
  changedRound.evidenceHash = hashObject(
    changedRoundPayload, "VALIDATOR_EQUIVOCATION_V2",
  );
  assert.throws(
    () => verifyValidatorPrepareEquivocationEvidence(changedRound, { chain }),
    /signatures/,
  );
  const prepareSigners = quorumFor(first, validators);
  const prepareCertificate = prepareSigners.map((wallet) => voteForBlock(first, wallet));
  const timeoutFields = {
    blockHash: blockHash(first),
    height: first.height,
    networkId: first.networkId,
    nextRound: 1,
    previousHash: first.previousHash,
  };
  const recovered = chain.buildBlock({
    round: 1,
    roundCertificate: prepareSigners.map((wallet) => timeoutForRound(timeoutFields, wallet)),
    timestamp: first.timestamp,
  });
  const recoveredBlock = {
    ...recovered,
    certificate: prepareSigners.map((wallet) =>
      commitVoteForBlock(recovered, prepareCertificate, wallet)),
    hash: blockHash(recovered),
    prepareCertificate,
  };
  chain.appendBlock(recoveredBlock);
  const inactiveTransaction = createValidatorEquivocationTransaction({
    evidence: inactiveEvidence,
    networkId: chain.networkId,
    nonce: chain.nextNonce(treasury.address),
    wallet: treasury,
  });
  assertRejectedAtomically(chain, inactiveTransaction, validators, /not active and bonded/);
  const wrongRoundEvidence = assembleValidatorPrepareEquivocationEvidence({
    first: {
      ...evidence.statements[0],
      signature: signObject({
        blockHash: evidence.statements[0].blockHash,
        height: evidence.height,
        round: 1,
      }, offender, "BLOCK_PREPARE"),
    },
    second: {
      ...evidence.statements[1],
      signature: signObject({
        blockHash: evidence.statements[1].blockHash,
        height: evidence.height,
        round: 1,
      }, offender, "BLOCK_PREPARE"),
    },
    height: evidence.height,
    networkId: evidence.networkId,
    round: 1,
    validator: offender.address,
  });
  const wrongRoundTransaction = createValidatorEquivocationTransaction({
    evidence: wrongRoundEvidence,
    networkId: chain.networkId,
    nonce: chain.nextNonce(treasury.address),
    wallet: treasury,
  });
  assertRejectedAtomically(chain, wrongRoundTransaction, validators, /current finalized head/);
  const atEvidenceHead = chain.fork();
  const snapshotAtEvidenceHead = restoreAtHead(chain, genesisConfig);
  const transaction = createValidatorEquivocationTransaction({
    evidence,
    networkId: chain.networkId,
    nonce: chain.nextNonce(treasury.address),
    wallet: treasury,
  });
  const slashProposal = chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 3, transactions: [transaction],
  });
  const slashBlock = finalizeBlock(slashProposal, quorumFor(slashProposal, validators));
  for (const replica of [chain, atEvidenceHead, snapshotAtEvidenceHead]) {
    replica.appendBlock(slashBlock);
    assert.equal(replica.validatorBond(offender.address), 0n);
    assert.equal(replica.validatorDisabled(offender.address), true);
    assert.equal(replica.validatorEquivocationEvidenceUsed(evidence.evidenceHash), true);
    assert.equal(replica.burned, MIN_VALIDATOR_BOND);
    assert.ok(replica.validatorMembers.some(({ address }) => address === offender.address));
  }
  assert.equal(atEvidenceHead.stateRoot, chain.stateRoot);
  assert.equal(snapshotAtEvidenceHead.stateRoot, chain.stateRoot);

  const replay = createValidatorEquivocationTransaction({
    evidence,
    networkId: chain.networkId,
    nonce: chain.nextNonce(treasury.address),
    wallet: treasury,
  });
  assertRejectedAtomically(chain, replay, validators, /already used/);

  const replayed = new NirChain(genesisConfig);
  for (const block of chain.blocks().slice(1)) replayed.appendBlock(block);
  assert.equal(replayed.stateRoot, chain.stateRoot);
  assert.equal(replayed.validatorDisabled(offender.address), true);

  const activeWallets = validators.filter(({ address }) => address !== offender.address);
  assert.equal(chain.validatorSetId, new NirChain(genesisConfig).validatorSetId);
  const rebond = createValidatorBond({
    amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId,
    nonce: chain.nextNonce(offender.address), wallet: offender,
  });
  assertRejectedAtomically(chain, rebond, validators, /disabled validator identity/);

  const proposedWallets = [...activeWallets, newcomer];
  const proposedMembers = proposedWallets.map((wallet) => {
    const originalIndex = validators.indexOf(wallet);
    return {
      ...publicWallet(wallet),
      operatorId: originalIndex >= 0 ? `validator-${originalIndex}` : "recovery-4",
    };
  });
  const rotationMixRoot = chain.stateRoot;
  const rotationMixNonce = chain.nextNonce(treasury.address);
  assert.throws(() => chain.buildBlock({
    transactions: [transaction],
    validatorRotation: {
      activationHeight: chain.height + 5,
      validators: proposedMembers,
    },
  }), /require separate blocks/);
  assert.equal(chain.stateRoot, rotationMixRoot);
  assert.equal(chain.nextNonce(treasury.address), rotationMixNonce);
  assert.throws(() => chain.buildBlock({
    validatorRotation: {
      activationHeight: chain.height + 5,
      validators: [...proposedMembers, {
        ...publicWallet(offender), operatorId: "validator-0",
      }],
    },
  }), /disabled validator/);

  const activationHeight = chain.height + 5;
  append(chain, chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 4,
    validatorRotation: { activationHeight, validators: proposedMembers },
  }), validators);
  let activationBlock;
  while (chain.height < activationHeight) {
    const activating = chain.height + 1 === activationHeight;
    const signingWallets = activating ? proposedWallets : validators;
    const proposal = chain.buildBlock({
      timestamp: chain.blocks().at(-1).timestamp + 1,
    });
    const block = activating
      ? finalizeBlock(proposal, signingWallets)
      : finalizeBlock(proposal, quorumFor(proposal, signingWallets));
    chain.appendBlock(block);
    if (activating) activationBlock = block;
  }
  assert.deepEqual(
    chain.validatorMembers.map(({ address }) => address).sort(),
    proposedWallets.map(({ address }) => address).sort(),
  );
  assert.equal(chain.validatorDisabled(offender.address), true);
  const handoff = createValidatorHandoff({
    activationBlockHash: activationBlock.hash,
    activationHeight,
    activationStateRoot: activationBlock.stateRoot,
    networkId: chain.networkId,
    nextValidators: proposedMembers,
    previousValidators: genesisConfig.validators,
  }, activeWallets, proposedWallets);
  append(chain, chain.buildBlock({
    timestamp: chain.blocks().at(-1).timestamp + 1,
  }), proposedWallets);
  const genesisBlock = chain.blocks()[0];
  const proofs = chain.blocks().slice(1).map(createFinalityProof);
  const proofOptions = {
      checkpoint: {
        height: 0,
        stateRoot: genesisBlock.stateRoot,
        tipHash: genesisBlock.hash,
        validatorSetId: new NirChain(genesisConfig).validatorSetId,
      },
      expectedNetworkId: chain.networkId,
      handoffs: [handoff],
      trustedValidators: genesisConfig.validators,
  };
  const changedProofRound = structuredClone(proofs);
  changedProofRound[0].round += 1;
  assert.throws(
    () => verifyFinalityProofChain(changedProofRound, proofOptions),
    /prepare vote/,
  );
  const legacyProof = structuredClone(proofs);
  legacyProof[0].format = "nir-finality-proof-v1";
  delete legacyProof[0].round;
  assert.throws(
    () => verifyFinalityProofChain(legacyProof, proofOptions),
    /finality proof is invalid/,
  );
  const lightTip = verifyFinalityProofChain(proofs, proofOptions);
  assert.equal(lightTip.tipHash, chain.tipHash);
  assert.equal(lightTip.validatorSetId, chain.validatorSetId);
});

test("activation evidence uses the exact recent dual-quorum membership across restart", () => {
  const values = fixture();
  const releaseWallets = Array.from({ length: 4 }, generateWallet);
  const authoritySet = createReleaseAuthoritySet({
    authorities: members(releaseWallets, "release"),
    generation: 1,
    rotationDelayEntries: 2,
    threshold: 3,
  });
  const releaseAnchor = createReleaseTransparencyAnchor({
    initialSet: authoritySet,
    logId: "nir-protocol-releases",
    networkId: values.genesisConfig.networkId,
  });
  const genesisConfig = {
    ...values.genesisConfig,
    evaluationEnvironment: {
      adapter_protocol: "nir-application-adapter-v1",
      cpu_limit: 2,
      format: "nir-evaluation-environment-v1",
      image_digest: `sha256:${"3".repeat(64)}`,
      memory_limit_bytes: 1 << 30,
      runner_digest: `sha256:${"4".repeat(64)}`,
      timeout_seconds: 60,
    },
    genesisProtocolVersion: 27,
    protocolUpgradeReleaseAnchor: releaseAnchor,
  };
  const chain = new NirChain(genesisConfig);
  const { treasury, validators } = values;
  append(chain, chain.buildBlock({ timestamp: 1 }), validators);
  let protocolActivationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, chain.buildBlock({
    protocolUpgrade: { activationHeight: protocolActivationHeight,
      format: "nir-protocol-upgrade-v1", version: 28 },
    timestamp: chain.blocks().at(-1).timestamp + 1,
  }), validators);
  while (chain.height < protocolActivationHeight) {
    append(chain, chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 }), validators);
  }
  protocolActivationHeight = chain.height + 1 + MIN_PROTOCOL_UPGRADE_DELAY_BLOCKS;
  append(chain, chain.buildBlock({
    protocolUpgrade: authorizedUpgrade(
      chain, authoritySet, releaseWallets, protocolActivationHeight,
    ),
    timestamp: chain.blocks().at(-1).timestamp + 1,
  }), validators);
  while (chain.height < protocolActivationHeight) {
    append(chain, chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 }), validators);
  }
  const newcomer = generateWallet();
  const outsider = generateWallet();
  fundAndBond(chain, treasury, validators, [newcomer, outsider]);
  const nextWallets = [...validators.slice(1), newcomer];
  const nextMembers = [
    ...genesisConfig.validators.slice(1),
    { ...publicWallet(newcomer), operatorId: "recovery-4" },
  ];
  const activationHeight = chain.height + 5;
  append(chain, chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 2,
    validatorRotation: { activationHeight, validators: nextMembers },
  }), validators);
  while (chain.height + 1 < activationHeight) {
    append(chain, chain.buildBlock({
      timestamp: chain.blocks().at(-1).timestamp + 1,
    }), validators);
  }

  const first = chain.buildBlock({ timestamp: chain.blocks().at(-1).timestamp + 1 });
  const second = chain.buildBlock({ timestamp: first.timestamp + 1 });
  const oldOnlyEvidence = evidenceForProposals(chain, first, second, validators[0]);
  const newOnlyEvidence = evidenceForProposals(chain, first, second, newcomer);
  const outsiderEvidence = evidenceForProposals(chain, first, second, outsider);
  const activation = finalizeBlock(first, [...validators, newcomer]);
  chain.appendBlock(activation);
  assert.equal(chain.consensusSnapshot().state.recentValidatorTransition.activationHeight,
    activationHeight);
  const missingContext = chain.consensusSnapshot();
  delete missingContext.state.recentValidatorTransition;
  missingContext.stateRoot = computeChainStateRoot(missingContext.state);
  const missingCheckpoint = structuredClone(activation);
  missingCheckpoint.stateRoot = missingContext.stateRoot;
  missingCheckpoint.hash = blockHeaderHash(blockHeader(missingCheckpoint));
  assert.throws(() => NirChain.fromVerifiedSnapshot(genesisConfig, {
    capabilityMemory: missingContext.capabilityMemory,
    chainIdentityGenesisHash: chain.blocks()[0].hash,
    checkpoint: missingCheckpoint,
    evaluationAssignmentRoot: chain.evaluationAssignmentRoot,
    height: chain.height,
    networkId: chain.networkId,
    recoveryStateCommitment: chain.recoveryStateCommitment,
    state: missingContext.state,
    stateRoot: missingContext.stateRoot,
    tipHash: missingCheckpoint.hash,
    validatorSetId: chain.validatorSetId,
  }), /historical validator evidence snapshot schema/);

  for (const [offender, evidence] of [
    [validators[0], oldOnlyEvidence],
    [newcomer, newOnlyEvidence],
  ]) {
    const restarted = restoreAtHead(chain, genesisConfig);
    const transaction = createValidatorEquivocationTransaction({
      evidence,
      networkId: restarted.networkId,
      nonce: restarted.nextNonce(treasury.address),
      wallet: treasury,
    });
    append(restarted, restarted.buildBlock({
      timestamp: activation.timestamp + 1,
      transactions: [transaction],
    }), nextWallets);
    assert.equal(restarted.validatorDisabled(offender.address), true);
    assert.equal(restarted.consensusSnapshot().state.recentValidatorTransition, null);
  }

  const outsiderFork = restoreAtHead(chain, genesisConfig);
  const outsiderTransaction = createValidatorEquivocationTransaction({
    evidence: outsiderEvidence,
    networkId: outsiderFork.networkId,
    nonce: outsiderFork.nextNonce(treasury.address),
    wallet: treasury,
  });
  assertRejectedAtomically(
    outsiderFork, outsiderTransaction, nextWallets, /not active and bonded/,
  );
});

test("unbonded genesis equivocation and malformed or stale evidence are atomic rejections", () => {
  {
    const { chain, treasury, validators } = fixture();
    const { evidence, first } = prepareEvidence(chain, validators, validators[0], 1);
    append(chain, first, validators);
    const transaction = createValidatorEquivocationTransaction({
      evidence, networkId: chain.networkId, nonce: 0, wallet: treasury,
    });
    assertRejectedAtomically(chain, transaction, validators, /not active and bonded/);
    assert.equal(chain.validatorDisabled(validators[0].address), false);
    assert.equal(chain.validatorBond(validators[0].address), 0n);
  }

  {
    const { chain, treasury, validators } = fixture();
    fundAndBond(chain, treasury, validators);
    const { evidence, first } = prepareEvidence(
      chain, validators, validators[0], TREASURY_VESTING_MS + 2,
    );
    append(chain, first, validators);
    const malformedTransaction = createValidatorEquivocationTransaction({
      evidence, networkId: chain.networkId,
      nonce: chain.nextNonce(treasury.address), wallet: treasury,
    });
    malformedTransaction.evidence.statements[1].header.unexpected = true;
    assertRejectedAtomically(chain, malformedTransaction, validators, /block header/);

    const futureEvidence = structuredClone(evidence);
    futureEvidence.height += 1;
    const { evidenceHash: _futureHash, ...futurePayload } = futureEvidence;
    futureEvidence.evidenceHash = hashObject(futurePayload, "VALIDATOR_EQUIVOCATION_V2");
    const future = createValidatorEquivocationTransaction({
      evidence: futureEvidence, networkId: chain.networkId,
      nonce: chain.nextNonce(treasury.address), wallet: treasury,
    });
    assertRejectedAtomically(chain, future, validators, /current finalized head/);

    append(chain, chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 3 }), validators);
    const stale = createValidatorEquivocationTransaction({
      evidence, networkId: chain.networkId,
      nonce: chain.nextNonce(treasury.address), wallet: treasury,
    });
    assertRejectedAtomically(chain, stale, validators, /current finalized head/);

    const wrongNetworkEvidence = structuredClone(evidence);
    wrongNetworkEvidence.networkId = "other-network";
    const wrongNetwork = createValidatorEquivocationTransaction({
      evidence: wrongNetworkEvidence, networkId: chain.networkId,
      nonce: chain.nextNonce(treasury.address), wallet: treasury,
    });
    assertRejectedAtomically(chain, wrongNetwork, validators, /transaction is invalid/);
  }
});

test("a disabled ValidatorReplica refuses to propose, prepare, commit, or time out", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-disabled-validator-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"), {
    networkId: "nir-disabled-validator-runtime-test",
  });
  const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
  try {
    const genesisConfig = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "genesis.json"), "utf8",
    ));
    const treasury = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "TREASURY-DEV-KEY.json"), "utf8",
    ));
    const validators = layout.validatorDirectories.map((directory) => JSON.parse(
      readFileSync(join(directory, "VALIDATOR-KEY.json"), "utf8"),
    ));
    const chain = new NirChain(genesisConfig);
    const commitEverywhere = (proposal, signers) => {
      const block = finalizeBlock(proposal, signers);
      chain.appendBlock(block);
      for (const replica of replicas) replica.commit(block);
      return block;
    };
    const funding = validators.map((wallet, nonce) => createTransfer({
      amount: (MIN_VALIDATOR_BOND + MIN_TRANSFER_FEE).toString(),
      networkId: chain.networkId,
      nonce,
      recipient: wallet.address,
      wallet: treasury,
    }));
    commitEverywhere(
      chain.buildBlock({ transactions: funding, timestamp: TREASURY_VESTING_MS }),
      validators.slice(0, 3),
    );
    const bonds = validators.map((wallet) => createValidatorBond({
      amount: MIN_VALIDATOR_BOND.toString(), networkId: chain.networkId, nonce: 0, wallet,
    }));
    commitEverywhere(
      chain.buildBlock({ transactions: bonds, timestamp: TREASURY_VESTING_MS + 1 }),
      validators.slice(0, 3),
    );
    const offender = validators[0];
    const { evidence, first } = prepareEvidence(
      chain, validators, offender, TREASURY_VESTING_MS + 2,
    );
    commitEverywhere(first, quorumFor(first, validators));
    const slash = createValidatorEquivocationTransaction({
      evidence, networkId: chain.networkId,
      nonce: chain.nextNonce(treasury.address), wallet: treasury,
    });
    const slashProposal = chain.buildBlock({
      timestamp: TREASURY_VESTING_MS + 3, transactions: [slash],
    });
    commitEverywhere(slashProposal, quorumFor(slashProposal, validators));
    const disabledReplica = replicas.find(({ address }) => address === offender.address);
    const next = chain.buildBlock({ timestamp: TREASURY_VESTING_MS + 4 });
    assert.throws(() => disabledReplica.buildProposal(), /disabled local validator/);
    assert.throws(() => disabledReplica.vote(next), /disabled local validator/);
    assert.throws(() => disabledReplica.commitVote(next, []), /disabled local validator/);
    assert.throws(() => disabledReplica.timeout({ proposal: next, nextRound: 1 }),
      /disabled local validator/);
  } finally {
    for (const replica of replicas) replica.closeSecurityState();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("near-limit conflicting proposal bodies produce compact slashable evidence", () => {
  const { chain, treasury, validators } = fixture();
  fundAndBond(chain, treasury, validators);
  const recipient = generateWallet();
  const transactions = [];
  let first;
  let bodyBytes = 0;
  while (bodyBytes < Math.floor(MAX_BLOCK_BYTES * 0.9)) {
    const start = transactions.length;
    for (let offset = 0; offset < 25; offset += 1) {
      transactions.push(createTransfer({
        amount: "1",
        networkId: chain.networkId,
        nonce: chain.nextNonce(treasury.address) + start + offset,
        recipient: recipient.address,
        wallet: treasury,
      }));
    }
    first = chain.buildBlock({
      timestamp: TREASURY_VESTING_MS + 2,
      transactions,
    });
    bodyBytes = Buffer.byteLength(canonicalJson(first));
    assert.ok(bodyBytes <= MAX_BLOCK_BYTES, "proposal must remain within the protocol limit");
  }
  const second = chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 3,
    transactions,
  });
  const secondBytes = Buffer.byteLength(canonicalJson(second));
  assert.ok(secondBytes >= Math.floor(MAX_BLOCK_BYTES * 0.9));
  assert.ok(bodyBytes + secondBytes > MAX_BLOCK_BYTES);
  const offender = validators[0];
  const evidence = proveValidatorPrepareEquivocation({
    chain,
    first: { proposal: first, vote: voteForBlock(first, offender) },
    second: { proposal: second, vote: voteForBlock(second, offender) },
  });
  assert.ok(Buffer.byteLength(canonicalJson(evidence)) < MAX_EQUIVOCATION_EVIDENCE_BYTES);
  append(chain, first, validators);
  const transaction = createValidatorEquivocationTransaction({
    evidence,
    networkId: chain.networkId,
    nonce: chain.nextNonce(treasury.address),
    wallet: treasury,
  });
  append(chain, chain.buildBlock({
    timestamp: TREASURY_VESTING_MS + 4,
    transactions: [transaction],
  }), validators);
  assert.equal(chain.validatorBond(offender.address), 0n);
  assert.equal(chain.validatorDisabled(offender.address), true);
});
