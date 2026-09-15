import { createHash, X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
} = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new Error("HTTP client URL protocol is invalid"));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return Promise.reject(new Error("HTTP client timeout is invalid"));
  }
  if (tlsCertificateSha256 !== null && !/^[0-9a-f]{64}$/.test(tlsCertificateSha256)) {
    return Promise.reject(new Error("TLS certificate pin is invalid"));
  }
  if (target.protocol === "http:" && tlsCertificateSha256 !== null) {
    return Promise.reject(new Error("TLS certificate pin cannot be used with plaintext HTTP"));
  }
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const outgoing = request(target, {
      headers: encoded ? {
        "content-length": encoded.length,
        "content-type": "application/json",
      } : undefined,
      method,
      minVersion: target.protocol === "https:" ? "TLSv1.3" : undefined,
      rejectUnauthorized: target.protocol === "https:" && tlsCertificateSha256 === null,
    }, (response) => {
      if (target.protocol === "https:" && tlsCertificateSha256 !== null) {
        const certificate = response.socket.getPeerCertificate?.();
        let fingerprint;
        try { fingerprint = certificateSha256(certificate?.raw); }
        catch (error) {
          response.destroy();
          return fail(error);
        }
        if (fingerprint !== tlsCertificateSha256) {
          response.destroy();
          return fail(new Error("TLS peer certificate pin mismatch"));
        }
        const parsed = new X509Certificate(certificate.raw);
        const now = Date.now();
        if (now < Date.parse(parsed.validFrom) || now > Date.parse(parsed.validTo)) {
          response.destroy();
          return fail(new Error("TLS peer certificate is outside its validity period"));
        }
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          fail(new Error("HTTP response is too large"));
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        try {
          const result = {
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
          };
          settled = true;
          resolve(result);
        } catch {
          fail(new Error("HTTP response is not valid JSON"));
        }
      });
      response.on("error", fail);
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("HTTP request timed out")));
    outgoing.on("error", fail);
    if (encoded) outgoing.write(encoded);
    outgoing.end();
  });
}
