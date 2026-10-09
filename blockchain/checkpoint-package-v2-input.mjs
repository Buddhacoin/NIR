import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";

/** Read exactly one bounded canonical file from a pinned regular-file descriptor. */
export function readCanonicalCheckpointV2Input(path, label, maximumBytes = 4 * 1024 * 1024, {
  _afterOpen,
} = {}) {
  if (typeof path !== "string" || !isAbsolute(path) ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 2 ||
      !Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW ||
      !Number.isInteger(constants.O_NONBLOCK) || !constants.O_NONBLOCK) {
    throw new Error(`${label} path is invalid`);
  }
  const before = lstatSync(path); let descriptor;
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 2 || before.size > maximumBytes || (before.mode & 0o022) !== 0) {
      throw new Error(`${label} file is unsafe`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW |
      constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev ||
        opened.ino !== before.ino || opened.size !== before.size ||
        (opened.mode & 0o022) !== 0) {
      throw new Error(`${label} changed during open`);
    }
    _afterOpen?.({ descriptor, path });
    // One extra byte detects growth, while this allocation caps memory even if a
    // concurrent writer appends indefinitely after the initial stat.
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (length !== opened.size || after.nlink !== 1 || linked.nlink !== 1 ||
        after.dev !== opened.dev || after.ino !== opened.ino ||
        linked.dev !== opened.dev || linked.ino !== opened.ino ||
        after.size !== opened.size || linked.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        linked.mtimeMs !== opened.mtimeMs || linked.ctimeMs !== opened.ctimeMs ||
        (after.mode & 0o022) !== 0 || (linked.mode & 0o022) !== 0) {
      throw new Error(`${label} changed during read`);
    }
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, length));
    if (!text.endsWith("\n") || text.endsWith("\n\n")) {
      throw new Error(`${label} must be canonical JSON with one newline`);
    }
    const value = parseConsensusJson(text.slice(0, -1));
    if (`${canonicalJson(value)}\n` !== text) {
      throw new Error(`${label} must be canonical JSON with one newline`);
    }
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
