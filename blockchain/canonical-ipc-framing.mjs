import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";

function options(value = {}) {
  const { label = "canonical IPC frame", maximumBytes } = value;
  if (typeof label !== "string" || label.length < 1 || label.length > 128 ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) {
    throw new Error("canonical IPC framing options are invalid");
  }
  return { label, maximumBytes };
}

export function encodeCanonicalIpcFrame(value, framingOptions) {
  const { label, maximumBytes } = options(framingOptions);
  const body = Buffer.from(canonicalJson(value), "utf8");
  if (body.length < 1 || body.length > maximumBytes) {
    throw new Error(`${label} is outside the bounded limit`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body], header.length + body.length);
}

export function createCanonicalIpcFrameDecoder(framingOptions) {
  const { label, maximumBytes } = options(framingOptions);
  let body = null; let bodyOffset = 0; let failed = false;
  const header = Buffer.alloc(4); let headerOffset = 0;
  const poison = (error) => {
    failed = true; body = null; bodyOffset = 0; headerOffset = 0;
    throw error;
  };
  return Object.freeze({
    finish() {
      if (failed) throw new Error(`${label} decoder is poisoned`);
      if (headerOffset !== 0 || body !== null) {
        poison(new Error(`${label} ended before completion`));
      }
    },
    hasPendingFrame() { return headerOffset !== 0 || body !== null; },
    push(chunk) {
      if (failed) throw new Error(`${label} decoder is poisoned`);
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        return poison(new Error(`${label} chunk is invalid`));
      }
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const messages = []; let offset = 0;
      try {
        while (offset < bytes.length) {
          if (body === null) {
            const copied = Math.min(4 - headerOffset, bytes.length - offset);
            bytes.copy(header, headerOffset, offset, offset + copied);
            headerOffset += copied; offset += copied;
            if (headerOffset < 4) continue;
            const length = header.readUInt32BE(0); headerOffset = 0;
            if (length < 1 || length > maximumBytes) {
              throw new Error(`${label} length is invalid`);
            }
            body = Buffer.allocUnsafe(length); bodyOffset = 0;
          }
          const copied = Math.min(body.length - bodyOffset, bytes.length - offset);
          bytes.copy(body, bodyOffset, offset, offset + copied);
          bodyOffset += copied; offset += copied;
          if (bodyOffset !== body.length) continue;
          let text;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); }
          catch { throw new Error(`${label} is not UTF-8`); }
          const value = parseConsensusJson(text);
          if (canonicalJson(value) !== text) {
            throw new Error(`${label} is not canonical JSON`);
          }
          messages.push(value); body = null; bodyOffset = 0;
        }
        return messages;
      } catch (error) { return poison(error); }
    },
  });
}
