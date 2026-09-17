import assert from "node:assert/strict";
import test from "node:test";

import {
  accountStateRoot,
  createAccountStateProof,
  emptyAccountState,
  verifyAccountStateProof,
} from "../blockchain/account-tree.mjs";
import { generateWallet } from "../blockchain/crypto.mjs";

function account(address, balance) {
  return {
    ...emptyAccountState(address),
    atomicBalance: balance,
  };
}

test("account tree proves membership and absence against one root", () => {
  const first = account(generateWallet().address, "100");
  const second = account(generateWallet().address, "200");
  const absent = generateWallet().address;
  const accounts = [first, second];
  const root = accountStateRoot(accounts);
  assert.deepEqual(
    verifyAccountStateProof(first, createAccountStateProof(accounts, first.address), root), first,
  );
  assert.deepEqual(
    verifyAccountStateProof(
      emptyAccountState(absent), createAccountStateProof(accounts, absent), root,
    ),
    emptyAccountState(absent),
  );
});

test("account tree rejects modified balances, paths, roots, and fake absence", () => {
  const first = account(generateWallet().address, "100");
  const accounts = [first];
  const root = accountStateRoot(accounts);
  const proof = createAccountStateProof(accounts, first.address);
  assert.throws(() => verifyAccountStateProof({ ...first, atomicBalance: "101" }, proof, root),
    /root does not match/);
  const changedPath = structuredClone(proof);
  changedPath.siblings[0] = "a".repeat(64);
  assert.throws(() => verifyAccountStateProof(first, changedPath, root), /root does not match/);
  assert.throws(() => verifyAccountStateProof(first, proof, "b".repeat(64)), /root does not match/);
  assert.throws(() => verifyAccountStateProof(first, { ...proof, exists: false }, root), /invalid/);
});
