import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  addressFromPublicKey, canonicalJson, hashObject, signObject, verifyObject,
} from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import { validateOfflineReleaseBundle } from "./offline-release-bundle.mjs";

const SET_FORMAT = "nir-release-authority-set-v1";
const ANCHOR_FORMAT = "nir-release-transparency-anchor-v1";
const PROPOSAL_FORMAT = "nir-release-log-proposal-v1";
const APPROVAL_FORMAT = "nir-release-governance-approval-v1";
const ENTRY_FORMAT = "nir-release-transparency-entry-v1";
const CHECKPOINT_FORMAT = "nir-release-transparency-checkpoint-v1";
const HASH = /^sha3-256:[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const LOG_ID = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENTRY_NAME = /^([0-9]{12})-([0-9a-f]{64})\.json$/;
const MAX_AUTHORITIES = 64;
const MAX_ENTRY_BYTES = 512 * 1024;

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function canonicalBase64(value, maximum, label) {
  if (typeof value !== "string" || value.length > maximum * 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1 || decoded.length > maximum || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
}

function setPayload(value) {
  exact(value, ["authorities", "format", "generation", "rotationDelayEntries", "threshold"],
    "release authority set");
  if (value.format !== SET_FORMAT || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      !Number.isSafeInteger(value.threshold) || value.threshold < 2 ||
      !Number.isSafeInteger(value.rotationDelayEntries) || value.rotationDelayEntries < 2 ||
      value.rotationDelayEntries > 1024 || !Array.isArray(value.authorities) ||
      value.authorities.length < value.threshold || value.authorities.length > MAX_AUTHORITIES) {
    throw new Error("release authority set policy is invalid");
  }
  const operatorIds = new Set();
  const addresses = new Set();
  const publicKeys = new Set();
  const authorities = value.authorities.map((authority) => {
    exact(authority, ["address", "algorithm", "operatorId", "publicKey"], "release authority");
    canonicalBase64(authority.publicKey, 8 * 1024, "release authority public key");
    if (!OPERATOR.test(authority.operatorId ?? "") || authority.algorithm !== SIGNATURE_ALGORITHM ||
        !ADDRESS.test(authority.address ?? "") ||
        addressFromPublicKey(authority.publicKey) !== authority.address ||
        operatorIds.has(authority.operatorId) || addresses.has(authority.address) ||
        publicKeys.has(authority.publicKey)) throw new Error("release authorities are invalid or duplicate");
    operatorIds.add(authority.operatorId); addresses.add(authority.address); publicKeys.add(authority.publicKey);
    return structuredClone(authority);
  });
  if (authorities.some((authority, index) => authority.operatorId !== value.authorities[index].operatorId) ||
      authorities.some((authority, index) => index > 0 &&
        authorities[index - 1].operatorId >= authority.operatorId)) {
    throw new Error("release authorities are not canonically ordered");
  }
  return { authorities, format: SET_FORMAT, generation: value.generation,
    rotationDelayEntries: value.rotationDelayEntries, threshold: value.threshold };
}

export function createReleaseAuthoritySet({ authorities, generation, rotationDelayEntries, threshold }) {
  const payload = setPayload({ authorities: [...authorities].sort((a, b) =>
    a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0),
  format: SET_FORMAT, generation, rotationDelayEntries, threshold });
  return { ...payload, setId: `sha3-256:${hashObject(payload, "RELEASE_AUTHORITY_SET_V1")}` };
}

export function validateReleaseAuthoritySet(value) {
  exact(value, ["authorities", "format", "generation", "rotationDelayEntries", "setId", "threshold"],
    "release authority set envelope");
  const { setId, ...unsigned } = value;
  const payload = setPayload(unsigned);
  const expected = `sha3-256:${hashObject(payload, "RELEASE_AUTHORITY_SET_V1")}`;
  if (setId !== expected) throw new Error("release authority set id is invalid");
  return { ...payload, setId };
}

function anchorPayload(value) {
  exact(value, ["format", "initialSet", "logId", "networkId", "version"],
    "release transparency anchor");
  if (value.format !== ANCHOR_FORMAT || value.version !== 1 || !LOG_ID.test(value.logId ?? "") ||
      !NETWORK.test(value.networkId ?? "")) throw new Error("release transparency anchor is invalid");
  return { format: ANCHOR_FORMAT, initialSet: validateReleaseAuthoritySet(value.initialSet),
    logId: value.logId, networkId: value.networkId, version: 1 };
}

export function createReleaseTransparencyAnchor({ initialSet, logId, networkId }) {
  const payload = anchorPayload({ format: ANCHOR_FORMAT, initialSet, logId, networkId, version: 1 });
  return { ...payload, anchorHash: `sha3-256:${hashObject(payload, "RELEASE_TRANSPARENCY_ANCHOR_V1")}` };
}

export function validateReleaseTransparencyAnchor(value) {
  exact(value, ["anchorHash", "format", "initialSet", "logId", "networkId", "version"],
    "release transparency anchor envelope");
  const { anchorHash, ...unsigned } = value;
  const payload = anchorPayload(unsigned);
  if (anchorHash !== `sha3-256:${hashObject(payload, "RELEASE_TRANSPARENCY_ANCHOR_V1")}`) {
    throw new Error("release transparency anchor hash is invalid");
  }
  return { ...payload, anchorHash };
}

function releasePayload(bundleValue) {
  const bundle = validateOfflineReleaseBundle(bundleValue);
  return {
    bundleHash: bundle.bundleHash, manifestHash: bundle.manifestHash,
    networkId: bundle.manifest.networkId, previousBundleHash: bundle.manifest.previousBundleHash,
    protocolVersion: bundle.manifest.protocolVersion, releaseVersion: bundle.manifest.releaseVersion,
    sourceRevision: bundle.manifest.sourceRevision,
  };
}

function validateChangePayload(payload, currentSet, sequence) {
  exact(payload, ["activationSequence", "nextSet", "reason"], "authority change payload");
  const nextSet = validateReleaseAuthoritySet(payload.nextSet);
  if (!['rotation', 'revocation'].includes(payload.reason) ||
      nextSet.generation !== currentSet.generation + 1 || nextSet.setId === currentSet.setId ||
      payload.activationSequence !== sequence + currentSet.rotationDelayEntries) {
    throw new Error("authority change generation or activation is invalid");
  }
  const currentByOperator = new Map(currentSet.authorities.map((authority) =>
    [authority.operatorId, authority.address]));
  const overlap = nextSet.authorities.filter((authority) =>
    currentByOperator.get(authority.operatorId) === authority.address).length;
  if (overlap < Math.min(currentSet.threshold, nextSet.threshold)) {
    throw new Error("authority change lacks threshold overlap");
  }
  if (payload.reason === "revocation" &&
      currentSet.authorities.every((authority) => nextSet.authorities.some((candidate) =>
        candidate.operatorId === authority.operatorId && candidate.address === authority.address))) {
    throw new Error("revocation does not revoke an authority");
  }
  return { activationSequence: payload.activationSequence, nextSet, reason: payload.reason };
}

function proposalPayload(value, { currentSet, pendingChange, state }) {
  exact(value, ["activeSetId", "format", "logId", "networkId", "payload", "previousEntryHash",
    "sequence", "type", "version"], "release log proposal");
  if (value.format !== PROPOSAL_FORMAT || value.version !== 1 || value.logId !== state.logId ||
      value.networkId !== state.networkId || value.activeSetId !== currentSet.setId ||
      value.sequence !== state.sequence + 1 || value.previousEntryHash !== state.entryHash ||
      !["release", "authority-change"].includes(value.type)) {
    throw new Error("release log proposal is stale or has invalid context");
  }
  let payload;
  if (value.type === "release") {
    exact(value.payload, ["bundleHash", "manifestHash", "networkId", "previousBundleHash",
      "protocolVersion", "releaseVersion", "sourceRevision"], "release proposal payload");
    if (!HASH.test(value.payload.bundleHash ?? "") || !HASH.test(value.payload.manifestHash ?? "") ||
        value.payload.networkId !== state.networkId || value.payload.previousBundleHash !== state.lastBundleHash ||
        !Number.isSafeInteger(value.payload.protocolVersion) || value.payload.protocolVersion < 1 ||
        !RELEASE_VERSION.test(value.payload.releaseVersion ?? "") ||
        !REVISION.test(value.payload.sourceRevision ?? "")) {
      throw new Error("release proposal payload is invalid or not forward-linked");
    }
    payload = structuredClone(value.payload);
  } else {
    if (pendingChange !== null) throw new Error("an authority change is already pending");
    payload = validateChangePayload(value.payload, currentSet, value.sequence);
  }
  return { activeSetId: value.activeSetId, format: PROPOSAL_FORMAT, logId: value.logId,
    networkId: value.networkId, payload, previousEntryHash: value.previousEntryHash,
    sequence: value.sequence, type: value.type, version: 1 };
}

function withProposalHash(payload) {
  return { ...payload, proposalHash: `sha3-256:${hashObject(payload, "RELEASE_LOG_PROPOSAL_V1")}` };
}

export function validateReleaseLogProposal(value, context) {
  exact(value, ["activeSetId", "format", "logId", "networkId", "payload", "previousEntryHash",
    "proposalHash", "sequence", "type", "version"], "release log proposal envelope");
  const { proposalHash, ...unsigned } = value;
  const payload = proposalPayload(unsigned, context);
  const expected = `sha3-256:${hashObject(payload, "RELEASE_LOG_PROPOSAL_V1")}`;
  if (proposalHash !== expected) throw new Error("release proposal hash is invalid");
  return { ...payload, proposalHash };
}

function approvalSigningPayload(proposal) {
  return { proposalHash: proposal.proposalHash, sequence: proposal.sequence };
}

export function approveReleaseLogProposal(proposalValue, context, { operatorId, wallet }) {
  const proposal = validateReleaseLogProposal(proposalValue, context);
  return approvalForSet(proposal, context.currentSet, "active", { operatorId, wallet });
}

export function acceptReleaseAuthorityChange(proposalValue, context, { operatorId, wallet }) {
  const proposal = validateReleaseLogProposal(proposalValue, context);
  if (proposal.type !== "authority-change") throw new Error("only an authority change can be accepted");
  return approvalForSet(proposal, proposal.payload.nextSet, "next-set-acceptance", { operatorId, wallet });
}

export function approveReleaseActivationProposal(proposalValue, context, { operatorId, wallet }) {
  const proposal = validateReleaseLogProposal(proposalValue, context);
  if (context.activationSet === null) throw new Error("release proposal is not an activation boundary");
  return approvalForSet(proposal, context.activationSet, "activation", { operatorId, wallet });
}

function approvalForSet(proposal, set, role, { operatorId, wallet }) {
  const authority = set.authorities.find((candidate) => candidate.operatorId === operatorId);
  if (!authority || wallet.address !== authority.address || wallet.publicKey !== authority.publicKey) {
    throw new Error("release approval signer is not an authority for this role");
  }
  return {
    address: authority.address, format: APPROVAL_FORMAT, operatorId, proposalHash: proposal.proposalHash,
    role, setId: set.setId,
    signature: signObject({ ...approvalSigningPayload(proposal), role, setId: set.setId }, wallet,
      "RELEASE_GOVERNANCE_APPROVAL_V1"), version: 1,
  };
}

function validateApprovals(proposal, approvals, set, role) {
  if (!Array.isArray(approvals) || approvals.length < set.threshold ||
      approvals.length > set.authorities.length) throw new Error("release approval quorum is missing");
  const operators = new Set();
  const addresses = new Set();
  const normalized = approvals.map((approval) => {
    exact(approval, ["address", "format", "operatorId", "proposalHash", "role", "setId", "signature", "version"],
      "release governance approval");
    canonicalBase64(approval.signature, 16 * 1024, "release governance signature");
    const authority = set.authorities.find((candidate) => candidate.operatorId === approval.operatorId);
    if (approval.format !== APPROVAL_FORMAT || approval.version !== 1 || !authority ||
        approval.address !== authority.address || approval.setId !== set.setId || approval.role !== role ||
        approval.proposalHash !== proposal.proposalHash || operators.has(approval.operatorId) ||
        addresses.has(approval.address) || !verifyObject({ ...approvalSigningPayload(proposal), role,
          setId: set.setId }, approval.signature, authority.publicKey, "RELEASE_GOVERNANCE_APPROVAL_V1")) {
      throw new Error("release approval is duplicate, stale, or invalid");
    }
    operators.add(approval.operatorId); addresses.add(approval.address);
    return structuredClone(approval);
  }).sort((a, b) => a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0);
  if (normalized.length < set.threshold) throw new Error("release approval threshold is not met");
  return normalized;
}

function entryFromProposal(proposal, approvals, activationApprovals, nextSetAcceptances) {
  const unsigned = { activeSetId: proposal.activeSetId, activationApprovals, approvals, format: ENTRY_FORMAT,
    logId: proposal.logId, networkId: proposal.networkId, payload: proposal.payload,
    nextSetAcceptances,
    previousEntryHash: proposal.previousEntryHash, proposalHash: proposal.proposalHash,
    sequence: proposal.sequence, type: proposal.type, version: 1 };
  return { ...unsigned, entryHash: `sha3-256:${hashObject(unsigned, "RELEASE_TRANSPARENCY_ENTRY_V1")}` };
}

function initialState(anchor) {
  return { activationSet: null, activeSet: anchor.initialSet, anchorHash: anchor.anchorHash, entryHash: anchor.anchorHash,
    lastBundleHash: null, logId: anchor.logId, networkId: anchor.networkId, pendingChange: null,
    sequence: 0 };
}

function headFromState(state) {
  return {
    activationSet: state.activationSet === null ? null : structuredClone(state.activationSet),
    activeSet: structuredClone(state.activeSet),
    activeSetId: state.activeSet.setId,
    entryHash: state.entryHash,
    lastBundleHash: state.lastBundleHash,
    pendingChange: state.pendingChange === null ? null : structuredClone(state.pendingChange),
    pendingChangeHeight: state.pendingChangeHeight ?? null,
    sequence: state.sequence,
  };
}

export function createReleaseGovernanceHead(anchorValue) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  return headFromState(initialState(anchor));
}

export function validateReleaseGovernanceHead(value, anchorValue) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  exact(value, ["activationSet", "activeSet", "activeSetId", "entryHash", "lastBundleHash",
    "pendingChange", "pendingChangeHeight", "sequence"], "release governance head");
  const activeSet = validateReleaseAuthoritySet(value.activeSet);
  const activationSet = value.activationSet === null ? null
    : validateReleaseAuthoritySet(value.activationSet);
  let pendingChange = null;
  if (value.pendingChange !== null) {
    exact(value.pendingChange, ["activationSequence", "nextSet", "reason"],
      "release governance pending change");
    const nextSet = validateReleaseAuthoritySet(value.pendingChange.nextSet);
    if (!Number.isSafeInteger(value.pendingChange.activationSequence) ||
        value.pendingChange.activationSequence <= value.sequence ||
        !["rotation", "revocation"].includes(value.pendingChange.reason) ||
        nextSet.generation !== activeSet.generation + 1) {
      throw new Error("release governance pending change is invalid");
    }
    pendingChange = { activationSequence: value.pendingChange.activationSequence,
      nextSet, reason: value.pendingChange.reason };
  }
  if (value.activeSetId !== activeSet.setId || !HASH.test(value.entryHash ?? "") ||
      !(value.lastBundleHash === null || HASH.test(value.lastBundleHash ?? "")) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      (value.sequence === 0 && (activeSet.setId !== anchor.initialSet.setId ||
        value.entryHash !== anchor.anchorHash || value.lastBundleHash !== null ||
        activationSet !== null || pendingChange !== null || value.pendingChangeHeight !== null)) ||
      (pendingChange === null) !== (value.pendingChangeHeight === null) ||
      !(value.pendingChangeHeight === null ||
        (Number.isSafeInteger(value.pendingChangeHeight) && value.pendingChangeHeight >= 0)) ||
      (activationSet !== null && activationSet.generation + 1 !== activeSet.generation)) {
    throw new Error("release governance head is invalid");
  }
  return { activationSet, activeSet, activeSetId: activeSet.setId, entryHash: value.entryHash,
    lastBundleHash: value.lastBundleHash, pendingChange,
    pendingChangeHeight: value.pendingChangeHeight, sequence: value.sequence };
}

