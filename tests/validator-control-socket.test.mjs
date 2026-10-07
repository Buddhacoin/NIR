import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeCanonicalIpcFrame } from "../blockchain/canonical-ipc-framing.mjs";
import { CONTROL_REQUEST_FRAME, listenOnPrivateValidatorControlSocket,
  requestValidatorControl } from "../blockchain/validator-control-socket.mjs";
import { createValidatorControlServer, createValidatorHttpServer }
  from "../blockchain/validator-service.mjs";

async function raw(path, bytes) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("raw control request timed out")); });
    socket.on("connect", () => socket.end(bytes));
    socket.resume();
    socket.on("close", resolve);
    socket.on("error", resolve);
  });
}

test("control socket requires an owned 0700 base and never reuses an existing path", async () => {
  const base = mkdtempSync(join(tmpdir(), "nvc-test-"));
  let existing;
  try {
    chmodSync(base, 0o755);
    await assert.rejects(listenOnPrivateValidatorControlSocket(createNetServer(), base), /0700/);
    chmodSync(base, 0o700);
    const link = `${base}-link`;
    symlinkSync(base, link);
    try {
      await assert.rejects(listenOnPrivateValidatorControlSocket(createNetServer(), link), /0700/);
    } finally { rmSync(link); }
    writeFileSync(join(base, "control.sock"), "foreign", { mode: 0o600 });
    existing = createNetServer();
    await new Promise((resolve) => existing.listen(join(base, "existing.sock"), resolve));
    const control = createValidatorControlServer({}, { peerUrls: () => [] });
    const channel = await listenOnPrivateValidatorControlSocket(control.server, base);
    control.enable();
    assert.equal(readFileSync(join(base, "control.sock"), "utf8"), "foreign");
    assert.notEqual(channel.path, join(base, "existing.sock"));
    await channel.close();
  } finally {
    if (existing?.listening) await new Promise((resolve) => existing.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});

test("ceremony HTTP refuses both operator routes before consulting any peers", async () => {
  let consulted = 0;
  const server = createValidatorHttpServer({ ceremonyMode: true }, {
    peerUrls: () => { consulted += 1; return []; },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/v1/sync", "/v1/sync?retry=1", "/v1/blocks/produce",
      "/v1/blocks/produce?retry=1"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: "not even valid JSON",
      });
      assert.equal(response.status, 404, path);
    }
    assert.equal(consulted, 0);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test("oversize, truncated, and extra control frames cause no operation", async () => {
  const base = mkdtempSync(join(tmpdir(), "nvc-test-"));
  let channel;
  let consulted = 0;
  const control = createValidatorControlServer({}, { peerUrls: () => { consulted += 1; return []; } });
  try {
    channel = await listenOnPrivateValidatorControlSocket(control.server, base);
    control.enable();
    await raw(channel.path, Buffer.from([0, 0, 1, 1])); // Declares 257 > 256.
    await raw(channel.path, Buffer.from([0, 0, 0, 20, 0x7b])); // Truncated frame.
    await raw(channel.path, encodeCanonicalIpcFrame({ operation: "shutdown" }, CONTROL_REQUEST_FRAME));
    await raw(channel.path, encodeCanonicalIpcFrame({ operation: "sync", extra: true }, CONTROL_REQUEST_FRAME));
    await raw(channel.path, Buffer.concat([
      encodeCanonicalIpcFrame({ operation: "sync" }, CONTROL_REQUEST_FRAME),
      encodeCanonicalIpcFrame({ operation: "produce" }, CONTROL_REQUEST_FRAME),
    ]));
    assert.equal(consulted, 0);
    await assert.rejects(requestValidatorControl(channel.path, "other"), /operation is invalid/);
  } finally {
    await channel?.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("a restart chooses a new socket path and leaves a crashed stale path untouched", async () => {
  const base = mkdtempSync(join(tmpdir(), "nvc-test-"));
  const first = createValidatorControlServer({}, { peerUrls: () => [] });
  const second = createValidatorControlServer({}, { peerUrls: () => [] });
  try {
    const old = await listenOnPrivateValidatorControlSocket(first.server, base);
    await new Promise((resolve) => first.server.close(resolve));
    writeFileSync(old.path, "stale", { mode: 0o600 });
    const current = await listenOnPrivateValidatorControlSocket(second.server, base);
    assert.notEqual(current.path, old.path);
    assert.equal(readFileSync(old.path, "utf8"), "stale");
    await current.close();
  } finally {
    if (first.server.listening) await new Promise((resolve) => first.server.close(resolve));
    if (second.server.listening) await new Promise((resolve) => second.server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});

test("identity-safe shutdown refuses to unlink a replaced control path", async () => {
  const base = mkdtempSync(join(tmpdir(), "nvc-test-"));
  const control = createValidatorControlServer({}, { peerUrls: () => [] });
  const channel = await listenOnPrivateValidatorControlSocket(control.server, base);
  const old = `${channel.path}.old`;
  const held = `${channel.path}.foreign`;
  try {
    control.enable();
    renameSync(channel.path, old);
    writeFileSync(channel.path, "foreign", { mode: 0o600 });
    await assert.rejects(requestValidatorControl(channel.path, "sync"), /socket/);
    await assert.rejects(channel.close(), /identity changed/);
    assert.equal(readFileSync(channel.path, "utf8"), "foreign");
    renameSync(channel.path, held);
    await new Promise((resolve) => control.server.close(resolve));
    renameSync(held, channel.path);
    assert.equal(readFileSync(channel.path, "utf8"), "foreign");
  } finally {
    if (control.server.listening) await new Promise((resolve) => control.server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  }
});
