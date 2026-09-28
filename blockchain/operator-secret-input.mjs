import { closeSync, createReadStream, fstatSync, readSync } from "node:fs";
import process from "node:process";

const MAX_PASSWORD_BYTES = 1_024;
const DEFAULT_SECRET_TIMEOUT_MS = 5_000;

function descriptorAvailable(descriptor) {
  try { fstatSync(descriptor); return true; }
  catch (error) {
    if (error?.code === "EBADF") return false;
    throw error;
  }
}

function trimTerminator(value) {
  let end = value.length;
  if (end > 0 && value[end - 1] === 10) end -= 1;
  if (end > 0 && value[end - 1] === 13) end -= 1;
  return Buffer.from(value.subarray(0, end));
}

function closeDescriptor(descriptor) {
  try { closeSync(descriptor); }
  catch (error) { if (error?.code !== "EBADF") throw error; }
}

function secretOptions(value = {}) {
  const { maximumBytes = MAX_PASSWORD_BYTES, timeoutMs = DEFAULT_SECRET_TIMEOUT_MS } = value;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 12 ||
      maximumBytes > MAX_PASSWORD_BYTES || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("one-time password reader options are invalid");
  }
  return { maximumBytes, timeoutMs };
}

function secretLabel(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("one-time password label is invalid");
  }
  return value;
}

function validSecretBytes(value, maximumBytes) {
  if (value.length < 12 || value.length > maximumBytes) return false;
  for (const byte of value) {
    if (byte <= 0x1f || byte === 0x7f) return false;
  }
  return true;
}

/**
 * Consume one password from a byte stream. Resolution requires EOF; timeout, premature close,
 * embedded controls, excess bytes, or any stream error clears every owned copy before rejection.
 */
export function readBoundedOneTimePasswordStream(stream, label, options = {}) {
  label = secretLabel(label);
  const { maximumBytes, timeoutMs } = secretOptions(options);
  if (!stream || typeof stream.on !== "function" || typeof stream.once !== "function" ||
      typeof stream.destroy !== "function" || stream.destroyed || stream.readableEnded) {
    return Promise.reject(new Error(`${label} password stream is invalid`));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let ended = false; let settled = false;
    const clear = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData); stream.off("end", onEnd);
      stream.off("error", onError); stream.off("close", onClose);
      if (!stream.closed) {
        // A filesystem callback may report one final error after a timeout/destroy race. Guard it
        // until close, then remove the guard so an externally retained stream leaks no listener.
        stream.once("error", onLateError); stream.once("close", onLateClose);
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true; cleanup(); clear();
      if (!stream.destroyed) stream.destroy();
      reject(error instanceof Error ? error : new Error(`${label} password stream failed`));
    };
    const succeed = () => {
      if (settled) return;
      const joined = Buffer.concat(chunks, total);
      clear();
      const password = trimTerminator(joined); joined.fill(0);
      if (!validSecretBytes(password, maximumBytes)) {
        password.fill(0); fail(new Error(`${label} password from inherited descriptor is invalid`));
        return;
      }
      settled = true; cleanup();
      if (!stream.destroyed) stream.destroy();
      resolve(password);
    };
    const onData = (value) => {
      if (settled) return;
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        fail(new Error(`${label} password stream returned non-binary data`)); return;
      }
      const copy = Buffer.from(value); total += copy.length;
      if (total > maximumBytes + 2) {
        copy.fill(0); fail(new Error(`${label} password is too large`)); return;
      }
      chunks.push(copy);
    };
    const onEnd = () => { ended = true; succeed(); };
    const onError = (error) => fail(error);
    const onLateError = () => {};
    const onLateClose = () => stream.off("error", onLateError);
    const onClose = () => {
      if (!ended && !settled) fail(new Error(`${label} password stream closed before EOF`));
    };
    const timer = setTimeout(() => fail(new Error(`${label} password read timed out`)), timeoutMs);
    timer.unref?.();
    stream.on("data", onData); stream.once("end", onEnd);
    stream.once("error", onError); stream.once("close", onClose);
  });
}

