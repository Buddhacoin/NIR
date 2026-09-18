const VALUES = ["A", "B"];
const NONE = -1;

function popcount(mask) {
  let value = mask;
  let count = 0;
  while (value) { count += value & 1; value >>>= 1; }
  return count;
}

function bit(index) { return 1 << index; }
function slot(round, value) { return round * VALUES.length + value; }
function slotRound(index) { return Math.floor(index / VALUES.length); }
function slotValue(index) { return index % VALUES.length; }
function clone(value) { return structuredClone(value); }
function canonical(value) { return JSON.stringify(value); }
function isByzantine(validator, bounds) {
  return validator >= bounds.validators - bounds.byzantine;
}

function quorumMasks(validators, quorum) {
  const result = [];
  for (let mask = 0; mask < 1 << validators; mask += 1) {
    if (popcount(mask) >= quorum) result.push(mask);
  }
  return result;
}

function initialState(bounds) {
  const slots = bounds.rounds * VALUES.length;
  return {
    certs: Array(slots).fill(false),
    commits: Array(slots).fill(0),
    finalized: null,
    locks: Array(bounds.validators).fill(NONE),
    prepares: Array(slots).fill(0),
    restarted: 0,
    roundValues: Array(bounds.validators).fill(NONE),
    rounds: Array(bounds.validators).fill(0),
    seen: Array(bounds.validators).fill(0),
    timeoutCerts: Array(slots).fill(false),
    timeouts: Array(slots).fill(0),
  };
}

function updateCertificate(next, certificate, bounds) {
  if (popcount(next.prepares[certificate]) >= bounds.quorum) next.certs[certificate] = true;
}

function updateTimeoutCertificate(next, certificate, bounds) {
  if (popcount(next.timeouts[certificate]) >= bounds.quorum) next.timeoutCerts[certificate] = true;
}

function updateFinality(next, bounds) {
  for (let certificate = 0; certificate < next.commits.length; certificate += 1) {
    if (!next.certs[certificate] || popcount(next.commits[certificate]) < bounds.quorum) continue;
    const value = VALUES[slotValue(certificate)];
    if (next.finalized === null) next.finalized = value;
    else if (next.finalized !== value) next.finalized = "CONFLICT";
  }
}

function preparedOtherValue(state, validator, round, value) {
  return VALUES.some((_, candidate) => candidate !== value &&
    (state.prepares[slot(round, candidate)] & bit(validator)) !== 0);
}

function timedOutOtherValue(state, validator, nextRound, value) {
  return VALUES.some((_, candidate) => candidate !== value &&
    (state.timeouts[slot(nextRound, candidate)] & bit(validator)) !== 0);
}

