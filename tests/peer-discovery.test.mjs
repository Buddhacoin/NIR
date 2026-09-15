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
import { discoverPeers, verifyPeerAnnouncement } from "../blockchain/peer-discovery.mjs";
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
