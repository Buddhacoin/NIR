#!/usr/bin/env node
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";

import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "./distributed-node.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { createValidatorControlServer, createValidatorHttpServer } from "./validator-service.mjs";
import { listenOnPrivateValidatorControlSocket } from "./validator-control-socket.mjs";
import { discoverPeersFromSeeds } from "./peer-discovery.mjs";
import { peerRegistryHash } from "./peer-registry.mjs";
import { installValidatorTlsReloader, loadTlsKeyPair } from "./tls-context-reload.mjs";
import {
  CERTIFICATE_MODE_DEV_GENESIS,
  CERTIFICATE_MODE_LIFECYCLE,
} from "./certificate-runtime.mjs";
import { loadValidatorRuntimeFromCeremony } from "./ceremony-validator-init.mjs";
import { readCeremonyPasswordBuffers } from "./operator-secret-input.mjs";
import { readBoundedPublicJsonFile } from "./secure-public-json.mjs";
import { listenOnLoopback } from "./loopback-listener.mjs";

const [command, directory, parameter = "", portText = ""] = process.argv.slice(2);

function validPort(text, fallback) {
  const port = Number(text || fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return port;
}

function inheritedListenerFd() {
  const text = process.env.NIR_LISTEN_FD;
  if (text === undefined) return null;
  delete process.env.NIR_LISTEN_FD;
  const descriptor = Number(text);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 255) {
    throw new Error("inherited listener descriptor is invalid");
  }
  return descriptor;
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

function certificateModeFromEnvironment({ ceremonyMode = false } = {}) {
  if (ceremonyMode && process.env.NIR_CERTIFICATE_MODE === undefined) {
    throw new Error("ceremony validator startup requires explicit NIR_CERTIFICATE_MODE");
  }
  const mode = process.env.NIR_CERTIFICATE_MODE ?? CERTIFICATE_MODE_DEV_GENESIS;
  if (mode !== CERTIFICATE_MODE_DEV_GENESIS && mode !== CERTIFICATE_MODE_LIFECYCLE) {
    throw new Error("NIR_CERTIFICATE_MODE must be dev-genesis or lifecycle");
  }
  return mode;
}

function certificateHeadAnchorPathFromEnvironment(mode, runtimeDirectory) {
  if (mode !== CERTIFICATE_MODE_LIFECYCLE) {
    if (process.env.NIR_CERTIFICATE_HEAD_ANCHOR_PATH !== undefined) {
      throw new Error("external certificate history anchor requires lifecycle mode");
    }
    return null;
  }
  const path = process.env.NIR_CERTIFICATE_HEAD_ANCHOR_PATH;
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("lifecycle mode requires an absolute NIR_CERTIFICATE_HEAD_ANCHOR_PATH");
  }
  const relativePath = relative(realpathSync(runtimeDirectory), realpathSync(path));
  if (relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))) {
    throw new Error("external certificate history anchor must be outside node state");
  }
  return path;
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
    const certificateMode = certificateModeFromEnvironment({ ceremonyMode });
    const listenerFd = inheritedListenerFd();
    if (ceremonyMode && (listenerFd === 3 || listenerFd === 4)) {
      throw new Error("inherited listener descriptor collides with ceremony password descriptors");
    }
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
      certificateMode,
      certificateHeadAnchorPath: certificateHeadAnchorPathFromEnvironment(
        certificateMode, runtimeDirectory),
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
    await listenOnLoopback(server, { host: "127.0.0.1", inheritedFd: listenerFd,
      label: "validator listener", port });
    let control = null;
    if (ceremonyMode) {
      try {
        const local = createValidatorControlServer(validator);
        control = await listenOnPrivateValidatorControlSocket(local.server,
          process.env.NIR_VALIDATOR_CONTROL_DIR);
        local.enable();
      } catch (error) {
        await server.gracefulShutdown();
        throw error;
      }
      console.log(`NIR validator control socket ${control.path}`);
    }
    const shutdown = async () => {
      try {
        await control?.close();
        await server.gracefulShutdown();
        process.exitCode = 0;
      } catch { process.exit(1); }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    const protocol = tls ? "https" : "http";
    console.log(`NIR validator ${validator.address} listening on ${protocol}://127.0.0.1:${port}`);
  } else if (command === "serve-coordinator" && directory && parameter) {
    const peers = parameter.split(",").filter(Boolean);
    const port = validPort(portText, 8787);
    const certificateMode = certificateModeFromEnvironment();
    const node = new DistributedCoordinator(directory, peers, {
      certificateMode,
      certificateHeadAnchorPath: certificateHeadAnchorPathFromEnvironment(certificateMode, directory),
    });
    createNodeHttpServer(node).listen(port, "127.0.0.1", () => {
      console.log(`NIR distributed coordinator listening on http://127.0.0.1:${port}`);
    });
  } else if (command === "discover" && directory && parameter) {
    const genesis = readBoundedPublicJsonFile(directory, {
      label: "discovery genesis", maximumBytes: 2 * 1024 * 1024,
    });
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