function applyAction(state, action, bounds, options = {}) {
  const next = clone(state);
  const validator = action.validator;
  if (action.type === "prepare") {
    const round = state.rounds[validator];
    if (round > 0 && state.roundValues[validator] !== action.value) return null;
    if (!isByzantine(validator, bounds) &&
        preparedOtherValue(state, validator, round, action.value)) return null;
    const certificate = slot(round, action.value);
    if (state.prepares[certificate] & bit(validator)) return { duplicate: true, next };
    next.prepares[certificate] |= bit(validator);
    updateCertificate(next, certificate, bounds);
    return { next };
  }
  if (action.type === "observe") {
    if (!state.certs[action.certificate]) return null;
    if (state.seen[validator] & bit(action.certificate)) return { duplicate: true, next };
    next.seen[validator] |= bit(action.certificate);
    return { next };
  }
  if (action.type === "commit") {
    if (!(state.seen[validator] & bit(action.certificate))) return null;
    const value = slotValue(action.certificate);
    if (!isByzantine(validator, bounds) && state.locks[validator] !== NONE &&
        state.locks[validator] !== value && !options.ignoreCommitLock) return null;
    if (state.commits[action.certificate] & bit(validator)) return { duplicate: true, next };
    next.commits[action.certificate] |= bit(validator);
    if (!isByzantine(validator, bounds)) next.locks[validator] = value;
    updateFinality(next, bounds);
    return { next };
  }
  if (action.type === "commit-quorum") {
    if (!state.certs[action.certificate] || popcount(action.mask) < bounds.quorum) return null;
    const value = slotValue(action.certificate);
    for (let member = 0; member < bounds.validators; member += 1) {
      if (!(action.mask & bit(member))) continue;
      if (!isByzantine(member, bounds) && state.locks[member] !== NONE &&
          state.locks[member] !== value && !options.ignoreCommitLock) return null;
      next.seen[member] |= bit(action.certificate);
      next.commits[action.certificate] |= bit(member);
      if (!isByzantine(member, bounds)) next.locks[member] = value;
    }
    updateFinality(next, bounds);
    return { next };
  }
  if (action.type === "timeout") {
    const nextRound = state.rounds[validator] + 1;
    if (nextRound >= bounds.rounds) return null;
    if (state.rounds[validator] > 0 && state.roundValues[validator] !== action.value) return null;
    if (!isByzantine(validator, bounds)) {
      if (timedOutOtherValue(state, validator, nextRound, action.value)) return null;
      if (state.locks[validator] !== NONE && state.locks[validator] !== action.value &&
          !options.ignoreCommitLock) return null;
    }
    const certificate = slot(nextRound, action.value);
    if (state.timeouts[certificate] & bit(validator)) return { duplicate: true, next };
    next.timeouts[certificate] |= bit(validator);
    updateTimeoutCertificate(next, certificate, bounds);
    return { next };
  }
  if (action.type === "advance") {
    const nextRound = state.rounds[validator] + 1;
    const certificate = slot(nextRound, action.value);
    if (nextRound >= bounds.rounds || !state.timeoutCerts[certificate]) return null;
    if (!isByzantine(validator, bounds) && state.locks[validator] !== NONE &&
        state.locks[validator] !== action.value && !options.ignoreCommitLock) return null;
    next.rounds[validator] = nextRound;
    next.roundValues[validator] = action.value;
    return { next };
  }
  if (action.type === "restart") {
    if (isByzantine(validator, bounds) || (state.restarted & bit(validator))) return null;
    next.seen[validator] = 0;
    next.restarted |= bit(validator);
    return { next };
  }
  throw new Error(`unknown model action ${action.type}`);
}

function actions(state, bounds) {
  const result = [];
  for (let validator = 0; validator < bounds.validators; validator += 1) {
    for (let value = 0; value < VALUES.length; value += 1) {
      result.push({ type: "prepare", validator, value });
      result.push({ type: "timeout", validator, value });
      result.push({ type: "advance", validator, value });
    }
    if (state.seen[validator] !== 0) result.push({ type: "restart", validator });
  }
  for (let certificate = 0; certificate < state.certs.length; certificate += 1) {
    if (!state.certs[certificate]) continue;
    for (let validator = 0; validator < bounds.validators; validator += 1) {
      result.push({ certificate, type: "observe", validator });
      result.push({ certificate, type: "commit", validator });
    }
    for (const mask of quorumMasks(bounds.validators, bounds.quorum)) {
      result.push({ certificate, mask, type: "commit-quorum" });
    }
  }
  return result;
}

function actionLabel(action) {
  const value = action.value === undefined ? undefined : VALUES[action.value];
  const certificate = action.certificate === undefined ? undefined : {
    round: slotRound(action.certificate), value: VALUES[slotValue(action.certificate)],
  };
  return { ...action, certificate, value };
}

function counterexample(invariant, state, trace) { return { invariant, state, trace }; }

function lockInvariant(previous, next, bounds) {
  for (let validator = 0; validator < bounds.validators; validator += 1) {
    if (isByzantine(validator, bounds)) continue;
    if (previous.locks[validator] !== NONE &&
        next.locks[validator] !== previous.locks[validator]) return false;
  }
  return true;
}

