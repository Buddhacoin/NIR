import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  MAX_HISTORY_ARCHIVE_CHUNK_BYTES,
  MAX_HISTORY_ARCHIVE_MANIFEST_BYTES,
  verifyHistoryArchiveChunk,
  verifySignedHistoryArchive,
  verifySignedHistoryArchiveManifest,
} from "./archive-sync.mjs";
import { installAccountHistoryIndexRecordIterable } from "./account-history-index.mjs";
import {
  consensusArrayEnvelopeHeader,
  consensusValueBytes,
} from "./consensus-codec.mjs";
import { canonicalJson } from "./crypto.mjs";
import {
  hardenHttpServer,
  HTTP_MAX_HEADER_BYTES,
  HttpIngressGuard,
  ingressErrorResponse,
  rejectUnexpectedRequestBody,
} from "./http-ingress.mjs";

const MAX_SOURCES = 128;
const MAX_SOURCE_BYTES = 256;
const MAX_JSON_OVERHEAD = 32 * 1024;
const DEFAULT_MAX_CHUNKS = 4096;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function json(response, status, value, headers = {}, maximumBytes = 128 * 1024) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maximumBytes) throw new Error("archive response exceeds its bound");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

async function streamChunk(response, chunk, manifest) {
  const prefix = `{"data":"`;
  const suffix = `","index":${chunk.index}}`;
  const length = Buffer.byteLength(prefix) + Buffer.byteLength(chunk.data) + Buffer.byteLength(suffix);
  const maximum = Math.ceil(manifest.size / 3) * 4 + 128;
  if (length > maximum) throw new Error("archive chunk response exceeds its bound");
  response.writeHead(200, {
    "accept-ranges": "none",
    "cache-control": "public, immutable, max-age=31536000",
    "content-length": length,
    "content-type": "application/json; charset=utf-8",
    etag: `"${manifest.sha3_256}"`,
    "x-content-type-options": "nosniff",
  });
  response.write(prefix);
  for (let offset = 0; offset < chunk.data.length; offset += 64 * 1024) {
    if (!response.write(chunk.data.slice(offset, offset + 64 * 1024))) {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          response.off("drain", drained);
          response.off("close", closed);
        };
        const drained = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error("archive download was aborted")); };
        response.once("drain", drained);
        response.once("close", closed);
      });
    }
  }
  response.end(suffix);
}

export function createHistoryArchiveHttpServer(archive, suppliedOptions = {}) {
  const options = suppliedOptions && typeof suppliedOptions === "object" &&
    !Array.isArray(suppliedOptions) ? suppliedOptions : {};
  if (!archive?.manifest || !archive?.signer || !archive?.signature ||
      !Array.isArray(archive.chunks) ||
      archive.chunks.length !== archive.manifest.chunks?.length) {
    throw new Error("history archive service input is invalid");
  }
  const stored = structuredClone(archive);
  const manifestEnvelope = {
    manifest: stored.manifest,
    signature: stored.signature,
    signer: stored.signer,
  };
  if (Buffer.byteLength(JSON.stringify(manifestEnvelope)) >
      MAX_HISTORY_ARCHIVE_MANIFEST_BYTES + 64 * 1024) {
    throw new Error("history archive manifest envelope is too large");
  }
  stored.chunks.forEach((chunk, index) => {
    const expected = stored.manifest.chunks[index];
    const maximumBase64Length = Math.ceil((expected?.size ?? 0) / 3) * 4;
    if (chunk?.index !== index || typeof chunk.data !== "string" ||
        !Number.isSafeInteger(expected?.size) || expected.size < 0 ||
        expected.size > MAX_HISTORY_ARCHIVE_CHUNK_BYTES ||
        chunk.data.length !== maximumBase64Length ||
        Buffer.byteLength(chunk.data) !== maximumBase64Length) {
      throw new Error("history archive response chunk is outside service bounds");
    }
  });
  const httpIngressOptions = {
    burst: 128,
    maxActive: 32,
    maxActivePerAddress: 8,
    maxConnections: 64,
    requestsPerMinute: 240,
    ...(options.httpIngress ?? {}),
  };
  const httpIngress = new HttpIngressGuard(httpIngressOptions);
  const server = createServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, async (request, response) => {
    let release = null;
    try {
      release = httpIngress.begin(request);
      response.once("finish", release);
      response.once("close", release);
      rejectUnexpectedRequestBody(request);
      if (request.method !== "GET") {
        json(response, 405, { error: "method not allowed" }, { allow: "GET" }); return;
      }
      if (request.headers.range !== undefined) {
        json(response, 416, { error: "range requests are not supported" }, {
          "accept-ranges": "none",
        });
        return;
      }
      const url = new URL(request.url, "http://archive.invalid");
      if (url.search || url.hash) {
        json(response, 400, { error: "query parameters are not supported" }); return;
      }
      if (url.pathname === "/health") {
        json(response, 200, {
          archiveHash: stored.manifest.archiveHash,
          height: stored.manifest.height,
          networkId: stored.manifest.networkId,
          operator: stored.signer.address,
        });
        return;
      }
      if (url.pathname === "/metrics") {
        json(response, 200, { httpIngress: httpIngress.metrics() }); return;
      }
      if (url.pathname === "/v1/history-archive/manifest") {
        json(response, 200, manifestEnvelope, {
          "cache-control": "public, max-age=60",
          etag: `"${stored.manifest.archiveHash}"`,
        }, MAX_HISTORY_ARCHIVE_MANIFEST_BYTES + 64 * 1024);
        return;
      }
      const match = /^\/v1\/history-archive\/chunks\/(0|[1-9][0-9]*)$/.exec(url.pathname);
      if (match) {
        const index = Number(match[1]);
        const chunk = stored.chunks[index];
        if (!Number.isSafeInteger(index) || !chunk || chunk.index !== index) {
          json(response, 404, { error: "chunk not found" }); return;
        }
        await streamChunk(response, chunk, stored.manifest.chunks[index]);
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      httpIngress.record(error);
      if (!response.headersSent) {
        const rejected = ingressErrorResponse(error);
        json(response, rejected.status, { error: rejected.message });
      } else response.destroy();
    }
  });
  server.httpIngressMetrics = () => httpIngress.metrics();
  return hardenHttpServer(server, httpIngressOptions);
}

