import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";

/** Verify that the pinned certificate can actually serve the readiness endpoint. */
export function verifyValidatorReadinessTlsCertificate(certificate, key, {
  expectedHost, expectedSha256, now = Date.now(),
}) {
  if (!Buffer.isBuffer(certificate) || !Buffer.isBuffer(key) ||
      typeof expectedHost !== "string" || !expectedHost ||
      !/^[0-9a-f]{64}$/u.test(expectedSha256) || !Number.isSafeInteger(now)) {
    throw new Error("validator readiness TLS verification inputs are invalid");
  }
  let parsed;
  try { parsed = new X509Certificate(certificate); }
  catch { throw new Error("validator readiness TLS certificate is invalid"); }
  const digest = createHash("sha256").update(parsed.raw).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error("validator readiness TLS certificate disagrees with the pin");
  }
  const validFrom = Date.parse(parsed.validFrom);
  const validTo = Date.parse(parsed.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) ||
      now < validFrom || now >= validTo) {
    throw new Error("validator readiness TLS certificate is not currently valid");
  }
  const ipHost = expectedHost.startsWith("[") && expectedHost.endsWith("]")
    ? expectedHost.slice(1, -1) : expectedHost;
  const matchesHost = isIP(ipHost)
    ? parsed.checkIP(ipHost)
    : parsed.checkHost(expectedHost, { subject: "never" });
  if (!matchesHost) {
    throw new Error("validator readiness TLS certificate does not match the endpoint");
  }
  let privateKey;
  try { privateKey = createPrivateKey(key); }
  catch { throw new Error("validator readiness TLS private key is invalid"); }
  if (!parsed.checkPrivateKey(privateKey)) {
    throw new Error("validator readiness TLS private key does not match the certificate");
  }
  return Object.freeze({ certificateSha256: digest, host: expectedHost,
    validFrom, validTo });
}
