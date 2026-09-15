import { createHash } from "node:crypto";

import { canonicalJson } from "./crypto.mjs";

export const MIN_FRONTIER_GAIN_BPS = 100;
export const MAX_PARENT_REGRESSION_BPS = 500;
const MAX_CAPABILITIES = 256;
const INTERNAL_CLONE = Symbol("NIR capability-memory clone");

function requireDigest(value, field, prefixed = false) {
  let digest = value;
  if (prefixed) {
    if (typeof value !== "string" || !value.startsWith("sha256:")) {
      throw new Error(`${field} must use the sha256 prefix`);
    }
    digest = value.slice(7);
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${field} must contain a 256-bit digest`);
  }
}

function validatedScores(scores) {
  if (
    typeof scores !== "object" ||
    scores === null ||
    Array.isArray(scores)
  ) {
    throw new Error("capability scores must be an object");
  }
  const entries = Object.entries(scores);
  if (entries.length === 0 || entries.length > MAX_CAPABILITIES) {
    throw new Error("capability count is outside protocol limits");
  }
  for (const [capability, score] of entries) {
    if (
      !/^[a-z][a-z0-9._-]{0,110}-v[1-9][0-9]{0,8}$/.test(capability) ||
      !Number.isSafeInteger(score) ||
      score < 0 ||
      score > 10_000
    ) {
      throw new Error("capability score or identifier is invalid");
    }
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function memoryRoot(records, behaviors) {
  const orderedRecords = Object.fromEntries(
    [...records.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([artifact, scores]) => [artifact, validatedScores(scores)]),
  );
  const payload = {
    behaviors: [...behaviors].sort(),
    records: orderedRecords,
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function capabilityMemorySnapshotRoot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.behaviors) ||
      snapshot.records.length === 0 || snapshot.records.length > 100_000 ||
      snapshot.behaviors.length !== snapshot.records.length ||
      new Set(snapshot.behaviors).size !== snapshot.behaviors.length) {
    throw new Error("capability memory snapshot is invalid");
  }
  const records = new Map();
  for (const entry of snapshot.records) {
    if (!Array.isArray(entry) || entry.length !== 2 || records.has(entry[0])) {
      throw new Error("capability memory snapshot records are invalid");
    }
    requireDigest(entry[0], "snapshot artifact", true);
    records.set(entry[0], validatedScores(entry[1]));
  }
  const behaviors = new Set();
  for (const behavior of snapshot.behaviors) {
    requireDigest(behavior, "snapshot behavior");
    behaviors.add(behavior);
  }
  return memoryRoot(records, behaviors);
}

export class CapabilityMemory {
  #behaviors;
  #records;

  constructor(references = [], internal = null) {
    this.#behaviors = new Set();
    this.#records = new Map();
    if (internal?.token === INTERNAL_CLONE) {
      this.#records = new Map(
        internal.records.map(([artifact, scores]) => [
          artifact,
          structuredClone(scores),
        ]),
      );
      this.#behaviors = new Set(internal.behaviors);
      return;
    }
    if (!Array.isArray(references) || references.length === 0) {
      throw new Error("world capability snapshot requires reference models");
    }
    for (const reference of references) {
      requireDigest(reference.artifactHash, "reference artifact", true);
      requireDigest(reference.behaviorCommitment, "reference behavior");
      if (
        this.#records.has(reference.artifactHash) ||
        this.#behaviors.has(reference.behaviorCommitment)
      ) {
        throw new Error("world capability reference is duplicated");
      }
      this.#records.set(
        reference.artifactHash,
        validatedScores(reference.capabilitiesBps),
      );
      this.#behaviors.add(reference.behaviorCommitment);
    }
  }

  clone() {
    return new CapabilityMemory([], {
      token: INTERNAL_CLONE,
      records: [...this.#records.entries()],
      behaviors: [...this.#behaviors],
    });
  }

  get stateRoot() {
    return memoryRoot(this.#records, this.#behaviors);
  }

  snapshot() {
    return {
      behaviors: [...this.#behaviors].sort(),
      records: [...this.#records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([artifact, scores]) => [artifact, structuredClone(scores)]),
    };
  }

  get frontier() {
    const frontier = {};
    for (const scores of this.#records.values()) {
      for (const [capability, score] of Object.entries(scores)) {
        frontier[capability] = Math.max(frontier[capability] ?? 0, score);
      }
    }
    return validatedScores(frontier);
  }

  assess(evaluation) {
    requireDigest(evaluation.artifactHash, "artifact hash", true);
    requireDigest(evaluation.behaviorCommitment, "behavior commitment");
    requireDigest(evaluation.challengeSeed, "challenge seed");
    if (
      !Number.isSafeInteger(evaluation.committedEpoch) ||
      !Number.isSafeInteger(evaluation.challengeEpoch) ||
      evaluation.committedEpoch < 0 ||
      evaluation.challengeEpoch <= evaluation.committedEpoch
    ) {
      throw new Error("challenge must follow the artifact commitment");
    }
    if (
      !Array.isArray(evaluation.parents) ||
      evaluation.parents.length === 0 ||
      new Set(evaluation.parents).size !== evaluation.parents.length
    ) {
      throw new Error("at least one unique parent artifact is required");
    }
    const scores = validatedScores(evaluation.capabilitiesBps);
    if (this.#records.has(evaluation.artifactHash)) {
      throw new Error("artifact is already known");
    }
    if (this.#behaviors.has(evaluation.behaviorCommitment)) {
      throw new Error("behavior is already known");
    }

    const parentFrontier = {};
    for (const parent of evaluation.parents) {
      requireDigest(parent, "parent artifact", true);
      const parentScores = this.#records.get(parent);
      if (!parentScores) throw new Error("model lineage contains an unknown parent");
      for (const [capability, score] of Object.entries(parentScores)) {
        parentFrontier[capability] = Math.max(parentFrontier[capability] ?? 0, score);
      }
    }
    for (const [capability, parentScore] of Object.entries(parentFrontier)) {
      if (!(capability in scores)) {
        throw new Error("candidate omitted a capability measured in its parent");
      }
      if (scores[capability] < parentScore - MAX_PARENT_REGRESSION_BPS) {
        throw new Error("candidate regresses too far from its parent");
      }
    }

    const before = this.frontier;
    const gains = {};
    for (const [capability, score] of Object.entries(scores)) {
      const gain = score - (before[capability] ?? 0);
      if (gain >= MIN_FRONTIER_GAIN_BPS) gains[capability] = gain;
    }
    if (Object.keys(gains).length === 0) {
      throw new Error("candidate adds no new world-frontier capability");
    }
    const denominator = Math.max(
      1,
      Object.values(scores).reduce((total, score) => total + score, 0),
    );
    const noveltyBps = Math.max(
      1,
      Math.min(
        10_000,
        Math.floor(
          (Object.values(gains).reduce((total, gain) => total + gain, 0) * 10_000) /
            denominator,
        ),
      ),
    );

    const projectedRecords = new Map(this.#records);
    projectedRecords.set(evaluation.artifactHash, scores);
    const projectedBehaviors = new Set(this.#behaviors);
    projectedBehaviors.add(evaluation.behaviorCommitment);
    return {
      frontierRootBefore: this.stateRoot,
      frontierRootAfter: memoryRoot(projectedRecords, projectedBehaviors),
      marginalGainsBps: gains,
      noveltyBps,
    };
  }

  accept(evaluation) {
    const report = this.assess(evaluation);
    this.#records.set(
      evaluation.artifactHash,
      validatedScores(evaluation.capabilitiesBps),
    );
    this.#behaviors.add(evaluation.behaviorCommitment);
    return report;
  }
}