export function runBoundedFinalityModel(options = {}) {
  const bounds = {
    byzantine: options.byzantine ?? 1,
    maxDepth: options.maxDepth ?? 8,
    maxStates: options.maxStates ?? 300_000,
    quorum: options.quorum ?? 3,
    rounds: options.rounds ?? 2,
    validators: options.validators ?? 4,
  };
  if (bounds.validators !== 4 || bounds.quorum !== 3 || bounds.byzantine !== 1 ||
      bounds.rounds !== 2 || bounds.maxDepth < 1 || bounds.maxDepth > 20) {
    throw new Error("unsupported bounded finality model configuration");
  }
  const start = initialState(bounds);
  const queue = [{ depth: 0, state: start, trace: [] }];
  let cursor = 0;
  const visited = new Set([canonical(start)]);
  let transitions = 0;
  let duplicateDeliveries = 0;
  let individualCertificateDeliveries = 0;
  let finalizedStates = 0;
  let perValidatorRoundStates = 0;
  let timeoutCertificateStates = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    if (current.state.finalized === "CONFLICT") {
      return { bounds, counterexample: counterexample("no-conflicting-finality",
        current.state, current.trace), ok: false };
    }
    if (current.depth >= bounds.maxDepth) continue;
    for (const action of actions(current.state, bounds)) {
      const applied = applyAction(current.state, action, bounds, options);
      if (!applied) continue;
      transitions += 1;
      if (applied.duplicate) duplicateDeliveries += 1;
      if (action.type === "observe") individualCertificateDeliveries += 1;
      const trace = [...current.trace, actionLabel(action)];
      if (!lockInvariant(current.state, applied.next, bounds)) {
        return { bounds, counterexample: counterexample("durable-commit-lock-preservation",
          applied.next, trace), ok: false };
      }
      const key = canonical(applied.next);
      if (key === canonical(current.state) || visited.has(key)) continue;
      visited.add(key);
      if (visited.size > bounds.maxStates) throw new Error("bounded finality state limit exceeded");
      if (new Set(applied.next.rounds).size > 1) perValidatorRoundStates += 1;
      if (applied.next.timeoutCerts.some(Boolean)) timeoutCertificateStates += 1;
      if (applied.next.finalized !== null) finalizedStates += 1;
      queue.push({ depth: current.depth + 1, state: applied.next, trace });
    }
  }
  return {
    bounds,
    counterexample: null,
    coverage: {
      duplicateDeliveries,
      finalizedStates,
      individualCertificateDeliveries,
      quorumCommitAbstraction: "commit-quorum batches one complete quorum response; individual deliveries remain enabled",
      messageSemantics: "each prepare-certificate delivery is an independent validator action",
      omissionSemantics: "an enabled action may remain unchosen before maxDepth",
      perValidatorRoundStates,
      restartModel: "volatile certificate observations clear; prepares, commits, locks, rounds, and timeouts persist",
      timeoutCertificateStates,
    },
    exploredStates: visited.size,
    invariants: {
      durableCommitLockPreservation: true,
      noConflictingFinalityAtHeight: true,
    },
    ok: true,
    transitions,
  };
}

export function findConflictingFinalityMutant() {
  const quorum = [0, 1, 2];
  const trace = [];
  for (const validator of quorum) trace.push({ type: "prepare", validator, value: "A" });
  for (const validator of quorum) trace.push(
    { certificate: { round: 0, value: "A" }, type: "observe", validator },
    { certificate: { round: 0, value: "A" }, type: "commit", validator });
  for (const validator of quorum) trace.push({ type: "timeout", validator, value: "B" });
  for (const validator of quorum) trace.push({ type: "advance", validator, value: "B" });
  for (const validator of quorum) trace.push({ type: "prepare", validator, value: "B" });
  for (const validator of quorum) trace.push(
    { certificate: { round: 1, value: "B" }, type: "observe", validator },
    { certificate: { round: 1, value: "B" }, type: "commit", validator });
  const result = executeModelTrace(trace, { ignoreCommitLock: true });
  if (!result.accepted || result.state.finalized !== "CONFLICT") {
    throw new Error("commit-lock mutant did not reach conflicting finality");
  }
  return result.counterexample;
}

