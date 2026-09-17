import { createHash } from "node:crypto";

import {
  installAccountHistoryIndexRecords,
  readAccountHistoryIndexRecords,
  verifyAccountHistoryIndexRecords,
} from "./account-history-index.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";
import {
  addressFromPublicKey,
  canonicalJson,
  hashObject,
  publicWallet,
  signObject,
  verifyObject,
} from "./crypto.mjs";

const FORMAT = "nir-history-archive-manifest-v1";
const HASH = /^[0-9a-f]{64}$/;
const MAX_CHUNKS = 100_000;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function chunkDigest(contents) {
  return createHash("sha3-256")
    .update("NIR/HISTORY_ARCHIVE_CHUNK/v1\0")
    .update(contents)
    .digest("hex");
}

function contentRoot(records) {
  return hashObject(records.map(({ blockHash, height, indexHash }) => ({
    blockHash, height, indexHash,
  })), "HISTORY_ARCHIVE_CONTENT");
}

function manifestPayload(value) {
  if (!value || value.format !== FORMAT || typeof value.networkId !== "string" ||
      value.networkId.length < 1 || value.networkId.length > 128 ||
      !Number.isSafeInteger(value.height) || value.height < 0 ||
      !HASH.test(value.tipHash ?? "") || !HASH.test(value.stateRoot ?? "") ||
      !HASH.test(value.accountStateRoot ?? "") || !HASH.test(value.contentRoot ?? "") ||
      !Number.isSafeInteger(value.recordCount) || value.recordCount !== value.height ||
      !Array.isArray(value.chunks) || value.chunks.length > MAX_CHUNKS) {
    throw new Error("history archive manifest header is invalid");
  }
  let previousEnd = 0;
  const chunks = value.chunks.map((chunk, index) => {
    if (chunk?.index !== index || !Number.isSafeInteger(chunk.startHeight) ||
        !Number.isSafeInteger(chunk.endHeight) || chunk.startHeight !== previousEnd + 1 ||
        chunk.endHeight < chunk.startHeight || chunk.endHeight > value.height ||
        !Number.isSafeInteger(chunk.size) || chunk.size < 2 || chunk.size > MAX_CHUNK_BYTES ||
        !HASH.test(chunk.sha3_256 ?? "")) {
      throw new Error("history archive chunk manifest is invalid");
    }
    previousEnd = chunk.endHeight;
    return {
      endHeight: chunk.endHeight,
      index,
      sha3_256: chunk.sha3_256,
      size: chunk.size,
      startHeight: chunk.startHeight,
    };
  });
  if ((value.height === 0) !== (chunks.length === 0) ||
      (value.height > 0 && previousEnd !== value.height)) {
    throw new Error("history archive chunk coverage is incomplete");
  }
  const payload = {
    accountStateRoot: value.accountStateRoot,
    chunks,
    contentRoot: value.contentRoot,
    format: FORMAT,
    height: value.height,
    networkId: value.networkId,
    recordCount: value.recordCount,
    stateRoot: value.stateRoot,
    tipHash: value.tipHash,
  };
  if (Buffer.byteLength(canonicalJson(payload)) > MAX_MANIFEST_BYTES) {
    throw new Error("history archive manifest is too large");
  }
  return payload;
}

function createChunks(records, { maxChunkBytes, maxRecordsPerChunk }) {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1024 ||
      maxChunkBytes > MAX_CHUNK_BYTES || !Number.isSafeInteger(maxRecordsPerChunk) ||
      maxRecordsPerChunk < 1 || maxRecordsPerChunk > 10_000) {
    throw new Error("history archive chunk policy is invalid");
  }
  const groups = [];
  let current = [];
  for (const record of records) {
    const proposed = [...current, record];
    const size = Buffer.byteLength(canonicalJson(proposed));
    if (current.length > 0 && (size > maxChunkBytes || current.length >= maxRecordsPerChunk)) {
      groups.push(current);
      current = [record];
    } else {
      current = proposed;
    }
    if (Buffer.byteLength(canonicalJson(current)) > maxChunkBytes) {
      throw new Error("one history archive record exceeds the chunk limit");
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, index) => {
    const contents = Buffer.from(canonicalJson(group));
    return {
      data: contents.toString("base64"),
      manifest: {
        endHeight: group.at(-1).height,
        index,
        sha3_256: chunkDigest(contents),
        size: contents.length,
        startHeight: group[0].height,
      },
    };
  });
}

export function createSignedHistoryArchive(directory, chain, wallet, {
  maxChunkBytes = MAX_CHUNK_BYTES,
  maxRecordsPerChunk = 256,
} = {}) {
  const records = readAccountHistoryIndexRecords(directory, chain);
  const chunks = createChunks(records, { maxChunkBytes, maxRecordsPerChunk });
  const payload = manifestPayload({
    accountStateRoot: chain.blocks().at(-1).accountStateRoot,
    chunks: chunks.map(({ manifest }) => manifest),
    contentRoot: contentRoot(records),
    format: FORMAT,
    height: chain.height,
    networkId: chain.networkId,
    recordCount: records.length,
    stateRoot: chain.stateRoot,
    tipHash: chain.tipHash,
  });
  const archiveHash = hashObject(payload, "HISTORY_ARCHIVE_MANIFEST");
  return {
    chunks: chunks.map(({ data, manifest }) => ({ data, index: manifest.index })),
    manifest: { ...payload, archiveHash },
    signature: signObject({ archiveHash }, wallet, "HISTORY_ARCHIVE_APPROVAL"),
    signer: publicWallet(wallet),
  };
}

