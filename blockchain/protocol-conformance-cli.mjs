#!/usr/bin/env node
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import {
  buildProtocolConformanceManifest, serializeProtocolConformanceManifest,
  verifyProtocolConformanceManifest,
} from "./protocol-conformance.mjs";

function readCanonical(pathValue) {
  if (!constants.O_NOFOLLOW) throw new Error("secure conformance reads are unavailable");
  const path = resolve(pathValue); let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > 8 * 1024 * 1024) {
      throw new Error("protocol conformance manifest file is unsafe");
    }
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("protocol conformance manifest changed during read");
    }
    const text = bytes.toString("utf8");
    const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("protocol conformance manifest is not canonical JSON");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function replaceFile(pathValue, contents) {
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error("secure conformance writes are unavailable");
  }
  const path = resolve(pathValue); const temporary = `${path}.new-${process.pid}`;
  let descriptor; let parent;
  try {
    parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, contents); fchmodSync(descriptor, 0o600); fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path); fsyncSync(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent !== undefined) closeSync(parent);
  }
}

const [command, rootArg = ".", manifestArg = "protocol/conformance-manifest.json"] = process.argv.slice(2);
try {
  const root = resolve(rootArg); const manifestPath = resolve(root, manifestArg);
  if (command === "generate") {
    const manifest = buildProtocolConformanceManifest(root);
    replaceFile(manifestPath, serializeProtocolConformanceManifest(manifest));
    console.log(`Protocol conformance manifest ${manifest.manifestHash} generated.`);
  } else if (command === "verify") {
    const manifest = verifyProtocolConformanceManifest(readCanonical(manifestPath), root);
    console.log(`Protocol conformance manifest ${manifest.manifestHash} verified.`);
  } else {
    throw new Error("usage: protocol-conformance <generate|verify> [repository-root] [manifest-relative-path]");
  }
} catch (error) {
  console.error(`Protocol conformance failed: ${error.message}`); process.exitCode = 1;
}
