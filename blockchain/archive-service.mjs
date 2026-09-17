import { createServer } from "node:http";

import {
  MAX_HISTORY_ARCHIVE_CHUNK_BYTES,
  MAX_HISTORY_ARCHIVE_MANIFEST_BYTES,
  restoreHistoryArchive,
  verifySignedHistoryArchive,
  verifySignedHistoryArchiveManifest,
} from "./archive-sync.mjs";

const MAX_SOURCES = 128;
const MAX_SOURCE_BYTES = 256;
const MAX_JSON_OVERHEAD = 32 * 1024;
const DEFAULT_MAX_CHUNKS = 4096;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

export function createHistoryArchiveHttpServer(archive) {
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
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { error: "method not allowed" }, { allow: "GET" }); return;
    }
    let url;
    try { url = new URL(request.url, "http://archive.invalid"); }
    catch { json(response, 400, { error: "request URL is invalid" }); return; }
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
    if (url.pathname === "/v1/history-archive/manifest") {
      json(response, 200, manifestEnvelope, {
        "cache-control": "public, max-age=60",
        etag: `"${stored.manifest.archiveHash}"`,
      });
      return;
    }
    const match = /^\/v1\/history-archive\/chunks\/(0|[1-9][0-9]*)$/.exec(url.pathname);
    if (match) {
      const index = Number(match[1]);
      const chunk = stored.chunks[index];
      if (!Number.isSafeInteger(index) || !chunk || chunk.index !== index) {
        json(response, 404, { error: "chunk not found" }); return;
      }
      json(response, 200, chunk, {
        "cache-control": "public, immutable, max-age=31536000",
        etag: `"${stored.manifest.chunks[index].sha3_256}"`,
      });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
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

export async function downloadHistoryArchive(sourceValue, chain, {
  allowInsecureLocalhost = false,
  concurrency,
  fetchImpl = globalThis.fetch,
  maxChunks,
  maxTotalBytes,
  timeoutMs,
  trustedOperators,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("history archive fetch is unavailable");
  const { source, url } = normalizedSource(sourceValue, allowInsecureLocalhost);
  const policy = downloadPolicy({ concurrency, maxChunks, maxTotalBytes, timeoutMs });
  const get = async (path, maximumBytes) => boundedJson(await fetchImpl(new URL(path, url), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(policy.timeoutMs),
  }), maximumBytes);
  const envelope = await get("v1/history-archive/manifest",
    MAX_HISTORY_ARCHIVE_MANIFEST_BYTES + MAX_JSON_OVERHEAD);
  const verified = verifySignedHistoryArchiveManifest(envelope, chain, { trustedOperators });
  const totalBytes = verified.manifest.chunks.reduce((total, chunk) => total + chunk.size, 0);
  if (verified.manifest.chunks.length > policy.maxChunks || totalBytes > policy.maxTotalBytes) {
    throw new Error("history archive exceeds the configured download budget");
  }
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

export async function restoreHistoryArchiveFromSources(directory, sources, chain, options = {}) {
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > MAX_SOURCES ||
      new Set(sources).size !== sources.length) {
    throw new Error("history archive source list is invalid");
  }
  const sourceConcurrency = options.sourceConcurrency ?? 2;
  if (!Number.isSafeInteger(sourceConcurrency) || sourceConcurrency < 1 ||
      sourceConcurrency > 8) throw new Error("history archive source concurrency is invalid");
  downloadPolicy(options);
  const candidates = [];
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const index = next;
      next += 1;
      try { candidates.push(await downloadHistoryArchive(sources[index], chain, options)); }
      catch { /* A failed source cannot count toward independent agreement. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(sourceConcurrency, sources.length) }, worker));
  return restoreHistoryArchive(directory, candidates, chain, options);
}
