import { createServer } from "node:http";

import {
  hardenHttpServer, HTTP_MAX_HEADER_BYTES, HttpIngressGuard,
  ingressErrorResponse, rejectUnexpectedRequestBody,
} from "./http-ingress.mjs";

const MAX_UI_FILES = 256;
const MAX_UI_FILE_BYTES = 16 * 1024 * 1024;
const MAX_UI_TOTAL_BYTES = 64 * 1024 * 1024;
const CSP = "default-src 'self'; base-uri 'none'; connect-src 'self' http://127.0.0.1:* http://localhost:*; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'";
const MIME = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
});
const NO_STORE = new Set(["index.html", "manifest.json", "manifest.webmanifest", "nodes.json", "sw.js"]);

function fileExtension(path) {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}

function securityHeaders(entry, immutable) {
  return {
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    "content-length": String(entry.body.length),
    "content-security-policy": CSP,
    "content-type": MIME[fileExtension(entry.path)] ?? "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    etag: `"nir-sha3-${entry.digest}"`,
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

export function walletUiSnapshotFromArtifact(artifact) {
  if (artifact?.kind !== "wallet" || !Array.isArray(artifact.entries) ||
      artifact.entries.length < 1 || artifact.entries.length > MAX_UI_FILES) {
    throw new Error("production wallet UI artifact is invalid or too large");
  }
  const files = new Map(); let total = 0;
  for (const entry of artifact.entries) {
    if (typeof entry?.path !== "string" || !entry.path.startsWith("wallet-ui/") ||
        !/^[0-9a-f]{64}$/.test(entry.sha3_256 ?? "") ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_UI_FILE_BYTES ||
        typeof entry.content !== "string" ||
        entry.content.length > Math.ceil(MAX_UI_FILE_BYTES / 3) * 4 + 4) {
      throw new Error("production wallet UI entry is invalid");
    }
    const path = entry.path.slice("wallet-ui/".length);
    if (!path || path.length > 256 || path.includes("\\") ||
        path.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))) {
      throw new Error("production wallet UI path is unsafe");
    }
    const body = Buffer.from(entry.content, "base64");
    if (body.length !== entry.size || files.has(path)) {
      throw new Error("production wallet UI bytes are invalid");
    }
    total += body.length;
    if (total > MAX_UI_TOTAL_BYTES) throw new Error("production wallet UI is too large");
    files.set(path, { body, digest: entry.sha3_256, path });
  }
  if (!files.has("index.html") || !files.has("sw.js")) {
    throw new Error("production wallet UI shell is incomplete");
  }
  return { files, totalBytes: total };
}

function route(request, snapshot) {
  rejectUnexpectedRequestBody(request);
  if (!new Set(["GET", "HEAD"]).has(request.method)) {
    const error = new Error("wallet UI method is not allowed"); error.status = 405; throw error;
  }
  if (request.headers.range !== undefined) {
    const error = new Error("wallet UI ranges are not allowed"); error.status = 416; throw error;
  }
  const raw = request.url;
  if (typeof raw !== "string" || raw.includes("#") || raw.includes("\\") || raw.includes("%")) {
    const error = new Error("wallet UI path is invalid"); error.status = 400; throw error;
  }
  const queryAt = raw.indexOf("?");
  const rawPath = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = queryAt < 0 ? "" : raw.slice(queryAt + 1);
  const relative = rawPath === "/" ? "index.html" : rawPath.slice(1);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") ||
      relative.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))) {
    const error = new Error("wallet UI path is invalid"); error.status = 400; throw error;
  }
  const entry = snapshot.files.get(relative);
  if (!entry) { const error = new Error("wallet UI asset not found"); error.status = 404; throw error; }
  let version = null;
  if (query) {
    const matched = /^v=([A-Za-z0-9._-]{1,128})$/.exec(query);
    if (!matched) { const error = new Error("wallet UI query is invalid"); error.status = 400; throw error; }
    version = matched[1];
  }
  return { entry, immutable: !NO_STORE.has(relative) && version === entry.digest };
}

export function createProductionWalletUiServer(snapshot, ingressOptions = {}) {
  if (!(snapshot?.files instanceof Map)) throw new Error("production wallet UI snapshot is invalid");
  const ingress = new HttpIngressGuard({
    burst: 128, maxActive: 32, maxActivePerAddress: 16, maxAddresses: 32,
    maxUrlBytes: 512, requestsPerMinute: 600, ...ingressOptions,
  });
  const handler = (request, response) => {
    let release;
    const finish = () => { if (release) { release(); release = null; } };
    response.once("finish", finish); response.once("close", finish);
    try {
      release = ingress.begin(request);
      const { entry, immutable } = route(request, snapshot);
      const headers = securityHeaders(entry, immutable);
      if (request.headers["if-none-match"] === headers.etag) {
        const { "content-length": ignored, ...notModifiedHeaders } = headers;
        response.writeHead(304, notModifiedHeaders); response.end(); return;
      }
      response.writeHead(200, headers);
      response.end(request.method === "HEAD" ? undefined : entry.body);
    } catch (error) {
      ingress.record(error);
      const status = Number.isInteger(error?.status) ? error.status : ingressErrorResponse(error).status;
      response.writeHead(status, {
        "cache-control": "no-store", "content-security-policy": CSP,
        "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff",
      });
      response.end(status === 404 ? "not found\n" : "request rejected\n");
    }
  };
  const server = createServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, handler);
  hardenHttpServer(server, { headersTimeoutMs: 3_000, keepAliveTimeoutMs: 1_000,
    maxConnections: 64, maxHeadersCount: 32, maxRequestsPerSocket: 50,
    requestTimeoutMs: 5_000 });
  server.ingressMetrics = () => ingress.metrics();
  return server;
}
