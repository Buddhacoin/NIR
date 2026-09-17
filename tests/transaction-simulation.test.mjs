import assert from "node:assert/strict";
import test from "node:test";

import { CREDIT_UNSTAKE_DELAY_BLOCKS, MIN_TRANSFER_FEE, TRANSFER_CREDIT_STAKE_UNIT } from "../blockchain/constants.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";
import { createPaymentRequest } from "../blockchain/payment-request.mjs";
import { decodeWalletOperation, simulateWalletOperation } from "../blockchain/transaction-simulation.mjs";

const networkId = "nir-simulation-test";
const tipHash = "a".repeat(64);
const stateRoot = "b".repeat(64);
const sender = generateWallet();
const recipient = generateWallet();
const sponsor = generateWallet();
const delegate = generateWallet();

function account(address, options = {}) {
  return {
    address,
    atomicBalance: options.atomicBalance ?? "1000000",
    history: { count: 0, root: "0".repeat(64) },
    nextNonce: options.nextNonce ?? 7,
    resources: {
      atomicStake: options.atomicStake ?? "100000",
      availableTransferCredits: options.availableTransferCredits ?? "4",
      delegations: options.delegations ?? [],
      pendingUnstake: options.pendingUnstake ?? null,
    },
  };
}

function evidence(accounts = { [sender.address]: account(sender.address) }, overrides = {}) {
  return {
    accounts,
    height: 41,
    networkId,
    proofVerified: true,
    stateRoot,
    tipHash,
    verified: true,
    ...overrides,
  };
}

function intent(type, fields = {}) {
  return { networkId, nonce: 7, sender: sender.address, type, ...fields };
}

test("simulation deterministically decodes ordinary and sponsored transfers", () => {
  const plain = simulateWalletOperation({
    intent: intent("transfer", { amount: "100", fee: MIN_TRANSFER_FEE.toString(), recipient: recipient.address }),
    stateEvidence: evidence(),
  });
  assert.equal(plain.title, "Transfer");
  assert.equal(plain.verified, true);
  assert.equal(plain.proof.tipHash, tipHash);
  assert.deepEqual(plain.deltas.nonce, [{ address: sender.address, after: 8, before: 7, role: "sender" }]);
  assert.equal(plain.deltas.balance[0].atomicDelta, "-1100");
  assert.equal(plain.deltas.fee.atomic, "1000");

  const sponsored = simulateWalletOperation({
    intent: intent("transfer", {
      amount: "100", fee: MIN_TRANSFER_FEE.toString(), feePayer: sponsor.address,
      feePayerNonce: 9, recipient: recipient.address,
    }),
    stateEvidence: evidence({
      [sender.address]: account(sender.address), [sponsor.address]: account(sponsor.address, { nextNonce: 9 }),
    }),
  });
  assert.equal(sponsored.title, "Sponsored transfer");
  assert.equal(sponsored.deltas.balance.find(({ role }) => role === "sender").atomicDelta, "-100");
  assert.equal(sponsored.deltas.balance.find(({ role }) => role === "fee-payer").atomicDelta, "-1000");
  assert.equal(sponsored.authority.length, 2);
});

test("simulation accounts for renewable credits and delegated credit limits", () => {
  const credit = simulateWalletOperation({
    intent: intent("transfer", { amount: "1", fee: "0", recipient: recipient.address, resource: "transfer-credit" }),
    stateEvidence: evidence(),
  });
  assert.equal(credit.deltas.fee.atomic, "0");
  assert.equal(credit.deltas.resources[0].after, "3");

  const owner = generateWallet();
  const delegated = simulateWalletOperation({
    intent: intent("transfer", {
      amount: "1", creditOwner: owner.address, fee: "0", recipient: recipient.address,
      resource: "transfer-credit",
    }),
    stateEvidence: evidence({
      [sender.address]: account(sender.address),
      [owner.address]: account(owner.address, { delegations: [{
        delegate: sender.address, epoch: 0, limit: 2, owner: owner.address, spent: 1,
      }] }),
    }),
  });
  assert.equal(delegated.deltas.resources[0].after, 2);
  assert.equal(delegated.deltas.resources[1].address, owner.address);
});

test("simulation covers stake, delegation, delayed unstake, and claim", () => {
  const stake = simulateWalletOperation({
    intent: intent("credit-stake", { amount: "2000", fee: "1000" }), stateEvidence: evidence(),
  });
  assert.equal(stake.deltas.resources[0].after, "102000");

  const delegated = simulateWalletOperation({
    intent: intent("credit-delegation", { delegate: delegate.address, fee: "1000", limit: 2 }),
    stateEvidence: evidence({ [sender.address]: account(sender.address, {
      atomicStake: TRANSFER_CREDIT_STAKE_UNIT.toString(),
    }) }),
  });
  assert.equal(delegated.deltas.resources[0].after.limit, 2);

  const unstake = simulateWalletOperation({
    intent: intent("credit-unstake-request", { amount: "3000", fee: "1000" }), stateEvidence: evidence(),
  });
  assert.deepEqual(unstake.deltas.resources[1].after, {
    amount: "2000", unlockHeight: 42 + CREDIT_UNSTAKE_DELAY_BLOCKS,
  });

  const claimEvidence = evidence({ [sender.address]: account(sender.address, {
    pendingUnstake: { amount: "2000", unlockHeight: 42 },
  }) });
  const claim = simulateWalletOperation({
    intent: intent("credit-unstake-claim"), stateEvidence: claimEvidence,
  });
  assert.equal(claim.deltas.balance[0].atomicDelta, "2000");
});

test("payment requests are decoded without pretending to authorize a transfer", () => {
  const request = createPaymentRequest({
    wallet: recipient, networkId, amount: "700", memo: "invoice", requestId: "c".repeat(64),
    expiresAt: 10_000,
  });
  const result = simulateWalletOperation({ intent: request, stateEvidence: evidence(), now: 1 });
  assert.equal(result.title, "Payment request");
  assert.equal(result.request.recipient, recipient.address);
  assert.equal(result.deltas.balance.length, 0);
  assert.match(result.risks[0], /not a transfer/);
  assert.equal(decodeWalletOperation(request, { stateEvidence: evidence(), now: 1 }).type, "payment-request");
  const preview = simulateWalletOperation({
    intent: { amount: "700", expiresAt: 10_000, memo: "invoice", networkId,
      recipient: sender.address, requestId: "d".repeat(64), type: "payment-request" },
    stateEvidence: evidence(), now: 1,
  });
  assert.equal(preview.request.recipient, sender.address);
  assert.equal(preview.intentHash.length, 64);
});

test("simulation fails closed for unknown, unproven, mismatched, and malformed input", () => {
  const transferIntent = intent("transfer", { amount: "1", fee: "1000", recipient: recipient.address });
  assert.throws(() => simulateWalletOperation({ intent: { type: "unknown" }, stateEvidence: evidence() }), /not supported/);
  assert.throws(() => simulateWalletOperation({ intent: transferIntent, stateEvidence: evidence({}, { verified: false }) }), /verified account evidence/);
  assert.throws(() => simulateWalletOperation({ intent: { ...transferIntent, nonce: 8 }, stateEvidence: evidence() }), /nonce/);
  assert.throws(() => simulateWalletOperation({ intent: { ...transferIntent, attacker: true }, stateEvidence: evidence() }), /unknown field/);
  assert.throws(() => simulateWalletOperation({
    intent: { ...transferIntent, feePayer: sponsor.address, feePayerNonce: 7 }, stateEvidence: evidence(),
  }), /fee payer account lacks independently verified state/);
});
