import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { transactionId } from "./chain.mjs";
import { certificatePinsAtHeight, verifyCertificateHistory } from "./certificate-lifecycle.mjs";
import { canonicalJson, hashObject } from "./crypto.mjs";
import { requestJson, requestValidatorJson } from "./http-client.mjs";
import { peerRegistryHash } from "./peer-registry.mjs";
import { verifyValidatorAdmission } from "./validator-admission.mjs";
import { verifyValidatorAdmissionSubmissionAck }
  from "./validator-admission-submission-ack.mjs";
import { verifyValidatorAdmissionSubmissionReceipt }
  from "./validator-admission-submission-receipt.mjs";
import { MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES, MAX_VALIDATOR_CANDIDATE_SYNC_INPUT_BYTES,
  synchronizeValidatorCandidateContext, validateValidatorCandidateContext,
  validateValidatorCandidateSyncInput } from "./validator-candidate-context.mjs";

const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const MAX_PACKAGE_BYTES = MAX_VALIDATOR_CANDIDATE_CONTEXT_BYTES + 1024 * 1024;
const MAX_ATTEMPTS = 64;
const MAX_CONCURRENCY = 8;
const ZERO_HASH = "0".repeat(64);
// 256 peers at eight-way concurrency need at most ~256 seconds at the configured GET+POST
// timeouts; ten minutes leaves a conservative scheduling margin without an unbounded lock.
const LOCK_LEASE_MS = 600_000;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function pinDirectory(path) {
  const canonical = realpathSync(resolve(path)); const linked = lstatSync(canonical);
  const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const identity = fstatSync(descriptor);
  if (!linked.isDirectory() || linked.isSymbolicLink() || (linked.mode & 0o077) ||
      !sameIdentity(linked, identity)) { closeSync(descriptor); throw new Error("submission directory is unsafe"); }
  return { descriptor, identity, path: canonical, assert() {
    const current = lstatSync(canonical); const held = fstatSync(descriptor);
    if (!sameIdentity(current, identity) || !sameIdentity(held, identity) ||
        current.isSymbolicLink()) throw new Error("submission directory changed");
  } };
}
function readJson(path, label, maximumBytes) {
  const requested = resolve(path); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested)); let descriptor;
  try {
    parent.assert(); const linked = lstatSync(target);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !sameIdentity(before, linked) ||
        (before.mode & 0o077) || before.size < 2 || before.size > maximumBytes) {
      throw new Error(`${label} is unsafe`);
    }
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor);
    parent.assert();
    if (!sameIdentity(before, after) || !sameIdentity(before, lstatSync(target)) ||
        bytes.length !== before.size) throw new Error(`${label} changed while reading`);
    return JSON.parse(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); closeSync(parent.descriptor); }
}
function writeExclusive(path, value) {
  const requested = resolve(path); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested));
  const temporary = join(parent.path, `.${basename(target)}.submission-${randomBytes(16).toString("hex")}`);
  let descriptor; let identity;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    identity = fstatSync(descriptor); writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined; parent.assert();
    if (!sameIdentity(identity, lstatSync(temporary))) throw new Error("submission staging changed");
    linkSync(temporary, target); unlinkSync(temporary); fsyncSync(parent.descriptor); parent.assert();
    if (!sameIdentity(identity, lstatSync(target))) throw new Error("submission activation changed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { if (identity && sameIdentity(identity, lstatSync(temporary))) unlinkSync(temporary); } catch {}
    closeSync(parent.descriptor);
  }
}
function writeReplace(path, value) {
  const requested = resolve(path); const parent = pinDirectory(dirname(requested));
  const target = join(parent.path, basename(requested));
  const temporary = join(parent.path, `.${basename(target)}.replace-${randomBytes(16).toString("hex")}`);
  let descriptor; let identity;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    identity = fstatSync(descriptor); writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined; parent.assert();
    if (!sameIdentity(identity, lstatSync(temporary))) throw new Error("submission head staging changed");
    renameSync(temporary, target); fsyncSync(parent.descriptor); parent.assert();
    if (!sameIdentity(identity, lstatSync(target))) throw new Error("submission head activation changed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { if (identity && sameIdentity(identity, lstatSync(temporary))) unlinkSync(temporary); } catch {}
    closeSync(parent.descriptor);
  }
}

