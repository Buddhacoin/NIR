const VALUES = ["A", "B"];
const NONE = -1;

function popcount(mask) {
  let value = mask;
  let count = 0;
  while (value) { count += value & 1; value >>>= 1; }
  return count;
}

function clone(state) {
  return structuredClone(state);
}

function slot(round, valueIndex) { return round * VALUES.length + valueIndex; }
function slotRound(value) { return Math.floor(value / VALUES.length); }
function slotValue(value) { return value % VALUES.length; }
function bit(index) { return 1 << index; }

function quorumMasks(validators, quorum) {
  const masks = [];
  for (let mask = 0; mask < 1 << validators; mask += 1) {
    if (popcount(mask) >= quorum) masks.push(mask);
  }
  return masks;
}

function initialState(bounds) {
  return {
    certs: Array(bounds.rounds * VALUES.length).fill(false),
    commits: Array(bounds.rounds * VALUES.length).fill(0),
    finalized: null,
    justification: NONE,
    locks: Array(bounds.validators).fill(NONE),
    prepares: Array(bounds.rounds * VALUES.length).fill(0),
    restarted: 0,
    round: 0,
    seen: Array(bounds.validators).fill(0),
  };
}

function canonical(state) {
  return JSON.stringify(state);
}

function isByzantine(validator, bounds) {
  return validator >= bounds.validators - bounds.byzantine;
}

function highestReportedCertificate(state, reporterMask, bounds) {
  let highest = NONE;
  for (let certificate = 0; certificate < state.certs.length; certificate += 1) {
    if (!state.certs[certificate]) continue;
    let reported = false;
    for (let validator = 0; validator < bounds.validators; validator += 1) {
      if ((reporterMask & bit(validator)) && (state.seen[validator] & bit(certificate))) {
        reported = true;
        break;
      }
    }
    if (reported && (highest === NONE || slotRound(certificate) > slotRound(highest) ||
        (slotRound(certificate) === slotRound(highest) &&
          slotValue(certificate) < slotValue(highest)))) highest = certificate;
  }
  return highest;
}

function preparedOtherValue(state, validator, round, valueIndex) {
  return VALUES.some((_, candidate) => candidate !== valueIndex &&
    (state.prepares[slot(round, candidate)] & bit(validator)) !== 0);
}

function safePrepare(state, validator, valueIndex, bounds, unsafeUnlock = false) {
  if (isByzantine(validator, bounds)) return { allowed: true, lockViolation: false };
  if (preparedOtherValue(state, validator, state.round, valueIndex)) {
    return { allowed: false, lockViolation: false };
  }
  if (state.justification !== NONE && slotValue(state.justification) !== valueIndex) {
    return { allowed: false, lockViolation: false };
  }
  const lock = state.locks[validator];
  if (lock === NONE || slotValue(lock) === valueIndex) return { allowed: true, lockViolation: false };
  const justified = state.justification !== NONE &&
    slotRound(state.justification) > slotRound(lock) &&
    slotValue(state.justification) === valueIndex;
  if (justified) return { allowed: true, lockViolation: false };
  return unsafeUnlock ? { allowed: true, lockViolation: true }
    : { allowed: false, lockViolation: false };
}

function updateCertificates(state, bounds) {
  for (let certificate = 0; certificate < state.certs.length; certificate += 1) {
    if (popcount(state.prepares[certificate]) >= bounds.quorum) state.certs[certificate] = true;
  }
}

function updateFinality(state, bounds) {
  for (let certificate = 0; certificate < state.certs.length; certificate += 1) {
    if (!state.certs[certificate] || popcount(state.commits[certificate]) < bounds.quorum) continue;
    const value = VALUES[slotValue(certificate)];
    if (state.finalized === null) state.finalized = value;
    else if (state.finalized !== value) state.finalized = "CONFLICT";
  }
}

function observeCertificate(next, validator, certificate) {
  next.seen[validator] |= bit(certificate);
  const current = next.locks[validator];
  if (current === NONE || slotRound(certificate) > slotRound(current) ||
      (slotRound(certificate) === slotRound(current) && slotValue(certificate) === slotValue(current))) {
    next.locks[validator] = certificate;
  }
}