export function advanceReleaseGovernanceHead(entries, headValue, anchorValue, {
  currentHeight = null, minimumRotationDelayBlocks = 0,
} = {}) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 1024) {
    throw new Error("release governance entry chain is invalid");
  }
  const head = validateReleaseGovernanceHead(headValue, anchor);
  let state = {
    activationSet: head.activationSet,
    activeSet: head.activeSet,
    anchorHash: anchor.anchorHash,
    entryHash: head.entryHash,
    lastBundleHash: head.lastBundleHash,
    logId: anchor.logId,
    networkId: anchor.networkId,
    pendingChange: head.pendingChange,
    pendingChangeHeight: head.pendingChangeHeight,
    sequence: head.sequence,
  };
  for (const entry of entries) {
    const activates = state.pendingChange !== null &&
      state.pendingChange.activationSequence === state.sequence + 1;
    if (activates && (!Number.isSafeInteger(currentHeight) ||
        currentHeight < state.pendingChangeHeight + minimumRotationDelayBlocks)) {
      throw new Error("release authority rotation block delay is not met");
    }
    const schedules = entry?.type === "authority-change";
    state = applyEntry(state, entry);
    if (activates) state.pendingChangeHeight = null;
    if (schedules) {
      if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) {
        throw new Error("release authority rotation height is missing");
      }
      state.pendingChangeHeight = currentHeight;
    }
  }
  return { entries: structuredClone(entries), head: headFromState(state), state };
}