/** Read and auto-close one inherited FIFO/socket password descriptor. Regular files are refused. */
export async function readOneTimePasswordFd(descriptor, label, options = {}) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1_024) {
    throw new Error("one-time password descriptor is invalid");
  }
  try {
    label = secretLabel(label); secretOptions(options);
  } catch (error) {
    closeDescriptor(descriptor);
    throw error;
  }
  let metadata;
  try { metadata = fstatSync(descriptor); }
  catch (error) { closeDescriptor(descriptor); throw error; }
  if ((!metadata.isFIFO() && !metadata.isSocket()) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    closeDescriptor(descriptor);
    throw new Error(`${label} password descriptor is not a restricted one-time channel`);
  }
  let stream;
  try {
    stream = createReadStream(null,
      { autoClose: false, fd: descriptor, highWaterMark: 256 });
  } catch (error) {
    closeDescriptor(descriptor); throw error;
  }
  try { return await readBoundedOneTimePasswordStream(stream, label, options); }
  finally { if (!stream.destroyed) stream.destroy(); closeDescriptor(descriptor); }
}

export function readRestrictedPasswordFd(descriptor, label) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1_024) {
    throw new Error(`${label} password descriptor is invalid`);
  }
  const metadata = fstatSync(descriptor);
  if ((!metadata.isFIFO() && !metadata.isSocket() && !metadata.isFile()) ||
      (metadata.isFile() && (metadata.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`${label} password descriptor is not restricted to this owner`);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(256);
    const length = readSync(descriptor, chunk, 0, chunk.length, null);
    if (length === 0) break;
    total += length;
    if (total > MAX_PASSWORD_BYTES + 2) {
      chunk.fill(0);
      for (const prior of chunks) prior.fill(0);
      throw new Error(`${label} password is too large`);
    }
    chunks.push(chunk.subarray(0, length));
  }
  const joined = Buffer.concat(chunks, total);
  for (const chunk of chunks) chunk.fill(0);
  const password = trimTerminator(joined);
  joined.fill(0);
  if (password.length < 12 || password.length > MAX_PASSWORD_BYTES ||
      password.includes(0) || password.includes(10) || password.includes(13)) {
    password.fill(0);
    throw new Error(`${label} password from inherited descriptor is invalid`);
  }
  return password;
}

function readInteractivePassword(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("ceremony vault passwords require an interactive TTY or inherited FDs 3 and 4"));
      return;
    }
    process.stdout.write(prompt);
    const bytes = [];
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(Buffer.from(bytes));
      bytes.fill(0);
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) bytes.pop();
        else if (byte >= 32 && bytes.length < MAX_PASSWORD_BYTES) bytes.push(byte);
        else if (bytes.length >= MAX_PASSWORD_BYTES) return finish(new Error("password is too large"));
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export async function readCeremonyPasswordBuffers() {
  const validatorFd = descriptorAvailable(3);
  const transportFd = descriptorAvailable(4);
  if (validatorFd !== transportFd) {
    throw new Error("ceremony startup requires both inherited password FDs 3 and 4");
  }
  if (validatorFd) {
    const consume = (descriptor, label) => {
      try { return readRestrictedPasswordFd(descriptor, label); }
      finally { closeSync(descriptor); }
    };
    const validatorPasswordBuffer = consume(3, "validator vault");
    try {
      return {
        transportPasswordBuffer: consume(4, "transport vault"),
        validatorPasswordBuffer,
      };
    } catch (error) {
      validatorPasswordBuffer.fill(0);
      throw error;
    }
  }
  const validatorPasswordBuffer = await readInteractivePassword("Validator vault password: ");
  try {
    return {
      transportPasswordBuffer: await readInteractivePassword("Transport vault password: "),
      validatorPasswordBuffer,
    };
  } catch (error) {
    validatorPasswordBuffer.fill(0);
    throw error;
  }
}
