import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { createAccountObserverBridgeServer } from "./account-observer-bridge.mjs";
import { validatorSetId } from "./validator-rotation.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const MAX_ANCHOR_BYTES = 1024 * 1024;
const REQUIRED = ["address", "origin", "node", "anchor-file", "anchor-sha256",
  "genesis-hash", "state-dir", "port"];

// JSON.stringify does not escape Unicode bidi overrides or C1 terminal
// controls. Present every non-printable/non-ASCII code point as literal text.
export function safeTerminalValue(value) {
  return JSON.stringify(String(value)).replace(/[^\x20-\x7e]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16)}}`);
}

export function parseObserverLaunchArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.startsWith("--") ? args[index].slice(2) : null;
    if (!REQUIRED.includes(key) || values[key] !== undefined || args[index + 1] === undefined) {
      throw new Error("observer requires each exact --address --origin --node --anchor-file --anchor-sha256 --genesis-hash --state-dir --port argument once");
    }
    values[key] = args[index + 1];
  }
  if (REQUIRED.some((key) => values[key] === undefined)) {
    throw new Error("observer launch arguments are incomplete");
  }
  return values;
}

export function loadAccountObserverLaunchConfig(values) {
  if (!ADDRESS.test(values.address ?? "") || !ORIGIN.test(values.origin ?? "") ||
      !HASH.test(values["anchor-sha256"] ?? "") || !HASH.test(values["genesis-hash"] ?? "")) {
    throw new Error("observer address, Firefox origin or independently pinned hash is invalid");
  }
  const nodePort = NODE.exec(values.node ?? "");
  const port = Number(values.port);
  if (!nodePort || Number(nodePort[1]) > 65_535 || !Number.isSafeInteger(port) ||
      port < 1 || port > 65_535) {
    throw new Error("observer and node must use explicit valid loopback ports");
  }
  const stateDir = resolve(values["state-dir"]);
  const state = lstatSync(stateDir);
  if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077 ||
      (typeof process.getuid === "function" && state.uid !== process.getuid())) {
    throw new Error("observer state directory must be an owned, private 0700 directory");
  }
  const anchorPath = resolve(values["anchor-file"]);
  let bytes;
  // A FIFO must not hang launch before fstat can reject it. O_NONBLOCK also
  // makes non-regular descriptors fail promptly when the operator supplied a
  // mistaken or hostile anchor path.
  const descriptor = openSync(anchorPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const anchorFile = fstatSync(descriptor);
    if (!anchorFile.isFile() || anchorFile.size < 1 ||
        anchorFile.size > MAX_ANCHOR_BYTES) {
      throw new Error("observer trust anchor file is unsafe");
    }
    bytes = readFileSync(descriptor);
    if (bytes.length !== anchorFile.size) {
      throw new Error("observer trust anchor changed during read");
    }
  } finally { closeSync(descriptor); }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== values["anchor-sha256"]) {
    throw new Error("observer trust anchor does not match the independently reviewed SHA-256");
  }
  const trustAnchor = JSON.parse(bytes.toString("utf8"));
  if (trustAnchor?.genesisCheckpoint?.tipHash !== values["genesis-hash"] ||
      !Array.isArray(trustAnchor.trustedValidators) ||
      trustAnchor.trustedValidators.length < 4 ||
      validatorSetId(trustAnchor.trustedValidators) !==
        trustAnchor.genesisCheckpoint.validatorSetId) {
    throw new Error("observer trust anchor genesis or validator set is invalid");
  }
  const identity = createHash("sha256").update(JSON.stringify({
    address: values.address, genesisHash: values["genesis-hash"],
    networkId: trustAnchor.expectedNetworkId,
  })).digest("hex");
  return {
    address: values.address, checkpointPath: join(stateDir, `account-${identity}.json`),
    nodeBaseUrl: values.node, origin: values.origin, port, trustAnchor,
  };
}

export function createLaunchedAccountObserver(config, sessionToken) {
  return createAccountObserverBridgeServer({ ...config, sessionToken });
}