function applyPending(state, nextSequence) {
  if (state.pendingChange !== null && state.pendingChange.activationSequence === nextSequence) {
    return { ...state, activationSet: state.activeSet, activeSet: state.pendingChange.nextSet,
      pendingChange: null };
  }
  if (state.pendingChange !== null && state.pendingChange.activationSequence < nextSequence) {
    throw new Error("release authority activation was skipped");
  }
  return state;
}

function applyEntry(stateValue, entryValue) {
  const state = applyPending(stateValue, stateValue.sequence + 1);
  exact(entryValue, ["activeSetId", "activationApprovals", "approvals", "entryHash", "format", "logId", "networkId",
    "nextSetAcceptances", "payload", "previousEntryHash", "proposalHash", "sequence", "type", "version"],
  "release transparency entry");
  const proposalValue = { activeSetId: entryValue.activeSetId, format: PROPOSAL_FORMAT,
    logId: entryValue.logId, networkId: entryValue.networkId, payload: entryValue.payload,
    previousEntryHash: entryValue.previousEntryHash, proposalHash: entryValue.proposalHash,
    sequence: entryValue.sequence, type: entryValue.type, version: 1 };
  const proposal = validateReleaseLogProposal(proposalValue, {
    currentSet: state.activeSet, pendingChange: state.pendingChange, state,
  });
  const approvals = validateApprovals(proposal, entryValue.approvals, state.activeSet, "active");
  const activationApprovals = state.activationSet === null
    ? (entryValue.activationApprovals.length === 0 ? [] : (() => { throw new Error("unexpected activation approvals"); })())
    : validateApprovals(proposal, entryValue.activationApprovals, state.activationSet, "activation");
  const nextSetAcceptances = proposal.type === "authority-change"
    ? validateApprovals(proposal, entryValue.nextSetAcceptances, proposal.payload.nextSet,
      "next-set-acceptance")
    : (entryValue.nextSetAcceptances.length === 0 ? [] : (() => { throw new Error("unexpected next-set acceptances"); })());
  const expected = entryFromProposal(proposal, approvals, activationApprovals, nextSetAcceptances);
  if (canonicalJson(expected) !== canonicalJson(entryValue)) {
    throw new Error("release transparency entry hash or canonical approvals are invalid");
  }
  return { ...state, activationSet: null, entryHash: expected.entryHash,
    lastBundleHash: proposal.type === "release" ? proposal.payload.bundleHash : state.lastBundleHash,
    pendingChange: proposal.type === "authority-change" ? proposal.payload : state.pendingChange,
    sequence: proposal.sequence };
}