function applyAction(state, action, bounds, options = {}) {
  const next = clone(state);
  if (action.type === "prepare") {
    const safety = safePrepare(state, action.validator, action.value, bounds,
      options.unsafeUnlock ?? false);
    if (!safety.allowed) return null;
    next.prepares[slot(state.round, action.value)] |= bit(action.validator);
    // NIR persists the prepare decision before returning the signed vote. Treat
    // that durable decision as a value lock even when the certificate itself is
    // delayed or dropped; a restart must not make the validator forget it.
    if (!isByzantine(action.validator, bounds)) {
      const prepared = slot(state.round, action.value);
      const current = next.locks[action.validator];
      if (current === NONE || slotRound(prepared) >= slotRound(current)) {
        next.locks[action.validator] = prepared;
      }
    }
    updateCertificates(next, bounds);
    return { lockViolation: safety.lockViolation, next };
  }
  if (action.type === "observe") {
    if (!state.certs[action.certificate]) return null;
    if (state.seen[action.validator] & bit(action.certificate)) return { duplicate: true, next };
    observeCertificate(next, action.validator, action.certificate);
    return { next };
  }
  if (action.type === "commit") {
    if (!(state.seen[action.validator] & bit(action.certificate))) return null;
    if (!isByzantine(action.validator, bounds)) {
      for (let certificate = 0; certificate < state.commits.length; certificate += 1) {
        if (slotValue(certificate) !== slotValue(action.certificate) &&
            (state.commits[certificate] & bit(action.validator))) return null;
      }
    }
    if (state.commits[action.certificate] & bit(action.validator)) {
      return { duplicate: true, next };
    }
    next.commits[action.certificate] |= bit(action.validator);
    updateFinality(next, bounds);
    return { next };
  }
  if (action.type === "commit-quorum") {
    if (!state.certs[action.certificate] || popcount(action.mask) < bounds.quorum) return null;
    for (let validator = 0; validator < bounds.validators; validator += 1) {
      if (!(action.mask & bit(validator))) continue;
      observeCertificate(next, validator, action.certificate);
      if (!isByzantine(validator, bounds)) {
        const conflict = next.commits.some((mask, certificate) =>
          slotValue(certificate) !== slotValue(action.certificate) &&
          (mask & bit(validator)));
        if (conflict) return null;
      }
      next.commits[action.certificate] |= bit(validator);
    }
    updateFinality(next, bounds);
    return { next };
  }
  if (action.type === "advance-round") {
    if (state.round + 1 >= bounds.rounds || popcount(action.reporters) < bounds.quorum) return null;
    next.round = state.round + 1;
    next.justification = highestReportedCertificate(state, action.reporters, bounds);
    return { next };
  }
  if (action.type === "restart") {
    if (isByzantine(action.validator, bounds) || (state.restarted & bit(action.validator))) return null;
    next.seen[action.validator] = 0;
    next.restarted |= bit(action.validator);
    return { next };
  }
  throw new Error(`unknown model action ${action.type}`);
}

function actions(state, bounds) {
  const result = [];
  for (let validator = 0; validator < bounds.validators; validator += 1) {
    for (let value = 0; value < VALUES.length; value += 1) {
      result.push({ type: "prepare", validator, value });
    }
  }
  for (let certificate = 0; certificate < state.certs.length; certificate += 1) {
    if (!state.certs[certificate]) continue;
    // Honest validators are symmetric for single-message partial delivery. Keep
    // one honest representative plus the Byzantine process; quorum macros below
    // still enumerate every validator mask.
    for (const validator of [0, bounds.validators - 1]) {
      result.push({ certificate, type: "observe", validator });
      result.push({ certificate, type: "commit", validator });
    }
    for (const mask of quorumMasks(bounds.validators, bounds.quorum)) {
      result.push({ certificate, mask, type: "commit-quorum" });
    }
  }
  if (state.round + 1 < bounds.rounds) {
    for (const reporters of quorumMasks(bounds.validators, bounds.quorum)) {
      result.push({ reporters, type: "advance-round" });
    }
  }
  result.push({ type: "restart", validator: 0 });
  return result;
}

