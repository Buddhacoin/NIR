import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  readBoundedOneTimePasswordStream,
  readOneTimePasswordFd,
} from "../blockchain/operator-secret-input.mjs";

test("one-time password stream resolves only after EOF and returns owned bytes", async () => {
  const stream = new PassThrough();
  const source = Buffer.from("one-time-password-bytes\n");
  const result = readBoundedOneTimePasswordStream(stream, "signer vault",
    { timeoutMs: 100 });
  stream.write(source.subarray(0, 7)); stream.end(source.subarray(7));
  const password = await result;
  assert.equal(password.toString("utf8"), "one-time-password-bytes");
  assert.equal(source.toString("utf8"), "one-time-password-bytes\n");
  password.fill(0); source.fill(0);
});

test("one-time password stream rejects timeout, premature close, overflow, controls, and errors", async () => {
  const stalled = new PassThrough();
  await assert.rejects(readBoundedOneTimePasswordStream(stalled, "stalled signer",
    { timeoutMs: 10 }), /timed out/);
  assert.equal(stalled.destroyed, true);

  class DelayedNativeStream extends EventEmitter {
    destroyed = false;
    readableEnded = false;
    closed = false;
    destroy() { this.destroyed = true; }
  }
  const delayed = new DelayedNativeStream();
  await assert.rejects(readBoundedOneTimePasswordStream(delayed, "late signer",
    { timeoutMs: 10 }), /timed out/);
  // A late native read completion must be consumed rather than becoming an uncaught EventEmitter
  // error after the promise has already rejected.
  assert.equal(delayed.listenerCount("error"), 1);
  delayed.emit("error", new Error("late read completion"));
  assert.equal(delayed.listenerCount("error"), 0);

  const closed = new PassThrough();
  const closedResult = readBoundedOneTimePasswordStream(closed, "closed signer",
    { timeoutMs: 100 });
  closed.destroy();
  await assert.rejects(closedResult, /closed before EOF/);

  const oversized = new PassThrough();
  const oversizedResult = readBoundedOneTimePasswordStream(oversized, "large signer",
    { maximumBytes: 16, timeoutMs: 100 });
  oversized.end(Buffer.alloc(19, 0x61));
  await assert.rejects(oversizedResult, /too large/);

  const control = new PassThrough();
  const controlResult = readBoundedOneTimePasswordStream(control, "control signer",
    { timeoutMs: 100 });
  control.end(Buffer.from("password-with\u0000control"));
  await assert.rejects(controlResult, /invalid/);

  const failed = new PassThrough();
  const failedResult = readBoundedOneTimePasswordStream(failed, "failed signer",
    { timeoutMs: 100 });
  failed.destroy(new Error("simulated EINTR/error"));
  await assert.rejects(failedResult, /simulated EINTR\/error/);
});

test("inherited one-time password reader rejects and closes regular files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-one-time-secret-"));
  const path = join(directory, "password");
  writeFileSync(path, "owner-only-password", { mode: 0o600 });
  const descriptor = openSync(path, "r");
  try {
    await assert.rejects(readOneTimePasswordFd(descriptor, "runtime signer"),
      /not a restricted one-time channel/);
    assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
  } finally { rmSync(directory, { force: true, recursive: true }); }
});

test("inherited FIFO reader accepts fragmented bytes only after writer EOF and auto-closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-one-time-fifo-"));
  const path = join(directory, "password.fifo");
  let writer;
  try {
    execFileSync("mkfifo", [path]);
    // The temporary read/write anchor makes opening both one-way ends deterministic without
    // weakening the descriptor that the production reader actually validates and consumes.
    const anchor = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    const descriptor = openSync(path, constants.O_RDONLY);
    writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    closeSync(anchor);
    const result = readOneTimePasswordFd(descriptor, "fragmented signer",
      { timeoutMs: 1_000 });
    writeSync(writer, Buffer.from("fragmented-"));
    await new Promise((resolve) => setImmediate(resolve));
    writeSync(writer, Buffer.from("password\n"));
    closeSync(writer); writer = undefined;
    const password = await result;
    assert.equal(password.toString("utf8"), "fragmented-password");
    password.fill(0);
    assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
  } finally {
    if (writer !== undefined) closeSync(writer);
    rmSync(directory, { force: true, recursive: true });
  }
});

test("one-time reader validates labels and explicit bounds", async () => {
  await assert.rejects(async () => readBoundedOneTimePasswordStream(
    new PassThrough(), "bad\nlabel"),
    /label is invalid/);
  await assert.rejects(async () => readBoundedOneTimePasswordStream(new PassThrough(), "signer",
    { maximumBytes: 11 }), /options are invalid/);
  await assert.rejects(async () => readOneTimePasswordFd(2, "signer"),
    /descriptor is invalid/);
});

test("inherited descriptor closes when label or option validation fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nir-one-time-options-"));
  try {
    for (const [label, options] of [["bad\nlabel", {}], ["signer", { maximumBytes: 11 }]]) {
      const path = join(directory, Math.random().toString(16).slice(2));
      writeFileSync(path, "owner-only-password", { mode: 0o600 });
      const descriptor = openSync(path, "r");
      await assert.rejects(readOneTimePasswordFd(descriptor, label, options), /invalid/);
      assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
    }
  } finally { rmSync(directory, { force: true, recursive: true }); }
});
