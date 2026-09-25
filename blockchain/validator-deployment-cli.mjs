#!/usr/bin/env node
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync,
} from "node:fs";
import process from "node:process";

import { canonicalJson } from "./crypto.mjs";
import { requestJson } from "./http-client.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
import {
  createValidatorDeploymentPlan, validateValidatorDeploymentPlan,
} from "./validator-deployment-plan.mjs";

function readPublic(path, label, maximum = 2 * 1024 * 1024) {
  const before = lstatSync(path); let descriptor;
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 ||
        before.size > maximum || (before.mode & 0o022) !== 0) throw new Error(`${label} is unsafe`);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor); const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        bytes.length !== opened.size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function writeExclusive(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

const [command, inputPath, outputPath] = process.argv.slice(2);
try {
  if (command === "plan" && inputPath && outputPath) {
    const input = readBoundedPublicJsonFile(inputPath, { label: "deployment input" });
    if (outputPath !== input.paths?.planOutput) {
      throw new Error("deployment output path does not match the public input planOutput");
    }
    const plan = createValidatorDeploymentPlan(input, {
      anchor: readBoundedPublicJsonFile(input.artifacts.anchor, { label: "ceremony anchor" }),
      approvals: readBoundedPublicJsonFile(input.artifacts.approvals, { label: "ceremony approvals" }),
      ceremonyPlan: readBoundedPublicJsonFile(input.artifacts.plan, { label: "ceremony plan" }),
      genesis: readBoundedPublicJsonFile(input.artifacts.genesis, { label: "compiled genesis" }),
      signedRelease: readBoundedPublicJsonFile(input.artifacts.signedRelease, { label: "signed release" }),
      tlsCertificatePem: readPublic(input.artifacts.tlsCertificate, "TLS certificate"),
    });
    writeExclusive(outputPath, plan);
    console.log(JSON.stringify({ outputPath, planHash: plan.planHash, status: "planned" }));
  } else if (command === "health" && inputPath && outputPath === undefined) {
    const plan = validateValidatorDeploymentPlan(readBoundedPublicJsonFile(inputPath,
      { label: "deployment plan" }));
    const result = await requestJson(new URL("/health", plan.endpoint), {
      tlsCertificateSha256: plan.tlsCertificateSha256,
    });
    if (!result.ok || result.body?.status !== "ready" ||
        result.body?.networkId !== plan.networkId || result.body?.address !== plan.validatorAddress ||
        result.body?.certificateMode !== plan.certificateMode) {
      throw new Error("validator health does not match the deployment plan");
    }
    console.log(JSON.stringify({ endpoint: plan.endpoint, height: result.body.height,
      status: "healthy", tipHash: result.body.tipHash }));
  } else {
    throw new Error("usage: validator:deploy plan <input.json> <new-plan.json> | validator:deploy health <plan.json>");
  }
} catch (error) {
  console.error(`Validator deployment failed: ${error.message}`);
  process.exitCode = 1;
}
