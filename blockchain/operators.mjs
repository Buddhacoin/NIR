import { hashObject, signObject, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function randomnessCommitment({ networkId, candidateId, secret }) {
  if (typeof networkId !== "string" || !HASH.test(candidateId ?? "") || !HASH.test(secret ?? "")) {
    throw new Error("randomness contribution is invalid");
  }
  return hashObject({ candidateId, networkId, secret }, "RANDOMNESS_COMMITMENT");
}

export function createRandomnessCommit({ wallet, networkId, candidateId, secret }) {
  const payload = {
    candidateId,
    commitment: randomnessCommitment({ networkId, candidateId, secret }),
    contributor: wallet.address,
    networkId,
  };
  return { ...payload, signature: signObject(payload, wallet, "RANDOMNESS_COMMIT") };
}

export function createRandomnessReveal({ wallet, networkId, candidateId, secret }) {
  randomnessCommitment({ networkId, candidateId, secret });
  const payload = { candidateId, contributor: wallet.address, networkId, secret };
  return { ...payload, signature: signObject(payload, wallet, "RANDOMNESS_REVEAL") };
}

export function createFallbackBeaconShare({ wallet, networkId, candidateId, round, value }) {
  if (!wallet || !HASH.test(candidateId ?? "") || !HASH.test(value ?? "") ||
      !Number.isSafeInteger(round) || round < 1) throw new Error("fallback beacon share input is invalid");
  const payload = { authority: wallet.address, candidateId, networkId, round, value };
  return { ...payload, signature: signObject(payload, wallet, "FALLBACK_RANDOMNESS_SHARE") };
}

export function createFallbackBeacon({ shares, networkId, candidateId, round }) {
  if (!Array.isArray(shares) || !HASH.test(candidateId ?? "") ||
      !Number.isSafeInteger(round) || round < 1) throw new Error("fallback beacon input is invalid");
  const attestations = shares.map((share) => ({
    authority: share.authority, signature: share.signature, value: share.value,
  })).sort((a, b) => a.authority.localeCompare(b.authority));
  const value = hashObject({ candidateId, networkId, round, shares: attestations.map(({ authority, value }) => ({ authority, value })) },
    "FALLBACK_RANDOMNESS_SHARES");
  return { candidateId, networkId, round, value, attestations };
}

export function createProgressBeaconShare({ wallet, networkId, candidateId, round, value }) {
  if (!wallet || !HASH.test(candidateId ?? "") || !HASH.test(value ?? "") ||
      !Number.isSafeInteger(round) || round < 1) throw new Error("progress beacon share input is invalid");
  const payload = { authority: wallet.address, candidateId, networkId, round, value };
  return { ...payload, signature: signObject(payload, wallet, "PROGRESS_RANDOMNESS_SHARE") };
}

export function createProgressBeacon({ shares, networkId, candidateId, round }) {
  if (!Array.isArray(shares) || !HASH.test(candidateId ?? "") ||
      !Number.isSafeInteger(round) || round < 1) throw new Error("progress beacon input is invalid");
  const attestations = shares.map((share) => ({
    authority: share.authority, signature: share.signature, value: share.value,
  })).sort((a, b) => a.authority.localeCompare(b.authority));
  const value = hashObject({
    candidateId, networkId, round,
    shares: attestations.map(({ authority, value: shareValue }) => ({
      authority, value: shareValue,
    })),
  }, "PROGRESS_RANDOMNESS_SHARES");
  return { candidateId, networkId, round, value, attestations };
}

export function combineRandomnessReveals({ networkId, candidateId, commitments, reveals, quorum }) {
  if (!(commitments instanceof Map) || !(reveals instanceof Map) || !HASH.test(candidateId ?? "") ||
      !Number.isSafeInteger(quorum) || quorum < 2 || reveals.size < quorum) {
    throw new Error("randomness reveal quorum not reached");
  }
  const contributions = [...reveals.entries()].map(([address, secret]) => {
    if (commitments.get(address) !== randomnessCommitment({
      networkId, candidateId, secret,
    })) throw new Error("randomness reveal does not match commitment");
    return { address, secret };
  }).sort((a, b) => a.address.localeCompare(b.address));
  return hashObject({ candidateId, contributions }, "DISTRIBUTED_RANDOMNESS");
}

export function epochRandomnessCommitment({ networkId, round, secret }) {
  if (typeof networkId !== "string" || !Number.isSafeInteger(round) || round < 1 ||
      !HASH.test(secret ?? "")) throw new Error("epoch randomness commitment input is invalid");
  return hashObject({ networkId, round, secret }, "EPOCH_RANDOMNESS_COMMITMENT");
}

export function createEpochRandomnessCommit({ wallet, networkId, round, secret }) {
  const payload = {
    authority: wallet.address,
    commitment: epochRandomnessCommitment({ networkId, round, secret }),
    networkId,
    round,
  };
  return { ...payload, signature: signObject(payload, wallet, "EPOCH_RANDOMNESS_COMMIT") };
}

export function createEpochRandomnessReveal({ wallet, networkId, round, secret }) {
  epochRandomnessCommitment({ networkId, round, secret });
  const payload = { authority: wallet.address, networkId, round, secret };
  return { ...payload, signature: signObject(payload, wallet, "EPOCH_RANDOMNESS_REVEAL") };
}

export class EpochRandomnessMachine {
  #attempt = 0;
  #commitHeight = null;
  #commitments = new Map();
  #committee;
  #committeeSize;
  #excluded = new Set();
  #lastFault = null;
  #networkId;
  #previousSeed;
  #registry;
  #reveals = new Map();
  #round = 1;

  constructor({ networkId, registry, committeeSize, genesisSeed }) {
    if (!(registry instanceof Map) || !HASH.test(genesisSeed ?? "")) {
      throw new Error("epoch randomness configuration is invalid");
    }
    this.#networkId = networkId;
    this.#registry = registry;
    this.#committeeSize = committeeSize;
    this.#previousSeed = genesisSeed;
    this.#committee = this.#selectCommittee();
  }

  static fromSnapshot({ networkId, registry, committeeSize, snapshot }) {
    if (!snapshot || !Number.isSafeInteger(snapshot.round) || snapshot.round < 1 ||
        !HASH.test(snapshot.previousSeed ?? "") ||
        !Array.isArray(snapshot.committee) || !Array.isArray(snapshot.commitments) ||
        !Array.isArray(snapshot.reveals) || !Array.isArray(snapshot.excluded) ||
        !Number.isSafeInteger(snapshot.attempt) || snapshot.attempt < 0) {
      throw new Error("epoch randomness snapshot is invalid");
    }
    const machine = new EpochRandomnessMachine({
      networkId, registry, committeeSize, genesisSeed: snapshot.previousSeed,
    });
    machine.#round = snapshot.round;
    machine.#previousSeed = snapshot.previousSeed;
    machine.#attempt = snapshot.attempt;
    machine.#excluded = new Set(snapshot.excluded);
    if (machine.#excluded.size !== snapshot.excluded.length ||
        [...machine.#excluded].some((address) => !registry.has(address))) {
      throw new Error("epoch randomness snapshot exclusions are invalid");
    }
    if (snapshot.lastFault !== null && (
      !snapshot.lastFault || !Number.isSafeInteger(snapshot.lastFault.attempt) ||
      !Number.isSafeInteger(snapshot.lastFault.detectedHeight) ||
      !Number.isSafeInteger(snapshot.lastFault.round) ||
      !Array.isArray(snapshot.lastFault.nonRevealers) ||
      snapshot.lastFault.nonRevealers.some((address) => !machine.#excluded.has(address))
    )) throw new Error("epoch randomness snapshot fault is invalid");
    machine.#lastFault = structuredClone(snapshot.lastFault);
    machine.#committee = machine.#selectCommittee();
    if (snapshot.committee.length !== machine.#committee.length ||
        snapshot.committee.some((address, index) => address !== machine.#committee[index])) {
      throw new Error("epoch randomness snapshot committee is invalid");
    }
    const commitments = new Map(snapshot.commitments);
    const reveals = new Map(snapshot.reveals);
    const members = new Set(machine.#committee);
    if (commitments.size !== snapshot.commitments.length || reveals.size !== snapshot.reveals.length ||
        [...commitments].some(([address, value]) => !members.has(address) || !HASH.test(value ?? "")) ||
        [...reveals].some(([address, secret]) => !members.has(address) || !HASH.test(secret ?? "") ||
          commitments.get(address) !== epochRandomnessCommitment({ networkId, round: snapshot.round, secret }))) {
      throw new Error("epoch randomness snapshot contributions are invalid");
    }
    const commitHeightValid = snapshot.commitHeight === null
      ? commitments.size < machine.#committee.length && reveals.size === 0
      : Number.isSafeInteger(snapshot.commitHeight) && snapshot.commitHeight >= 1 &&
        commitments.size === machine.#committee.length;
    if (!commitHeightValid) throw new Error("epoch randomness snapshot phase is invalid");
    machine.#commitHeight = snapshot.commitHeight;
    machine.#commitments = commitments;
    machine.#reveals = reveals;
    return machine;
  }

  #selectCommittee() {
    const eligible = new Map([...this.#registry].filter(([address]) => !this.#excluded.has(address)));
    if (eligible.size < this.#committeeSize) {
      throw new Error("not enough eligible epoch randomness authorities");
    }
    return selectOperatorCommittee({
      registry: eligible,
      randomness: this.#previousSeed,
      context: { attempt: this.#attempt, networkId: this.#networkId, round: this.#round },
      size: this.#committeeSize,
    }).map(({ address }) => address);
  }

  get round() { return this.#round; }
  get previousSeed() { return this.#previousSeed; }
  committee() { return [...this.#committee]; }

  snapshot() {
    return {
      attempt: this.#attempt,
      commitHeight: this.#commitHeight,
      commitments: [...this.#commitments.entries()].sort(([left], [right]) => left.localeCompare(right)),
      committee: [...this.#committee],
      excluded: [...this.#excluded].sort(),
      lastFault: structuredClone(this.#lastFault),
      previousSeed: this.#previousSeed,
      reveals: [...this.#reveals.entries()].sort(([left], [right]) => left.localeCompare(right)),
      round: this.#round,
    };
  }

  commit(message, height) {
    if (!Number.isSafeInteger(height) || height < 1 || message?.networkId !== this.#networkId ||
        message?.round !== this.#round || !this.#committee.includes(message.authority) ||
        !HASH.test(message.commitment ?? "") || this.#commitments.has(message.authority)) {
      throw new Error("epoch randomness commit is invalid or duplicated");
    }
    const operator = this.#registry.get(message.authority);
    const { signature, ...payload } = message;
    if (!operator || !verifyObject(payload, signature, operator.publicKey, "EPOCH_RANDOMNESS_COMMIT")) {
      throw new Error("epoch randomness commit signature is invalid");
    }
    this.#commitments.set(message.authority, message.commitment);
    if (this.#commitments.size === this.#committee.length) this.#commitHeight = height;
  }

  expire(height, timeoutBlocks) {
    if (!Number.isSafeInteger(height) || !Number.isSafeInteger(timeoutBlocks) || timeoutBlocks < 1) {
      throw new Error("epoch randomness timeout input is invalid");
    }
    if (this.#commitHeight === null || height <= this.#commitHeight + timeoutBlocks ||
        this.#reveals.size === this.#committee.length) return null;
    const nonRevealers = this.#committee.filter((address) => !this.#reveals.has(address));
    if (this.#registry.size - this.#excluded.size - nonRevealers.length < this.#committeeSize) {
      throw new Error("epoch randomness cannot rotate without enough eligible authorities");
    }
    for (const address of nonRevealers) this.#excluded.add(address);
    const fault = {
      attempt: this.#attempt,
      detectedHeight: height,
      nonRevealers: [...nonRevealers].sort(),
      round: this.#round,
    };
    this.#lastFault = fault;
    this.#attempt += 1;
    this.#commitHeight = null;
    this.#commitments = new Map();
    this.#reveals = new Map();
    this.#committee = this.#selectCommittee();
    return fault;
  }

  reveal(message, height) {
    if (this.#commitHeight === null || !Number.isSafeInteger(height) || height <= this.#commitHeight ||
        message?.networkId !== this.#networkId || message?.round !== this.#round ||
        !this.#committee.includes(message.authority) || this.#reveals.has(message.authority) ||
        !HASH.test(message.secret ?? "")) {
      throw new Error("epoch randomness reveal is premature, invalid, or duplicated");
    }
    const operator = this.#registry.get(message.authority);
    const { signature, ...payload } = message;
    if (!operator || !verifyObject(payload, signature, operator.publicKey, "EPOCH_RANDOMNESS_REVEAL")) {
      throw new Error("epoch randomness reveal signature is invalid");
    }
    if (this.#commitments.get(message.authority) !== epochRandomnessCommitment({
      networkId: this.#networkId, round: this.#round, secret: message.secret,
    })) throw new Error("epoch randomness reveal does not match commitment");
    this.#reveals.set(message.authority, message.secret);
    if (this.#reveals.size !== this.#committee.length) return null;
    const completedRound = this.#round;
    const value = hashObject({
      networkId: this.#networkId,
      previousSeed: this.#previousSeed,
      round: completedRound,
      reveals: [...this.#reveals.entries()]
        .map(([authority, secret]) => ({ authority, secret }))
        .sort((left, right) => left.authority.localeCompare(right.authority)),
    }, "EPOCH_RANDOMNESS_VALUE");
    this.#previousSeed = value;
    this.#round += 1;
    this.#attempt = 0;
    this.#excluded = new Set();
    this.#commitHeight = null;
    this.#commitments = new Map();
    this.#reveals = new Map();
    this.#committee = this.#selectCommittee();
    return { round: completedRound, value };
  }
}

function unsignedCredential(credential) {
  const { signature: _signature, ...payload } = credential;
  return payload;
}

export function createOperatorCredential({ authorityWallet, networkId, operator, role, validFromEpoch, validUntilEpoch }) {
  if (!operator || !ADDRESS.test(operator.address ?? "")) throw new Error("operator address is invalid");
  const payload = {
    algorithm: SIGNATURE_ALGORITHM,
    authority: authorityWallet.address,
    networkId,
    operatorAddress: operator.address,
    operatorId: operator.operatorId,
    publicKeyHash: hashObject(operator.publicKey, "OPERATOR_PUBLIC_KEY"),
    role,
    validFromEpoch,
    validUntilEpoch,
  };
  return { ...payload, signature: signObject(payload, authorityWallet, "OPERATOR_CREDENTIAL") };
}

export function verifyOperatorCredential({ credential, operator, role, networkId, epoch, authorities }) {
  if (
    !credential || credential.algorithm !== SIGNATURE_ALGORITHM ||
    credential.networkId !== networkId || credential.role !== role ||
    credential.operatorAddress !== operator.address ||
    credential.operatorId !== operator.operatorId ||
    credential.publicKeyHash !== hashObject(operator.publicKey, "OPERATOR_PUBLIC_KEY") ||
    !Number.isSafeInteger(credential.validFromEpoch) ||
    !Number.isSafeInteger(credential.validUntilEpoch) ||
    credential.validFromEpoch < 0 || credential.validUntilEpoch < credential.validFromEpoch ||
    epoch < credential.validFromEpoch || epoch > credential.validUntilEpoch
  ) return false;
  const authorityPublicKey = authorities.get(credential.authority);
  return Boolean(authorityPublicKey && verifyObject(
    unsignedCredential(credential), credential.signature, authorityPublicKey, "OPERATOR_CREDENTIAL",
  ));
}

export function createAttestedRegistry({ members, authorities, networkId, role, epoch, minimumBond }) {
  if (!(authorities instanceof Map) || authorities.size < 2) {
    throw new Error("at least two independent attestation authorities are required");
  }
  const minimum = BigInt(minimumBond);
  if (minimum <= 0n) throw new Error("minimum operator bond must be positive");
  const registry = new Map();
  const operatorIds = new Set();
  for (const member of members ?? []) {
    if (
      !ADDRESS.test(member.address ?? "") || !OPERATOR_ID.test(member.operatorId ?? "") ||
      member.algorithm !== SIGNATURE_ALGORITHM || registry.has(member.address) ||
      operatorIds.has(member.operatorId)
    ) throw new Error("operator identity is invalid or duplicated");
    const bond = BigInt(member.bond);
    if (bond < minimum) throw new Error("operator bond is below the minimum");
    const attesters = new Set();
    for (const credential of member.credentials ?? []) {
      if (verifyOperatorCredential({ credential, operator: member, role, networkId, epoch, authorities })) {
        attesters.add(credential.authority);
      }
    }
    if (attesters.size < 2) throw new Error("operator lacks independent external attestations");
    registry.set(member.address, { ...structuredClone(member), bond, attesters: [...attesters].sort() });
    operatorIds.add(member.operatorId);
  }
  if (registry.size < 4) throw new Error("attested registry requires four operators");
  return registry;
}

// Randomness must become unknowable until after every candidate commitment is final.
// The caller is responsible for enforcing that commit/reveal ordering.
export function selectOperatorCommittee({ registry, randomness, context, size }) {
  if (!(registry instanceof Map) || registry.size < 1 || !HASH.test(randomness ?? "")) {
    throw new Error("registry or committee randomness is invalid");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > registry.size) {
    throw new Error("committee size is invalid");
  }
  return [...registry.values()]
    .map((operator) => ({
      address: operator.address,
      operatorId: operator.operatorId,
      rank: hashObject({ address: operator.address, context, randomness }, "OPERATOR_COMMITTEE_RANK"),
    }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.address.localeCompare(b.address))
    .slice(0, size)
    .map(({ rank: _rank, ...operator }) => operator);
}

export class ProgressAdmissionBook {
  #committeeSize;
  #entries;
  #networkId;
  #registry;

  constructor({ networkId, registry, committeeSize }) {
    if (typeof networkId !== "string" || networkId.length < 1) {
      throw new Error("admission network id is invalid");
    }
    if (!(registry instanceof Map) || registry.size < 4) {
      throw new Error("admission registry is invalid");
    }
    if (!Number.isSafeInteger(committeeSize) || committeeSize < 3 || committeeSize > registry.size) {
      throw new Error("admission committee size is invalid");
    }
    this.#networkId = networkId;
    this.#registry = registry;
    this.#committeeSize = committeeSize;
    this.#entries = new Map();
  }

  commit({ artifactHash, baselineHash, suiteCommitment, recipient, committedEpoch }) {
    if (
      !/^sha256:[0-9a-f]{64}$/.test(artifactHash ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(baselineHash ?? "") ||
      !HASH.test(suiteCommitment ?? "") || !ADDRESS.test(recipient ?? "") ||
      !Number.isSafeInteger(committedEpoch) || committedEpoch < 0
    ) throw new Error("candidate commitment is invalid");
    const payload = {
      artifactHash, baselineHash, committedEpoch, networkId: this.#networkId,
      recipient, suiteCommitment,
    };
    const commitmentHash = hashObject(payload, "CANDIDATE_ADMISSION");
    if (this.#entries.has(commitmentHash)) throw new Error("candidate is already committed");
    this.#entries.set(commitmentHash, { payload, assignment: null });
    return commitmentHash;
  }

  assign({ commitmentHash, randomness, randomnessEpoch }) {
    const entry = this.#entries.get(commitmentHash);
    if (!entry) throw new Error("candidate commitment is unknown");
    if (
      entry.assignment || !HASH.test(randomness ?? "") ||
      !Number.isSafeInteger(randomnessEpoch) || randomnessEpoch <= entry.payload.committedEpoch
    ) throw new Error("future committee randomness is invalid or already assigned");
    const committee = selectOperatorCommittee({
      registry: this.#registry,
      randomness,
      context: { commitmentHash, randomnessEpoch },
      size: this.#committeeSize,
    });
    entry.assignment = { committee, randomness, randomnessEpoch };
    return structuredClone(committee);
  }

  verifyAssignedEvaluators({ commitmentHash, evaluatorAddresses }) {
    const assignment = this.#entries.get(commitmentHash)?.assignment;
    if (!assignment || !Array.isArray(evaluatorAddresses)) return false;
    const actual = [...new Set(evaluatorAddresses)].sort();
    const expected = assignment.committee.map(({ address }) => address).sort();
    return actual.length === evaluatorAddresses.length && actual.length === expected.length &&
      actual.every((address, index) => address === expected[index]);
  }
}

function unsignedStatement(statement) {
  const { signature: _signature, ...payload } = statement;
  return payload;
}

export function signOperatorStatement({ wallet, networkId, role, epoch, slot, statementHash }) {
  if (!HASH.test(statementHash ?? "")) throw new Error("statement hash is invalid");
  const payload = { epoch, networkId, operator: wallet.address, role, slot, statementHash };
  return { ...payload, signature: signObject(payload, wallet, "OPERATOR_STATEMENT") };
}

export function proveOperatorEquivocation({ first, second, registry }) {
  const sameSlot = first?.operator === second?.operator && first?.networkId === second?.networkId &&
    first?.role === second?.role && first?.epoch === second?.epoch && first?.slot === second?.slot;
  if (!sameSlot || first.statementHash === second.statementHash) {
    throw new Error("statements do not prove equivocation");
  }
  const operator = registry.get(first.operator);
  if (!operator ||
    !verifyObject(unsignedStatement(first), first.signature, operator.publicKey, "OPERATOR_STATEMENT") ||
    !verifyObject(unsignedStatement(second), second.signature, operator.publicKey, "OPERATOR_STATEMENT")) {
    throw new Error("equivocation signatures are invalid");
  }
  return {
    evidenceHash: hashObject([first, second], "EQUIVOCATION_EVIDENCE"),
    operator: first.operator,
    penalty: operator.bond,
    reason: "conflicting signed statements",
  };
}

export class OperatorBondBook {
  #bonds;
  #evidence;
  #registry;
  constructor(registry) {
    this.#registry = registry;
    this.#bonds = new Map([...registry.entries()].map(([address, operator]) => [address, operator.bond]));
    this.#evidence = new Set();
  }
  balance(address) { return this.#bonds.get(address) ?? 0n; }
  slash({ first, second }) {
    const proof = proveOperatorEquivocation({ first, second, registry: this.#registry });
    if (this.#evidence.has(proof.evidenceHash)) {
      throw new Error("slashing evidence is invalid or already used");
    }
    const current = this.balance(proof.operator);
    const penalty = BigInt(proof.penalty);
    if (penalty <= 0n || penalty > current) throw new Error("slashing penalty is invalid");
    this.#bonds.set(proof.operator, current - penalty);
    this.#evidence.add(proof.evidenceHash);
    return penalty;
  }
}