const OLD = [0, 1, 2, 3];
const NEW = [2, 3, 4, 5];
const TRANSITION_QUORUM = 3;
const ACTIVATION_HEIGHT = 10;
const OLD_MASK = OLD.reduce((mask, validator) => mask | bit(validator), 0);
const NEW_MASK = NEW.reduce((mask, validator) => mask | bit(validator), 0);

function setQuorums(voters) {
  return {
    newQuorum: popcount(voters & NEW_MASK) >= TRANSITION_QUORUM,
    oldQuorum: popcount(voters & OLD_MASK) >= TRANSITION_QUORUM,
  };
}

function transitionCertificateAccepted(state, certificate) {
  if (certificate.height !== state.height || certificate.epoch !== state.epoch) return false;
  const { newQuorum, oldQuorum } = setQuorums(certificate.voters);
  if (state.phase === "old") return certificate.phase === "old" && oldQuorum;
  if (state.phase === "joint") return certificate.phase === "joint" && oldQuorum && newQuorum;
  return certificate.phase === "active-new" && newQuorum;
}

function advanceTransition(state, certificate) {
  if (!transitionCertificateAccepted(state, certificate)) return null;
  const next = clone(state);
  next.history.push({ certificate: clone(certificate), phase: state.phase });
  next.height += 1;
  if (state.phase === "old" && state.height + 1 === ACTIVATION_HEIGHT) next.phase = "joint";
  else if (state.phase === "joint") {
    next.phase = "active-new";
    next.epoch += 1;
  }
  return next;
}

export function runBoundedValidatorTransitionModel() {
  let assignments = 0;
  let jointCertificates = 0;
  for (let encoded = 0; encoded < 4 * (3 ** 5); encoded += 1) {
    let remaining = encoded;
    const choices = [];
    for (let validator = 0; validator < 6; validator += 1) {
      const radix = validator === 3 ? 4 : 3;
      choices.push(remaining % radix);
      remaining = Math.floor(remaining / radix);
    }
    let votesA = 0;
    let votesB = 0;
    for (let validator = 0; validator < choices.length; validator += 1) {
      if (choices[validator] === 1 || choices[validator] === 3) votesA |= bit(validator);
      if (choices[validator] === 2 || choices[validator] === 3) votesB |= bit(validator);
    }
    assignments += 1;
    const a = setQuorums(votesA);
    const b = setQuorums(votesB);
    const jointA = a.oldQuorum && a.newQuorum;
    const jointB = b.oldQuorum && b.newQuorum;
    jointCertificates += Number(jointA) + Number(jointB);
    if (jointA && jointB) return { assignments, counterexample: {
      invariant: "joint-transition-no-conflict", trace: [{ choices, votesA, votesB }],
    }, ok: false };
  }

  let state = { epoch: 0, height: ACTIVATION_HEIGHT - 1, history: [], phase: "old" };
  state = advanceTransition(state, {
    epoch: 0, height: ACTIVATION_HEIGHT - 1, phase: "old", voters: 0b001111,
  });
  state = advanceTransition(state, {
    epoch: 0, height: ACTIVATION_HEIGHT, phase: "joint", voters: 0b111111,
  });
  if (!state || state.phase !== "active-new" || state.epoch !== 1) {
    return { assignments, counterexample: { invariant: "validator-transition-history" }, ok: false };
  }
  let rejectedStaleCertificates = 0;
  for (const stale of [
    { epoch: 0, height: ACTIVATION_HEIGHT, phase: "joint", voters: 0b111111 },
    { epoch: 1, height: ACTIVATION_HEIGHT + 1, phase: "old", voters: 0b001111 },
    { epoch: 1, height: ACTIVATION_HEIGHT, phase: "active-new", voters: 0b111100 },
  ]) {
    if (advanceTransition(state, stale) === null) rejectedStaleCertificates += 1;
  }
  return {
    activationHeight: ACTIVATION_HEIGHT,
    assignments,
    counterexample: null,
    history: state.history,
    invariants: {
      jointCertificatesRequireBothQuorums: true,
      noConflictingJointCertificates: true,
      staleCertificatesRejectedAfterActivation: rejectedStaleCertificates === 3,
    },
    jointCertificates,
    membership: { new: NEW, old: OLD, overlap: OLD.filter((member) => NEW.includes(member)) },
    ok: rejectedStaleCertificates === 3,
    rejectedStaleCertificates,
    terminalState: { epoch: state.epoch, height: state.height, phase: state.phase },
  };
}

