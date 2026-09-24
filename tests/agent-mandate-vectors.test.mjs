import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_ACTIVE_AGENT_MANDATES_PER_OWNER,
  MAX_AGENT_MANDATES_GLOBAL,
  MAX_AGENT_MANDATE_PRUNE_BATCH,
  MAX_AGENT_MANDATE_LIFETIME,
  MAX_AGENT_MANDATE_PAYEES,
  applyAgentMandateTransferState,
  closeAgentMandateState,
  createAgentMandateState,
  pruneExpiredAgentMandatesState,
} from "../blockchain/agent-mandate-transition.mjs";

const suite = JSON.parse(readFileSync(
  new URL("./vectors/agent-mandate-state-v1.json", import.meta.url), "utf8",
));

function parseMandate(value) {
  return {
    ...structuredClone(value),
    balance: BigInt(value.balance),
    initialEscrow: BigInt(value.initialEscrow),
    maxFee: BigInt(value.maxFee),
    maxPerTransfer: BigInt(value.maxPerTransfer),
    totalLimit: BigInt(value.totalLimit),
    totalFeeLimit: BigInt(value.totalFeeLimit),
    totalFees: BigInt(value.totalFees),
    totalSpent: BigInt(value.totalSpent),
  };
}

function buildState(vector) {
  const result = {
    balances: new Map(Object.entries(vector.state.balances)
      .map(([key, value]) => [key, BigInt(value)])),
    burned: BigInt(vector.state.burned),
    mandates: new Map(Object.entries(vector.state.mandates)
      .map(([key, value]) => [key, parseMandate(value)])),
    nonces: new Map(Object.entries(vector.state.nonces)),
  };
  for (let index = 0; index < (vector.fillMandates ?? 0); index += 1) {
    const id = (index + 1).toString(16).padStart(64, "0");
    const owner = vector.fillOwner ?? vector.input.owner;
    result.mandates.set(id, Object.freeze({ agent: "nir1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      allowedPayees: Object.freeze(["nir1cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]),
      balance: 0n, createdHeight: 0, expiresHeight: 1, initialEscrow: 1001n, maxFee: 1000n,
      maxPerTransfer: 1n, networkId: "nir-testnet", owner,
      policyHash: "1111111111111111111111111111111111111111111111111111111111111111",
      totalFeeLimit: 1000n, totalFees: 1000n, totalLimit: 1n, totalSpent: 1n }));
  }
  for (let index = 0; index < (vector.fillGlobalMandates ?? 0); index += 1) {
    const id = (index + 1).toString(16).padStart(64, "0");
    const owner = `nir1${(index + 4096).toString(16).padStart(64, "0")}`;
    result.mandates.set(id, Object.freeze({ agent: "nir1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      allowedPayees: Object.freeze(["nir1cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]),
      balance: 0n, createdHeight: 0, expiresHeight: 1, initialEscrow: 1001n, maxFee: 1000n,
      maxPerTransfer: 1n, networkId: "nir-testnet", owner,
      policyHash: "1111111111111111111111111111111111111111111111111111111111111111",
      totalFeeLimit: 1000n, totalFees: 1000n, totalLimit: 1n, totalSpent: 1n }));
  }
  return result;
}

function snapshot(state, includePlaceholders = false) {
  const mandates = [...state.mandates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, {
      ...value,
      balance: value.balance.toString(),
      initialEscrow: value.initialEscrow.toString(),
      maxFee: value.maxFee.toString(),
      maxPerTransfer: value.maxPerTransfer.toString(),
      totalLimit: value.totalLimit.toString(),
      totalFeeLimit: value.totalFeeLimit.toString(),
      totalFees: value.totalFees.toString(),
      totalSpent: value.totalSpent.toString(),
    }]);
  return {
    balances: Object.fromEntries([...state.balances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value.toString()])),
    nonces: Object.fromEntries([...state.nonces.entries()]
      .sort(([left], [right]) => left.localeCompare(right))),
    mandates: Object.fromEntries(mandates),
    burned: state.burned.toString(),
  };
}

function total(state) {
  return [...state.balances.values()].reduce((sum, value) => sum + value, state.burned) +
    [...state.mandates.values()].reduce((sum, value) =>
      sum + value.balance, 0n);
}

function apply(vector, state) {
  const shared = { ...vector.input, balances: state.balances, mandates: state.mandates,
    nonces: state.nonces };
  if (vector.action === "create") return createAgentMandateState(shared);
  if (vector.action === "transfer") return applyAgentMandateTransferState(shared);
  if (vector.action === "close") return closeAgentMandateState(shared);
  if (vector.action === "prune") return pruneExpiredAgentMandatesState(shared);
  throw new Error(`unknown vector action ${vector.action}`);
}

test("agent mandate vectors reproduce atomic bounded state transitions", () => {
  assert.equal(suite.format, "nir-agent-mandate-state-vectors-v1");
  assert.equal(suite.maximumActiveMandatesPerOwner, MAX_ACTIVE_AGENT_MANDATES_PER_OWNER);
  assert.equal(suite.maximumGlobalMandates, MAX_AGENT_MANDATES_GLOBAL);
  assert.equal(suite.maximumPruneBatch, MAX_AGENT_MANDATE_PRUNE_BATCH);
  assert.equal(suite.maximumPayees, MAX_AGENT_MANDATE_PAYEES);
  assert.equal(suite.maximumLifetime, MAX_AGENT_MANDATE_LIFETIME);
  for (const vector of suite.vectors) {
    const state = buildState(vector);
    const before = snapshot(state, true);
    const beforeTotal = total(state);
    if (vector.error) {
      assert.throws(() => apply(vector, state),
        (error) => String(error?.message ?? error).includes(vector.error), vector.name);
      assert.deepEqual(snapshot(state, true), before, `${vector.name} must be atomic`);
      continue;
    }
    apply(vector, state);
    const expectedState = buildState({ ...vector, state: vector.expected, input: vector.input });
    assert.deepEqual(snapshot(state), snapshot(expectedState), vector.name);
    assert.equal(total(state), beforeTotal, `${vector.name} must conserve NIR`);
  }
});

test("malformed persisted mandate numerics fail before mutation", () => {
  const vector = structuredClone(suite.vectors.find((entry) => entry.action === "transfer"));
  const state = buildState(vector);
  state.mandates.get(vector.input.mandateId).totalSpent = "not-a-decimal";
  const before = snapshot(state, true);
  assert.throws(() => apply(vector, state), /mandate total spent is not canonical/);
  assert.deepEqual(snapshot(state, true), before);
});

test("authorization and execution context reject extra fields atomically", () => {
  const base = suite.vectors.find((entry) => entry.action === "transfer" && entry.expected);
  for (const mutate of [
    (input) => { input.preverifiedAgentAuthorization.extra = true; },
    (input) => { input.executionContext.extra = true; },
  ]) {
    const vector = structuredClone(base); mutate(vector.input);
    const state = buildState(vector); const before = snapshot(state, true);
    assert.throws(() => apply(vector, state));
    assert.deepEqual(snapshot(state, true), before);
  }
});
