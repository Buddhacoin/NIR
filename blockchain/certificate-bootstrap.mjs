import {
  chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { selectCertificateHistoryCandidates } from "./certificate-lifecycle.mjs";
import {
  certificateStorePaths,
  installCertificateHistory,
  MAX_CERTIFICATE_STORE_BYTES,
} from "./certificate-lifecycle-store.mjs";
import {
  CERTIFICATE_MODE_DEV_GENESIS,
  runtimeCertificateContext,
} from "./certificate-runtime.mjs";
import { parseConsensusJson } from "./consensus-json.mjs";
import { hashObject } from "./crypto.mjs";
import { ValidatorReplica } from "./distributed-node.mjs";
import { requestJson } from "./http-client.mjs";
import { boundedAllSettled } from "./operator-defense.mjs";

export const CERTIFICATE_BOOTSTRAP_MARKER = "CERTIFICATE-LIFECYCLE-BOOTSTRAPPED.json";
const HISTORY_PATH = "/v1/p2p/certificates/history";
const MAX_RESPONSE_BYTES = MAX_CERTIFICATE_STORE_BYTES + 64 * 1024;

function markerPath(directory) {
  return join(resolve(directory), CERTIFICATE_BOOTSTRAP_MARKER);
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertBootstrapUnused(directory) {
  const marker = markerPath(directory);
  const paths = certificateStorePaths(join(directory, "certificates"));
  if (pathEntryExists(marker) || pathEntryExists(paths.primary) || pathEntryExists(paths.backup)) {
    throw new Error("certificate lifecycle bootstrap was already used or a store already exists");
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeMarker(directory, value) {
  const path = markerPath(directory);
  const temporary = `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readGenesis(directory) {
  const contents = readFileSync(join(directory, "genesis.json"), "utf8");
  if (Buffer.byteLength(contents) > 4 * 1024 * 1024) {
    throw new Error("bootstrap genesis is too large");
  }
  return parseConsensusJson(contents);
}

export async function bootstrapCertificateLifecycle(directory, urls, {
  request = requestJson,
} = {}) {
  const root = resolve(directory);
  if (!Array.isArray(urls) || typeof request !== "function") {
    throw new Error("certificate lifecycle bootstrap inputs are invalid");
  }
  assertBootstrapUnused(root);
  const validator = new ValidatorReplica(root, { certificateMode: CERTIFICATE_MODE_DEV_GENESIS });
  if (urls.length !== validator.peerCount || urls.some((url) => typeof url !== "string")) {
    throw new Error("bootstrap peer URL set does not match the consensus peer set");
  }
  const genesis = readGenesis(root);
  const context = runtimeCertificateContext(root, genesis);
  const peers = urls.map((url, index) => validator.peerDescriptor(index, url));
  for (const peer of peers) {
    if (!Array.isArray(peer.tlsCertificateSha256Pins) ||
        peer.tlsCertificateSha256Pins.length !== 1 || !peer.url.startsWith("https://")) {
      throw new Error("bootstrap requires a consensus-pinned HTTPS peer set");
    }
  }
  const responses = await boundedAllSettled(peers, async (peer) => {
    const payload = {};
    const auth = validator.createValidatorRequest(HISTORY_PATH, payload);
    const response = await request(`${peer.url}${HISTORY_PATH}`, {
      body: { auth, payload },
      maxResponseBytes: MAX_RESPONSE_BYTES,
      method: "POST",
      timeoutMs: 5_000,
      tlsCertificateSha256Pins: peer.tlsCertificateSha256Pins,
    });
    if (!response.ok) throw new Error(response.body?.error ?? "bootstrap peer request failed");
    const result = validator.verifyValidatorResponseFrom(
      peer.transport, response.body?.auth, auth.nonce, response.body?.result,
    );
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).join("\0") !== "history") {
      throw new Error("bootstrap peer returned an invalid history envelope");
    }
    return { history: result?.history, source: peer.validatorAddress };
  });
  const candidates = responses
    .filter(({ status, value }) => status === "fulfilled" && Array.isArray(value?.history))
    .map(({ value }) => value);
  const selected = selectCertificateHistoryCandidates(candidates, {
    context,
    localHistory: [],
    trustedSources: context.validators,
  });
  const quorum = Math.floor((context.validators.length * 2) / 3) + 1;
  if (selected.history.length === 0 || selected.matchingSources.length < quorum) {
    throw new Error("certificate lifecycle bootstrap head quorum not reached");
  }
  assertBootstrapUnused(root);
  const installed = installCertificateHistory(join(root, "certificates"), selected.history, context);
  const receipt = {
    format: "nir-certificate-bootstrap-v1",
    genesisHash: hashObject(genesis, "CERTIFICATE_BOOTSTRAP_GENESIS"),
    headHash: selected.headHash,
    networkId: genesis.networkId,
    records: installed.history.length,
  };
  writeMarker(root, receipt);
  return { ...receipt, matchingSources: selected.matchingSources, status: installed.status };
}

export function certificateBootstrapMarkerPath(directory) {
  return markerPath(directory);
}
