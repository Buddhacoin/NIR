import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync,
} from "node:fs";
import {
  createPrivateKey, createPublicKey, timingSafeEqual, X509Certificate,
} from "node:crypto";
import { createSecureContext } from "node:tls";

import { CERTIFICATE_MODE_LIFECYCLE } from "./certificate-runtime.mjs";
import { certificateSha256 } from "./http-client.mjs";

const MAX_TLS_FILE_BYTES = 1024 * 1024;

function readDescriptorBound(path, name) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4_096) {
    throw new Error(`${name} path is invalid`);
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 ||
      before.size > MAX_TLS_FILE_BYTES) {
    throw new Error(`${name} file is unsafe or too large`);
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) {
      throw new Error(`${name} file changed during open`);
    }
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const length = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (length === 0) throw new Error(`${name} file changed during read`);
      offset += length;
    }
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`${name} file changed during read`);
    }
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadTlsKeyPair({ certPath, keyPath }) {
  const cert = readDescriptorBound(certPath, "TLS certificate");
  const key = readDescriptorBound(keyPath, "TLS private key");
  const certificate = new X509Certificate(cert);
  const privateKey = createPrivateKey(key);
  const certificatePublicKey = certificate.publicKey.export({ format: "der", type: "spki" });
  const privatePublicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (certificatePublicKey.length !== privatePublicKey.length ||
      !timingSafeEqual(certificatePublicKey, privatePublicKey)) {
    throw new Error("TLS private key does not match the certificate");
  }
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new Error("TLS certificate is outside its validity period");
  }
  createSecureContext({ cert, key, minVersion: "TLSv1.3" });
  return { cert, fingerprint: certificateSha256(certificate.raw), key };
}

export function installValidatorTlsReloader({
  certPath,
  keyPath,
  logger = (message) => console.error(message),
  server,
  signalTarget = process,
  validator,
}) {
  if (validator?.certificateMode !== CERTIFICATE_MODE_LIFECYCLE) {
    throw new Error("TLS context reload is available only in lifecycle mode");
  }
  if (typeof server?.setSecureContext !== "function" || typeof logger !== "function" ||
      typeof signalTarget?.on !== "function" || typeof signalTarget?.off !== "function") {
    throw new Error("TLS context reload controls are invalid");
  }
  const reload = () => {
    try {
      const material = loadTlsKeyPair({ certPath, keyPath });
      const ownIndex = Array.from({ length: validator.peerCount })
        .findIndex((_, index) => validator.peerAddress(index) === validator.address);
      if (ownIndex < 0 || !validator.peerTlsCertificateSha256Pins(ownIndex)
        .includes(material.fingerprint)) {
        throw new Error("TLS certificate fingerprint is not active at the finalized height");
      }
      server.setSecureContext({ cert: material.cert, key: material.key, minVersion: "TLSv1.3" });
      logger(`Validator TLS reload succeeded: ${material.fingerprint}`);
      return { fingerprint: material.fingerprint, height: validator.height };
    } catch (error) {
      logger(`Validator TLS reload failed: ${error.message}`);
      throw error;
    }
  };
  const onSignal = () => {
    try { reload(); } catch { /* The previous secure context remains active. */ }
  };
  signalTarget.on("SIGHUP", onSignal);
  return {
    close() { signalTarget.off("SIGHUP", onSignal); },
    reload,
  };
}