// Verify one release entry against an already trusted authority set and an
// already trusted hash-linked log head. This deliberately does not accept an
// authority set from the entry itself: callers must obtain the set and head
// from genesis or another authenticated transition.
export function validateReleaseAuthorizationEntry(entryValue, {
  authoritySet: authoritySetValue,
  entryHash,
  lastBundleHash,
  logId,
  networkId,
  sequence,
} = {}) {
  const authoritySet = validateReleaseAuthoritySet(authoritySetValue);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !HASH.test(entryHash ?? "") ||
      !(lastBundleHash === null || HASH.test(lastBundleHash ?? "")) ||
      !LOG_ID.test(logId ?? "") || !NETWORK.test(networkId ?? "")) {
    throw new Error("trusted release governance head is invalid");
  }
  if (entryValue?.type !== "release" || entryValue?.sequence !== sequence + 1 ||
      entryValue?.previousEntryHash !== entryHash || entryValue?.logId !== logId ||
      entryValue?.networkId !== networkId || entryValue?.activeSetId !== authoritySet.setId) {
    throw new Error("release authorization entry does not extend the trusted head");
  }
  const state = {
    activationSet: null,
    activeSet: authoritySet,
    anchorHash: entryHash,
    entryHash,
    lastBundleHash,
    logId,
    networkId,
    pendingChange: null,
    sequence,
  };
  const next = applyEntry(state, entryValue);
  return {
    entry: structuredClone(entryValue),
    head: {
      activeSetId: authoritySet.setId,
      entryHash: next.entryHash,
      lastBundleHash: next.lastBundleHash,
      sequence: next.sequence,
    },
    release: structuredClone(entryValue.payload),
  };
}

