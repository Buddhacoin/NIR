#!/usr/bin/env node
import { closeSync, constants, fchmodSync, fsyncSync, openSync,
  writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";

import { certificateHistoryHead } from "./certificate-lifecycle.mjs";
import { CERTIFICATE_MODE_LIFECYCLE, RuntimeCertificatePins }
  from "./certificate-runtime.mjs";
import { NirChain } from "./chain.mjs";
import { MAX_CHECKPOINT_TRUST_PACKAGE_BYTES, validateCheckpointWitnessPolicy }
  from "./checkpoint-trust-package.mjs";
import { assembleCheckpointTrustPackageV2, serializeCheckpointTrustPackageV2,
  verifyCheckpointTrustPackageV2 } from "./checkpoint-trust-package-v2.mjs";
import { readCanonicalCheckpointV2Input as readCanonical }
  from "./checkpoint-package-v2-input.mjs";
import { assertTransactionIngressValidatorSet }
  from "./validator-transaction-ingress-checkpoint.mjs";

const CONFIG_FIELDS = ["certificateDirectory", "certificateHeadAnchorPath",
  "expectedGenesisHash", "expectedNetworkId", "expectedPolicyId", "format",
  "genesisPath", "maxWitnessAgeMs", "policyPath", "version"];
const HASH = /^[0-9a-f]{64}$/;
const TAGGED_HASH = /^sha3-256:[0-9a-f]{64}$/;

function exact(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function readContext(path) {
  const value = readCanonical(path, "checkpoint v2 operator context", 16 * 1024);
  exact(value, CONFIG_FIELDS, "checkpoint v2 operator context");
  if (value.format !== "nir-checkpoint-v2-operator-context-v1" || value.version !== 1 ||
      !HASH.test(value.expectedGenesisHash ?? "") ||
      !TAGGED_HASH.test(value.expectedPolicyId ?? "") ||
      typeof value.expectedNetworkId !== "string" ||
      value.expectedNetworkId.length < 3 || value.expectedNetworkId.length > 128 ||
      !Number.isSafeInteger(value.maxWitnessAgeMs) ||
      value.maxWitnessAgeMs < 1 || value.maxWitnessAgeMs > 120_000 ||
      ["certificateDirectory", "certificateHeadAnchorPath", "genesisPath", "policyPath"]
        .some((field) => typeof value[field] !== "string" ||
          !isAbsolute(value[field]) || value[field].includes("\0"))) {
    throw new Error("checkpoint v2 operator context is invalid");
  }
  return value;
}

function trustedInputs(config) {
  const genesis = readCanonical(config.genesisPath, "checkpoint genesis");
  if (new NirChain(genesis).blocks()[0].hash !== config.expectedGenesisHash ||
      genesis.networkId !== config.expectedNetworkId) {
    throw new Error("checkpoint v2 genesis does not match external pins");
  }
  const policy = validateCheckpointWitnessPolicy(readCanonical(config.policyPath,
    "checkpoint witness policy", 1024 * 1024));
  if (policy.policyId !== config.expectedPolicyId ||
      policy.chainIdentityGenesisHash !== config.expectedGenesisHash ||
      policy.networkId !== config.expectedNetworkId) {
    throw new Error("checkpoint v2 witness policy does not match external pins");
  }
  const pins = new RuntimeCertificatePins(config.certificateDirectory, genesis, {
    mode: CERTIFICATE_MODE_LIFECYCLE,
    externalAnchorPath: config.certificateHeadAnchorPath,
  });
  const { context, history } = pins.loadVerifiedHistory();
  if (history.length < 1) throw new Error("checkpoint v2 certificate history is empty");
  return { commitment: { certificateHistoryHead: certificateHistoryHead(history, context),
    certificateRecordCount: history.length }, context, genesis, policy };
}

function nonnegative(value, label) {
  const parsed = Number(value);
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? "") ||
      !Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function candidateValidatorsAtHeight(genesisValidators, context, height) {
  if (!Array.isArray(genesisValidators) || !Array.isArray(context?.handoffs) ||
      !Number.isSafeInteger(height) || height < 0) {
    throw new Error("checkpoint v2 validator topology is unavailable");
  }
  let validators = genesisValidators;
  for (const handoff of context.handoffs) {
    if (handoff.activationHeight > height) break;
    validators = handoff.nextValidators;
  }
  return validators;
}

function writeExclusive(path, contents) {
  if (typeof path !== "string" || !isAbsolute(path) ||
      !Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW ||
      !Number.isInteger(constants.O_DIRECTORY) || !constants.O_DIRECTORY) {
    throw new Error("checkpoint v2 output path is invalid");
  }
  const target = resolve(path); const parent = openSync(dirname(target),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor); fsyncSync(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(parent);
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "assemble" && args.length === 5) {
    const [contextPath, proofPath, sequenceText, attestationsPath, outputPath] = args;
    const config = readContext(contextPath);
    const { commitment, context, genesis, policy } = trustedInputs(config);
    const finalityProof = readCanonical(proofPath, "checkpoint finality proof");
    const attestations = readCanonical(attestationsPath, "checkpoint v2 attestations");
    if (!Array.isArray(attestations)) throw new Error("checkpoint v2 attestations must be an array");
    const sequence = nonnegative(sequenceText, "checkpoint v2 sequence");
    // The proof height selects a candidate topology only; verification below authenticates it.
    const validators = candidateValidatorsAtHeight(genesis.validators, context,
      finalityProof?.header?.height);
    const packageValue = assembleCheckpointTrustPackageV2({ ...commitment, attestations,
      finalityProof, policy, sequence, validators });
    const verified = verifyCheckpointTrustPackageV2(packageValue, {
      expectedChainIdentityGenesisHash: config.expectedGenesisHash,
      expectedNetworkId: config.expectedNetworkId,
      expectedPolicyId: config.expectedPolicyId,
      maxAgeMs: config.maxWitnessAgeMs, maxFutureSkewMs: 5_000,
      minimumCheckpointHeight: 1, minimumSequence: sequence, now: Date.now(),
    });
    assertTransactionIngressValidatorSet(verified, genesis.validators, context);
    const bytes = serializeCheckpointTrustPackageV2(packageValue);
    if (Buffer.byteLength(bytes) > MAX_CHECKPOINT_TRUST_PACKAGE_BYTES) {
      throw new Error("checkpoint v2 package exceeds bounded size");
    }
    writeExclusive(outputPath, bytes);
    console.log(`Checkpoint v2 package ${packageValue.packageHash} assembled.`);
  } else if (command === "verify" && args.length === 5) {
    const [contextPath, packagePath, heightText, sequenceText, nowText] = args;
    const config = readContext(contextPath);
    const { commitment, context, genesis } = trustedInputs(config);
    const packageValue = readCanonical(packagePath, "checkpoint v2 package",
      MAX_CHECKPOINT_TRUST_PACKAGE_BYTES);
    const verified = verifyCheckpointTrustPackageV2(packageValue, {
      expectedChainIdentityGenesisHash: config.expectedGenesisHash,
      expectedNetworkId: config.expectedNetworkId,
      expectedPolicyId: config.expectedPolicyId,
      maxAgeMs: config.maxWitnessAgeMs, maxFutureSkewMs: 5_000,
      minimumCheckpointHeight: nonnegative(heightText, "minimum checkpoint height"),
      minimumSequence: nonnegative(sequenceText, "minimum sequence"),
      now: nonnegative(nowText, "observation time"),
    });
    if (verified.certificateHistoryHead !== commitment.certificateHistoryHead ||
        verified.certificateRecordCount !== commitment.certificateRecordCount) {
      throw new Error("checkpoint v2 package certificate head or count differs from verified history");
    }
    assertTransactionIngressValidatorSet(verified, genesis.validators, context);
    console.log(`Checkpoint v2 package ${verified.packageHash} verified.`);
  } else {
    throw new Error("usage: checkpoint:package-v2 assemble <context.json> <finality-proof.json> <sequence> <attestations.json> <new-package.json> | verify <context.json> <package.json> <minimum-height> <minimum-sequence> <now-ms>");
  }
} catch (error) {
  console.error(`Checkpoint v2 package ${command ?? "command"} failed: ${error.message}`);
  process.exitCode = 1;
}
