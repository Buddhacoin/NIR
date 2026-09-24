import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyOrdinaryTransferState,
  applySponsoredTransferState,
} from "../blockchain/transfer-state-transition.mjs";
import { MAX_DECIMAL_DIGITS, MIN_TRANSFER_FEE } from "../blockchain/constants.mjs";

const suite = JSON.parse(readFileSync(
  new URL("./vectors/transfer-state-v1.json", import.meta.url), "utf8",
));
const sponsoredSuite = JSON.parse(readFileSync(
  new URL("./vectors/sponsored-transfer-state-v1.json", import.meta.url), "utf8",
));

function state(value) {
  return {
    balances: new Map(Object.entries(value.balances).map(([account, balance]) =>
      [account, BigInt(balance)])),
    burned: BigInt(value.burned),
    nonces: new Map(Object.entries(value.nonces)),
  };
}

function snapshot(value) {
  return {
    balances: Object.fromEntries([...value.balances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([account, balance]) => [account, balance.toString()])),
    nonces: Object.fromEntries([...value.nonces.entries()]
      .sort(([left], [right]) => left.localeCompare(right))),
    burned: value.burned.toString(),
  };
}

function classify(error) {
  const message = String(error?.message ?? error);
  if (message.includes("fee payer must be distinct")) return "fee payer must be distinct";
  if (message.includes("unexpected fee payer nonce")) return "unexpected fee payer nonce";
  if (message.includes("unexpected nonce")) return "unexpected nonce";
  if (message.includes("below the protocol minimum")) return "fee below minimum";
  if (message.includes("amount must be positive")) return "amount must be positive";
  if (message.includes("sender has insufficient balance")) return "sender insufficient balance";
  if (message.includes("fee payer has insufficient balance")) return "fee payer insufficient balance";
  if (message.includes("insufficient balance")) return "insufficient balance";
  if (message.includes("fee payer nonce") && message.includes("cannot advance")) {
    return "fee payer nonce cannot advance";
  }
  if (message.includes("cannot advance safely")) return "nonce cannot advance";
  if (message.includes("unsigned decimal string")) return "invalid atomic decimal";
  if (message.includes("balance is out of range")) return "balance overflow";
  return `unclassified: ${message}`;
}

test("ordinary transfer state vectors are reproduced by the normative JS transition", () => {
  assert.equal(suite.format, "nir-transfer-state-vectors-v1");
  assert.equal(suite.minimumFee, MIN_TRANSFER_FEE.toString());
  assert.equal(suite.maximumAtomicDigits, MAX_DECIMAL_DIGITS);
  assert.ok(suite.vectors.some(({ expected }) => expected));
  assert.ok(suite.vectors.some(({ error }) => error));

  for (const vector of suite.vectors) {
    const current = state(vector.state);
    const before = snapshot(current);
    const beforeTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    if (vector.error) {
      assert.throws(() => applyOrdinaryTransferState({
        ...vector.transaction,
        balances: current.balances,
        nonces: current.nonces,
      }), (error) => classify(error) === vector.error, vector.name);
      assert.deepEqual(snapshot(current), before, `${vector.name} must be atomic`);
      continue;
    }

    applyOrdinaryTransferState({
      ...vector.transaction,
      balances: current.balances,
      nonces: current.nonces,
    });
    assert.deepEqual(snapshot(current), vector.expected, vector.name);
    const afterTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    assert.equal(afterTotal, beforeTotal, `${vector.name} must conserve balances`);
    assert.equal(current.burned, BigInt(vector.state.burned),
      `${vector.name} must not burn the fee`);
  }
});

test("sponsored transfer state vectors are reproduced by the normative JS transition", () => {
  assert.equal(sponsoredSuite.format, "nir-sponsored-transfer-state-vectors-v1");
  assert.equal(sponsoredSuite.minimumFee, MIN_TRANSFER_FEE.toString());
  assert.equal(sponsoredSuite.maximumAtomicDigits, MAX_DECIMAL_DIGITS);
  assert.ok(sponsoredSuite.vectors.some(({ expected }) => expected));
  assert.ok(sponsoredSuite.vectors.some(({ error }) => error));

  for (const vector of sponsoredSuite.vectors) {
    const current = state(vector.state);
    const before = snapshot(current);
    const beforeTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    if (vector.error) {
      assert.throws(() => applySponsoredTransferState({
        ...vector.transaction,
        balances: current.balances,
        nonces: current.nonces,
      }), (error) => classify(error) === vector.error, vector.name);
      assert.deepEqual(snapshot(current), before, `${vector.name} must be atomic`);
      continue;
    }

    applySponsoredTransferState({
      ...vector.transaction,
      balances: current.balances,
      nonces: current.nonces,
    });
    assert.deepEqual(snapshot(current), vector.expected, vector.name);
    const afterTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    assert.equal(afterTotal, beforeTotal, `${vector.name} must conserve balances`);
    assert.equal(current.burned, BigInt(vector.state.burned),
      `${vector.name} must not burn the fee`);
  }
});
