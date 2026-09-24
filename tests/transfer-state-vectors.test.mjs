import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyCreditTransferState,
  applyAuthorizedOrdinaryTransferState,
  applyMultisigTransferState,
  applyOrdinaryTransferState,
  applySponsoredTransferState,
  validateTransferAuthorizationEnvelope,
} from "../blockchain/transfer-state-transition.mjs";
import {
  MAX_DECIMAL_DIGITS,
  MIN_TRANSFER_FEE,
  TRANSFER_CREDIT_EPOCH_BLOCKS,
  TRANSFER_CREDIT_STAKE_UNIT,
  TRANSFER_CREDITS_PER_STAKE_UNIT,
} from "../blockchain/constants.mjs";

const suite = JSON.parse(readFileSync(
  new URL("./vectors/transfer-state-v1.json", import.meta.url), "utf8",
));
const sponsoredSuite = JSON.parse(readFileSync(
  new URL("./vectors/sponsored-transfer-state-v1.json", import.meta.url), "utf8",
));
const creditSuite = JSON.parse(readFileSync(
  new URL("./vectors/credit-transfer-state-v1.json", import.meta.url), "utf8",
));
const multisigSuite = JSON.parse(readFileSync(
  new URL("./vectors/multisig-transfer-state-v1.json", import.meta.url), "utf8",
));
const authorizationSuite = JSON.parse(readFileSync(
  new URL("./vectors/transfer-authorization-v1.json", import.meta.url), "utf8",
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

function creditState(value) {
  return {
    ...state(value),
    creditDelegations: new Map(Object.entries(value.creditDelegations)
      .map(([key, delegation]) => [key, structuredClone(delegation)])),
    creditStakes: new Map(Object.entries(value.creditStakes)
      .map(([account, stake]) => [account, BigInt(stake)])),
    creditUsage: new Map(Object.entries(value.creditUsage)
      .map(([account, usage]) => [account, structuredClone(usage)])),
  };
}

function snapshotCredit(value) {
  return {
    ...snapshot(value),
    creditDelegations: Object.fromEntries([...value.creditDelegations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))),
    creditStakes: Object.fromEntries([...value.creditStakes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([account, stake]) => [account, stake.toString()])),
    creditUsage: Object.fromEntries([...value.creditUsage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))),
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
  if (message.includes("quota is exhausted")) return "credit quota exhausted";
  if (message.includes("delegation is exhausted")) return "delegation exhausted";
  if (message.includes("credit-paid transfer fee must be zero")) return "credit fee must be zero";
  if (message.includes("descriptor is invalid")) return "invalid descriptor";
  if (message.includes("address does not match multisignature")) return "descriptor address mismatch";
  if (message.includes("threshold not reached")) return "threshold not reached";
  if (message.includes("duplicated")) return "duplicate signer";
  if (message.includes("unknown")) return "unknown signer";
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

test("credit-paid transfer vectors are reproduced by the normative JS transition", () => {
  assert.equal(creditSuite.format, "nir-credit-transfer-state-vectors-v1");
  assert.equal(creditSuite.stakeUnit, TRANSFER_CREDIT_STAKE_UNIT.toString());
  assert.equal(creditSuite.creditsPerStakeUnit, TRANSFER_CREDITS_PER_STAKE_UNIT);
  assert.equal(creditSuite.epochBlocks, TRANSFER_CREDIT_EPOCH_BLOCKS);

  for (const vector of creditSuite.vectors) {
    const current = creditState(vector.state);
    const before = snapshotCredit(current);
    const beforeTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    const transition = () => applyCreditTransferState({
      ...vector.transaction,
      balances: current.balances,
      creditDelegations: current.creditDelegations,
      creditStakes: current.creditStakes,
      creditUsage: current.creditUsage,
      nonces: current.nonces,
    });
    if (vector.error) {
      assert.throws(transition, (error) => classify(error) === vector.error, vector.name);
      assert.deepEqual(snapshotCredit(current), before, `${vector.name} must be atomic`);
      continue;
    }
    transition();
    assert.deepEqual(snapshotCredit(current), vector.expected, vector.name);
    const afterTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    assert.equal(afterTotal, beforeTotal, `${vector.name} must conserve balances`);
    assert.equal(current.burned, BigInt(vector.state.burned),
      `${vector.name} must not burn NIR`);
  }
});

test("multisignature transfer vectors are reproduced by the normative JS transition", () => {
  assert.equal(multisigSuite.format, "nir-multisig-transfer-state-vectors-v1");
  assert.equal(multisigSuite.maximumMembers, 16);
  for (const vector of multisigSuite.vectors) {
    const current = state(vector.state);
    const before = snapshot(current);
    const beforeTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    const transition = () => applyMultisigTransferState({
      ...vector.transaction,
      balances: current.balances,
      nonces: current.nonces,
    });
    if (vector.error) {
      assert.throws(transition, (error) => classify(error) === vector.error, vector.name);
      assert.deepEqual(snapshot(current), before, `${vector.name} must be atomic`);
      continue;
    }
    transition();
    assert.deepEqual(snapshot(current), vector.expected, vector.name);
    const afterTotal = [...current.balances.values()]
      .reduce((total, balance) => total + balance, 0n);
    assert.equal(afterTotal, beforeTotal, `${vector.name} must conserve balances`);
  }
});

test("authorization envelopes bind preverified identities to exact unsigned bytes", () => {
  assert.equal(authorizationSuite.format, "nir-transfer-authorization-vectors-v1");
  for (const vector of authorizationSuite.vectors) {
    const validate = () => validateTransferAuthorizationEnvelope({
      envelope: vector.envelope,
      expectedAlgorithm: vector.expectedAlgorithm,
      unsignedTransaction: vector.unsignedTransaction,
    });
    if (vector.error) {
      assert.throws(validate, (error) => {
        const message = String(error?.message ?? error);
        if (vector.error === "duplicate approval") return message.includes("duplicated");
        if (vector.error === "invalid approval") {
          return message.includes("approval") && message.includes("invalid");
        }
        return message.includes(vector.error);
      }, vector.name);
    } else {
      assert.deepEqual(validate().preverifiedSigners, vector.expectedSigners, vector.name);
    }
  }
  const current = state({
    balances: {
      nir1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: "2000",
      nir1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: "0",
    },
    burned: "0",
    nonces: { nir1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 0 },
  });
  const before = snapshot(current);
  assert.throws(() => applyAuthorizedOrdinaryTransferState({
    authorizationEnvelope: authorizationSuite.vectors[0].envelope,
    balances: current.balances,
    feeRecipient: "nir1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    nonces: current.nonces,
    unsignedTransaction: authorizationSuite.vectors[2].unsignedTransaction,
  }), /digest mismatch/);
  assert.deepEqual(snapshot(current), before, "authorization mismatch must be atomic");
});
