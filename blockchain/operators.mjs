import { hashObject, signObject, verifyObject } from "./crypto.mjs";
import { SIGNATURE_ALGORITHM } from "./constants.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^nir1[0-9a-f]{64}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

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
