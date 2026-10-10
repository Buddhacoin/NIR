import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const DATA_SHA256 = "596ffd580471ca4d4880f8e439c7281f3b50d8249a5960353cb200b1490f63a0";
const FORMAT = "nir-iris-integer-linear-v1";
const LABELS = ["Iris-setosa", "Iris-versicolor", "Iris-virginica"];
export const MAX_IRIS_MODEL_BYTES = 4096;
const STRESS_DOMAIN = "NIR_LOCAL_IRIS_POSTCOMMIT_STRESS_V1\0";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function readDataset(root) {
  const descriptor = openSync(join(root, "examples/iris.data"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 20_000)
      throw new Error("pinned Iris dataset is not a bounded regular file");
    const bytes = Buffer.alloc(stat.size);
    if (readSync(descriptor, bytes, 0, stat.size, 0) !== stat.size ||
        createHash("sha256").update(bytes).digest("hex") !== DATA_SHA256)
      throw new Error("pinned Iris dataset changed");
    const records = bytes.toString("ascii").trimEnd().split("\n");
    if (records.length !== 150) throw new Error("pinned Iris row count changed");
    const counts = [0, 0, 0];
    const rows = records.map((record) => {
      const fields = record.trimEnd().split(",");
      const label = LABELS.indexOf(fields[4]);
      if (fields.length !== 5 || label < 0 ||
          fields.slice(0, 4).some((value) => !/^(?:[0-9]|1[0-9])\.[0-9]$/.test(value)))
        throw new Error("pinned Iris row shape changed");
      counts[label]++;
      return { features: fields.slice(0, 4).map((value) =>
        Number(value.replace(".", ""))), label };
    });
    if (counts.some((count) => count !== 50)) throw new Error("pinned Iris labels changed");
    return rows;
  } finally { closeSync(descriptor); }
}

function parseModel(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_IRIS_MODEL_BYTES)
    throw new Error("Iris model size is invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const model = JSON.parse(body);
  if (!model || typeof model !== "object" || Array.isArray(model) ||
      Object.keys(model).sort().join(",") !== "bias,format,weights" ||
      model.format !== FORMAT || !Array.isArray(model.bias) || model.bias.length !== 3 ||
      !Array.isArray(model.weights) || model.weights.length !== 3 ||
      model.bias.some((value) => !Number.isSafeInteger(value) || Math.abs(value) > 1_000_000) ||
      model.weights.some((row) => !Array.isArray(row) || row.length !== 4 ||
        row.some((value) => !Number.isSafeInteger(value) || Math.abs(value) > 20_000)) ||
      body !== canonicalJson(model))
    throw new Error("Iris model must be exact canonical integer data, not code");
  return { model, canonical: body };
}

export function evaluateIrisLinearCandidate(root, modelBytes) {
  const { model, canonical } = parseModel(modelBytes);
  const rows = readDataset(root);
  const training = rows.filter((_, index) => index % 5 !== 0);
  const heldOut = rows.filter((_, index) => index % 5 === 0);
  const sums = LABELS.map((_, label) => [0, 1].map((feature) => training.reduce((total, row) =>
    total + (row.label === label ? row.features[feature] : 0), 0)));
  if (LABELS.some((_, label) => training.filter((row) => row.label === label).length !== 40))
    throw new Error("pinned Iris training split changed");
  let baselineCorrect = 0;
  let candidateCorrect = 0;
  for (const row of heldOut) {
    const baseline = LABELS.map((_, label) =>
      (40 * row.features[0] - sums[label][0]) ** 2 +
      (40 * row.features[1] - sums[label][1]) ** 2);
    const scores = model.bias.map((bias, label) => bias + model.weights[label].reduce((total, weight, index) =>
      total + weight * row.features[index], 0));
    if (baseline.indexOf(Math.min(...baseline)) === row.label) baselineCorrect++;
    if (scores.indexOf(Math.max(...scores)) === row.label) candidateCorrect++;
  }
  return {
    status: "local-iris-data-model-evaluated", scope: "public-iris-data-only",
    modelHash: `sha256:${createHash("sha256").update("NIR_IRIS_INTEGER_LINEAR_V1\0")
      .update(canonical).digest("hex")}`,
    datasetHash: `sha256:${DATA_SHA256}`,
    baselineAccuracyBps: Math.floor(baselineCorrect * 10_000 / heldOut.length),
    candidateAccuracyBps: Math.floor(candidateCorrect * 10_000 / heldOut.length),
    caseCount: heldOut.length, independentOperators: false, hiddenChallenges: false,
    networkSubmitted: false, rewardEligible: false, walletChanged: false,
  };
}

