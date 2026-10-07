import { constants, fstatSync, lstatSync, mkdtempSync, openSync, closeSync,
  rmdirSync, unlinkSync, chmodSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, dirname } from "node:path";

import { createCanonicalIpcFrameDecoder, encodeCanonicalIpcFrame }
  from "./canonical-ipc-framing.mjs";

export const CONTROL_REQUEST_FRAME = { label: "validator control request", maximumBytes: 256 };
export const CONTROL_RESPONSE_FRAME = { label: "validator control response", maximumBytes: 64 * 1024 };

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function privateDirectory(path) {
  if (typeof process.getuid !== "function" || typeof path !== "string" ||
      path.includes("\0") || !isAbsolute(path) ||
      !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error("private validator control directory is unavailable");
  }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() ||
      before.uid !== process.getuid() || (before.mode & 0o777) !== 0o700) {
    throw new Error("validator control directory must be owned and mode 0700");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd); const after = lstatSync(path);
    if (!same(before, opened) || !same(before, after) || opened.mode !== before.mode) {
      throw new Error("validator control directory changed during validation");
    }
    return before;
  } finally { closeSync(fd); }
}

function privateSocket(path) {
  privateDirectory(dirname(path));
  const metadata = lstatSync(path);
  if (!metadata.isSocket() || metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("validator control socket must be owned and mode 0600");
  }
  return metadata;
}

/** Fresh private pathname each start: a crashed socket is never reused or unlinked. */
export async function listenOnPrivateValidatorControlSocket(server, baseDirectory) {
  if (!server || typeof server.listen !== "function") {
    throw new Error("validator control server is invalid");
  }
  const baseIdentity = privateDirectory(baseDirectory);
  const directory = mkdtempSync(join(baseDirectory, "nvc-"));
  const path = join(directory, "control.sock");
  try {
    if (!same(baseIdentity, privateDirectory(baseDirectory))) {
      throw new Error("validator control base directory changed");
    }
    const directoryIdentity = privateDirectory(directory);
    if (Buffer.byteLength(path) > 99) throw new Error("validator control socket path is too long");
    await new Promise((resolve, reject) => {
      const failed = (error) => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", ready); server.listen(path);
    });
    // The parent is private; the server handler remains disabled until validation finishes.
    chmodSync(path, 0o600);
    const identity = privateSocket(path);
    if (!same(baseIdentity, privateDirectory(baseDirectory))) {
      throw new Error("validator control base directory changed");
    }
    if (!same(directoryIdentity, privateDirectory(directory))) {
      throw new Error("validator control private directory changed");
    }
    return {
      path,
      async close() {
        const current = lstatSync(path);
        if (!same(current, identity) || !current.isSocket() ||
            !same(baseIdentity, privateDirectory(baseDirectory)) ||
            !same(directoryIdentity, privateDirectory(directory))) {
          throw new Error("validator control socket identity changed; refusing to remove foreign path");
        }
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        try {
          const after = lstatSync(path);
          if (same(after, identity) && after.isSocket()) unlinkSync(path);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        try { rmdirSync(directory); } catch { /* preserve unexpected entries */ }
      },
    };
  } catch (error) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    try { rmdirSync(directory); } catch { /* preserve unexpected entries */ }
    throw error;
  }
}

/** Same-UID local operator only; Node does not expose peer credentials for this socket. */
export function requestValidatorControl(path, operation) {
  if (operation !== "sync" && operation !== "produce") {
    return Promise.reject(new Error("validator control operation is invalid"));
  }
  try { privateSocket(path); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const decoder = createCanonicalIpcFrameDecoder(CONTROL_RESPONSE_FRAME);
    let response = null; let finished = false;
    const fail = (error) => { if (!finished) { finished = true; socket.destroy(); reject(error); } };
    socket.setTimeout(30_000, () => fail(new Error("validator control request timed out")));
    socket.on("connect", () => socket.end(encodeCanonicalIpcFrame({ operation }, CONTROL_REQUEST_FRAME)));
    socket.on("data", (chunk) => {
      try {
        const messages = decoder.push(chunk);
        if (messages.length > 1 || response !== null && messages.length > 0) {
          throw new Error("validator control response has extra frames");
        }
        if (messages.length === 1) response = messages[0];
      } catch (error) { fail(error); }
    });
    socket.on("end", () => {
      if (finished) return;
      try {
        decoder.finish();
        if (!response || typeof response.ok !== "boolean" ||
            !Number.isSafeInteger(response.status)) throw new Error("validator control response is invalid");
        finished = true; resolve(response);
      } catch (error) { fail(error); }
    });
    socket.on("error", fail);
  });
}