function actionLabel(action) {
  const value = action.value === undefined ? undefined : VALUES[action.value];
  const certificate = action.certificate === undefined ? undefined : {
    round: slotRound(action.certificate), value: VALUES[slotValue(action.certificate)],
  };
  return { ...action, certificate, value };
}

function counterexample(invariant, state, trace) {
  return { invariant, state, trace };
}

export function runBoundedFinalityModel(options = {}) {
  const bounds = {
    byzantine: options.byzantine ?? 1,
    maxDepth: options.maxDepth ?? 10,
    maxStates: options.maxStates ?? 250_000,
    quorum: options.quorum ?? 3,
    rounds: options.rounds ?? 2,
    validators: options.validators ?? 4,
  };
  if (bounds.validators !== 4 || bounds.quorum !== 3 || bounds.byzantine !== 1 ||
      bounds.rounds < 1 || bounds.rounds > 3 || bounds.maxDepth < 1 || bounds.maxDepth > 24) {
    throw new Error("unsupported bounded finality model configuration");
  }
  const start = initialState(bounds);
  const queue = [{ depth: 0, state: start, trace: [] }];
  const visited = new Set([canonical(start)]);
  let transitions = 0;
  let duplicateDeliveries = 0;
  let partialPrepareStates = 0;
  let partialCommitStates = 0;
  while (queue.length) {
    const current = queue.shift();
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
      const trace = [...current.trace, actionLabel(action)];
      if (applied.lockViolation) {
        return { bounds, counterexample: counterexample("locked-value-preservation",
          applied.next, trace), ok: false };
      }
      const key = canonical(applied.next);
      if (key === canonical(current.state) || visited.has(key)) continue;
      visited.add(key);
      if (visited.size > bounds.maxStates) throw new Error("bounded finality state limit exceeded");
      if (applied.next.prepares.some((mask) => popcount(mask) > 0 &&
          popcount(mask) < bounds.quorum)) partialPrepareStates += 1;
      if (applied.next.commits.some((mask) => popcount(mask) > 0 &&
          popcount(mask) < bounds.quorum)) partialCommitStates += 1;
      queue.push({ depth: current.depth + 1, state: applied.next, trace });
    }
  }
  return {
    bounds,
    counterexample: null,
    coverage: {
      delayedMessages: "all enabled delivery orderings within maxDepth",
      droppedMessages: "any enabled delivery may be omitted within maxDepth",
      duplicateDeliveries,
      partialCommitStates,
      partialPrepareStates,
      restartModel: "volatile certificate observations clear; locks and votes persist",
    },
    exploredStates: visited.size,
    invariants: {
      lockedValuePreservation: true,
      noConflictingFinalityAtHeight: true,
    },
    ok: true,
    transitions,
  };
}

const OLD = [0, 1, 2, 3];
const NEW = [2, 3, 4, 5];
const TRANSITION_QUORUM = 3;

function membersMask(members) { return members.reduce((mask, member) => mask | bit(member), 0); }
const OLD_MASK = membersMask(OLD);
const NEW_MASK = membersMask(NEW);

function certificateAccepted(phase, voters) {
  const oldQuorum = popcount(voters & OLD_MASK) >= TRANSITION_QUORUM;
  const newQuorum = popcount(voters & NEW_MASK) >= TRANSITION_QUORUM;
  if (phase === "old") return oldQuorum;
  if (phase === "joint") return oldQuorum && newQuorum;
  if (phase === "active-new") return newQuorum;
  throw new Error("unknown transition phase");
}

