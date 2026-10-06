import { createHash, X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseConsensusJson } from "./consensus-json.mjs";
import {
  certificatePinsAtHeight,
  verifyCertificateHistory,
} from "./certificate-lifecycle.mjs";

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function certificateSha256(rawCertificate) {
  if (!Buffer.isBuffer(rawCertificate) || rawCertificate.length === 0) {
    throw new Error("TLS peer certificate is unavailable");
  }
  return createHash("sha256").update(rawCertificate).digest("hex");
}

export function requestJson(url, {
  body = undefined,
  method = body === undefined ? "GET" : "POST",
  timeoutMs = 3_000,
  tlsCertificateSha256 = null,
  tlsCertificateSha256Pins = null,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal = null,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new Error("HTTP client URL protocol is invalid"));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return Promise.reject(new Error("HTTP client timeout is invalid"));
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 ||
      maxResponseBytes > 40 * 1024 * 1024) {
    return Promise.reject(new Error("HTTP response size limit is invalid"));
  }
  if (signal !== null && (typeof signal !== "object" ||
      typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    return Promise.reject(new Error("HTTP abort signal is invalid"));
  }
  if (signal?.aborted) return Promise.reject(new Error("HTTP request was aborted"));
  if (tlsCertificateSha256 !== null && !/^[0-9a-f]{64}$/.test(tlsCertificateSha256)) {
    return Promise.reject(new Error("TLS certificate pin is invalid"));
  }
  if (tlsCertificateSha256Pins !== null &&
      (!Array.isArray(tlsCertificateSha256Pins) || tlsCertificateSha256Pins.length < 1 ||
       tlsCertificateSha256Pins.length > 2 ||
       tlsCertificateSha256Pins.some((pin) => !/^[0-9a-f]{64}$/.test(pin)) ||
       new Set(tlsCertificateSha256Pins).size !== tlsCertificateSha256Pins.length)) {
    return Promise.reject(new Error("TLS certificate pin set is invalid"));
  }
  if (tlsCertificateSha256 !== null && tlsCertificateSha256Pins !== null) {
    return Promise.reject(new Error("TLS certificate pin options conflict"));
  }
  const certificatePins = tlsCertificateSha256Pins !== null
    ? Object.freeze([...tlsCertificateSha256Pins])
    : tlsCertificateSha256 === null ? null : Object.freeze([tlsCertificateSha256]);
  if (target.protocol === "http:" && certificatePins !== null) {
    return Promise.reject(new Error("TLS certificate pin cannot be used with plaintext HTTP"));
  }
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    let peerVerified = certificatePins === null;
    let outgoing;
    const cleanup = () => signal?.removeEventListener?.("abort", abort);
    const fail = (error) => {
      if (settled) return;
      settled = true; cleanup();
      reject(error);
    };
    const abort = () => outgoing?.destroy(new Error("HTTP request was aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    const verifyPeer = (socket) => {
      const certificate = socket.getPeerCertificate?.();
      const fingerprint = certificateSha256(certificate?.raw);
      if (!certificatePins.includes(fingerprint)) {
        throw new Error("TLS peer certificate pin mismatch");
      }
      const parsed = new X509Certificate(certificate.raw);
      const now = Date.now();
      const validFrom = Date.parse(parsed.validFrom);
      const validTo = Date.parse(parsed.validTo);
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) ||
          now < validFrom || now >= validTo) {
        throw new Error("TLS peer certificate is outside its validity period");
      }
    };
    const send = () => {
      if (settled) return;
      try {
        if (encoded) outgoing.write(encoded);
        outgoing.end();
      } catch (error) { outgoing.destroy(error); }
    };
    outgoing = request(target, {
      agent: certificatePins === null ? undefined : false,
      headers: encoded ? {
        "content-length": encoded.length,
        "content-type": "application/json",
      } : undefined,
      method,
      minVersion: target.protocol === "https:" ? "TLSv1.3" : undefined,
      rejectUnauthorized: target.protocol === "https:" && certificatePins === null,
    }, (response) => {
      if (!peerVerified) {
        response.destroy();
        return fail(new Error("TLS peer certificate was not verified before the request"));
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          response.destroy();
          fail(new Error("HTTP response is too large"));
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        try {
          const result = {
            body: parseConsensusJson(Buffer.concat(chunks).toString("utf8")),
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
          };
          settled = true; cleanup();
          resolve(result);
        } catch {
          fail(new Error("HTTP response is not valid JSON"));
        }
      });
      response.on("error", fail);
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("HTTP request timed out")));
    outgoing.on("error", fail);
    if (certificatePins === null) send();
    else outgoing.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        if (settled) return;
        try { verifyPeer(socket); }
        catch (error) { outgoing.destroy(error); return; }
        peerVerified = true;
        send();
      });
    });
  });
}

export function requestValidatorJson(url, {
  certificateContext,
  certificateHistory,
  height,
  validatorAddress,
  ...options
} = {}) {
  let pins;
  try {
    if (!certificateContext || typeof certificateContext !== "object") {
      throw new Error("verified certificate context is required");
    }
    const verifiedHistory = verifyCertificateHistory(certificateHistory, certificateContext);
    pins = certificatePinsAtHeight(verifiedHistory, validatorAddress, height);
  } catch (error) {
    return Promise.reject(error);
  }
  if (pins.length === 0) {
    return Promise.reject(new Error("validator has no active authenticated TLS certificate"));
  }
  if (options.tlsCertificateSha256 !== undefined ||
      options.tlsCertificateSha256Pins !== undefined) {
    return Promise.reject(new Error("validator TLS pins must come from certificate history"));
  }
  return requestJson(url, { ...options, tlsCertificateSha256Pins: pins });
}
