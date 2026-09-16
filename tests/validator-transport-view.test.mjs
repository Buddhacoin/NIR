import assert from "node:assert/strict";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createPeerRegistry, EMPTY_PEER_REGISTRY_HASH } from "../blockchain/peer-registry.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import {
  authorizeTransportAction,
  buildValidatorTransportView,
} from "../blockchain/validator-transport-view.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

function member(wallet, operatorId) {
  return { ...publicWallet(wallet), operatorId };
}

function fixture() {
  const currentWallets = Array.from({ length: 4 }, generateWallet);
  const futureWallets = [currentWallets[0], currentWallets[1], generateWallet(), generateWallet()];
  const currentValidators = currentWallets.map((wallet, index) => member(wallet, `old-${index}`));
  const nextValidators = futureWallets.map((wallet, index) =>
    index < 2 ? currentValidators[index] : member(wallet, `new-${index}`));
  const currentTransports = Array.from({ length: 4 }, generateWallet);
  const futureTransports = [currentTransports[0], currentTransports[1], generateWallet(), generateWallet()];
  const currentPeerRegistry = createPeerRegistry({
    activationHeight: 0,
    epoch: 0,
    networkId: "nir-transport-view-test",
    peers: currentWallets.map((wallet, index) => ({
      tlsCertificateSha256: null,
      transport: publicWallet(currentTransports[index]),
      url: `http://127.0.0.1:${9500 + index}`,
      validatorAddress: wallet.address,
    })),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  }, currentWallets.slice(0, 3));
  const onboarding = createValidatorOnboarding({
    activationHeight: 10,
    currentValidators,
    networkId: "nir-transport-view-test",
    nextValidators,
    peers: futureWallets.map((wallet, index) => ({
      tlsCertificateSha256: null,
      transport: publicWallet(futureTransports[index]),
      url: index < 2 ? `http://127.0.0.1:${9500 + index}` : `http://127.0.0.1:${9600 + index}`,
      validatorAddress: wallet.address,
    })),
  }, currentWallets.slice(0, 3), futureWallets, futureTransports);
  return {
    currentPeerRegistry,
    currentValidators,
    pendingRotation: {
      activationHeight: 10,
      nextSetId: validatorSetId(nextValidators),
      onboarding,
      previousSetId: validatorSetId(currentValidators),
      validators: nextValidators,
    },
  };
}

test("pre-activation transport view is the authenticated union of both validator sets", () => {
  const values = fixture();
  const view = buildValidatorTransportView({
    ...values, height: 5, networkId: "nir-transport-view-test",
  });
  assert.equal(view.length, 6);
  assert.deepEqual(view.map(({ role }) => role).sort(), [
    "current", "current", "future", "future", "overlap", "overlap",
  ]);
  assert.equal(new Set(view.map(({ transport }) => transport.address)).size, 6);
});

test("future-only transports can sync and join only the exact activation height", () => {
  const values = fixture();
  const view = buildValidatorTransportView({
    ...values, height: 5, networkId: "nir-transport-view-test",
  });
  const future = view.find(({ role }) => role === "future");
  const request = { currentHeight: 5, pendingRotation: values.pendingRotation };
  assert.equal(authorizeTransportAction(future, {
    ...request, path: "/v1/p2p/blocks/range", payload: { fromHeight: 1 },
  }), true);
  assert.equal(authorizeTransportAction(future, {
    ...request, path: "/v1/p2p/proposals", payload: { height: 10 },
  }), true);
  assert.throws(() => authorizeTransportAction(future, {
    ...request, path: "/v1/p2p/proposals", payload: { height: 9 },
  }), /limited/);
  assert.throws(() => authorizeTransportAction(future, {
    ...request, path: "/v1/gossip/transactions", payload: {},
  }), /limited/);
  assert.throws(() => authorizeTransportAction(future, {
    currentHeight: 10, path: "/v1/p2p/health", payload: {},
    pendingRotation: values.pendingRotation,
  }), /not active/);
});

test("a tampered onboarding cannot enter the transition transport view", () => {
  const values = fixture();
  values.pendingRotation.onboarding.peers.at(-1).url = "http://127.0.0.1:9999";
  assert.throws(() => buildValidatorTransportView({
    ...values, height: 5, networkId: "nir-transport-view-test",
  }), /commitment|signature/);
});