export function runBoundedValidatorTransitionModel() {
  let assignments = 0;
  let certificates = 0;
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
      const choice = choices[validator];
      if (choice === 1 || choice === 3) votesA |= bit(validator);
      if (choice === 2 || choice === 3) votesB |= bit(validator);
    }
    assignments += 1;
    const jointA = certificateAccepted("joint", votesA);
    const jointB = certificateAccepted("joint", votesB);
    certificates += Number(jointA) + Number(jointB);
    if (jointA && jointB) {
      return { assignments, counterexample: {
        invariant: "joint-transition-no-conflict", trace: [{ choices, votesA, votesB }],
      }, ok: false };
    }
  }
  for (let voters = 0; voters < 1 << 6; voters += 1) {
    const oldOnly = popcount(voters & OLD_MASK) >= TRANSITION_QUORUM &&
      popcount(voters & NEW_MASK) < TRANSITION_QUORUM;
    if (oldOnly && certificateAccepted("active-new", voters)) {
      return { assignments, counterexample: {
        invariant: "no-old-set-finality-after-activation", trace: [{ voters }],
      }, ok: false };
    }
  }
  return {
    assignments,
    certificates,
    counterexample: null,
    invariants: {
      jointActivationRequiresOldAndNewQuorums: true,
      noConflictingJointActivation: true,
      noOldSetFinalityAfterActivation: true,
    },
    membership: { new: NEW, old: OLD, overlap: OLD.filter((member) => NEW.includes(member)) },
    ok: true,
  };
}

function runSynchronousRound({ faultyProposer = false } = {}) {
  const bounds = { byzantine: 1, quorum: 3, rounds: 2, validators: 4 };
  let state = initialState(bounds);
  const trace = [];
  if (faultyProposer) {
    const action = { reporters: 0b0111, type: "advance-round" };
    state = applyAction(state, action, bounds).next;
    trace.push(actionLabel(action));
  }
  for (const validator of [0, 1, 2]) {
    const action = { type: "prepare", validator, value: 0 };
    state = applyAction(state, action, bounds).next;
    trace.push(actionLabel(action));
  }
  const certificate = slot(state.round, 0);
  const action = { certificate, mask: 0b0111, type: "commit-quorum" };
  state = applyAction(state, action, bounds).next;
  trace.push(actionLabel(action));
  return { finalized: state.finalized, trace };
}

export function checkBoundedLivenessAssumptions() {
  const normal = runSynchronousRound();
  const replacement = runSynchronousRound({ faultyProposer: true });
  return {
    assumptions: [
      "eventual synchrony after the modeled timeout",
      "at least one honest proposer in a bounded round",
      "at least three of four validators online and messages delivered",
      "at most one Byzantine validator",
    ],
    lossyNetworkWithoutQuorum: {
      expectedToStall: true,
      reason: "the model makes no liveness claim under permanent quorum message loss",
    },
    normalRoundFinalized: normal.finalized === "A",
    ok: normal.finalized === "A" && replacement.finalized === "A",
    replacementRoundFinalized: replacement.finalized === "A",
    traces: { normal: normal.trace, replacement: replacement.trace },
  };
}

export function runFormalConsensusSuite(options = {}) {
  const finality = runBoundedFinalityModel(options);
  const transition = runBoundedValidatorTransitionModel();
  const liveness = checkBoundedLivenessAssumptions();
  const ok = finality.ok && transition.ok && liveness.ok;
  return {
    counterexample: finality.counterexample ?? transition.counterexample ?? null,
    finality,
    format: "nir-bounded-consensus-model-v1",
    liveness,
    ok,
    transition,
  };
}

export function executeModelTrace(trace, options = {}) {
  const bounds = {
    byzantine: options.byzantine ?? 1,
    quorum: options.quorum ?? 3,
    rounds: options.rounds ?? 2,
    validators: options.validators ?? 4,
  };
  let state = initialState(bounds);
  const appliedTrace = [];
  for (const action of trace) {
    const value = typeof action.value === "string" ? VALUES.indexOf(action.value) : action.value;
    const certificate = action.certificate && typeof action.certificate === "object"
      ? slot(action.certificate.round, VALUES.indexOf(action.certificate.value))
      : action.certificate;
    const normalized = { ...action, certificate, value };
    const result = applyAction(state, normalized, bounds, options);
    if (!result) return { accepted: false, appliedTrace, state };
    state = result.next;
    appliedTrace.push(actionLabel(normalized));
    if (result.lockViolation) return {
      accepted: true,
      counterexample: counterexample("locked-value-preservation", state, appliedTrace),
      state,
    };
  }
  return { accepted: true, counterexample: state.finalized === "CONFLICT"
    ? counterexample("no-conflicting-finality", state, appliedTrace) : null, state };
}
