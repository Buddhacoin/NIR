import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeDistributedDevnet,
  ValidatorReplica,
} from "../blockchain/distributed-node.mjs";
import { requestJson } from "../blockchain/http-client.mjs";
import { IngressLimiter } from "../blockchain/ingress-limiter.mjs";
import {
  createPeerAnnouncement,
  discoverPeers,
  discoverPeersFromSeeds,
  selectPeerAnnouncements,
  verifyPeerAnnouncement,
} from "../blockchain/peer-discovery.mjs";
import { peerRegistryHash } from "../blockchain/peer-registry.mjs";
import { createValidatorHttpServer } from "../blockchain/validator-service.mjs";

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "nir-discovery-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const validator = new ValidatorReplica(layout.validatorDirectories[0]);
  const genesis = JSON.parse(readFileSync(
    join(layout.validatorDirectories[0], "genesis.json"), "utf8",
  ));
  const seed = genesis.peerRegistry.peers.find(
    ({ validatorAddress }) => validatorAddress === validator.address,
  );
  return { genesis, layout, seed, temporary, validator };
}

test("peer announcements are bound to the chain registry and transport key", () => {
  const { genesis, seed, temporary, validator } = fixture();
  try {
    const announcement = validator.peerAnnouncement();
    const verified = verifyPeerAnnouncement(announcement, {
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      trustedTransport: seed.transport,
    });
    assert.equal(verified.registryHash, peerRegistryHash(genesis.peerRegistry));
    assert.equal(verified.registry.peers.length, 4);
    assert.throws(() => verifyPeerAnnouncement({
      ...announcement,
      registry: {
        ...announcement.registry,
        peers: announcement.registry.peers.map((peer, index) => index === 0
          ? { ...peer, url: "http://127.0.0.1:9999" }
          : peer),
      },
    }, {
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      trustedTransport: seed.transport,
    }), /not trusted/);
    assert.throws(() => verifyPeerAnnouncement(announcement, {
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      minimumHeight: 1,
      trustedTransport: seed.transport,
    }), /not trusted/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a seed serves signed discovery under bounded ingress and server limits", async () => {
  const { genesis, seed, temporary, validator } = fixture();
  let server;
  try {
    server = createValidatorHttpServer(validator, {
      ingressLimiter: new IngressLimiter({ capacity: 2, refillPerMinute: 1 }),
      maxConnections: 32,
    });
    assert.equal(server.maxConnections, 32);
    assert.equal(server.maxHeadersCount, 64);
    assert.equal(server.requestTimeout, 10_000);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const seedUrl = `http://127.0.0.1:${server.address().port}`;
    const announcement = await discoverPeers({
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      seedUrl,
      trustedTransport: seed.transport,
    });
    assert.equal(announcement.registry.peers.length, 4);
    assert.equal((await requestJson(`${seedUrl}/v1/discovery`)).status, 200);
    const limited = await requestJson(`${seedUrl}/v1/discovery`);
    assert.equal(limited.status, 400);
    assert.match(limited.body.error, /rate limit/);
  } finally {
    if (server) await close(server);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("multi-seed discovery survives one outage and requires independent responses", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "nir-multi-discovery-test-"));
  const layout = initializeDistributedDevnet(join(temporary, "network"));
  const validators = layout.validatorDirectories.slice(0, 3)
    .map((directory) => new ValidatorReplica(directory));
  const genesis = JSON.parse(readFileSync(
    join(layout.validatorDirectories[0], "genesis.json"), "utf8",
  ));
  const peers = new Map(genesis.peerRegistry.peers.map((peer) =>
    [peer.validatorAddress, peer]));
  const servers = validators.slice(0, 2).map((validator) =>
    createValidatorHttpServer(validator));
  try {
    const urls = [];
    for (const server of servers) {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      urls.push(`http://127.0.0.1:${server.address().port}`);
    }
    const result = await discoverPeersFromSeeds({
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      minimumResponses: 2,
      seeds: validators.map((validator, index) => ({
        trustedTransport: peers.get(validator.address).transport,
        url: index < 2 ? urls[index] : "http://127.0.0.1:1",
      })),
    });
    assert.equal(result.respondingSeeds, 2);
    assert.equal(result.registry.peers.length, 4);
    await assert.rejects(() => discoverPeersFromSeeds({
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      minimumResponses: 3,
      seeds: validators.map((validator, index) => ({
        trustedTransport: peers.get(validator.address).transport,
        url: index < 2 ? urls[index] : "http://127.0.0.1:1",
      })),
    }), /insufficient/);
  } finally {
    await Promise.all(servers.map(close));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("multi-seed selection rejects independently signed conflicts at one height", () => {
  const { genesis, layout, temporary } = fixture();
  try {
    const validators = layout.validatorDirectories.slice(0, 2)
      .map((directory) => new ValidatorReplica(directory));
    const transports = layout.validatorDirectories.slice(0, 2).map((directory) =>
      JSON.parse(readFileSync(join(directory, "TRANSPORT-KEY.json"), "utf8")));
    const peerByValidator = new Map(genesis.peerRegistry.peers.map((peer) =>
      [peer.validatorAddress, peer]));
    const first = validators[0].peerAnnouncement();
    const conflicting = createPeerAnnouncement({
      height: first.height,
      networkId: genesis.networkId,
      registry: genesis.peerRegistry,
      tipHash: "f".repeat(64),
    }, transports[1]);
    assert.throws(() => selectPeerAnnouncements([
      { announcement: first, trustedTransport: peerByValidator.get(validators[0].address).transport },
      {
        announcement: conflicting,
        trustedTransport: peerByValidator.get(validators[1].address).transport,
      },
    ], {
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      minimumResponses: 2,
    }), /conflicting tips/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
