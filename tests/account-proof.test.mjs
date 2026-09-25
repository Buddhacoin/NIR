import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccountProof,
  verifyAccountProof,
  verifyAccountProofCandidate,
} from "../blockchain/account-proof.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { emptyAccountHistory } from "../blockchain/account-history.mjs";

function fixture() {
  const validators = Array.from({ length: 4 }, generateWallet);
  const accountWallet = generateWallet();
  const account = {
    address: accountWallet.address,
    atomicBalance: "500000000",
    history: emptyAccountHistory(),
    nextNonce: 3,
    resources: {
      atomicStake: "10000000000",
      availableTransferCredits: "9",
      delegations: [],
      pendingUnstake: null,
    },
  };
  const proof = createAccountProof({
    account,
    height: 17,
    networkId: "nir-testnet",
    stateRoot: "a".repeat(64),
    tipHash: "b".repeat(64),
    validators: validators.map(publicWallet),
    validatorWallets: validators.slice(0, 3),
  });
  return { account, proof, validators: validators.map(publicWallet) };
}

test("an account view needs a matching post-quantum validator quorum", () => {
  const { account, proof, validators } = fixture();
  const verified = verifyAccountProof(proof, {
    expectedAddress: account.address,
    expectedNetworkId: "nir-testnet",
    minimumHeight: 17,
    trustedValidators: validators,
  });
  assert.deepEqual(verified.account, account);
  assert.equal(verified.height, 17);
});

test("a proof candidate is bound to exactly one expected validator", () => {
  const { account, validators } = fixture();
  const validatorWallet = generateWallet();
  const trustedValidators = [publicWallet(validatorWallet), ...validators.slice(0, 3)];
  const candidate = createAccountProof({
    account,
    height: 17,
    networkId: "nir-testnet",
    stateRoot: "a".repeat(64),
    tipHash: "b".repeat(64),
    validators: trustedValidators,
    validatorWallets: [validatorWallet],
  });
  const options = {
    expectedAddress: account.address,
    expectedNetworkId: "nir-testnet",
    minimumHeight: 17,
    trustedValidators,
  };
  assert.equal(verifyAccountProofCandidate(
    candidate, options, validatorWallet.address,
  ).height, 17);
  assert.throws(() => verifyAccountProofCandidate(
    candidate, options, trustedValidators[1].address,
  ), /candidate signer/);
});

test("account proofs reject mutation, stale height, minority, and a self-declared set", () => {
  const { account, proof, validators } = fixture();
  const options = {
    expectedAddress: account.address,
    expectedNetworkId: "nir-testnet",
    minimumHeight: 17,
    trustedValidators: validators,
  };
  assert.throws(() => verifyAccountProof({
    ...proof, account: { ...proof.account, atomicBalance: "500000001" },
  }, options), /hash/);
  assert.throws(() => verifyAccountProof(proof, { ...options, minimumHeight: 18 }), /trust anchor/);
  assert.throws(() => verifyAccountProof({ ...proof, attestations: proof.attestations.slice(0, 2) },
    options), /quorum/);
  const attackers = Array.from({ length: 4 }, () => publicWallet(generateWallet()));
  assert.throws(() => verifyAccountProof(proof, { ...options, trustedValidators: attackers }),
    /trust anchor/);
});

test("account proof envelope supports a post-quantum quorum above the former 64 KiB bound", () => {
  const validatorWallets = Array.from({ length: 24 }, generateWallet);
  const trustedValidators = validatorWallets.map(publicWallet);
  const account = fixture().account;
  const proof = createAccountProof({ account, height: 18, networkId: "nir-large-proof-test",
    stateRoot: "c".repeat(64), tipHash: "d".repeat(64), validators: trustedValidators,
    validatorWallets: validatorWallets.slice(0, 17) });
  assert.ok(Buffer.byteLength(JSON.stringify(proof)) > 64 * 1024);
  assert.equal(verifyAccountProof(proof, { expectedAddress: account.address,
    expectedNetworkId: "nir-large-proof-test", minimumHeight: 18,
    trustedValidators }).height, 18);
});
