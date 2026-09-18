#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "./distributed-node.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { createValidatorHttpServer } from "./validator-service.mjs";
import { discoverPeersFromSeeds } from "./peer-discovery.mjs";
import { peerRegistryHash } from "./peer-registry.mjs";
import { installValidatorTlsReloader, loadTlsKeyPair } from "./tls-context-reload.mjs";
import {
  CERTIFICATE_MODE_DEV_GENESIS,
  CERTIFICATE_MODE_LIFECYCLE,
} from "./certificate-runtime.mjs";
import { loadValidatorRuntimeFromCeremony } from "./ceremony-validator-init.mjs";
import { readCeremonyPasswordBuffers } from "./operator-secret-input.mjs";

const [command, directory, parameter = "", portText = ""] = process.argv.slice(2);

function validPort(text, fallback) {
  const port = Number(text || fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return port;
}

function tlsFromEnvironment(defaultCertificatePath = null) {
  const keyPath = process.env.NIR_TLS_KEY_PATH;
  const certPath = process.env.NIR_TLS_CERT_PATH ?? defaultCertificatePath;
  if (!keyPath && !certPath) return null;
  if (!keyPath || !certPath) {
    throw new Error("TLS startup requires a private-key path and certificate path");
  }
  return { ...loadTlsKeyPair({ certPath, keyPath }), certPath, keyPath };
}

function certificateModeFromEnvironment() {
  const mode = process.env.NIR_CERTIFICATE_MODE ?? CERTIFICATE_MODE_DEV_GENESIS;
  if (mode !== CERTIFICATE_MODE_DEV_GENESIS && mode !== CERTIFICATE_MODE_LIFECYCLE) {
    throw new Error("NIR_CERTIFICATE_MODE must be dev-genesis or lifecycle");
  }
  return mode;
}

try {
  if (command === "init-dev" && directory) {
    const tls = tlsFromEnvironment();
    console.log(JSON.stringify(initializeDistributedDevnet(directory, {
      tlsCertificateSha256: tls?.fingerprint ?? null,
    }), null, 2));
  } else if (command === "serve-validator" && directory) {
    const port = validPort(parameter, 8791);
    const ceremonyMode = lstatSync(directory).isSymbolicLink();
    let ceremonyCredentials = null;
    if (ceremonyMode) {
      if (!/^nir1[0-9a-f]{64}$/.test(portText)) {
        throw new Error("ceremony validator startup requires the trusted release signer address");
      }
      ceremonyCredentials = loadValidatorRuntimeFromCeremony(directory, {
        ...(await readCeremonyPasswordBuffers()), trustedAddress: portText,
      });
    }
    const runtimeDirectory = ceremonyCredentials?.directory ?? directory;
    const validator = new ValidatorReplica(runtimeDirectory, {
      certificateMode: certificateModeFromEnvironment(),
      ceremonyCredentials,
    });
    const tls = tlsFromEnvironment(ceremonyMode
      ? join(runtimeDirectory, "TLS-CERTIFICATE.pem") : null);
    const ownIndex = validator.peerUrls.findIndex((_, index) =>
      validator.peerAddress(index) === validator.address);
    const expectedPins = validator.peerTlsCertificateSha256Pins(ownIndex);
    if ((expectedPins === null) !== (tls === null) ||
        (tls !== null && !expectedPins.includes(tls.fingerprint))) {
      throw new Error("TLS certificate does not match the validator's active certificate mode");
    }
    const server = createValidatorHttpServer(validator, { tls });
    if (validator.certificateMode === CERTIFICATE_MODE_LIFECYCLE && tls !== null) {
      installValidatorTlsReloader({
        certPath: tls.certPath,
        keyPath: tls.keyPath,
        server,
        validator,
      });
    }
    server.listen(port, "127.0.0.1", () => {
      const protocol = tls ? "https" : "http";
      console.log(`NIR validator ${validator.address} listening on ${protocol}://127.0.0.1:${port}`);
    });
  } else if (command === "serve-coordinator" && directory && parameter) {
    const peers = parameter.split(",").filter(Boolean);
    const port = validPort(portText, 8787);
    const node = new DistributedCoordinator(directory, peers, {
      certificateMode: certificateModeFromEnvironment(),
    });
    createNodeHttpServer(node).listen(port, "127.0.0.1", () => {
      console.log(`NIR distributed coordinator listening on http://127.0.0.1:${port}`);
    });
  } else if (command === "discover" && directory && parameter) {
    const genesis = JSON.parse(readFileSync(directory, "utf8"));
    const requestedOrigins = parameter.split(",").filter(Boolean).map((value) =>
      new URL(value).origin);
    const registrySeeds = new Map(genesis.peerRegistry?.peers?.map((peer) =>
      [new URL(peer.url).origin, peer]));
    const seeds = requestedOrigins.map((origin) => {
      const seed = registrySeeds.get(origin);
      if (!seed) throw new Error(`seed URL is not trusted by genesis: ${origin}`);
      return {
        tlsCertificateSha256: seed.tlsCertificateSha256,
        trustedTransport: seed.transport,
        url: origin,
      };
    });
    const announcement = await discoverPeersFromSeeds({
      expectedNetworkId: genesis.networkId,
      expectedRegistryHash: peerRegistryHash(genesis.peerRegistry),
      minimumResponses: Math.min(2, seeds.length),
      seeds,
    });
    console.log(JSON.stringify(announcement, null, 2));
  } else {
    throw new Error("usage: init-dev <new-dir> | serve-validator <dir> [port] [trusted-release-address-for-ceremony] | serve-coordinator <dir> <peer-urls> [port] | discover <genesis.json> <seed-urls-comma-separated>");
  }
} catch (error) {
  console.error(`Network operation failed: ${error.message}`);
  process.exitCode = 1;
}