function submissionHead(transactionIdValue, sequence, receiptHash) {
  const payload = { format: "nir-validator-admission-submission-head-v1", receiptHash,
    sequence, transactionId: transactionIdValue, version: 1 };
  return { ...payload, headHash: hashObject(payload, "VALIDATOR_ADMISSION_SUBMISSION_HEAD_V1") };
}
function validateSubmissionHead(value, transactionIdValue) {
  exact(value, ["format", "headHash", "receiptHash", "sequence", "transactionId", "version"],
    "validator admission submission head");
  const { headHash, ...payload } = value;
  if (value.format !== "nir-validator-admission-submission-head-v1" || value.version !== 1 ||
      value.transactionId !== transactionIdValue || !HASH.test(value.receiptHash ?? "") ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      headHash !== hashObject(payload, "VALIDATOR_ADMISSION_SUBMISSION_HEAD_V1")) {
    throw new Error("validator admission submission head is invalid");
  }
  return structuredClone(value);
}
function pendingSubmissionHead(transactionIdValue, head, previousHeadHash) {
  const payload = { format: "nir-validator-admission-submission-pending-head-v1", head,
    previousHeadHash, transactionId: transactionIdValue, version: 1 };
  return { ...payload, pendingHash:
    hashObject(payload, "VALIDATOR_ADMISSION_PENDING_HEAD_V1") };
}
function validatePendingSubmissionHead(value, transactionIdValue) {
  exact(value, ["format", "head", "pendingHash", "previousHeadHash", "transactionId", "version"],
    "validator admission pending head");
  const { pendingHash, ...payload } = value;
  validateSubmissionHead(value.head, transactionIdValue);
  if (value.format !== "nir-validator-admission-submission-pending-head-v1" || value.version !== 1 ||
      value.transactionId !== transactionIdValue || !HASH.test(value.previousHeadHash ?? "") ||
      pendingHash !== hashObject(payload, "VALIDATOR_ADMISSION_PENDING_HEAD_V1")) {
    throw new Error("validator admission pending head is invalid");
  }
  return structuredClone(value);
}

function processIsLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; if (error?.code === "EPERM") return true; throw error; }
}
function acquireSubmissionLock(root, transactionIdValue, now) {
  const path = join(root, `admission-submission-${transactionIdValue}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = { format: "nir-validator-admission-submission-lock-v1", pid: process.pid,
      startedAt: now, token: randomBytes(32).toString("hex"), transactionId: transactionIdValue,
      version: 1 };
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
        constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, `${canonicalJson(owner)}\n`); fsyncSync(descriptor);
      const identity = fstatSync(descriptor);
      if (!sameIdentity(identity, lstatSync(path))) throw new Error("submission lock activation changed");
      return { descriptor, identity, owner, path };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;
      const before = lstatSync(path); const current = readJson(path, "validator admission submission lock", 64 * 1024);
      exact(current, ["format", "pid", "startedAt", "token", "transactionId", "version"],
        "validator admission submission lock");
      if (current.format !== "nir-validator-admission-submission-lock-v1" || current.version !== 1 ||
          current.transactionId !== transactionIdValue || !HASH.test(current.token ?? "") ||
          !Number.isSafeInteger(current.pid) || current.pid < 1 ||
          !Number.isSafeInteger(current.startedAt) || current.startedAt < 0 || current.startedAt > now + 30_000) {
        throw new Error("validator admission submission lock is invalid");
      }
      if (now - current.startedAt <= LOCK_LEASE_MS && processIsLive(current.pid)) {
        throw new Error("validator admission submission is already in progress");
      }
      const again = readJson(path, "validator admission submission lock", 64 * 1024);
      if (!sameIdentity(before, lstatSync(path)) || canonicalJson(again) !== canonicalJson(current)) {
        throw new Error("validator admission submission lock changed during recovery");
      }
      const quarantine = `${path}.stale-${randomBytes(16).toString("hex")}`;
      renameSync(path, quarantine);
      if (!sameIdentity(before, lstatSync(quarantine))) throw new Error("submission lock recovery changed inode");
      unlinkSync(quarantine);
    }
  }
  throw new Error("validator admission submission lock could not be acquired");
}
function releaseSubmissionLock(lock) {
  try {
    const held = fstatSync(lock.descriptor); const current = lstatSync(lock.path);
    const owner = readJson(lock.path, "validator admission submission lock", 64 * 1024);
    if (!sameIdentity(held, lock.identity) || !sameIdentity(current, lock.identity) ||
        canonicalJson(owner) !== canonicalJson(lock.owner)) {
      throw new Error("validator admission submission lock ownership changed");
    }
    unlinkSync(lock.path);
  } finally { closeSync(lock.descriptor); }
}

function validatePublicPlan(value) {
  exact(value, ["candidateContextMaxWitnessAgeMs", "candidateContextMinimumCheckpointHeight",
    "candidateContextMinimumSequence", "consensus", "endpoint", "expectedChainIdentityGenesisHash",
    "expectedCheckpointPolicyId", "format", "networkId", "operatorId", "planCommitment",
    "tlsCertificateSha256", "transport", "version"], "validator admission public plan");
  const { format: _format, planCommitment, version: _version, ...payload } = value;
  if (value.format !== "nir-validator-admission-public-plan-v1" || value.version !== 1 ||
      !HASH.test(value.expectedChainIdentityGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.expectedCheckpointPolicyId ?? "") ||
      !HASH.test(value.tlsCertificateSha256 ?? "") ||
      !ADDRESS.test(value.consensus?.address ?? "") || !ADDRESS.test(value.transport?.address ?? "") ||
      planCommitment !== hashObject(payload, "VALIDATOR_ADMISSION_PLAN_V1")) {
    throw new Error("validator admission public plan is invalid");
  }
  return structuredClone(value);
}

function validatePackage(value, plan) {
  exact(value, ["amount", "candidateContext", "candidateContextHash", "chainIdentityGenesisHash",
    "consensus", "endpoint", "fee", "format", "networkId", "nonce", "operatorId", "packageHash",
    "planCommitment", "referenceHeight", "tlsCertificateSha256", "transport", "validUntilHeight",
    "version"], "validator admission signing package");
  const { packageHash, ...payload } = value;
  const context = validateValidatorCandidateContext(value.candidateContext, plan,
    { now: value.candidateContext?.syncedAt });
  if (value.format !== "nir-validator-admission-signing-package-v1" || value.version !== 1 ||
      value.planCommitment !== plan.planCommitment || value.networkId !== plan.networkId ||
      value.chainIdentityGenesisHash !== plan.expectedChainIdentityGenesisHash ||
      canonicalJson(value.consensus) !== canonicalJson(plan.consensus) ||
      canonicalJson(value.transport) !== canonicalJson(plan.transport) ||
      value.candidateContextHash !== context.contextHash || value.endpoint !== plan.endpoint ||
      value.operatorId !== plan.operatorId || value.tlsCertificateSha256 !== plan.tlsCertificateSha256 ||
      packageHash !== hashObject(payload, "VALIDATOR_ADMISSION_PACKAGE_V1")) {
    throw new Error("validator admission signing package does not match its public plan");
  }
  return structuredClone(value);
}

function validateSigned(value, signingPackage, plan) {
  exact(value, ["broadcast", "format", "packageHash", "transaction", "transactionId", "version"],
    "signed validator admission");
  const verified = verifyValidatorAdmission(value.transaction, plan.networkId, {
    chainIdentityGenesisHash: plan.expectedChainIdentityGenesisHash,
    currentHeight: signingPackage.referenceHeight + 1, protocolVersion: 32 });
  const { signature: _signature, transportSignature: _transportSignature, ...unsigned } = value.transaction;
  const expected = { algorithm: plan.consensus.algorithm, amount: signingPackage.amount,
    chainIdentityGenesisHash: signingPackage.chainIdentityGenesisHash, endpoint: signingPackage.endpoint,
    fee: signingPackage.fee, networkId: plan.networkId, nonce: signingPackage.nonce,
    operatorId: plan.operatorId, publicKey: plan.consensus.publicKey,
    referenceHeight: signingPackage.referenceHeight, sender: plan.consensus.address,
    tlsCertificateSha256: plan.tlsCertificateSha256,
    transportAlgorithm: plan.transport.algorithm, transportPublicKey: plan.transport.publicKey,
    type: "validator-admission", validUntilHeight: signingPackage.validUntilHeight };
  if (value.broadcast !== false || value.format !== "nir-signed-validator-admission-v1" ||
      value.version !== 1 || value.packageHash !== signingPackage.packageHash ||
      value.transactionId !== transactionId(value.transaction) ||
      canonicalJson(unsigned) !== canonicalJson(expected) ||
      verified.payload.sender !== plan.consensus.address || verified.transport.address !== plan.transport.address) {
    throw new Error("signed validator admission is invalid or mismatched");
  }
  return structuredClone(value);
}

export function loadValidatorAdmissionSubmissionInput(path) {
  const value = readJson(path, "validator admission submission input",
    MAX_VALIDATOR_CANDIDATE_SYNC_INPUT_BYTES + 32 * 1024 * 1024);
  exact(value, ["candidateSyncInput", "certificateHistories", "format", "peerRegistry", "version"],
    "validator admission submission input");
  if (value.format !== "nir-validator-admission-submission-input-v1" || value.version !== 1 ||
      !Array.isArray(value.certificateHistories) || value.certificateHistories.length < 4 ||
      value.certificateHistories.length > 256) throw new Error("validator admission submission input is invalid");
  return { ...structuredClone(value), candidateSyncInput:
    validateValidatorCandidateSyncInput(value.candidateSyncInput) };
}

async function settle(values, operation) {
  const results = new Array(values.length); let next = 0;
  async function worker() { while (next < values.length) { const index = next++;
    try { results[index] = { status: "fulfilled", value: await operation(values[index], index) }; }
    catch (reason) { results[index] = { status: "rejected", reason }; } } }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, values.length) }, worker));
  return results;
}

function receiptPayload(value, binding) {
  exact(value, ["acknowledgements", "attemptNonce", "attemptedAt", "candidateContext",
    "chainIdentityGenesisHash", "format", "networkId", "packageHash", "peerRegistry",
    "peerOutcomes", "previousReceiptHash", "quorumRequired", "sequence", "status",
    "transactionId", "version"],
  "validator admission submission receipt payload");
  if (!Array.isArray(value.acknowledgements) || value.acknowledgements.length > 256 ||
      !Array.isArray(value.peerOutcomes) || value.peerOutcomes.length < 4 ||
      value.peerOutcomes.length > 256 ||
      value.format !== "nir-validator-admission-submission-v1" || value.version !== 1 ||
      value.networkId !== binding.plan.networkId || value.packageHash !== binding.package.packageHash ||
      value.transactionId !== binding.signed.transactionId || !HASH.test(value.attemptNonce ?? "") ||
      value.chainIdentityGenesisHash !== binding.plan.expectedChainIdentityGenesisHash ||
      !HASH.test(value.previousReceiptHash ?? "") || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Number.isSafeInteger(value.attemptedAt) || value.attemptedAt < 0) {
    throw new Error("validator admission submission receipt payload is invalid");
  }
  return structuredClone(value);
}

function loadLocal(directory, signedArtifactPath) {
  const root = realpathSync(resolve(directory));
  const plan = validatePublicPlan(readJson(join(root, "validator-admission-public-plan.json"),
    "validator admission public plan", 1024 * 1024));
  const raw = readJson(signedArtifactPath, "signed validator admission", 1024 * 1024);
  const intent = readJson(join(root, `admission-intent-${raw.transaction?.nonce}-${raw.packageHash}.json`),
    "validator admission intent", MAX_PACKAGE_BYTES);
  const signingPackage = validatePackage(intent, plan);
  const signed = validateSigned(raw, signingPackage, plan);
  const journal = validateSigned(readJson(join(root,
    `admission-signature-${signingPackage.nonce}-${signingPackage.packageHash}.json`),
  "signed validator admission journal", 1024 * 1024), signingPackage, plan);
  if (canonicalJson(journal) !== canonicalJson(signed)) throw new Error("signed artifact differs from journal");
  return { package: signingPackage, plan, root, signed };
}

async function submitValidatorAdmissionLocked({ binding, submissionInput,
  request, validatorRequest, now }) {
  const input = loadValidatorAdmissionSubmissionInputObject(submissionInput);
  const syncPlan = { ...binding.plan, format: "nir-validator-join-plan-v2", version: 2 };
  delete syncPlan.planCommitment;
  const context = await synchronizeValidatorCandidateContext({ plan: syncPlan,
    syncInput: input.candidateSyncInput, request, now });
  const packageContext = binding.package.candidateContext;
  const checkpointChanged = canonicalJson(context.checkpoint) !== canonicalJson(packageContext.checkpoint);
  if (context.protocolVersion !== 32 || context.status !== "not-admitted" || context.admission !== null ||
      context.queuePosition !== null || context.account.nextNonce !== binding.package.nonce ||
      context.bondAndFeeCovered !== true || context.checkpoint.height < binding.package.referenceHeight ||
      context.checkpoint.height > binding.package.validUntilHeight ||
      context.checkpoint.height < packageContext.checkpoint.height ||
      (context.checkpoint.height === packageContext.checkpoint.height && checkpointChanged) ||
      (checkpointChanged
        ? context.checkpointTrustPackage.sequence <= packageContext.checkpointTrustPackage.sequence
        : context.checkpointTrustPackage.sequence < packageContext.checkpointTrustPackage.sequence)) {
    throw new Error("fresh validator admission preflight is stale, conflicting, or outside validity");
  }
  const registryHash = peerRegistryHash(input.peerRegistry);
  if (registryHash !== context.checkpointTrustPackage.finalityProof.header.peerRegistryHash) {
    throw new Error("submission peer registry is not committed by the finalized checkpoint");
  }
  const validators = context.checkpointTrustPackage.validators;
  const validatorMap = new Map(validators.map((validator) => [validator.address, validator]));
  const peers = input.peerRegistry.peers;
  const expectedSyncPeers = peers.map(({ tlsCertificateSha256, url, validatorAddress }) =>
    ({ tlsCertificateSha256, url, validatorAddress }))
    .sort((a, b) => a.validatorAddress.localeCompare(b.validatorAddress));
  if (validatorMap.size !== validators.length || peers.length !== validators.length ||
      new Set(peers.map(({ validatorAddress }) => validatorAddress)).size !== peers.length ||
      peers.some(({ validatorAddress }) => !validatorMap.has(validatorAddress)) ||
      canonicalJson(input.candidateSyncInput.peers) !== canonicalJson(expectedSyncPeers)) {
    throw new Error("submission peer registry does not exactly cover active validators");
  }
  const certificateContext = { networkId: binding.plan.networkId, validators,
    expectedPeerRegistryHash: registryHash };
  const histories = new Map(input.certificateHistories.map((entry) => {
    exact(entry, ["history", "validatorAddress"], "submission certificate history");
    if (!ADDRESS.test(entry.validatorAddress ?? "")) throw new Error("certificate history owner is invalid");
    return [entry.validatorAddress, verifyCertificateHistory(entry.history, certificateContext)];
  }));
  if (histories.size !== validators.length || validators.some(({ address }) => !histories.has(address))) {
    throw new Error("submission certificate histories do not exactly cover active validators");
  }
  const seenUrls = new Set(); const seenPins = new Set(); const seenTransports = new Set();
  for (const peer of peers) {
    if (seenUrls.has(peer.url) || seenPins.has(peer.tlsCertificateSha256) ||
        seenTransports.has(peer.transport.address)) throw new Error("submission peer bindings are duplicated");
    seenUrls.add(peer.url); seenPins.add(peer.tlsCertificateSha256); seenTransports.add(peer.transport.address);
    const pins = certificatePinsAtHeight(histories.get(peer.validatorAddress), peer.validatorAddress,
      context.checkpoint.height);
    if (!pins.includes(peer.tlsCertificateSha256)) throw new Error("peer registry TLS pin lacks verified history");
  }
  const existingNames = readdirSync(binding.root).filter((name) =>
    new RegExp(`^admission-submission-${binding.signed.transactionId}-[0-9]{6}-[0-9a-f]{64}\\.json$`).test(name)).sort();
  const headPath = join(binding.root, `admission-submission-${binding.signed.transactionId}-head.json`);
  const pendingHeadPath = join(binding.root,
    `admission-submission-${binding.signed.transactionId}-pending-head.json`);
  let storedHead = null;
  try { storedHead = validateSubmissionHead(readJson(headPath,
    "validator admission submission head", 64 * 1024), binding.signed.transactionId); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  let pendingHead = null;
  try { pendingHead = validatePendingSubmissionHead(readJson(pendingHeadPath,
    "validator admission pending head", 128 * 1024), binding.signed.transactionId); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  let previousReceiptHash = ZERO_HASH; let previousAttemptedAt = -1; let previousContext = null;
  let completedReceipt = null;
  for (let index = 0; index < existingNames.length; index += 1) {
    if (completedReceipt !== null) {
      throw new Error("validator admission submission receipt exists after quorum completion");
    }
    const stored = readJson(join(binding.root, existingNames[index]), "validator admission submission receipt", 40 * 1024 * 1024);
    exact(stored, ["acknowledgements", "attemptNonce", "attemptedAt", "candidateContext",
      "chainIdentityGenesisHash", "format", "networkId", "packageHash", "peerRegistry",
      "peerOutcomes", "previousReceiptHash", "quorumRequired", "receiptHash", "sequence",
      "status", "transactionId", "version"], "validator admission submission receipt");
    const { receiptHash, ...payload } = stored; receiptPayload(payload, binding);
    if (stored.sequence !== index + 1 || stored.previousReceiptHash !== previousReceiptHash ||
        stored.attemptedAt < previousAttemptedAt ||
        existingNames[index] !== `admission-submission-${binding.signed.transactionId}-${String(stored.sequence)
          .padStart(6, "0")}-${receiptHash}.json` ||
        receiptHash !== hashObject(payload, "VALIDATOR_ADMISSION_SUBMISSION_V1")) {
      throw new Error("validator admission submission receipt chain is forked or rolled back");
    }
    verifyValidatorAdmissionSubmissionReceipt(stored, {
      joinPlan: syncPlan, plan: binding.plan, signed: binding.signed,
      signingPackage: binding.package,
    });
    const storedContext = validateValidatorCandidateContext(stored.candidateContext, syncPlan,
      { now: stored.candidateContext?.syncedAt });
    const storedValidators = storedContext.checkpointTrustPackage.validators;
    const storedValidatorMap = new Map(storedValidators.map((validator) => [validator.address, validator]));
    const storedPeerAddresses = stored.peerRegistry.peers?.map(({ validatorAddress }) => validatorAddress);
    if (stored.chainIdentityGenesisHash !== binding.plan.expectedChainIdentityGenesisHash ||
        peerRegistryHash(stored.peerRegistry) !==
          storedContext.checkpointTrustPackage.finalityProof.header.peerRegistryHash ||
        storedValidatorMap.size !== storedValidators.length ||
        !Array.isArray(storedPeerAddresses) || storedPeerAddresses.length !== storedValidators.length ||
        new Set(storedPeerAddresses).size !== storedPeerAddresses.length ||
        storedPeerAddresses.some((address) => !storedValidatorMap.has(address)) ||
        stored.quorumRequired !== Math.floor(storedValidators.length * 2 / 3) + 1 ||
        (previousContext !== null && (() => {
          const changed = canonicalJson(storedContext.checkpoint) !== canonicalJson(previousContext.checkpoint);
          return storedContext.checkpoint.height < previousContext.checkpoint.height ||
            (storedContext.checkpoint.height === previousContext.checkpoint.height && changed) ||
            (changed
              ? storedContext.checkpointTrustPackage.sequence <= previousContext.checkpointTrustPackage.sequence
              : storedContext.checkpointTrustPackage.sequence < previousContext.checkpointTrustPackage.sequence);
        })())) {
      throw new Error("stored submission receipt context is unauthenticated");
    }
    const ackValidators = new Set();
    for (const ack of stored.acknowledgements) {
      if (ackValidators.has(ack.validator) || !storedValidatorMap.has(ack.validator)) {
        throw new Error("stored submission acknowledgement is duplicated or unknown");
      }
      ackValidators.add(ack.validator);
      verifyValidatorAdmissionSubmissionAck(ack, {
      attemptNonce: stored.attemptNonce, candidateContextHash: stored.candidateContext.contextHash,
      chainIdentityGenesisHash: binding.plan.expectedChainIdentityGenesisHash,
      networkId: binding.plan.networkId, transactionId: binding.signed.transactionId,
      validator: storedValidatorMap.get(ack.validator) });
    }
    const outcomeValidators = new Set();
    const acknowledgementByValidator = new Map(stored.acknowledgements.map((ack) =>
      [ack.validator, ack]));
    for (const outcome of stored.peerOutcomes) {
      exact(outcome, ["status", "validatorAddress"], "validator admission submission peer outcome");
      if (!storedValidatorMap.has(outcome.validatorAddress) ||
          outcomeValidators.has(outcome.validatorAddress) ||
          !["failed", "known", "queued"].includes(outcome.status)) {
        throw new Error("stored submission peer outcome is invalid or duplicated");
      }
      outcomeValidators.add(outcome.validatorAddress);
      if ((outcome.status === "queued" || outcome.status === "known") !==
          ackValidators.has(outcome.validatorAddress) ||
          (acknowledgementByValidator.has(outcome.validatorAddress) &&
           acknowledgementByValidator.get(outcome.validatorAddress).status !== outcome.status)) {
        throw new Error("stored submission outcome lacks its signed acknowledgement");
      }
    }
    if (outcomeValidators.size !== storedValidators.length) {
      throw new Error("stored submission outcomes do not cover the historical validator set");
    }
    const derivedStatus = ackValidators.size >= stored.quorumRequired
      ? "submitted-to-quorum" : "partial-retryable";
    if (stored.status !== derivedStatus) throw new Error("stored submission status is forged");
    if (stored.status === "submitted-to-quorum") completedReceipt = stored;
    previousReceiptHash = receiptHash; previousAttemptedAt = stored.attemptedAt;
    previousContext = storedContext;
  }
  if (existingNames.length === 0 && storedHead !== null) {
    throw new Error("validator admission submission receipt tail was deleted");
  }
  if (existingNames.length === 0 && pendingHead !== null) {
    if (pendingHead.head.sequence !== 1 || pendingHead.previousHeadHash !== ZERO_HASH) {
      throw new Error("pending submission head has no matching receipt chain");
    }
    unlinkSync(pendingHeadPath); pendingHead = null;
  }
  if (existingNames.length > 0) {
    const expectedHead = submissionHead(binding.signed.transactionId, existingNames.length,
      previousReceiptHash);
    if (storedHead === null) {
      if (pendingHead === null || pendingHead.previousHeadHash !== ZERO_HASH ||
          canonicalJson(pendingHead.head) !== canonicalJson(expectedHead)) {
        throw new Error("validator admission submission head detects deletion, rollback, or fork");
      }
      writeExclusive(headPath, expectedHead); storedHead = expectedHead;
    } else if (storedHead.sequence === existingNames.length - 1 &&
        existingNames.length === storedHead.sequence + 1) {
      if (pendingHead === null || pendingHead.previousHeadHash !== storedHead.headHash ||
          canonicalJson(pendingHead.head) !== canonicalJson(expectedHead)) {
        throw new Error("validator admission submission head detects deletion, rollback, or fork");
      }
      writeReplace(headPath, expectedHead); storedHead = expectedHead;
    } else if (canonicalJson(storedHead) !== canonicalJson(expectedHead)) {
      throw new Error("validator admission submission head detects deletion, rollback, or fork");
    }
    if (pendingHead !== null) {
      const committedPending = canonicalJson(pendingHead.head) === canonicalJson(storedHead);
      const preAppendPending = pendingHead.previousHeadHash === storedHead.headHash &&
        pendingHead.head.sequence === storedHead.sequence + 1 &&
        existingNames.length === storedHead.sequence;
      if (!committedPending && !preAppendPending) {
        throw new Error("pending submission head conflicts with committed head");
      }
      unlinkSync(pendingHeadPath); pendingHead = null;
    }
  }
  if (completedReceipt !== null) return { broadcast: true, receipt: completedReceipt,
    status: "submitted-to-quorum; finality not proven" };
  if (existingNames.length >= MAX_ATTEMPTS) {
    throw new Error("validator admission submission attempt limit exceeded");
  }
  if (previousContext !== null &&
      (() => {
        const changed = canonicalJson(context.checkpoint) !== canonicalJson(previousContext.checkpoint);
        return context.checkpoint.height < previousContext.checkpoint.height ||
          (context.checkpoint.height === previousContext.checkpoint.height && changed) ||
          (changed
            ? context.checkpointTrustPackage.sequence <= previousContext.checkpointTrustPackage.sequence
            : context.checkpointTrustPackage.sequence < previousContext.checkpointTrustPackage.sequence);
      })()) {
    throw new Error("fresh submission context rolls back or forks the receipt chain");
  }
  const attemptNonce = randomBytes(32).toString("hex");
  const transaction = JSON.parse(canonicalJson(binding.signed.transaction));
  const results = await settle(peers, async (peer) => {
    const target = new URL("/v1/transactions/validator-admission-submission", peer.url);
    target.searchParams.set("attemptNonce", attemptNonce);
    target.searchParams.set("candidateContextHash", context.contextHash);
    const response = await validatorRequest(target.toString(), {
      body: transaction, certificateContext, certificateHistory: histories.get(peer.validatorAddress),
      height: context.checkpoint.height, maxResponseBytes: 256 * 1024, method: "POST",
      timeoutMs: 5_000, validatorAddress: peer.validatorAddress });
    if (!response.ok) throw new Error("validator rejected admission submission");
    return verifyValidatorAdmissionSubmissionAck(response.body?.acknowledgement, {
      attemptNonce, candidateContextHash: context.contextHash,
      chainIdentityGenesisHash: binding.plan.expectedChainIdentityGenesisHash,
      networkId: binding.plan.networkId, transactionId: binding.signed.transactionId,
      validator: validatorMap.get(peer.validatorAddress) });
  });
  const acknowledgements = results.filter(({ status }) => status === "fulfilled")
    .map(({ value }) => value).sort((a, b) => a.validator.localeCompare(b.validator));
  const peerOutcomes = results.map((result, index) => ({
    status: result.status === "fulfilled" ? result.value.status : "failed",
    validatorAddress: peers[index].validatorAddress,
  })).sort((a, b) => a.validatorAddress.localeCompare(b.validatorAddress));
  const quorumRequired = Math.floor(validators.length * 2 / 3) + 1;
  if (now < previousAttemptedAt) throw new Error("submission attempt clock rolled back");
  const payload = receiptPayload({ acknowledgements, attemptNonce, attemptedAt: now,
    candidateContext: context, chainIdentityGenesisHash: binding.plan.expectedChainIdentityGenesisHash,
    format: "nir-validator-admission-submission-v1", networkId: binding.plan.networkId,
    packageHash: binding.package.packageHash, peerRegistry: input.peerRegistry,
    peerOutcomes, previousReceiptHash, quorumRequired, sequence: existingNames.length + 1,
    status: acknowledgements.length >= quorumRequired ? "submitted-to-quorum" : "partial-retryable",
    transactionId: binding.signed.transactionId, version: 1 }, binding);
  const receipt = { ...payload, receiptHash: hashObject(payload, "VALIDATOR_ADMISSION_SUBMISSION_V1") };
  const nextHead = submissionHead(binding.signed.transactionId, payload.sequence, receipt.receiptHash);
  const pending = pendingSubmissionHead(binding.signed.transactionId, nextHead,
    storedHead?.headHash ?? ZERO_HASH);
  writeExclusive(pendingHeadPath, pending);
  writeExclusive(join(binding.root, `admission-submission-${binding.signed.transactionId}-${String(payload.sequence)
    .padStart(6, "0")}-${receipt.receiptHash}.json`), receipt);
  if (storedHead === null) writeExclusive(headPath, nextHead);
  else writeReplace(headPath, nextHead);
  unlinkSync(pendingHeadPath);
  return { broadcast: true, receipt, status: receipt.status === "submitted-to-quorum"
    ? "submitted-to-quorum; finality not proven" : "partial submission; retry exact signed bytes" };
}

export async function submitValidatorAdmission({ directory, signedArtifactPath, submissionInput,
  request = requestJson, validatorRequest = requestValidatorJson, now = Date.now() }) {
  const binding = loadLocal(directory, signedArtifactPath);
  const lock = acquireSubmissionLock(binding.root, binding.signed.transactionId, now);
  try {
    return await submitValidatorAdmissionLocked({ binding, submissionInput, request,
      validatorRequest, now });
  } finally { releaseSubmissionLock(lock); }
}

function loadValidatorAdmissionSubmissionInputObject(value) {
  // Apply the same strict envelope checks to in-memory callers as to CLI-loaded input.
  exact(value, ["candidateSyncInput", "certificateHistories", "format", "peerRegistry", "version"],
    "validator admission submission input");
  if (value.format !== "nir-validator-admission-submission-input-v1" || value.version !== 1 ||
      !Array.isArray(value.certificateHistories) || value.certificateHistories.length < 4 ||
      value.certificateHistories.length > 256) throw new Error("validator admission submission input is invalid");
  return { ...structuredClone(value), candidateSyncInput:
    validateValidatorCandidateSyncInput(value.candidateSyncInput) };
}