export function createReleaseProposal({ anchor: anchorValue, state: stateValue, bundle, nextSet, reason }) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const state = applyPending(stateValue ?? initialState(anchor), (stateValue?.sequence ?? 0) + 1);
  if (state.anchorHash !== anchor.anchorHash || state.logId !== anchor.logId || state.networkId !== anchor.networkId) {
    throw new Error("release proposal state does not match its anchor");
  }
  const base = { activeSetId: state.activeSet.setId, format: PROPOSAL_FORMAT, logId: state.logId,
    networkId: state.networkId, previousEntryHash: state.entryHash, sequence: state.sequence + 1, version: 1 };
  const unsigned = bundle !== undefined
    ? { ...base, payload: releasePayload(bundle), type: "release" }
    : { ...base, payload: { activationSequence: base.sequence + state.activeSet.rotationDelayEntries,
      nextSet: validateReleaseAuthoritySet(nextSet), reason }, type: "authority-change" };
  return withProposalHash(proposalPayload(unsigned, {
    currentSet: state.activeSet, pendingChange: state.pendingChange, state,
  }));
}

export function createReleaseLogEntry(proposalValue, approvals, context,
  { activationApprovals = [], nextSetAcceptances = [] } = {}) {
  const proposal = validateReleaseLogProposal(proposalValue, context);
  const active = validateApprovals(proposal, approvals, context.currentSet, "active");
  const activation = context.activationSet === null
    ? (activationApprovals.length === 0 ? [] : (() => { throw new Error("unexpected activation approvals"); })())
    : validateApprovals(proposal, activationApprovals, context.activationSet, "activation");
  const acceptance = proposal.type === "authority-change"
    ? validateApprovals(proposal, nextSetAcceptances, proposal.payload.nextSet, "next-set-acceptance")
    : (nextSetAcceptances.length === 0 ? [] : (() => { throw new Error("unexpected next-set acceptances"); })());
  return entryFromProposal(proposal, active, activation, acceptance);
}

