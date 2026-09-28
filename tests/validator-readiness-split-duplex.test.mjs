import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { once } from "node:events";
import test from "node:test";

import { createValidatorReadinessInheritedSplitDuplex, createValidatorReadinessSplitDuplex }
  from "../blockchain/validator-readiness-split-duplex.mjs";

function channel(options = {}) {
  const input = new PassThrough(); const output = new PassThrough();
  const stream = createValidatorReadinessSplitDuplex({ readable: input, writable: output },
    { label: "test split channel", maxPendingBytes: 64, writeTimeoutMs: 100, ...options });
  stream.on("error", () => {});
  return { input, output, stream };
}

test("split duplex preserves independent read and write directions", async () => {
  const { input, output, stream } = channel();
  const reads = []; const writes = [];
  stream.on("data", (chunk) => reads.push(chunk));
  output.on("data", (chunk) => writes.push(chunk));
  input.write(Buffer.from("from-child"));
  await new Promise((resolve, reject) => stream.write(Buffer.from("to-child"),
    (error) => error ? reject(error) : resolve()));
  assert.equal(Buffer.concat(reads).toString(), "from-child");
  assert.equal(Buffer.concat(writes).toString(), "to-child");
  input.end();
  await once(stream, "end");
  assert.equal(output.writableEnded, true);
});

test("one input error destroys both owned ends and the facade", async () => {
  const { input, output, stream } = channel();
  const failure = once(stream, "error");
  input.destroy(new Error("hostile input"));
  const [error] = await failure;
  assert.match(error.message, /hostile input/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.destroyed, true);
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
});

test("pending writes and single chunks are bounded fail-closed", async () => {
  const first = channel();
  const firstFailure = once(first.stream, "error");
  assert.equal(first.stream.write(Buffer.alloc(65)), false);
  assert.match((await firstFailure)[0].message, /pending writes exceed/);

  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) {
    setTimeout(callback, 50);
  } });
  const stream = createValidatorReadinessSplitDuplex({ readable: input, writable: output },
    { label: "bounded test", maxPendingBytes: 16, writeTimeoutMs: 100 });
  stream.on("error", () => {});
  assert.equal(stream.write(Buffer.alloc(12)), true);
  assert.equal(stream.write(Buffer.alloc(8)), false);
  const [error] = await once(stream, "error");
  assert.match(error.message, /pending writes exceed/);
});

test("hostile inbound chunks cannot bypass the pending-byte bound", async () => {
  const bounded = channel(); const failure = once(bounded.stream, "error");
  bounded.stream.resume();
  bounded.input.write(Buffer.alloc(65));
  assert.match((await failure)[0].message, /pending reads exceed/);
  assert.equal(bounded.stream.destroyed, true);
});

test("rejected writes settle their callback and synchronous output callbacks are safe", async () => {
  const bounded = channel(); bounded.stream.on("error", () => {});
  let callbackError;
  assert.equal(bounded.stream.write(Buffer.alloc(65), (error) => { callbackError = error; }), false);
  await new Promise((resolve) => bounded.stream.once("close", resolve));
  assert.match(callbackError?.message ?? "", /pending writes exceed/);

  const input = new PassThrough();
  const output = { destroyed: false, writableEnded: false, writableFinished: false,
    on() { return this; }, once() { return this; },
    write(_bytes, callback) { callback(); return true; },
    end(callback) { this.writableEnded = true; callback(); },
    destroy() { this.destroyed = true; } };
  const immediate = createValidatorReadinessSplitDuplex({ readable: input, writable: output },
    { label: "immediate callback", maxPendingBytes: 64, writeTimeoutMs: 100 });
  await new Promise((resolve, reject) => immediate.write(Buffer.from("ok"),
    (error) => error ? reject(error) : resolve()));
  immediate.destroy();
});

test("stalled output times out and poisons the whole channel", async () => {
  const input = new PassThrough();
  const output = new Writable({ write() {} });
  const stream = createValidatorReadinessSplitDuplex({ readable: input, writable: output },
    { label: "stalled output", maxPendingBytes: 64, writeTimeoutMs: 20 });
  stream.on("error", () => {});
  const failure = once(stream, "error");
  stream.write(Buffer.from("blocked"));
  const [error] = await failure;
  assert.match(error.message, /write timed out/);
  assert.equal(stream.destroyed, true);
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
});

