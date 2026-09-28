import { createReadStream, createWriteStream } from "node:fs";
import { Duplex } from "node:stream";

const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
const DEFAULT_WRITE_TIMEOUT_MS = 5_000;

function positiveInteger(value, fallback, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return result;
}

function label(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("validator readiness split channel label is invalid");
  }
  return value;
}

function readable(value) {
  if (!value || typeof value.on !== "function" || typeof value.once !== "function" ||
      typeof value.pause !== "function" ||
      typeof value.resume !== "function" || typeof value.destroy !== "function" ||
      value.destroyed || value.readableEnded) {
    throw new Error("validator readiness split channel readable end is invalid");
  }
  return value;
}

function writable(value) {
  if (!value || typeof value.on !== "function" || typeof value.once !== "function" ||
      typeof value.write !== "function" ||
      typeof value.end !== "function" || typeof value.destroy !== "function" ||
      value.destroyed || value.writableEnded || value.writableFinished) {
    throw new Error("validator readiness split channel writable end is invalid");
  }
  return value;
}

class ValidatorReadinessSplitDuplex extends Duplex {
  constructor(input, output, { channelLabel, maxPendingBytes, writeTimeoutMs }) {
    super({ allowHalfOpen: false, readableHighWaterMark: maxPendingBytes,
      writableHighWaterMark: maxPendingBytes });
    this.input = input; this.output = output; this.channelLabel = channelLabel;
    this.maxPendingBytes = maxPendingBytes;
    this.writeTimeoutMs = writeTimeoutMs; this.inputEnded = false;
    this.outputFinished = false; this.started = false;

    input.pause();
    input.on("data", (chunk) => {
      if (this.destroyed) return;
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        this.destroy(new Error(`${channelLabel} received a non-binary chunk`)); return;
      }
      if (chunk.byteLength > this.maxPendingBytes ||
          chunk.byteLength + this.readableLength > this.maxPendingBytes) {
        this.destroy(new Error(`${channelLabel} pending reads exceed the bounded limit`)); return;
      }
      if (!this.push(chunk)) input.pause();
    });
    input.once("end", () => {
      this.inputEnded = true;
      if (!this.destroyed) this.push(null);
    });
    input.once("error", (error) => this.destroy(error));
    input.once("close", () => {
      if (!this.inputEnded && !this.destroyed) {
        this.destroy(new Error(`${channelLabel} readable end closed before EOF`));
      }
    });
    output.once("error", (error) => this.destroy(error));
    output.once("finish", () => { this.outputFinished = true; });
    output.once("close", () => {
      if (!this.outputFinished && !this.destroyed) {
        this.destroy(new Error(`${channelLabel} writable end closed before completion`));
      }
    });
  }

  _read() {
    if (!this.started) this.started = true;
    if (!this.inputEnded && !this.destroyed) this.input.resume();
  }

  _write(chunk, encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (bytes.length > this.maxPendingBytes) {
      callback(new Error(`${this.channelLabel} write exceeds the bounded limit`)); return;
    }
    if (this.output.destroyed || this.output.writableEnded) {
      callback(new Error(`${this.channelLabel} writable end is unavailable`)); return;
    }
    let settled = false; let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); callback(error);
    };
    timer = setTimeout(() => finish(
      new Error(`${this.channelLabel} write timed out`)), this.writeTimeoutMs);
    timer.unref?.();
    try { this.output.write(bytes, (error) => finish(error)); }
    catch (error) { finish(error); }
  }

  _final(callback) {
    if (this.output.destroyed || this.outputFinished || this.output.writableEnded) {
      callback(); return;
    }
    let settled = false; let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); callback(error);
    };
    timer = setTimeout(() => finish(
      new Error(`${this.channelLabel} close timed out`)), this.writeTimeoutMs);
    timer.unref?.();
    try { this.output.end((error) => finish(error)); }
    catch (error) { finish(error); }
  }

  _destroy(error, callback) {
    this.input.pause?.();
    if (!this.input.destroyed) this.input.destroy();
    if (!this.output.destroyed) this.output.destroy();
    callback(error);
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk?.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes < 0 ||
        bytes + this.writableLength > this.maxPendingBytes) {
      const error = new Error(`${this.channelLabel} pending writes exceed the bounded limit`);
      queueMicrotask(() => {
        try { callback?.(error); } finally { this.destroy(error); }
      });
      return false;
    }
    return super.write(chunk, encoding, callback);
  }
}

export function createValidatorReadinessSplitDuplex({ readable: input, writable: output } = {}, {
  label: channelLabel = "validator readiness split channel",
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
} = {}) {
  channelLabel = label(channelLabel);
  maxPendingBytes = positiveInteger(maxPendingBytes, DEFAULT_MAX_PENDING_BYTES,
    64 * 1024 * 1024, "validator readiness split channel pending-byte limit");
  writeTimeoutMs = positiveInteger(writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS, 300_000,
    "validator readiness split channel write timeout");
  input = readable(input); output = writable(output);
  if (input === output) throw new Error("validator readiness split channel ends must be distinct");
  if (Number.isSafeInteger(input.fd) && input.fd === output.fd) {
    throw new Error("validator readiness split channel descriptors must be distinct");
  }
  return new ValidatorReadinessSplitDuplex(input, output,
    { channelLabel, maxPendingBytes, writeTimeoutMs });
}

export function createValidatorReadinessInheritedSplitDuplex({ readableFd, writableFd } = {},
  options = {}) {
  if (!Number.isSafeInteger(readableFd) || readableFd < 3 || readableFd > 0x7fff_ffff ||
      !Number.isSafeInteger(writableFd) || writableFd < 3 || writableFd > 0x7fff_ffff ||
      readableFd === writableFd) {
    throw new Error("validator readiness inherited split channel descriptors are invalid");
  }
  const input = createReadStream(null, { autoClose: true, fd: readableFd });
  const output = createWriteStream(null, { autoClose: true, fd: writableFd });
  try {
    return createValidatorReadinessSplitDuplex({ readable: input, writable: output },
      options);
  } catch (error) {
    input.destroy(); output.destroy(); throw error;
  }
}

export const VALIDATOR_READINESS_SPLIT_DUPLEX_DEFAULT_MAX_PENDING_BYTES =
  DEFAULT_MAX_PENDING_BYTES;
export const VALIDATOR_READINESS_SPLIT_DUPLEX_DEFAULT_WRITE_TIMEOUT_MS =
  DEFAULT_WRITE_TIMEOUT_MS;
