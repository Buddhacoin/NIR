#!/usr/bin/env node
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync,
} from "node:fs";
import process from "node:process";
import { parseConsensusJson } from "./consensus-json.mjs";
import {
  CERTIFICATE_RECORD_FORMAT,
  createCertificateRecord,
  EMPTY_CERTIFICATE_RECORD_HASH,
  certificatePinsAtHeight,
} from "./certificate-lifecycle.mjs";
import {
  installCertificateRecord,
  loadCertificateHistory,
} from "./certificate-lifecycle-store.mjs";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const [command, contextPath, directory, inputPath = ""] = process.argv.slice(2);

function readBoundedJson(path, name) {
  if (!path) throw new Error(`${name} file is unsafe or too large`);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_INPUT_BYTES) {
    throw new Error(`${name} file is unsafe or too large`);
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) throw new Error(`${name} file changed during open`);
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`${name} file changed during read`);
    }
    return parseConsensusJson(contents);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function contextFrom(path) {
  const value = readBoundedJson(path, "certificate context");
  if (!Number.isSafeInteger(value?.currentHeight) || value.currentHeight < 0 ||
      typeof value.networkId !== "string" || !Array.isArray(value.validators) ||
      !/^[0-9a-f]{64}$/.test(value.peerRegistryHash ?? "") ||
      !/^[0-9a-f]{64}$/.test(value.topologyHistoryHash ?? "")) {
    throw new Error("certificate context is invalid");
  }
  return value;
}

function plan(context, history, request, forcedOperation = null) {
  const operation = forcedOperation ?? request?.operation;
  const records = history.filter(({ validatorAddress }) =>
    validatorAddress === request?.validatorAddress);
  const previous = records.at(-1) ?? null;
  const activationHeight = request?.activationHeight;
  const overlapUntilHeight = operation === "renew"
    ? request?.overlapUntilHeight ?? activationHeight
    : activationHeight;
  return createCertificateRecord({
    activationHeight,
    certificate: operation === "revoke" ? null : request?.certificate,
    format: CERTIFICATE_RECORD_FORMAT,
    networkId: context.networkId,
    operation,
    overlapUntilHeight,
    peerRegistryHash: context.peerRegistryHash,
    previousRecordHash: previous?.recordHash ?? EMPTY_CERTIFICATE_RECORD_HASH,
    sequence: previous ? previous.sequence + 1 : 0,
    topologyHistoryHash: context.topologyHistoryHash,
    validatorAddress: request?.validatorAddress,
  }, []);
}

function baseVerificationContext(context) {
  return {
    networkId: context.networkId,
    validators: context.validators,
    validatorSetsByTopologyHash: context.validatorSetsByTopologyHash ?? null,
  };
}

try {
  const context = contextFrom(contextPath);
  const loaded = loadCertificateHistory(directory, baseVerificationContext(context));
  if (command === "plan" || command === "revoke") {
    const request = readBoundedJson(inputPath, "certificate request");
    console.log(JSON.stringify(plan(context, loaded.history, request,
      command === "revoke" ? "revoke" : null), null, 2));
  } else if (command === "apply") {
    const record = readBoundedJson(inputPath, "signed certificate record");
    console.log(JSON.stringify(installCertificateRecord(directory, record, {
      ...baseVerificationContext(context),
      currentHeight: context.currentHeight,
      minimumActivationDelay: context.minimumActivationDelay ?? 2,
      peerRegistryHash: context.peerRegistryHash,
      topologyHistoryHash: context.topologyHistoryHash,
    }), null, 2));
  } else if (command === "status") {
    const height = inputPath === "" ? context.currentHeight : Number(inputPath);
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("status height is invalid");
    const validators = [...new Set(loaded.history.map(({ validatorAddress }) =>
      validatorAddress))];
    console.log(JSON.stringify({
      height,
      records: loaded.history.length,
      validators: validators.map((validatorAddress) => ({
        pins: certificatePinsAtHeight(loaded.history, validatorAddress, height),
        validatorAddress,
      })),
    }, null, 2));
  } else {
    throw new Error("usage: certificate-lifecycle <plan|apply|status|revoke> <context.json> <state-dir> [request-or-record.json|height]");
  }
} catch (error) {
  console.error(`Certificate lifecycle operation failed: ${error.message}`);
  process.exitCode = 1;
}