test("a callback arriving after write timeout cannot settle the facade twice", async () => {
  const input = new PassThrough(); let lateCallback;
  const output = new Writable({ write(_chunk, _encoding, callback) {
    lateCallback = callback;
  } });
  const stream = createValidatorReadinessSplitDuplex({ readable: input, writable: output },
    { label: "late callback", maxPendingBytes: 64, writeTimeoutMs: 20 });
  const errors = []; stream.on("error", (error) => errors.push(error));
  let writeCallbacks = 0;
  stream.write(Buffer.from("blocked"), () => { writeCallbacks += 1; });
  await new Promise((resolve) => stream.once("close", resolve));
  assert.equal(writeCallbacks, 1);
  assert.equal(errors.length, 1);
  lateCallback?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writeCallbacks, 1);
  assert.equal(errors.length, 1);
});

test("premature readable close is fatal while clean EOF half-closes output", async () => {
  const bad = channel();
  const failure = once(bad.stream, "error");
  bad.input.destroy();
  assert.match((await failure)[0].message, /closed before EOF/);

  const clean = channel();
  clean.stream.resume();
  clean.input.end();
  await once(clean.stream, "end");
  assert.equal(clean.stream.readableEnded, true);
  assert.equal(clean.output.writableEnded, true);
});

test("invalid ends, descriptor pairs, limits, and labels are rejected", () => {
  const pass = new PassThrough();
  assert.throws(() => createValidatorReadinessSplitDuplex(
    { readable: pass, writable: pass }), /must be distinct/);
  const sameDescriptor = { destroyed: false, readableEnded: false, writableEnded: false,
    writableFinished: false, fd: 9, on() {}, once() {}, pause() {}, resume() {}, write() {}, end() {},
    destroy() {} };
  assert.throws(() => createValidatorReadinessSplitDuplex({
    readable: sameDescriptor, writable: { ...sameDescriptor },
  }), /descriptors must be distinct/);
  assert.throws(() => createValidatorReadinessSplitDuplex(
    { readable: {}, writable: pass }), /readable end is invalid/);
  assert.throws(() => createValidatorReadinessSplitDuplex(
    { readable: pass, writable: {} }), /writable end is invalid/);
  assert.throws(() => createValidatorReadinessSplitDuplex(
    { readable: new PassThrough(), writable: new PassThrough() }, { maxPendingBytes: 0 }),
  /pending-byte limit is invalid/);
  assert.throws(() => createValidatorReadinessSplitDuplex(
    { readable: new PassThrough(), writable: new PassThrough() }, { label: "bad\nlabel" }),
  /label is invalid/);
});

test("inherited numeric descriptors are consumed directly and closed by the facade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-split-fd-"));
  const inputPath = join(directory, "input"); const outputPath = join(directory, "output");
  writeFileSync(inputPath, "inherited-input");
  const readableFd = openSync(inputPath, "r"); const writableFd = openSync(outputPath, "w");
  try {
    const stream = createValidatorReadinessInheritedSplitDuplex({ readableFd, writableFd },
      { label: "inherited test", maxPendingBytes: 64, writeTimeoutMs: 100 });
    stream.on("error", () => {});
    const chunks = []; stream.on("data", (chunk) => chunks.push(chunk));
    const ended = once(stream, "end"); const closed = once(stream, "close");
    await new Promise((resolve, reject) => stream.write(Buffer.from("inherited-output"),
      (error) => error ? reject(error) : resolve()));
    await ended; await closed;
    assert.equal(Buffer.concat(chunks).toString(), "inherited-input");
    assert.equal(readFileSync(outputPath, "utf8"), "inherited-output");
  } finally {
    try { closeSync(readableFd); } catch {}
    try { closeSync(writableFd); } catch {}
    rmSync(directory, { force: true, recursive: true });
  }
});

test("split-duplex source cannot spawn, inspect environment, or access key material", () => {
  const source = readFileSync(new URL(
    "../blockchain/validator-readiness-split-duplex.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source,
    /from\s+["']node:(?:child_process|process)["']|process\.env|decryptWallet|privateKey|password|\bspawn\b/u);
});

test("portable deployment contract requires a unique non-reexported lifeline", () => {
  const documentation = readFileSync(new URL(
    "../docs/validator-readiness-process-runtime.md", import.meta.url), "utf8");
  assert.match(documentation, /unique, one-way[\s\S]*inherited by exactly one child/u);
  assert.match(documentation, /never re-export an inherited end to another child/u);
  assert.match(documentation, /cannot prove open-file-description uniqueness/u);
});
