import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { createPeerRegistry, EMPTY_PEER_REGISTRY_HASH } from "../blockchain/peer-registry.mjs";
import { createValidatorHandoff } from "../blockchain/validator-handoff.mjs";
import { createValidatorOnboarding } from "../blockchain/validator-onboarding.mjs";
import {
  installValidatorTopology,
  loadValidatorTopologyHistory,
  selectValidatorTopologyHistoryCandidates,
  verifyValidatorTopologyHistory,
} from "../blockchain/validator-topology-history.mjs";

function member(wallet, operatorId) {
  return { ...publicWallet(wallet), operatorId };
}

function fixture() {
  const first = Array.from({ length: 4 }, generateWallet);
  const second = [first[0], first[1], generateWallet(), generateWallet()];
  const third = [second[0], second[2], generateWallet(), generateWallet()];
  const all = [...new Map([...first, ...second, ...third]
    .map((wallet) => [wallet.address, wallet])).values()];
  const membersByAddress = new Map(all.map((wallet, index) =>
    [wallet.address, member(wallet, `operator-${index}`)]));
  const members = (wallets) => wallets.map(({ address }) => membersByAddress.get(address));
  const transports = new Map(all.map((wallet) => [wallet.address, generateWallet()]));
  const urls = new Map(all.map((wallet, index) =>
    [wallet.address, `http://127.0.0.1:${9800 + index}`]));
  const peers = (wallets) => wallets.map((wallet) => ({
    tlsCertificateSha256: null,
    transport: publicWallet(transports.get(wallet.address)),
    url: urls.get(wallet.address),
    validatorAddress: wallet.address,
  }));
  const networkId = "nir-topology-history-test";
  const genesisPeerRegistry = createPeerRegistry({
    activationHeight: 0,
    epoch: 0,
    networkId,
    peers: peers(first),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  }, first);
  const onboarding1 = createValidatorOnboarding({
    activationHeight: 10,
    currentValidators: members(first),
    networkId,
    nextValidators: members(second),
    peers: peers(second),
  }, first.slice(0, 3), second, second.map(({ address }) => transports.get(address)));
  const onboarding2 = createValidatorOnboarding({
    activationHeight: 20,
    currentValidators: members(second),
    networkId,
    nextValidators: members(third),
    peers: peers(third),
  }, second.slice(0, 3), third, third.map(({ address }) => transports.get(address)));
  const handoff1 = createValidatorHandoff({
    activationBlockHash: "a".repeat(64),
    activationHeight: 10,
    activationStateRoot: "b".repeat(64),
    networkId,
    nextValidators: members(second),
    previousValidators: members(first),
  }, first.slice(0, 3), second.slice(0, 3));
  const handoff2 = createValidatorHandoff({
    activationBlockHash: "c".repeat(64),
    activationHeight: 20,
    activationStateRoot: "d".repeat(64),
    networkId,
    nextValidators: members(third),
    previousValidators: members(second),
  }, second.slice(0, 3), third.slice(0, 3));
  const conflictingHandoff2 = createValidatorHandoff({
    activationBlockHash: "e".repeat(64),
    activationHeight: 20,
    activationStateRoot: "f".repeat(64),
    networkId,
    nextValidators: members(third),
    previousValidators: members(second),
  }, second.slice(0, 3), third.slice(0, 3));
  return {
    context: {
      genesisPeerRegistry,
      genesisValidators: members(first),
      handoffs: [handoff1, handoff2],
      networkId,
    },
    onboardings: [onboarding1, onboarding2],
    conflictingHandoff2,
    third,
  };
}

test("onboarding history advances endpoints through two handoff-bound generations", () => {
  const values = fixture();
  const verified = verifyValidatorTopologyHistory({
    ...values.context, onboardings: values.onboardings,
  });
  assert.equal(verified.activationHeight, 20);
  assert.deepEqual(verified.peerRegistry.peers.map(({ validatorAddress }) => validatorAddress),
    values.third.map(({ address }) => address).sort());
  assert.throws(() => verifyValidatorTopologyHistory({
    ...values.context, onboardings: [...values.onboardings].reverse(),
  }), /commitment|handoff|onboarding/);
  const tampered = structuredClone(values.onboardings);
  tampered[1].peers.at(-1).url = "http://127.0.0.1:9999";
  assert.throws(() => verifyValidatorTopologyHistory({
    ...values.context, onboardings: tampered,
  }), /commitment|signature/);
});

test("candidate selection accepts stale prefixes but rejects valid divergent histories", () => {
  const values = fixture();
  const selected = selectValidatorTopologyHistoryCandidates([
    {
      handoffs: values.context.handoffs.slice(0, 1),
      onboardings: values.onboardings.slice(0, 1),
    },
    { handoffs: values.context.handoffs, onboardings: values.onboardings },
    { handoffs: [], onboardings: [values.onboardings[0]] },
  ], {
    genesisPeerRegistry: values.context.genesisPeerRegistry,
    genesisValidators: values.context.genesisValidators,
    networkId: values.context.networkId,
  });
  assert.equal(selected.handoffs.length, 2);
  assert.equal(selected.verified.activationHeight, 20);
  assert.throws(() => selectValidatorTopologyHistoryCandidates([
    { handoffs: values.context.handoffs, onboardings: values.onboardings },
    {
      handoffs: [values.context.handoffs[0], values.conflictingHandoff2],
      onboardings: values.onboardings,
    },
  ], {
    genesisPeerRegistry: values.context.genesisPeerRegistry,
    genesisValidators: values.context.genesisValidators,
    networkId: values.context.networkId,
  }), /conflict/);
});

test("topology history is atomically redundant and repairs one damaged copy", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-topology-store-test-"));
  try {
    const values = fixture();
    installValidatorTopology(temporary, values.onboardings[0], values.context);
    installValidatorTopology(temporary, values.onboardings[1], values.context);
    let loaded = loadValidatorTopologyHistory(temporary, values.context);
    assert.equal(loaded.onboardings.length, 2);
    writeFileSync(join(temporary, "VALIDATOR-TOPOLOGIES.json"), "broken", { mode: 0o600 });
    loaded = loadValidatorTopologyHistory(temporary, values.context);
    assert.equal(loaded.recoveredCopies, 1);
    assert.equal(loaded.activationHeight, 20);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