function requireSecureFs() {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new Error("secure release transparency filesystem support is unavailable");
  }
}

function openDirectory(path, { create = false } = {}) {
  requireSecureFs();
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) {
    throw new Error("release transparency directory is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(descriptor); throw new Error("release transparency directory changed during open");
  }
  return { descriptor, metadata: opened, path };
}

function assertDirectory(opened, requireStableMetadata = false) {
  const descriptor = fstatSync(opened.descriptor);
  const linked = lstatSync(opened.path);
  if (!linked.isDirectory() || linked.isSymbolicLink() || descriptor.dev !== opened.metadata.dev ||
      descriptor.ino !== opened.metadata.ino || linked.dev !== opened.metadata.dev ||
      linked.ino !== opened.metadata.ino || descriptor.uid !== opened.metadata.uid ||
      descriptor.mode !== opened.metadata.mode || (requireStableMetadata &&
        (descriptor.mtimeMs !== opened.metadata.mtimeMs ||
         descriptor.ctimeMs !== opened.metadata.ctimeMs))) {
    throw new Error("release transparency directory changed");
  }
}

function readCanonicalFile(path, maximum = MAX_ENTRY_BYTES) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum ||
        (before.mode & 0o077) !== 0) throw new Error("release transparency file is unsafe");
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    if (contents.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("release transparency file changed during read");
    }
    const text = contents.toString("utf8");
    const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("release transparency JSON is not canonical");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function writeCanonicalExclusive(directory, name, value) {
  const path = join(directory.path, name);
  let descriptor;
  try {
    assertDirectory(directory);
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    const contents = `${canonicalJson(value)}\n`;
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, 0o600); fsyncSync(descriptor); fsyncSync(directory.descriptor);
    assertDirectory(directory);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function entryName(sequence, hash) {
  return `${String(sequence).padStart(12, "0")}-${hash.slice("sha3-256:".length)}.json`;
}

export function loadReleaseTransparencyLog(anchorValue, logDirectory, checkpointDirectory) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const directory = openDirectory(resolve(logDirectory), { create: true });
  let state = initialState(anchor);
  const history = new Map([[0, { activationSetId: null, activeSetId: state.activeSet.setId,
    entryHash: state.entryHash, lastBundleHash: null, pendingChange: null }]]);
  try {
    const names = readdirSync(directory.path).sort();
    const sequences = new Set();
    for (const name of names) {
      const match = ENTRY_NAME.exec(name);
      if (!match) throw new Error("release transparency directory contains an unknown file");
      const sequence = Number(match[1]);
      if (sequences.has(sequence) || sequence !== state.sequence + 1) {
        throw new Error("release transparency log is split, duplicated, or non-contiguous");
      }
      sequences.add(sequence);
      const entry = readCanonicalFile(join(directory.path, name));
      state = applyEntry(state, entry);
      history.set(state.sequence, { activationSetId: state.activationSet?.setId ?? null,
        activeSetId: state.activeSet.setId, entryHash: state.entryHash,
        lastBundleHash: state.lastBundleHash, pendingChange: state.pendingChange === null ? null : {
          activationSequence: state.pendingChange.activationSequence,
          nextSetId: state.pendingChange.nextSet.setId, reason: state.pendingChange.reason,
        } });
      if (name !== entryName(state.sequence, state.entryHash)) {
        throw new Error("release transparency entry filename does not match its hash");
      }
    }
    assertDirectory(directory, true);
  } finally { closeSync(directory.descriptor); }
  if (checkpointDirectory !== undefined) {
    verifyReleaseTransparencyCheckpoints(anchor, state, checkpointDirectory, history);
  }
  return state;
}