export function hashIrisModelCommit(modelBytes) {
  parseModel(modelBytes);
  return `sha256:${createHash("sha256").update(STRESS_DOMAIN)
    .update(DATA_SHA256).update("\0").update(modelBytes).digest("hex")}`;
}

export function evaluateIrisPostCommitStress(root, modelBytes, seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error("local stress seed is invalid");
  const { model } = parseModel(modelBytes);
  const rows = readDataset(root);
  const training = rows.filter((_, index) => index % 5 !== 0);
  const heldOut = rows.filter((_, index) => index % 5 === 0);
  const sums = LABELS.map((_, label) => [0, 1].map((feature) => training.reduce((total, row) =>
    total + (row.label === label ? row.features[feature] : 0), 0)));
  let baselineCorrect = 0;
  let candidateCorrect = 0;
  for (let index = 0; index < heldOut.length; index++) {
    const row = heldOut[index];
    for (let variant = 0; variant < 3; variant++) {
      const features = row.features.map((value, feature) => {
        const choice = createHash("sha256").update(STRESS_DOMAIN).update(seed)
          .update(Buffer.from([index, variant, feature])).digest()[0] % 3;
        return value + choice - 1;
      });
      const baseline = LABELS.map((_, label) =>
        (40 * features[0] - sums[label][0]) ** 2 +
        (40 * features[1] - sums[label][1]) ** 2);
      const scores = model.bias.map((bias, label) => bias + model.weights[label].reduce((total, weight, feature) =>
        total + weight * features[feature], 0));
      if (baseline.indexOf(Math.min(...baseline)) === row.label) baselineCorrect++;
      if (scores.indexOf(Math.max(...scores)) === row.label) candidateCorrect++;
    }
  }
  return {
    status: "local-postcommit-iris-stress", scope: "public-iris-synthetic-perturbations-only",
    modelHash: evaluateIrisLinearCandidate(root, modelBytes).modelHash,
    commitHash: hashIrisModelCommit(modelBytes),
    datasetHash: `sha256:${DATA_SHA256}`, seed: seed.toString("hex"),
    baselineAccuracyBps: Math.floor(baselineCorrect * 10_000 / 90),
    candidateAccuracyBps: Math.floor(candidateCorrect * 10_000 / 90),
    caseCount: 90, syntheticPerturbations: true, independentOperators: false,
    hiddenChallenges: false, networkSubmitted: false, rewardEligible: false, walletChanged: false,
  };
}

export function recheckIrisPostCommitRecord(root, modelBytes, record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      !/^[0-9a-f]{64}$/.test(record.seed ?? ""))
    throw new Error("local Iris record is invalid");
  const expected = evaluateIrisPostCommitStress(root, modelBytes, Buffer.from(record.seed, "hex"));
  const matched = isDeepStrictEqual(record, expected);
  return { status: matched ? "local-iris-recheck-matched" : "local-iris-recheck-mismatch",
    modelHash: expected.modelHash, commitHash: expected.commitHash, caseCount: 90,
    baselineAccuracyBps: expected.baselineAccuracyBps,
    candidateAccuracyBps: expected.candidateAccuracyBps,
    independentOperators: false, operatorIdentityVerified: false,
    hiddenChallenges: false, networkSubmitted: false, rewardEligible: false,
    walletChanged: false };
}
