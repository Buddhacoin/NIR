import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

import { parseConsensusJson } from "./consensus-json.mjs";

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

export function readBoundedPublicJsonFile(path, {
  label = "public JSON input", maximumBytes = 16 * 1024 * 1024, _afterOpen,
} = {}) {
  if (typeof path !== "string" || path.length < 1 ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 2 ||
      !Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error(`${label} secure read is unavailable`);
  }
  const before = lstatSync(path); let descriptor;
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 ||
        before.size > maximumBytes || (before.mode & 0o022) !== 0) {
      throw new Error(`${label} file is unsafe`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !same(opened, before)) {
      throw new Error(`${label} file changed during open`);
    }
    _afterOpen?.({ descriptor, path });
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(path);
    if (bytes.length !== opened.size || !same(opened, after) || !same(opened, linked) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs) throw new Error(`${label} file changed during read`);
    return parseConsensusJson(bytes.toString("utf8"));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
