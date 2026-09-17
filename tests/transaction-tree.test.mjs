import assert from "node:assert/strict";
import test from "node:test";
import { generateWallet } from "../blockchain/crypto.mjs";
import {
  committedTransactionId, createTransactionProof, transactionRoot, verifyTransactionProof,
} from "../blockchain/transaction-tree.mjs";

const transactions = Array.from({ length: 7 }, (_, nonce) => ({
  amount: String(nonce + 1), nonce, recipient: generateWallet().address, type: "test",
}));

test("ordered transaction tree proves every leaf including an odd tail", () => {
  const root = transactionRoot(transactions);
  transactions.forEach((transaction, index) => {
    assert.equal(verifyTransactionProof(
      transaction, createTransactionProof(transactions, index), root,
    ), committedTransactionId(transaction));
  });
});

test("transaction proof rejects mutation, wrong position, root, and depth", () => {
  const root = transactionRoot(transactions);
  const proof = createTransactionProof(transactions, 3);
  assert.throws(() => verifyTransactionProof({ ...transactions[3], amount: "99" }, proof, root),
    /root does not match/);
  assert.throws(() => verifyTransactionProof(transactions[3], { ...proof, index: 2 }, root),
    /root does not match/);
  assert.throws(() => verifyTransactionProof(transactions[3], proof, "a".repeat(64)),
    /root does not match/);
  assert.throws(() => verifyTransactionProof(
    transactions[3], { ...proof, siblings: proof.siblings.slice(1) }, root,
  ), /depth/);
});
