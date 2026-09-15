import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { finalizeBlock, NirChain } from "../blockchain/chain.mjs";
import {
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import {
  createPeerRegistry,
  EMPTY_PEER_REGISTRY_HASH,
  peerRegistryHash,
  verifyPeerRegistry,
} from "../blockchain/peer-registry.mjs";

function validators(wallets) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), operatorId: `validator-${index}`,
  }));
}

function peers(consensusWallets, transportWallets, prefix = "node") {
  return consensusWallets.map((wallet, index) => ({
    tlsCertificateSha256: `${index}`.repeat(64),
    transport: publicWallet(transportWallets[index]),
    url: `https://${prefix}-${index}.nir.example:9443`,
    validatorAddress: wallet.address,
  }));
}

test("a quorum-authorized peer registry rotates endpoints and separate transport keys", () => {
  const consensusWallets = Array.from({ length: 4 }, generateWallet);
  const firstTransports = Array.from({ length: 4 }, generateWallet);
  const secondTransports = Array.from({ length: 4 }, generateWallet);
  const members = validators(consensusWallets);
  const initial = createPeerRegistry({
    activationHeight: 0,
    epoch: 0,
    networkId: "nir-peer-registry-test",
    peers: peers(consensusWallets, firstTransports, "old"),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  }, consensusWallets.slice(0, 3));
  assert.equal(verifyPeerRegistry(initial, {
    currentHeight: 0, networkId: "nir-peer-registry-test", validators: members,
  }).epoch, 0);

  const rotated = createPeerRegistry({
    activationHeight: 10,
    epoch: 1,
    networkId: "nir-peer-registry-test",
    peers: peers(consensusWallets, secondTransports, "new"),
    previousRegistryHash: peerRegistryHash(initial),
  }, consensusWallets.slice(1));
  const verified = verifyPeerRegistry(rotated, {
    currentHeight: 10,
    networkId: "nir-peer-registry-test",
    previousRegistry: initial,
    validators: members,
  });
  assert.equal(verified.epoch, 1);
  assert.ok(verified.peers.every((peer) => peer.url.startsWith("https://new-")));
  assert.ok(verified.peers.every((peer) =>
    peer.transport.address !== peer.validatorAddress));

  assert.throws(() => verifyPeerRegistry(rotated, {
    currentHeight: 9,
    networkId: "nir-peer-registry-test",
    previousRegistry: initial,
    validators: members,
  }), /not active/);
  assert.throws(() => verifyPeerRegistry({ ...rotated, previousRegistryHash: "0".repeat(64) }, {
    currentHeight: 10,
    networkId: "nir-peer-registry-test",
    previousRegistry: initial,
    validators: members,
  }), /lineage/);
  assert.throws(() => createPeerRegistry({
    activationHeight: 11,
    epoch: 1,
    networkId: "nir-peer-registry-test",
    peers: [{ ...peers(consensusWallets, secondTransports)[0],
      tlsCertificateSha256: null, url: "http://public.example" },
      ...peers(consensusWallets, secondTransports).slice(1)],
    previousRegistryHash: peerRegistryHash(initial),
  }, consensusWallets.slice(0, 3)), /require HTTPS/);
});

test("tampering and minority approval cannot replace the peer registry", () => {
  const consensusWallets = Array.from({ length: 4 }, generateWallet);
  const transportWallets = Array.from({ length: 4 }, generateWallet);
  const members = validators(consensusWallets);
  const fields = {
    activationHeight: 0,
    epoch: 0,
    networkId: "nir-peer-tamper-test",
    peers: peers(consensusWallets, transportWallets),
    previousRegistryHash: EMPTY_PEER_REGISTRY_HASH,
  };
  const minority = createPeerRegistry(fields, consensusWallets.slice(0, 2));
  assert.throws(() => verifyPeerRegistry(minority, {
    currentHeight: 0, networkId: fields.networkId, validators: members,
  }), /quorum/);
  const quorum = createPeerRegistry(fields, consensusWallets.slice(0, 3));
  const tampered = structuredClone(quorum);
  tampered.peers[0].url = "https://attacker.example";
  assert.throws(() => verifyPeerRegistry(tampered, {
    currentHeight: 0, networkId: fields.networkId, validators: members,
  }), /approval/);
});

test("validator gossip authenticates with transport keys, not finality keys", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-transport-separation-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    const replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
    const payload = { height: 7 };
    const auth = replicas[0].createValidatorRequest("/v1/p2p/test", payload);
    assert.notEqual(auth.signer, replicas[0].address);
    const nonce = replicas[1].authorizeValidator(auth, "POST", "/v1/p2p/test", payload);
    assert.equal(replicas[1].validatorAddressForPeerSigner(auth.signer), replicas[0].address);
    const result = { accepted: true };
    const response = replicas[1].authenticateValidatorResponse(nonce, result);
    assert.deepEqual(replicas[0].verifyValidatorResponse(1, response, nonce, result), result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("validators activate a quorum-signed transport rotation after chain height advances", () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-transport-rotation-test-"));
  try {
    const layout = initializeDistributedDevnet(join(temporary, "network"));
    let replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
    const genesis = JSON.parse(readFileSync(
      join(layout.coordinatorDirectory, "genesis.json"), "utf8",
    ));
    const consensusWallets = layout.validatorDirectories.map((directory) =>
      JSON.parse(readFileSync(join(directory, "VALIDATOR-KEY.json"), "utf8")));
    const initial = JSON.parse(readFileSync(
      join(layout.validatorDirectories[0], "PEER-REGISTRY.json"), "utf8",
    ));
    const chain = new NirChain(genesis);
    const newTransports = Array.from({ length: 4 }, generateWallet);
    const rotated = createPeerRegistry({
      activationHeight: 1,
      epoch: 1,
      networkId: genesis.networkId,
      peers: consensusWallets.map((wallet, index) => ({
        transport: publicWallet(newTransports[index]),
        url: layout.validatorUrls[index],
        validatorAddress: wallet.address,
      })),
      previousRegistryHash: peerRegistryHash(initial),
    }, consensusWallets.slice(0, 3));
    const proposal = chain.buildBlock({
      peerRegistryUpdate: rotated, timestamp: 1,
    });
    assert.throws(() => chain.validateProposal({
      ...proposal, peerRegistryHash: "0".repeat(64),
    }), /peer registry commitment/);
    const block = finalizeBlock(proposal, consensusWallets.slice(0, 3));
    replicas.forEach((replica) => replica.commit(block));
    assert.throws(() => new ValidatorReplica(layout.validatorDirectories[0]),
      /does not match finalized chain state/);
    layout.validatorDirectories.forEach((directory, index) => {
      writeFileSync(join(directory, "PEER-REGISTRIES.json"),
        `${JSON.stringify([initial, rotated], null, 2)}\n`, { mode: 0o600 });
      writeFileSync(join(directory, "TRANSPORT-KEY.json"),
        `${JSON.stringify(newTransports[index], null, 2)}\n`, { mode: 0o600 });
    });
    replicas = layout.validatorDirectories.map((directory) => new ValidatorReplica(directory));
    const payload = { epoch: 1 };
    const auth = replicas[0].createValidatorRequest("/v1/p2p/rotation", payload);
    assert.equal(auth.signer, newTransports[0].address);
    assert.equal(replicas[1].authorizeValidator(
      auth, "POST", "/v1/p2p/rotation", payload,
    ), auth.nonce);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
