#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";
import {
  createResetDrill,
  createResetManifest,
  genesisIdentity,
  incidentReportHash,
  resetValidatorTopology,
  signResetManifest,
  verifyResetManifest,
} from "./testnet-reset.mjs";
import { decryptWallet } from "./vault.mjs";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

function readBounded(path, name, maximumBytes) {
  if (!path) throw new Error(`${name} file is unsafe or too large`);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error(`${name} file is unsafe or too large`);
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) throw new Error(`${name} file changed during open`);
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`${name} file changed during read`);
    }
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, name) {
  return parseConsensusJson(readBounded(path, name, MAX_JSON_BYTES).toString("utf8"));
}

function exactRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !==
        ["notBefore", "oldFinalizedHeight", "reason"].join("\0")) {
    throw new Error("reset request shape is invalid");
  }
  return value;
}

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
        else if (character >= " ") value += character;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

function inputs(oldGenesisPath, newGenesisPath, incidentPath) {
  const oldGenesis = readJson(oldGenesisPath, "old genesis");
  const newGenesis = readJson(newGenesisPath, "new genesis");
  const incidentContents = readBounded(incidentPath, "incident report", MAX_REPORT_BYTES);
  return {
    incidentContents,
    newGenesis,
    oldGenesis,
    reportHash: incidentReportHash(incidentContents),
  };
}

function rawFileHash(contents) {
  return createHash("sha3-256").update("NIR/RESET_SOURCE_FILE/v1\0").update(contents).digest("hex");
}

function writeExclusive(path, value) {
  writeFileSync(path, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "plan" && args.length === 5) {
    const [oldGenesisPath, handoffsPath, newGenesisPath, incidentPath, requestPath] = args;
    const { newGenesis, oldGenesis, reportHash } = inputs(
      oldGenesisPath, newGenesisPath, incidentPath,
    );
    const request = exactRequest(readJson(requestPath, "reset request"));
    const oldIdentity = genesisIdentity(oldGenesis);
    const newIdentity = genesisIdentity(newGenesis);
    const handoffs = readJson(handoffsPath, "validator handoff history");
    const topology = resetValidatorTopology(
      oldGenesis, handoffs, request.oldFinalizedHeight,
    );
    console.log(JSON.stringify(createResetManifest({
      activeValidatorSetId: topology.activeValidatorSetId,
      incidentReportHash: reportHash,
      newGenesisHash: newIdentity.genesisHash,
      newNetworkId: newIdentity.networkId,
      notBefore: request.notBefore,
      oldFinalizedHeight: request.oldFinalizedHeight,
      oldGenesisHash: oldIdentity.genesisHash,
      oldNetworkId: oldIdentity.networkId,
      reason: request.reason,
      validatorTopologyHash: topology.validatorTopologyHash,
    }), null, 2));
  } else if (command === "sign" && args.length === 4) {
    const [oldGenesisPath, handoffsPath, manifestPath, vaultPath] = args;
    const oldGenesis = readJson(oldGenesisPath, "old genesis");
    const oldIdentity = genesisIdentity(oldGenesis);
    const manifest = readJson(manifestPath, "reset manifest");
    const handoffs = readJson(handoffsPath, "validator handoff history");
    if (manifest.oldGenesisHash !== oldIdentity.genesisHash ||
        manifest.oldNetworkId !== oldIdentity.networkId) {
      throw new Error("reset manifest does not match the trusted old genesis");
    }
    const password = await readSecret("Validator vault password: ");
    const wallet = decryptWallet(readJson(vaultPath, "validator vault"), password);
    try {
      console.log(JSON.stringify(signResetManifest(manifest, wallet, {
        handoffs,
        oldGenesis,
      }), null, 2));
    } finally {
      wallet.privateKey = "";
    }
  } else if ((command === "verify" || command === "drill") &&
      args.length === (command === "verify" ? 5 : 6)) {
    const [oldGenesisPath, handoffsPath, newGenesisPath, incidentPath, manifestPath,
      targetPath] = args;
    const oldGenesisBytes = readBounded(oldGenesisPath, "old genesis", MAX_JSON_BYTES);
    const oldGenesisFileHash = rawFileHash(oldGenesisBytes);
    const oldGenesis = parseConsensusJson(oldGenesisBytes.toString("utf8"));
    const newGenesis = readJson(newGenesisPath, "new genesis");
    const reportHash = incidentReportHash(readBounded(
      incidentPath, "incident report", MAX_REPORT_BYTES,
    ));
    const manifest = readJson(manifestPath, "reset manifest");
    const handoffs = readJson(handoffsPath, "validator handoff history");
    const options = {
      expectedIncidentReportHash: reportHash,
      handoffs,
      newGenesis,
      oldGenesis,
    };
    if (command === "verify") {
      const verified = verifyResetManifest(manifest, options);
      console.log(JSON.stringify({
        manifestHash: verified.manifestHash,
        quorum: verified.quorum,
        signatures: verified.approvals.length,
        verified: true,
      }, null, 2));
    } else {
      const report = createResetDrill(manifest, options);
      const target = resolve(targetPath);
      const parent = dirname(target);
      const parentMetadata = lstatSync(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || existsSync(target)) {
        throw new Error("reset drill requires a new directory in a regular parent");
      }
      mkdirSync(target, { mode: 0o700 });
      writeExclusive(join(target, "OLD-GENESIS.json"), oldGenesis);
      writeExclusive(join(target, "VALIDATOR-HANDOFFS.json"), handoffs);
      writeExclusive(join(target, "NEW-GENESIS.json"), newGenesis);
      writeExclusive(join(target, "RESET-MANIFEST.json"), manifest);
      const after = readBounded(oldGenesisPath, "old genesis", MAX_JSON_BYTES);
      const oldGenesisFileHashAfter = rawFileHash(after);
      if (oldGenesisFileHashAfter !== oldGenesisFileHash) {
        throw new Error("old genesis changed during the reset drill");
      }
      const evidence = {
        ...report,
        oldGenesisFileHashAfter,
        oldGenesisFileHashBefore: oldGenesisFileHash,
        oldGenesisPreserved: true,
      };
      writeExclusive(join(target, "RESET-DRILL.json"), evidence);
      console.log(JSON.stringify({ directory: target, ...evidence }, null, 2));
    }
  } else {
    throw new Error("usage: testnet-reset plan <old-genesis.json> <validator-handoffs.json> <new-genesis.json> <incident-report> <request.json> | testnet-reset sign <old-genesis.json> <validator-handoffs.json> <manifest.json> <validator-vault> | testnet-reset verify <old-genesis.json> <validator-handoffs.json> <new-genesis.json> <incident-report> <signed-manifest.json> | testnet-reset drill <old-genesis.json> <validator-handoffs.json> <new-genesis.json> <incident-report> <signed-manifest.json> <new-directory>");
  }
} catch (error) {
  console.error(`Testnet reset operation failed: ${error.message}`);
  process.exitCode = 1;
}