function checkpointValue(anchor, state) {
  const payload = { activationSetId: state.activationSet?.setId ?? null,
    activeSetId: state.activeSet.setId, anchorHash: anchor.anchorHash,
    entryHash: state.entryHash, format: CHECKPOINT_FORMAT, lastBundleHash: state.lastBundleHash,
    logId: state.logId, networkId: state.networkId,
    pendingChange: state.pendingChange === null ? null : {
      activationSequence: state.pendingChange.activationSequence,
      nextSetId: state.pendingChange.nextSet.setId, reason: state.pendingChange.reason,
    }, sequence: state.sequence, version: 1 };
  return { ...payload, checkpointHash:
    `sha3-256:${hashObject(payload, "RELEASE_TRANSPARENCY_CHECKPOINT_V1")}` };
}

export function validateReleaseTransparencyCheckpoint(value, anchor) {
  exact(value, ["activationSetId", "activeSetId", "anchorHash", "checkpointHash", "entryHash", "format", "lastBundleHash",
    "logId", "networkId", "pendingChange", "sequence", "version"], "release checkpoint");
  const { checkpointHash, ...payload } = value;
  if (value.pendingChange !== null) {
    exact(value.pendingChange, ["activationSequence", "nextSetId", "reason"],
      "release checkpoint pending change");
    if (!Number.isSafeInteger(value.pendingChange.activationSequence) ||
        value.pendingChange.activationSequence <= value.sequence ||
        !HASH.test(value.pendingChange.nextSetId ?? "") ||
        !["rotation", "revocation"].includes(value.pendingChange.reason)) {
      throw new Error("release checkpoint pending change is invalid");
    }
  }
  if (value.format !== CHECKPOINT_FORMAT || value.version !== 1 || value.anchorHash !== anchor.anchorHash ||
      value.logId !== anchor.logId || value.networkId !== anchor.networkId ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !HASH.test(value.entryHash ?? "") ||
      !HASH.test(value.activeSetId ?? "") || !HASH.test(checkpointHash ?? "") ||
      !(value.activationSetId === null || HASH.test(value.activationSetId ?? "")) ||
      !(value.lastBundleHash === null || HASH.test(value.lastBundleHash ?? "")) ||
      checkpointHash !== `sha3-256:${hashObject(payload, "RELEASE_TRANSPARENCY_CHECKPOINT_V1")}`) {
    throw new Error("release checkpoint is invalid");
  }
  return structuredClone(value);
}

