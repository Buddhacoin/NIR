#!/usr/bin/env node
import { createServer } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hardenHttpServer, HTTP_MAX_HEADER_BYTES, HttpIngressGuard,
  ingressErrorResponse, rejectUnexpectedRequestBody,
} from "./http-ingress.mjs";
import { normalizeNodePolicy } from "../wallet-ui/node-selection.js";

const HOST = "127.0.0.1";
const PORT = 8765;
const UI_ROOT = fileURLToPath(new URL("../wallet-ui/", import.meta.url));
const DEMO_POLICY = fileURLToPath(new URL("../demo/wallet-nodes.local-demo.json", import.meta.url));
const UI_FILES = Object.freeze([
  "address-book.js", "app.js", "extension-background.js", "index.html",
  "manifest.json", "manifest.webmanifest", "nir-coin-icon.png", "nir-coin-icon.svg",
  "node-selection.js", "nodes.json", "offline-signing.js", "qr.js", "style.css",
  "submission-status.js", "sw.js", "transaction-decoder.js",
]);
const MIME = Object.freeze({
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
});
const CSP = "default-src 'self'; base-uri 'none'; connect-src 'self' http://127.0.0.1:*; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'";

function regularBytes(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
    throw new Error("wallet preview asset is not a bounded regular file");
  }
  return readFileSync(path);
}

function previewAssets() {
  const files = new Map(UI_FILES.map((name) => [name, regularBytes(join(UI_ROOT, name))]));
  const demo = regularBytes(DEMO_POLICY);
  const policy = normalizeNodePolicy(JSON.parse(demo.toString("utf8")));
  if (policy.nodes.length !== 1 || policy.nodes[0] !== "http://127.0.0.1:8787" ||
      policy.minimumAgreement !== 1 || policy.submissionOrigin !== policy.nodes[0]) {
    throw new Error("wallet preview demo policy is not the fixed valueless loopback node");
  }
  files.set("nodes.local-demo.json", demo);
  return files;
}

function route(request, files) {
  if (request.method !== "GET" && request.method !== "HEAD") return { status: 405 };
  rejectUnexpectedRequestBody(request);
  if (request.headers.range !== undefined) return { status: 416 };
  const raw = request.url;
  if (typeof raw !== "string" || raw.length > 512 || raw.includes("%") ||
      raw.includes("\\") || raw.includes("#") || raw.startsWith("//")) return { status: 400 };
  const [pathname, query = ""] = raw.split("?");
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!pathname.startsWith("/") || !files.has(name) || raw.split("?").length > 2) {
    return { status: 404 };
  }
  if (query && !(name === "index.html" &&
      ["local-demo=1", "local-demo=1&local-app=1"].includes(query)) &&
      !/^v=[A-Za-z0-9._-]{1,128}$/.test(query)) return { status: 400 };
  const body = files.get(name);
  const extension = name.slice(name.lastIndexOf("."));
  return { status: 200, body, mime: MIME[extension] ?? "application/octet-stream" };
}

export function createWalletPreviewServer() {
  const files = previewAssets();
  const ingress = new HttpIngressGuard({ burst: 64, maxActive: 8,
    maxActivePerAddress: 8, maxUrlBytes: 512, requestsPerMinute: 600 });
  const server = createServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES }, (request, response) => {
    let release;
    try {
      release = ingress.begin(request);
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== HOST ||
          request.headers.host !== `${HOST}:${address.port}`) {
        response.writeHead(421); response.end(); return;
      }
      if (request.headers.origin !== undefined &&
          request.headers.origin !== `http://${HOST}:${address.port}`) {
        response.writeHead(403); response.end(); return;
      }
      const result = route(request, files);
      response.writeHead(result.status, {
        "cache-control": "no-store", "content-security-policy": CSP,
        "content-type": result.mime ?? "text/plain; charset=utf-8",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      response.end(result.status === 200 && request.method !== "HEAD" ? result.body : undefined);
    } catch (error) {
      ingress.record(error);
      response.writeHead(ingressErrorResponse(error).status, {
        "cache-control": "no-store", "content-security-policy": CSP,
        "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff",
      });
      response.end("request rejected\n");
    } finally { release?.(); }
  });
  hardenHttpServer(server, { maxConnections: 32, maxHeadersCount: 32,
    headersTimeoutMs: 3_000, requestTimeoutMs: 5_000, keepAliveTimeoutMs: 1_000,
    maxRequestsPerSocket: 50 });
  server.on("checkContinue", (_request, response) => {
    response.writeHead(417, { connection: "close" }); response.end();
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) {
    console.error("Wallet preview accepts no listener arguments; use http://127.0.0.1:8765/ only.");
    process.exitCode = 1;
  } else {
    try {
      const server = createWalletPreviewServer();
      server.once("error", (error) => {
        console.error(`Wallet preview could not bind loopback: ${error.message}`);
        process.exitCode = 1;
      });
      server.listen(PORT, HOST, () => {
        console.log(`Valueless NIR wallet preview: http://${HOST}:${PORT}/?local-demo=1`);
      });
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => server.gracefulShutdown().then(() => process.exit(0)));
      }
    } catch (error) {
      console.error(`Wallet preview unavailable: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
