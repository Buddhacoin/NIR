#!/usr/bin/env node
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

import {
  DistributedCoordinator,
  initializeDistributedDevnet,
  ValidatorReplica,
} from "./distributed-node.mjs";
import { createNodeHttpServer } from "./node-service.mjs";
import { createValidatorHttpServer } from "./validator-service.mjs";
import { certificateSha256 } from "./http-client.mjs";

const [command, directory, parameter = "", portText = ""] = process.argv.slice(2);

function validPort(text, fallback) {
  const port = Number(text || fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return port;
}

function tlsFromEnvironment() {
  const keyPath = process.env.NIR_TLS_KEY_PATH;
  const certPath = process.env.NIR_TLS_CERT_PATH;
  if (!keyPath && !certPath) return null;
  if (!keyPath || !certPath) {
    throw new Error("NIR_TLS_KEY_PATH and NIR_TLS_CERT_PATH must be set together");
  }
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  return { cert, key, fingerprint: certificateSha256(new X509Certificate(cert).raw) };
}

try {
  if (command === "init-dev" && directory) {
    const tls = tlsFromEnvironment();
    console.log(JSON.stringify(initializeDistributedDevnet(directory, {
      tlsCertificateSha256: tls?.fingerprint ?? null,
    }), null, 2));
  } else if (command === "serve-validator" && directory) {
    const port = validPort(parameter, 8791);
    const validator = new ValidatorReplica(directory);
    const tls = tlsFromEnvironment();
    const ownIndex = validator.peerUrls.findIndex((_, index) =>
      validator.peerAddress(index) === validator.address);
    const expectedPin = validator.peerTlsCertificateSha256(ownIndex);
    if ((expectedPin === null) !== (tls === null) ||
        (tls !== null && tls.fingerprint !== expectedPin)) {
      throw new Error("TLS certificate does not match the validator's active peer registry");
    }
    createValidatorHttpServer(validator, { tls }).listen(port, "127.0.0.1", () => {
      const protocol = tls ? "https" : "http";
      console.log(`NIR validator ${validator.address} listening on ${protocol}://127.0.0.1:${port}`);
    });
  } else if (command === "serve-coordinator" && directory && parameter) {
    const peers = parameter.split(",").filter(Boolean);
    const port = validPort(portText, 8787);
    const node = new DistributedCoordinator(directory, peers);
    createNodeHttpServer(node).listen(port, "127.0.0.1", () => {
      console.log(`NIR distributed coordinator listening on http://127.0.0.1:${port}`);
    });
  } else {
    throw new Error("usage: init-dev <new-dir> | serve-validator <dir> [port] | serve-coordinator <dir> <peer-urls> [port]");
  }
} catch (error) {
  console.error(`Network operation failed: ${error.message}`);
  process.exitCode = 1;
}