export function runConsensusScenarioSmokeChecks() {
  const normal = executeModelTrace([
    ...[0, 1, 2].map((validator) => ({ type: "prepare", validator, value: "A" })),
    ...[0, 1, 2].flatMap((validator) => [
      { certificate: { round: 0, value: "A" }, type: "observe", validator },
      { certificate: { round: 0, value: "A" }, type: "commit", validator },
    ]),
  ]);
  const replacement = executeModelTrace([
    ...[0, 1, 2].map((validator) => ({ type: "timeout", validator, value: "A" })),
    ...[0, 1, 2].map((validator) => ({ type: "advance", validator, value: "A" })),
    ...[0, 1, 2].map((validator) => ({ type: "prepare", validator, value: "A" })),
    ...[0, 1, 2].flatMap((validator) => [
      { certificate: { round: 1, value: "A" }, type: "observe", validator },
      { certificate: { round: 1, value: "A" }, type: "commit", validator },
    ]),
  ]);
  return {
    claim: "scenario-smoke-check-only",
    normalRoundFinalized: normal.state.finalized === "A",
    ok: normal.state.finalized === "A" && replacement.state.finalized === "A",
    replacementRoundFinalized: replacement.state.finalized === "A",
    scenarios: ["normal quorum path", "value-bound timeout and replacement-round path"],
  };
}

export function runFormalConsensusSuite(options = {}) {
  const finality = runBoundedFinalityModel(options);
  const transition = runBoundedValidatorTransitionModel();
  const scenarios = runConsensusScenarioSmokeChecks();
  return {
    counterexample: finality.counterexample ?? transition.counterexample ?? null,
    finality,
    format: "nir-bounded-consensus-model-v2",
    ok: finality.ok && transition.ok && scenarios.ok,
    scenarios,
    transition,
  };
}

export function executeModelTrace(trace, options = {}) {
  const bounds = { byzantine: 1, quorum: 3, rounds: 2, validators: 4 };
  let state = initialState(bounds);
  const appliedTrace = [];
  for (const action of trace) {
    const value = typeof action.value === "string" ? VALUES.indexOf(action.value) : action.value;
    const certificate = action.certificate && typeof action.certificate === "object"
      ? slot(action.certificate.round, VALUES.indexOf(action.certificate.value))
      : action.certificate;
    if ((value !== undefined && !VALUES[value]) ||
        (certificate !== undefined && (!Number.isInteger(certificate) || certificate < 0 ||
          certificate >= bounds.rounds * VALUES.length))) {
      return { accepted: false, appliedTrace, state };
    }
    const normalized = { ...action, certificate, value };
    const result = applyAction(state, normalized, bounds, options);
    if (!result) return { accepted: false, appliedTrace, state };
    state = result.next;
    appliedTrace.push(actionLabel(normalized));
  }
  return {
    accepted: true,
    appliedTrace,
    counterexample: state.finalized === "CONFLICT"
      ? counterexample("no-conflicting-finality", state, appliedTrace) : null,
    state,
  };
}
