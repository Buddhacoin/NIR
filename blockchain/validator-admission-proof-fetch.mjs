import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync }
  from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { certificatePinsAtHeight, verifyCertificateHistory } from "./certificate-lifecycle.mjs";
import { canonicalJson } from "./crypto.mjs";
import { requestValidatorJson } from "./http-client.mjs";
import { peerRegistryHash } from "./peer-registry.mjs";
import {
  validateValidatorAdmissionFinalityBase, verifyValidatorAdmissionFinalityEvidence,
} from "./validator-admission-finality.mjs";
import {
  VALIDATOR_ADMISSION_PROOF_PATH, validatorAdmissionProofRequest,
  verifyValidatorAdmissionProofResponseAuth,
} from "./validator-admission-proof-auth.mjs";

const ADDRESS = /^nir1[0-9a-f]{64}$/;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_VALIDATOR_ADMISSION_PROOF_RESPONSE_BYTES = 40 * 1024 * 1024;
const MAX_CONCURRENCY = 2;
const TIMEOUT_MS = 2_000;
// 256 validators at two-way concurrency need at most 256 seconds when every request times out.
const OVERALL_TIMEOUT_MS = 300_000;
const MAX_PROOFS = 64;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }

export function loadValidatorAdmissionProofFetchInput(path) {
  const requested = resolve(path); const parent = realpathSync(dirname(requested));
  const target = join(parent, basename(requested)); let descriptor;
  try {
    const linked = lstatSync(target);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor); const bytes = readFileSync(descriptor); const after = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) ||
        !sameIdentity(linked, before) || !sameIdentity(before, after) ||
        !sameIdentity(before, lstatSync(target)) || bytes.length < 2 ||
        bytes.length > MAX_INPUT_BYTES || bytes.length !== before.size) {
      throw new Error("validator admission proof fetch input is unsafe");
    }
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("validator admission proof fetch input is not canonical JSON");
    const value = JSON.parse(text.slice(0, -1));
    if (`${canonicalJson(value)}\n` !== text) {
      throw new Error("validator admission proof fetch input is not canonical JSON");
    }
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function validateInput(value) {
  exact(value, ["candidateCheckpoint", "certificateHistories", "format", "publicPlan",
    "signedArtifact", "signedJournal", "signingPackage", "submissionReceipt", "version"],
  "validator admission proof fetch input");
  if (value.format !== "nir-validator-admission-proof-fetch-v1" || value.version !== 1 ||
      !Array.isArray(value.certificateHistories)) {
    throw new Error("validator admission proof fetch input is invalid");
  }
  const baseValue = { candidateCheckpoint: value.candidateCheckpoint, publicPlan: value.publicPlan,
    signedArtifact: value.signedArtifact, signedJournal: value.signedJournal,
    signingPackage: value.signingPackage, submissionReceipt: value.submissionReceipt };
  const base = validateValidatorAdmissionFinalityBase(baseValue);
  const validators = base.submission.context.checkpointTrustPackage.validators;
  const peerRegistry = base.submission.receipt.peerRegistry;
  const registryHash = peerRegistryHash(peerRegistry);
  if (registryHash !== base.submission.context.checkpointTrustPackage.finalityProof.header.peerRegistryHash) {
    throw new Error("validator admission proof peer registry is not checkpoint committed");
  }
  const histories = new Map();
  for (const entry of value.certificateHistories) {
    exact(entry, ["history", "validatorAddress"], "validator admission proof certificate history");
    if (!ADDRESS.test(entry.validatorAddress ?? "") || histories.has(entry.validatorAddress)) {
      throw new Error("validator admission proof certificate history is duplicated or invalid");
    }
    histories.set(entry.validatorAddress, entry.history);
  }
  if (histories.size !== validators.length || validators.some(({ address }) => !histories.has(address))) {
    throw new Error("validator admission proof certificate histories do not cover the active set");
  }
  const certificateContext = { expectedPeerRegistryHash: registryHash,
    networkId: base.plan.networkId, validators };
  for (const [address, history] of histories) {
    histories.set(address, verifyCertificateHistory(history, certificateContext));
  }
  const peers = peerRegistry.peers;
  if (!Array.isArray(peers) || peers.length !== validators.length ||
      new Set(peers.map(({ validatorAddress }) => validatorAddress)).size !== validators.length) {
    throw new Error("validator admission proof peers do not exactly cover the active set");
  }
  for (const peer of peers) {
    const pins = certificatePinsAtHeight(histories.get(peer.validatorAddress),
      peer.validatorAddress, base.submission.context.checkpoint.height);
    if (!pins.includes(peer.tlsCertificateSha256)) {
      throw new Error("validator admission proof peer TLS pin lacks checkpoint history");
    }
  }
  return { base, baseValue, certificateContext, histories, peers };
}

