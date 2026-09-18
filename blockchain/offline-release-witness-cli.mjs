#!/usr/bin/env node
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import {
  validateReleaseTransparencyAnchor, validateReleaseTransparencyCheckpoint,
} from "./offline-release-governance.mjs";
import {
  createReleaseWitnessEquivocationEvidence, createReleaseWitnessReceipt,
  createReleaseWitnessSet, importReleaseWitnessReceipt, selectReleaseWitnessHeadStore,
  serializeReleaseWitness, validateReleaseWitnessSet,
} from "./offline-release-witness.mjs";
import { decryptWallet } from "./vault.mjs";

function readSecret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt); let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write("\n"); error ? reject(error) : resolveSecret(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") {
          value += character;
          if (Buffer.byteLength(value) > 1024) return finish(new Error("secret input is too long"));
        }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

function vaultSource(path) {
  const target = resolve(path); const metadata = lstatSync(target);
  if (!metadata.isSymbolicLink()) return target;
  const link = readlinkSync(target);
  const escaped = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (metadata.nlink !== 1 || !new RegExp(`^\\.${escaped}\\.nir-private-[0-9a-f]{32}$`).test(link)) {
    throw new Error("release witness vault activation is unsafe");
  }
  return join(dirname(target), link);
}

function readJson(path, maximum = 1024 * 1024, privateFile = false) {
  if (!constants.O_NOFOLLOW) throw new Error("secure no-follow witness reads are unavailable");
  const source = privateFile ? vaultSource(path) : resolve(path); let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum ||
        (privateFile && (before.mode & 0o077) !== 0)) throw new Error("release witness input is unsafe");
    const bytes = readFileSync(descriptor); const after = fstatSync(descriptor); const linked = lstatSync(source);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.dev !== linked.dev || before.ino !== linked.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("release witness input changed during read");
    }
    const text = bytes.toString("utf8");
    const canonical = text.endsWith("\n") && !text.endsWith("\n\n") ? text.slice(0, -1) : text;
    const value = JSON.parse(canonical);
    if (canonicalJson(value) !== canonical) throw new Error("release witness input is not canonical JSON");
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function writeExclusive(path, value) {
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error("secure witness output support is unavailable");
  }
  const target = resolve(path); let parent; let descriptor;
  try {
    parent = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, serializeReleaseWitness(value)); fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor); fsyncSync(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent !== undefined) closeSync(parent);
  }
}

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "set" && args.length === 2) {
    const [config, output] = args;
    const value = readJson(config);
    writeExclusive(output, createReleaseWitnessSet(value));
  } else if (command === "export" && args.length === 3) {
    const [anchorPath, checkpointPath, output] = args;
    const anchor = validateReleaseTransparencyAnchor(readJson(anchorPath));
    writeExclusive(output, validateReleaseTransparencyCheckpoint(readJson(checkpointPath), anchor));
  } else if (command === "sign" && args.length === 7) {
    const [anchorPath, setPath, checkpointPath, operatorId, vaultPath, observedAtText, output] = args;
    const anchor = validateReleaseTransparencyAnchor(readJson(anchorPath));
    const witnessSet = validateReleaseWitnessSet(readJson(setPath));
    const checkpoint = validateReleaseTransparencyCheckpoint(readJson(checkpointPath), anchor);
    const password = await readSecret("Release witness vault password: ");
    const wallet = decryptWallet(readJson(vaultPath, 64 * 1024, true), password);
    try { writeExclusive(output, createReleaseWitnessReceipt({ anchor, checkpoint, observedAt:
      number(observedAtText, "observedAt"), operatorId, wallet, witnessSet })); }
    finally { wallet.privateKey = ""; }
  } else if (command === "import" && args.length === 7) {
    const [anchorPath, setPath, store, receiptPath, nowText, maxAgeText, futureText] = args;
    const result = importReleaseWitnessReceipt(store, readJson(receiptPath), {
      anchor: validateReleaseTransparencyAnchor(readJson(anchorPath)),
      maxAgeMs: number(maxAgeText, "maxAgeMs"), maxFutureSkewMs: number(futureText, "maxFutureSkewMs"),
      now: number(nowText, "now"), witnessSet: validateReleaseWitnessSet(readJson(setPath)),
    });
    console.log(result.evidence ? serializeReleaseWitness(result.evidence).trim() :
      `Release witness receipt ${result.receipt.receiptHash} imported.`);
  } else if (command === "select" && args.length === 8) {
    const [anchorPath, setPath, store, sequenceText, nowText, maxAgeText, futureText, output] = args;
    writeExclusive(output, selectReleaseWitnessHeadStore(store, {
      anchor: validateReleaseTransparencyAnchor(readJson(anchorPath)), maxAgeMs: number(maxAgeText, "maxAgeMs"),
      maxFutureSkewMs: number(futureText, "maxFutureSkewMs"), now: number(nowText, "now"),
      sequence: number(sequenceText, "sequence"), witnessSet: validateReleaseWitnessSet(readJson(setPath)),
    }));
  } else if (command === "evidence" && args.length === 5) {
    const [anchorPath, setPath, firstPath, secondPath, output] = args;
    writeExclusive(output, createReleaseWitnessEquivocationEvidence(readJson(firstPath), readJson(secondPath), {
      anchor: validateReleaseTransparencyAnchor(readJson(anchorPath)),
      witnessSet: validateReleaseWitnessSet(readJson(setPath)),
    }));
  } else {
    throw new Error("usage: release-witness set <config> <output> | export <anchor> <checkpoint> <output> | sign <anchor> <set> <checkpoint> <operator> <vault> <observedAt-ms> <output> | import <anchor> <set> <store> <receipt> <now-ms> <max-age-ms> <future-skew-ms> | select <anchor> <set> <store> <sequence> <now-ms> <max-age-ms> <future-skew-ms> <output> | evidence <anchor> <set> <receipt-a> <receipt-b> <output>");
  }
} catch (error) {
  console.error(`Release witness operation failed: ${error.message}`); process.exitCode = 1;
}
