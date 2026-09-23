#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { readBoundedPublicJson } from "./production-release-gate.mjs";
import {
  assembleProductionRuntimePolicy, createProductionRuntimePolicy, inspectProductionRuntime,
  signProductionRuntimePolicy, verifyProductionRuntimePolicy,
} from "./production-runtime-policy.mjs";
import { decryptWallet } from "./vault.mjs";

function json(path, maximumBytes = 4 * 1024 * 1024) {
  return readBoundedPublicJson(path, { maximumBytes, requireCanonical: true });
}
function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function privateJson(path, maximumBytes) {
  const resolved = resolve(path); const before = lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) {
    throw new Error("runtime policy authority vault is unsafe");
  }
  const value = json(resolved, maximumBytes); const after = lstatSync(resolved);
  if (!same(before, after) || before.mode !== after.mode || before.uid !== after.uid ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("runtime policy authority vault changed during read");
  }
  return value;
}
function writeExclusive(pathValue, value) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY) ||
      constants.O_NOFOLLOW === 0 || constants.O_DIRECTORY === 0) {
    throw new Error("secure runtime policy output is unavailable");
  }
  const target = resolve(pathValue); const parent = dirname(target);
  const parentDescriptor = openSync(parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const parentIdentity = fstatSync(parentDescriptor);
  const temporary = resolve(parent, `.${basename(target)}.runtime-${randomBytes(16).toString("hex")}`);
  let temporaryIdentity = null; let targetIdentity = null;
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, `${canonicalJson(value)}\n`); fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor); temporaryIdentity = fstatSync(descriptor);
    } finally { closeSync(descriptor); }
    const currentParent = lstatSync(parent); const currentTemporary = lstatSync(temporary);
    if (!same(parentIdentity, currentParent) || currentParent.isSymbolicLink() ||
        !same(temporaryIdentity, currentTemporary) || currentTemporary.isSymbolicLink()) {
      throw new Error("runtime policy output parent changed");
    }
    linkSync(temporary, target); targetIdentity = lstatSync(target);
    const finalParent = lstatSync(parent); const finalTemporary = lstatSync(temporary);
    const finalTarget = lstatSync(target);
    if (!same(parentIdentity, finalParent) || finalParent.isSymbolicLink() ||
        !same(temporaryIdentity, finalTemporary) || finalTemporary.isSymbolicLink() ||
        !same(temporaryIdentity, targetIdentity) || !same(targetIdentity, finalTarget) ||
        finalTarget.isSymbolicLink()) throw new Error("runtime policy output activation changed");
    fsyncSync(parentDescriptor); unlinkSync(temporary); temporaryIdentity = null;
    fsyncSync(parentDescriptor);
  } catch (error) {
    if (targetIdentity !== null) try {
      const current = lstatSync(target);
      if (!current.isSymbolicLink() && same(current, targetIdentity)) unlinkSync(target);
    } catch {}
    throw error;
  } finally {
    if (temporaryIdentity !== null) try {
      const current = lstatSync(temporary);
      if (!current.isSymbolicLink() && same(current, temporaryIdentity)) unlinkSync(temporary);
    } catch {}
    closeSync(parentDescriptor);
  }
}
function secret(prompt) {
  return new Promise((resolveSecret, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new Error("secure password entry requires an interactive terminal")); return;
    }
    process.stdout.write(prompt); let value = "";
    const finish = (error) => { process.stdin.off("data", input); process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n"); error ? reject(error) : resolveSecret(value); };
    const input = (chunk) => { for (const character of chunk.toString()) {
      if (character === "\u0003") return finish(new Error("cancelled"));
      if (character === "\r" || character === "\n") return finish();
      if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
      else if (character >= " ") { value += character;
        if (Buffer.byteLength(value) > 1024) return finish(new Error("secret is too long")); }
    } };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", input);
  });
}

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (command === "inspect" && args.length === 1) {
    result = inspectProductionRuntime(); writeExclusive(args[0], result);
  } else if (command === "create" && args.length === 9) {
    const [runtimePath, bindingPath, setPath, commandsPath, sequence, previousPolicyHash,
      createdAt, expiresAt, output] = args;
    result = createProductionRuntimePolicy({ authoritySet: json(setPath), binding: json(bindingPath),
      commands: json(commandsPath, 64 * 1024), createdAt: Number(createdAt),
      expiresAt: Number(expiresAt), previousPolicyHash: previousPolicyHash === "none" ? null : previousPolicyHash,
      runtime: json(runtimePath, 64 * 1024), sequence: Number(sequence) });
    writeExclusive(output, result);
  } else if (command === "sign" && args.length === 5) {
    const [policyPath, setPath, operatorId, vaultPath, output] = args;
    const password = await secret("Runtime policy authority vault password: ");
    const wallet = decryptWallet(privateJson(vaultPath, 128 * 1024), password);
    try { result = signProductionRuntimePolicy(json(policyPath), json(setPath), { operatorId, wallet });
      writeExclusive(output, result); } finally { wallet.privateKey = ""; }
  } else if (command === "assemble" && args.length >= 4) {
    const [policyPath, setPath, output, ...approvals] = args;
    result = assembleProductionRuntimePolicy(json(policyPath), json(setPath),
      approvals.map((path) => json(path, 128 * 1024))); writeExclusive(output, result);
  } else if (command === "verify" && args.length === 8) {
    const [envelopePath, bindingPath, expectedHash, sequence, now, commandName,
      executablePath, output] = args;
    result = verifyProductionRuntimePolicy(json(envelopePath), { command: commandName,
      executablePath, expectedBinding: json(bindingPath), expectedPolicyHash: expectedHash,
      expectedSequence: Number(sequence), now: Number(now) });
    writeExclusive(output, { envelopeHash: result.envelopeHash,
      policyHash: result.policy.policyHash, sequence: result.policy.sequence, status: "VERIFIED" });
  } else {
    throw new Error("usage: wallet:runtime-policy inspect OUTPUT | create RUNTIME BINDING SET COMMANDS_JSON SEQUENCE PREVIOUS_HASH|none CREATED_AT EXPIRES_AT OUTPUT | sign POLICY SET OPERATOR_ID VAULT OUTPUT | assemble POLICY SET OUTPUT APPROVAL... | verify ENVELOPE BINDING EXPECTED_HASH SEQUENCE NOW COMMAND EXECUTABLE OUTPUT");
  }
  process.stdout.write(`${canonicalJson(result)}\n`);
} catch (error) {
  process.stderr.write(`Production runtime policy failed safely: ${error.message}\n`);
  process.exitCode = 1;
}