function normalizedSource(value, allowInsecureLocalhost) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("history archive source URL is invalid"); }
  const localhost = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(allowInsecureLocalhost && localhost &&
        url.protocol === "http:"))) {
    throw new Error("history archive source must use HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  const source = url.href.replace(/\/$/, "");
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw new Error("history archive source URL is too long");
  }
  return { source, url };
}

async function boundedJson(response, maximumBytes) {
  if (!response.ok) throw new Error(`history archive HTTP status ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("history archive response is too large");
  }
  if (!response.body) throw new Error("history archive response has no body");
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("history archive response is too large");
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(parts, length).toString("utf8")); }
  catch { throw new Error("history archive response JSON is invalid"); }
}

function downloadPolicy({
  concurrency = 4,
  maxChunks = DEFAULT_MAX_CHUNKS,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  timeoutMs = 15_000,
} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
      !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 100_000 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1024 ||
      maxTotalBytes > 4 * 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("history archive download policy is invalid");
  }
  return { concurrency, maxChunks, maxTotalBytes, timeoutMs };
}

function remoteSource(sourceValue, options = {}) {
  if (typeof options.fetchImpl !== "function" && options.fetchImpl !== undefined) {
    throw new Error("history archive fetch is unavailable");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("history archive fetch is unavailable");
  const { source, url } = normalizedSource(sourceValue, options.allowInsecureLocalhost ?? false);
  const policy = downloadPolicy(options);
  const get = async (path, maximumBytes) => boundedJson(await fetchImpl(new URL(path, url), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(policy.timeoutMs),
  }), maximumBytes);
  return { get, policy, source };
}

async function fetchVerifiedManifest(sourceValue, chain, options) {
  const remote = remoteSource(sourceValue, options);
  const envelope = await remote.get("v1/history-archive/manifest",
    MAX_HISTORY_ARCHIVE_MANIFEST_BYTES + MAX_JSON_OVERHEAD);
  const verified = verifySignedHistoryArchiveManifest(envelope, chain, options);
  const totalBytes = verified.manifest.chunks.reduce((total, chunk) => total + chunk.size, 0);
  if (verified.manifest.chunks.length > remote.policy.maxChunks ||
      totalBytes > remote.policy.maxTotalBytes) {
    throw new Error("history archive exceeds the configured download budget");
  }
  return { ...remote, envelope, verified };
}

export async function downloadHistoryArchive(sourceValue, chain, {
  allowInsecureLocalhost = false,
  concurrency,
  fetchImpl = globalThis.fetch,
  maxChunks,
  maxTotalBytes,
  timeoutMs,
  trustedOperators,
} = {}) {
  const { envelope, get, policy, source, verified } = await fetchVerifiedManifest(
    sourceValue, chain, {
      allowInsecureLocalhost, concurrency, fetchImpl, maxChunks, maxTotalBytes,
      timeoutMs, trustedOperators,
    },
  );
  const chunks = new Array(verified.manifest.chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next;
      next += 1;
      const expected = verified.manifest.chunks[index];
      const base64Bytes = Math.ceil(expected.size / 3) * 4;
      chunks[index] = await get(`v1/history-archive/chunks/${index}`,
        Math.min(base64Bytes + MAX_JSON_OVERHEAD,
          Math.ceil(MAX_HISTORY_ARCHIVE_CHUNK_BYTES / 3) * 4 + MAX_JSON_OVERHEAD));
    }
  };
  await Promise.all(Array.from({ length: Math.min(policy.concurrency, chunks.length) }, worker));
  const archive = { ...envelope, chunks };
  verifySignedHistoryArchive(archive, chain, { trustedOperators });
  return { archive, source };
}

async function selectRemoteManifests(sources, chain, options) {
  const sourceConcurrency = options.sourceConcurrency ?? 2;
  const minimumSources = options.minimumSources ?? 2;
  if (!Number.isSafeInteger(sourceConcurrency) || sourceConcurrency < 1 ||
      sourceConcurrency > 8 || !Number.isSafeInteger(minimumSources) ||
      minimumSources < 2 || minimumSources > MAX_SOURCES) {
    throw new Error("history archive source policy is invalid");
  }
  downloadPolicy(options);
  const providers = [];
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const index = next;
      next += 1;
      try {
        providers.push({
          ...await fetchVerifiedManifest(sources[index], chain, options),
          sourceIndex: index,
        });
      } catch { /* An invalid source cannot count toward agreement. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(sourceConcurrency, sources.length) }, worker));
  providers.sort((left, right) => left.sourceIndex - right.sourceIndex);
  const signers = new Set();
  const groups = new Map();
  for (const provider of providers) {
    const signer = provider.verified.signer.address;
    if (signers.has(signer)) throw new Error("history archive operators must be independent");
    signers.add(signer);
    const root = provider.verified.contentRoot;
    const group = groups.get(root) ?? [];
    group.push(provider);
    groups.set(root, group);
  }
  if (groups.size > 1) {
    throw new Error("trusted history archive operators returned conflicting content");
  }
  const selected = [...groups.values()].find((group) => group.length >= minimumSources);
  if (!selected) throw new Error("history archive lacks enough independent matching sources");
  return selected;
}

async function downloadChunksToDirectory(provider, directory) {
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const expectedChunks = provider.verified.manifest.chunks;
  let next = 0;
  const worker = async () => {
    while (next < expectedChunks.length) {
      const index = next;
      next += 1;
      const expected = expectedChunks[index];
      const base64Bytes = Math.ceil(expected.size / 3) * 4;
      const chunk = await provider.get(`v1/history-archive/chunks/${index}`,
        base64Bytes + MAX_JSON_OVERHEAD);
      const records = verifyHistoryArchiveChunk(chunk, expected, index);
      writeFileSync(join(directory, `${String(index).padStart(8, "0")}.json`),
        canonicalJson(records), { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  };
  await Promise.all(Array.from({
    length: Math.min(provider.policy.concurrency, expectedChunks.length),
  }, worker));
}

function *recordsFromDownloadedChunks(directory, verified) {
  const content = createHash("sha3-256").update(consensusArrayEnvelopeHeader(
    "HISTORY_ARCHIVE_CONTENT", verified.manifest.recordCount,
  ));
  let count = 0;
  for (const [index, expected] of verified.manifest.chunks.entries()) {
    const path = join(directory, `${String(index).padStart(8, "0")}.json`);
    let descriptor;
    let raw;
    try {
      descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.size !== expected.size) {
        throw new Error("downloaded history archive chunk size is invalid");
      }
      raw = readFileSync(descriptor);
      if (raw.length !== expected.size) {
        throw new Error("downloaded history archive chunk size is invalid");
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const records = verifyHistoryArchiveChunk({
      data: raw.toString("base64"), index,
    }, expected, index);
    for (const record of records) {
      content.update(consensusValueBytes({
        blockHash: record.blockHash,
        height: record.height,
        indexHash: record.indexHash,
      }));
      count += 1;
      yield record;
    }
  }
  if (count !== verified.manifest.recordCount ||
      content.digest("hex") !== verified.contentRoot) {
    throw new Error("downloaded history archive content root is invalid");
  }
}

export async function restoreHistoryArchiveFromSources(directory, sources, chain, options = {}) {
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > MAX_SOURCES ||
      new Set(sources).size !== sources.length) {
    throw new Error("history archive source list is invalid");
  }
  const providers = await selectRemoteManifests(sources, chain, options);
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("history archive destination is unsafe");
  }
  const temporary = mkdtempSync(join(root, ".history-archive-download-"));
  let lastError;
  try {
    for (const [attempt, provider] of providers.entries()) {
      const chunks = join(temporary, `source-${attempt}`);
      try {
        await downloadChunksToDirectory(provider, chunks);
        const installed = installAccountHistoryIndexRecordIterable(
          root, recordsFromDownloadedChunks(chunks, provider.verified), chain,
        );
        return {
          ...installed,
          matchingSources: providers.length,
          operators: providers.map(({ verified }) => verified.signer.address),
        };
      } catch (error) {
        lastError = error;
        rmSync(chunks, { recursive: true, force: true });
      }
    }
    throw lastError ?? new Error("history archive download failed");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