export function verifyReleaseTransparencyCheckpoints(anchorValue, state, checkpointDirectory, history = null) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const directory = openDirectory(resolve(checkpointDirectory), { create: true });
  try {
    const bySequence = new Map();
    for (const name of readdirSync(directory.path).sort()) {
      const match = ENTRY_NAME.exec(name);
      if (!match) throw new Error("release checkpoint directory contains an unknown file");
      const checkpoint = validateReleaseTransparencyCheckpoint(
        readCanonicalFile(join(directory.path, name)), anchor);
      if (name !== entryName(checkpoint.sequence, checkpoint.checkpointHash) ||
          bySequence.has(checkpoint.sequence)) throw new Error("release checkpoints are forked or duplicate");
      bySequence.set(checkpoint.sequence, checkpoint);
    }
    const latest = [...bySequence.values()].at(-1);
    if (latest) {
      const expected = latest.sequence === state.sequence ? {
        activationSetId: state.activationSet?.setId ?? null,
        activeSetId: state.activeSet.setId, entryHash: state.entryHash,
        lastBundleHash: state.lastBundleHash,
        pendingChange: state.pendingChange === null ? null : {
          activationSequence: state.pendingChange.activationSequence,
          nextSetId: state.pendingChange.nextSet.setId, reason: state.pendingChange.reason,
        },
      } : history?.get(latest.sequence);
      if (latest.sequence > state.sequence || !expected || latest.entryHash !== expected.entryHash ||
          latest.activeSetId !== expected.activeSetId ||
          latest.activationSetId !== expected.activationSetId ||
          latest.lastBundleHash !== expected.lastBundleHash ||
          canonicalJson(latest.pendingChange) !== canonicalJson(expected.pendingChange)) {
        throw new Error("release log is rolled back or forked from the persisted checkpoint");
      }
    }
    assertDirectory(directory, true);
    return latest ?? null;
  } finally { closeSync(directory.descriptor); }
}

export function appendReleaseTransparencyEntry({
  anchor: anchorValue, logDirectory, checkpointDirectory, proposal, approvals,
  activationApprovals = [], nextSetAcceptances = [],
}) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const stateBefore = loadReleaseTransparencyLog(anchor, logDirectory, checkpointDirectory);
  const stateForEntry = applyPending(stateBefore, stateBefore.sequence + 1);
  const entry = createReleaseLogEntry(proposal, approvals, {
    activationSet: stateForEntry.activationSet, currentSet: stateForEntry.activeSet,
    pendingChange: stateForEntry.pendingChange, state: stateForEntry,
  }, { activationApprovals, nextSetAcceptances });
  const log = openDirectory(resolve(logDirectory), { create: true });
  try {
    assertDirectory(log);
    writeCanonicalExclusive(log, entryName(entry.sequence, entry.entryHash), entry);
  } finally { closeSync(log.descriptor); }
  const state = loadReleaseTransparencyLog(anchor, logDirectory, checkpointDirectory);
  const checkpoints = openDirectory(resolve(checkpointDirectory), { create: true });
  const checkpoint = checkpointValue(anchor, state);
  try {
    writeCanonicalExclusive(checkpoints,
      entryName(checkpoint.sequence, checkpoint.checkpointHash), checkpoint);
  } finally { closeSync(checkpoints.descriptor); }
  return { checkpoint, entry, state };
}

export function recoverReleaseTransparencyCheckpoint({
  anchor: anchorValue, logDirectory, checkpointDirectory,
}) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const state = loadReleaseTransparencyLog(anchor, logDirectory, checkpointDirectory);
  const checkpoint = checkpointValue(anchor, state);
  const checkpoints = openDirectory(resolve(checkpointDirectory), { create: true });
  const name = entryName(checkpoint.sequence, checkpoint.checkpointHash);
  try {
    const names = readdirSync(checkpoints.path);
    if (!names.includes(name)) writeCanonicalExclusive(checkpoints, name, checkpoint);
    assertDirectory(checkpoints);
  } finally { closeSync(checkpoints.descriptor); }
  loadReleaseTransparencyLog(anchor, logDirectory, checkpointDirectory);
  return checkpoint;
}

export function contextForReleaseLog(anchorValue, stateValue) {
  const anchor = validateReleaseTransparencyAnchor(anchorValue);
  const state = applyPending(stateValue ?? initialState(anchor), (stateValue?.sequence ?? 0) + 1);
  return { activationSet: state.activationSet, currentSet: state.activeSet,
    pendingChange: state.pendingChange, state };
}

export function serializeReleaseGovernance(value) {
  return `${canonicalJson(value)}\n`;
}
