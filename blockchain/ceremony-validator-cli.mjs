#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import process from "node:process";

import { parseConsensusJson } from "./consensus-json.mjs";
import {
  initializeValidatorFromCeremony,
  reverifyValidatorFromCeremony,
} from "./ceremony-validator-init.mjs";

function readBounded(path, label, maximum = 16 * 1024 * 1024) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error("validator ceremony CLI requires no-follow file support");
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maximum) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    const value = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        value.length !== before.size) throw new Error(`${label} changed while reading`);
    return value;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function readJson(path, label) {
  return parseConsensusJson(readBounded(path, label).toString("utf8"));
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

async function passwords() {
  return {
    transportPassword: await readSecret("Local transport vault password: "),
    validatorPassword: await readSecret("Local validator vault password: "),
  };
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "init-from-ceremony" && args.length === 10) {
    const [target, genesisPath, planPath, envelopePath, releasePath, trustedAddress,
      anchorPath, validatorVaultPath, transportVaultPath, certificatePath] = args;
    const secrets = await passwords();
    const result = initializeValidatorFromCeremony(target, {
      anchor: readJson(anchorPath, "ceremony registry anchor"),
      envelope: readJson(envelopePath, "ceremony approval envelope"),
      genesis: readJson(genesisPath, "compiled genesis"),
      plan: readJson(planPath, "ceremony plan"),
      signedRelease: readJson(releasePath, "signed release"),
      tlsCertificatePem: readBounded(certificatePath, "TLS certificate", 1024 * 1024),
      transportVault: readJson(transportVaultPath, "transport vault"),
      trustedAddress,
      validatorVault: readJson(validatorVaultPath, "validator vault"),
      ...secrets,
    });
    console.log(JSON.stringify(result));
    console.log("Validator ceremony evidence initialized; no network process was started.");
  } else if (command === "reverify" && args.length === 2) {
    const [target, trustedAddress] = args;
    console.log(JSON.stringify(reverifyValidatorFromCeremony(target, {
      ...(await passwords()), trustedAddress,
    })));
  } else {
    throw new Error(
      "usage: validator:ceremony init-from-ceremony <new-target> <genesis.json> " +
      "<plan.json> <approvals.json> <signed-release.json> <trusted-release-address> " +
      "<anchor.json> <validator-vault.json> <transport-vault.json> <tls-certificate.pem>\n" +
      "   or: validator:ceremony reverify <target> <trusted-release-address>",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