export async function fetchValidatorAdmissionFinalityEvidence({ input, request = requestValidatorJson }) {
  if (typeof request !== "function") throw new Error("validator admission proof transport is invalid");
  const { base, baseValue, certificateContext, histories, peers } = validateInput(input);
  const proofRequest = validatorAdmissionProofRequest({
    chainIdentityGenesisHash: base.plan.expectedChainIdentityGenesisHash,
    checkpointHash: base.anchor.tipHash, fromHeight: base.anchor.height,
    transactionId: base.signed.transactionId });
  const validators = new Map(base.submission.context.checkpointTrustPackage.validators
    .map((validator) => [validator.address, validator]));
  let selected = null; let selectedHash = null; const validSources = []; let conflict = false;
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  const orderedPeers = [...peers].sort((left, right) =>
    left.validatorAddress.localeCompare(right.validatorAddress));
  const processPeer = async (peer) => {
    const clientNonce = randomBytes(32).toString("hex");
    const query = new URLSearchParams({
      chainIdentityGenesisHash: proofRequest.chainIdentityGenesisHash,
      checkpointHash: proofRequest.checkpointHash, clientNonce,
      fromHeight: String(proofRequest.fromHeight),
      transactionId: proofRequest.transactionId });
    const remaining = Math.max(1, Math.min(TIMEOUT_MS, deadline - Date.now()));
    let timer; const controller = new AbortController();
    const response = await Promise.race([
      request(`${peer.url}${VALIDATOR_ADMISSION_PROOF_PATH}?${query}`, {
        certificateContext, certificateHistory: histories.get(peer.validatorAddress),
        height: base.submission.context.checkpoint.height,
        maxResponseBytes: MAX_VALIDATOR_ADMISSION_PROOF_RESPONSE_BYTES,
        method: "GET", signal: controller.signal, timeoutMs: remaining,
        validatorAddress: peer.validatorAddress,
      }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort();
        reject(new Error("validator admission proof request timed out")); }, remaining); timer.unref?.(); }),
    ]).finally(() => { clearTimeout(timer); controller.abort(); });
    if (!response?.ok) throw new Error("validator admission proof source did not return evidence");
    exact(response.body, ["auth", "result"], "validator admission proof HTTP response");
    const sourceResult = verifyValidatorAdmissionProofResponseAuth(response.body.auth, {
      clientNonce, networkId: base.plan.networkId, request: proofRequest,
      result: response.body.result, validator: validators.get(peer.validatorAddress),
    });
    exact(sourceResult, ["bundle", "format", "status", "version"],
      "validator admission proof source result");
    if (sourceResult.format !== "nir-validator-admission-proof-source-result-v1" ||
        sourceResult.version !== 1 || !["found", "not-found"].includes(sourceResult.status) ||
        (sourceResult.status === "not-found") !== (sourceResult.bundle === null)) {
      throw new Error("validator admission proof source result is invalid");
    }
    if (sourceResult.status === "not-found") return;
    const remote = sourceResult.bundle;
    exact(remote, ["finalityProofs", "format", "handoffs", "inclusion", "version"],
      "validator admission proof bundle");
    if (remote.format !== "nir-validator-admission-proof-bundle-v1" || remote.version !== 1 ||
        !Array.isArray(remote.finalityProofs) || remote.finalityProofs.length < 1 ||
        remote.finalityProofs.length > MAX_PROOFS ||
        Buffer.byteLength(canonicalJson(remote)) > MAX_VALIDATOR_ADMISSION_PROOF_RESPONSE_BYTES) {
      throw new Error("validator admission proof bundle is invalid");
    }
    const evidence = { ...structuredClone(baseValue), finalityProofs: remote.finalityProofs,
      format: "nir-validator-admission-finality-evidence-v1", handoffs: remote.handoffs,
      inclusion: remote.inclusion, version: 1 };
    const verified = verifyValidatorAdmissionFinalityEvidence(evidence);
    if (selected === null) { selected = { evidence, verified }; selectedHash = verified.evidenceHash; }
    else if (verified.evidenceHash !== selectedHash) conflict = true;
    validSources.push(peer.validatorAddress);
  };
  for (let offset = 0; offset < orderedPeers.length; offset += MAX_CONCURRENCY) {
    if (Date.now() >= deadline) break;
    await Promise.all(orderedPeers.slice(offset, offset + MAX_CONCURRENCY).map(async (peer) => {
      try { await processPeer(peer); }
      catch { /* an invalid or unavailable peer is not evidence of absence */ }
    }));
    if (conflict) break;
  }
  if (conflict) {
    const error = new Error("authenticated validators supplied conflicting finalized admission proofs");
    error.code = "ERR_VALIDATOR_ADMISSION_PROOF_CONFLICT"; throw error;
  }
  if (selected === null) {
    throw new Error("no authenticated validator supplied a valid finalized admission proof");
  }
  return { evidence: selected.evidence, result: selected.verified,
    validSources: validSources.sort() };
}