function trustedOperatorMap(trustedOperators) {
  if (!Array.isArray(trustedOperators) || trustedOperators.length < 2 ||
      trustedOperators.length > 128) throw new Error("history archive operators are invalid");
  const operators = new Map();
  for (const operator of trustedOperators) {
    if (operator?.algorithm !== SIGNATURE_ALGORITHM ||
        addressFromPublicKey(operator.publicKey ?? "") !== operator.address ||
        operators.has(operator.address)) throw new Error("history archive operator is invalid");
    operators.set(operator.address, operator);
  }
  return operators;
}

export function verifySignedHistoryArchive(archive, chain, { trustedOperators } = {}) {
  const operators = trustedOperatorMap(trustedOperators);
  const signer = archive?.signer;
  const trusted = operators.get(signer?.address);
  if (!trusted || signer.algorithm !== trusted.algorithm || signer.publicKey !== trusted.publicKey) {
    throw new Error("history archive signer is not trusted");
  }
  const { archiveHash, ...unsigned } = archive?.manifest ?? {};
  const payload = manifestPayload(unsigned);
  if (archiveHash !== hashObject(payload, "HISTORY_ARCHIVE_MANIFEST") ||
      !verifyObject({ archiveHash }, archive?.signature, signer.publicKey,
        "HISTORY_ARCHIVE_APPROVAL")) {
    throw new Error("history archive signature is invalid");
  }
  const tip = chain.blocks().at(-1);
  if (payload.networkId !== chain.networkId || payload.height !== chain.height ||
      payload.tipHash !== chain.tipHash || payload.stateRoot !== chain.stateRoot ||
      payload.accountStateRoot !== tip.accountStateRoot) {
    throw new Error("history archive does not match the verified chain checkpoint");
  }
  if (!Array.isArray(archive.chunks) || archive.chunks.length !== payload.chunks.length) {
    throw new Error("history archive chunks are incomplete");
  }
  const records = [];
  for (const [index, expected] of payload.chunks.entries()) {
    const chunk = archive.chunks[index];
    const maximumBase64Length = Math.ceil(expected.size / 3) * 4;
    if (chunk?.index !== index || typeof chunk.data !== "string" ||
        chunk.data.length !== maximumBase64Length ||
        Buffer.byteLength(chunk.data) !== maximumBase64Length) {
      throw new Error("history archive chunk is invalid");
    }
    const contents = Buffer.from(chunk.data, "base64");
    if (contents.toString("base64") !== chunk.data || contents.length !== expected.size ||
        chunkDigest(contents) !== expected.sha3_256) {
      throw new Error("history archive chunk hash is invalid");
    }
    let parsed;
    try { parsed = JSON.parse(contents.toString("utf8")); }
    catch { throw new Error("history archive chunk JSON is invalid"); }
    if (!Array.isArray(parsed) || canonicalJson(parsed) !== contents.toString("utf8") ||
        parsed.length !== expected.endHeight - expected.startHeight + 1 ||
        parsed[0]?.height !== expected.startHeight || parsed.at(-1)?.height !== expected.endHeight) {
      throw new Error("history archive chunk contents are invalid");
    }
    records.push(...parsed);
  }
  if (records.length !== payload.recordCount || contentRoot(records) !== payload.contentRoot) {
    throw new Error("history archive content root is invalid");
  }
  return {
    archiveHash,
    contentRoot: payload.contentRoot,
    manifest: { ...payload, archiveHash },
    records: verifyAccountHistoryIndexRecords(records, chain),
    signer: structuredClone(signer),
  };
}

export function selectHistoryArchiveCandidates(candidates, chain, {
  minimumSources = 2,
  trustedOperators,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 128 ||
      !Number.isSafeInteger(minimumSources) || minimumSources < 2 || minimumSources > 128) {
    throw new Error("history archive candidate selection is invalid");
  }
  const sources = new Set();
  const signers = new Set();
  const groups = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.source !== "string" || candidate.source.length < 1 ||
        Buffer.byteLength(candidate.source) > 256 || sources.has(candidate.source)) {
      throw new Error("history archive sources must be unique identifiers");
    }
    sources.add(candidate.source);
    try {
      const verified = verifySignedHistoryArchive(candidate.archive, chain, { trustedOperators });
      if (signers.has(verified.signer.address)) {
        throw new Error("history archive operators must be independent");
      }
      signers.add(verified.signer.address);
      const group = groups.get(verified.contentRoot) ?? {
        archive: candidate.archive,
        records: verified.records,
        signers: [],
        sources: [],
      };
      group.signers.push(verified.signer.address);
      group.sources.push(candidate.source);
      groups.set(verified.contentRoot, group);
    } catch (error) {
      if (error.message === "history archive operators must be independent") throw error;
      // Invalid or stale sources cannot poison agreement among valid operators.
    }
  }
  if (groups.size > 1) throw new Error("trusted history archive operators returned conflicting content");
  const selected = [...groups.values()].find(({ sources: matches }) =>
    matches.length >= minimumSources);
  if (!selected) throw new Error("history archive lacks enough independent matching sources");
  return {
    ...selected,
    matchingSources: selected.sources.length,
  };
}

export function restoreHistoryArchive(directory, candidates, chain, options = {}) {
  const selected = selectHistoryArchiveCandidates(candidates, chain, options);
  const installed = installAccountHistoryIndexRecords(directory, selected.records, chain);
  return {
    ...installed,
    matchingSources: selected.matchingSources,
    operators: [...selected.signers],
  };
}
