import assert from "node:assert/strict";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  createValidatorOnboarding,
  validatorOnboardingHash,
  verifyValidatorOnboarding,
} from "../blockchain/validator-onboarding.mjs";

function members(wallets) {
  return wallets.map((wallet) => ({
    ...publicWallet(wallet), operatorId: `validator-${wallet.address.slice(4, 16)}`,
  }));
}

function fixture() {
  const current = Array.from({ length: 4 }, generateWallet);
  const next = [current[0], current[1], ...Array.from({ length: 2 }, generateWallet)];
  const transports = Array.from({ length: 4 }, generateWallet);
  const peers = next.map((wallet, index) => ({
    tlsCertificateSha256: `${index}`.repeat(64),
    transport: publicWallet(transports[index]),
    url: `https://future-${index}.nir.example:9443`,
    validatorAddress: wallet.address,
  }));
  const fields = {
    activationHeight: 20,
    currentValidators: members(current),
    networkId: "nir-onboarding-test",
    nextValidators: members(next),
    peers,
  };
  return { current, fields, next, transports };
}

test("future validators prove consensus, transport, and endpoint possession before activation", () => {
  const { current, fields, next, transports } = fixture();
  const onboarding = createValidatorOnboarding(fields, current.slice(0, 3), next, transports);
  const verified = verifyValidatorOnboarding(onboarding, {
    activationHeight: fields.activationHeight,
    currentValidators: fields.currentValidators,
    networkId: fields.networkId,
    nextValidators: fields.nextValidators,
  });
  assert.equal(verified.peers.length, 4);
  assert.equal(verified.activationHeight, 20);
  assert.equal(validatorOnboardingHash(verified), onboarding.onboardingHash);
});

test("minority approval, missing acceptance, endpoint mutation, and fake transport fail closed", () => {
  const { current, fields, next, transports } = fixture();
  const minority = createValidatorOnboarding(fields, current.slice(0, 2), next, transports);
  assert.throws(() => verifyValidatorOnboarding(minority, {
    activationHeight: 20, currentValidators: fields.currentValidators,
    networkId: fields.networkId, nextValidators: fields.nextValidators,
  }), /threshold/);
  const missing = createValidatorOnboarding(fields, current.slice(0, 3), next.slice(0, 3), transports);
  assert.throws(() => verifyValidatorOnboarding(missing, {
    activationHeight: 20, currentValidators: fields.currentValidators,
    networkId: fields.networkId, nextValidators: fields.nextValidators,
  }), /threshold/);
  const valid = createValidatorOnboarding(fields, current.slice(0, 3), next, transports);
  valid.peers[0].url = "https://attacker.example:9443";
  assert.throws(() => verifyValidatorOnboarding(valid, {
    activationHeight: 20, currentValidators: fields.currentValidators,
    networkId: fields.networkId, nextValidators: fields.nextValidators,
  }), /commitment/);
  const fakeTransport = createValidatorOnboarding(
    fields, current.slice(0, 3), next, [...transports.slice(0, 3), generateWallet()],
  );
  assert.throws(() => verifyValidatorOnboarding(fakeTransport, {
    activationHeight: 20, currentValidators: fields.currentValidators,
    networkId: fields.networkId, nextValidators: fields.nextValidators,
  }), /signature/);
});

test("non-canonical signature encodings fail for every onboarding signature role", () => {
  const { current, fields, next, transports } = fixture();
  const base = createValidatorOnboarding(fields, current.slice(0, 3), next, transports);
  for (const collection of ["currentApprovals", "nextAcceptances", "transportProofs"]) {
    const changed = structuredClone(base);
    changed[collection][0].signature += "=";
    assert.throws(() => verifyValidatorOnboarding(changed, {
      activationHeight: 20, currentValidators: fields.currentValidators,
      networkId: fields.networkId, nextValidators: fields.nextValidators,
    }), /signature/);
  }
});
