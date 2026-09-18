#!/usr/bin/env node
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { parseOfflineReleaseBundle } from "./offline-release-bundle.mjs";
import {
  acceptReleaseAuthorityChange, appendReleaseTransparencyEntry, approveReleaseActivationProposal,
  approveReleaseLogProposal, contextForReleaseLog,
  createReleaseAuthoritySet, createReleaseProposal, createReleaseTransparencyAnchor,
  loadReleaseTransparencyLog, recoverReleaseTransparencyCheckpoint, serializeReleaseGovernance,
  validateReleaseAuthoritySet,
  validateReleaseLogProposal, validateReleaseTransparencyAnchor,
} from "./offline-release-governance.mjs";
import { decryptWallet } from "./vault.mjs";

function readSecret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt);
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n");
      error ? reject(error) : resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") {
          value += character;
          if (Buffer.byteLength(value) > 1_024) return finish(new Error("secret input is too long"));
        }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

function vaultSource(path) {
  const target = resolve(path);
  const metadata = lstatSync(target);
  if (!metadata.isSymbolicLink()) return target;
  if (metadata.nlink !== 1) throw new Error("release authority vault activation is unsafe");
  const link = readlinkSync(target);
  const escaped = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\.${escaped}\\.nir-private-[0-9a-f]{32}$`).test(link)) {
    throw new Error("release authority vault activation is invalid");
  }
  return join(dirname(target), link);
}

function readText(path, maximum, { privateFile = false } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("secure no-follow release governance reads are unavailable");
  }
  const source = privateFile ? vaultSource(path) : resolve(path);
  let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum ||
        (privateFile && (before.mode & 0o077) !== 0)) throw new Error("release governance input is unsafe");
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const linked = lstatSync(source);
    if (contents.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("release governance input changed during read");
    }
    return contents.toString("utf8");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function readJson(path, maximum = 1024 * 1024, options) {
  const text = readText(path, maximum, options);
  const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
  let value;
  try { value = JSON.parse(canonical); } catch { throw new Error("release governance input is not JSON"); }
  if (canonicalJson(value) !== canonical) throw new Error("release governance input is not canonical JSON");
  return value;
}

function writeExclusive(path, value) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0 ||
      !Number.isInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new Error("secure release governance output support is unavailable");
  }
  const target = resolve(path);
  let descriptor;
  let parent;
  try {
    parent = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, serializeReleaseGovernance(value));
    fchmodSync(descriptor, 0o600); fsyncSync(descriptor); fsyncSync(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent !== undefined) closeSync(parent);
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "set" && args.length === 2) {
    const [configPath, output] = args;
    const config = readJson(configPath);
    writeExclusive(output, createReleaseAuthoritySet(config));
  } else if (command === "anchor" && args.length === 4) {
    const [setPath, networkId, logId, output] = args;
    writeExclusive(output, createReleaseTransparencyAnchor({
      initialSet: validateReleaseAuthoritySet(readJson(setPath)), logId, networkId,
    }));
  } else if (command === "propose-release" && args.length === 5) {
    const [anchorPath, logDirectory, checkpointDirectory, bundlePath, output] = args;
    const anchor = validateReleaseTransparencyAnchor(readJson(anchorPath));
    const state = loadReleaseTransparencyLog(anchor, logDirectory, checkpointDirectory);
    const bundle = parseOfflineReleaseBundle(readText(bundlePath, 192 * 1024 * 1024));
    writeExclusive(output, createReleaseProposal({ anchor, bundle, state }));
  } else if (command === "propose-change" && args.length === 6) {
    const [anchorPath, logDirectory, checkpointDirectory, nextSetPath, reason, output] = args;
    const anchor = validateReleaseTransparencyAnchor(readJson(anchorPath));
    const state = loadReleaseTransparencyLog(anchor, logDirectory, checkpointDirectory);
    writeExclusive(output, createReleaseProposal({ anchor,
      nextSet: validateReleaseAuthoritySet(readJson(nextSetPath)), reason, state }));
  } else if (["approve", "accept-change", "approve-activation"].includes(command) && args.length === 7) {
    const [anchorPath, logDirectory, checkpointDirectory, proposalPath, operatorId, vaultPath, output] = args;
    const anchor = validateReleaseTransparencyAnchor(readJson(anchorPath));
    const state = loadReleaseTransparencyLog(anchor, logDirectory, checkpointDirectory);
    const context = contextForReleaseLog(anchor, state);
    const proposal = validateReleaseLogProposal(readJson(proposalPath), context);
    const password = await readSecret("Release authority vault password: ");
    const wallet = decryptWallet(readJson(vaultPath, 64 * 1024, { privateFile: true }), password);
    const action = command === "approve" ? approveReleaseLogProposal
      : command === "accept-change" ? acceptReleaseAuthorityChange : approveReleaseActivationProposal;
    try { writeExclusive(output, action(proposal, context, { operatorId, wallet })); }
    finally { wallet.privateKey = ""; }
  } else if (command === "append" && args.length === 5) {
    const [anchorPath, logDirectory, checkpointDirectory, proposalPath, approvalsPath] = args;
    const approvalGroups = readJson(approvalsPath);
    if (!approvalGroups || Array.isArray(approvalGroups) ||
        Object.keys(approvalGroups).sort().join("\0") !==
          ["activation", "active", "nextSetAcceptance"].sort().join("\0")) {
      throw new Error("release approval groups have unknown or missing fields");
    }
    const result = appendReleaseTransparencyEntry({
      anchor: validateReleaseTransparencyAnchor(readJson(anchorPath)), checkpointDirectory, logDirectory,
      proposal: readJson(proposalPath), approvals: approvalGroups.active,
      activationApprovals: approvalGroups.activation,
      nextSetAcceptances: approvalGroups.nextSetAcceptance,
    });
    console.log(`Release transparency entry ${result.entry.entryHash} appended at ${result.entry.sequence}.`);
  } else if (command === "recover-checkpoint" && args.length === 3) {
    const [anchorPath, logDirectory, checkpointDirectory] = args;
    const checkpoint = recoverReleaseTransparencyCheckpoint({
      anchor: validateReleaseTransparencyAnchor(readJson(anchorPath)), checkpointDirectory, logDirectory,
    });
    console.log(`Release transparency checkpoint recovered at ${checkpoint.sequence} ${checkpoint.entryHash}.`);
  } else if (command === "verify" && args.length === 5) {
    const [anchorPath, logDirectory, checkpointDirectory, sequenceText, expectedHash] = args;
    const state = loadReleaseTransparencyLog(
      validateReleaseTransparencyAnchor(readJson(anchorPath)), logDirectory, checkpointDirectory);
    if (state.sequence !== Number(sequenceText) || state.entryHash !== expectedHash) {
      throw new Error("release transparency head does not match the external checkpoint");
    }
    console.log(`Release transparency log verified at ${state.sequence} ${state.entryHash}.`);
  } else {
    throw new Error("usage: release-governance set <config.json> <new-set.json> | anchor <set.json> <network> <log-id> <new-anchor.json> | propose-release <anchor> <log-dir> <checkpoint-dir> <bundle> <new-proposal> | propose-change <anchor> <log-dir> <checkpoint-dir> <next-set> <rotation|revocation> <new-proposal> | approve|accept-change|approve-activation <anchor> <log-dir> <checkpoint-dir> <proposal> <operator-id> <vault> <new-approval> | append <anchor> <log-dir> <checkpoint-dir> <proposal> <approval-groups.json> | recover-checkpoint <anchor> <log-dir> <checkpoint-dir> | verify <anchor> <log-dir> <checkpoint-dir> <sequence> <entry-hash>");
  }
} catch (error) {
  console.error(`Release governance operation failed: ${error.message}`);
  process.exitCode = 1;
}
