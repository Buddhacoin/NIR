import { createHash, X509Certificate } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { parseConsensusJson } from "./consensus-json.mjs";
import { canonicalJson } from "./crypto.mjs";
import {
  verifyValidatorAdmissionReadinessCandidateResponse,
  verifyValidatorAdmissionReadinessChallenge,
  verifyValidatorAdmissionReadinessContext,
} from "./validator-admission-readiness-auth.mjs";

export const VALIDATOR_ADMISSION_READINESS_PATH =
  "/v1/validator-admission/readiness/challenge";
export const VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES = 64 * 1024;
export const VALIDATOR_ADMISSION_READINESS_MAX_TIMEOUT_MS = 60_000;
export const VALIDATOR_ADMISSION_READINESS_MAX_HEADER_BYTES = 16 * 1024;
const MAX_DNS_ADDRESSES = 16;

function ipv4Bytes(address) {
  if (isIP(address) !== 4) return null;
  const bytes = address.split(".").map(Number);
  return bytes.length === 4 && bytes.every((value) => Number.isInteger(value) &&
    value >= 0 && value <= 255) ? bytes : null;
}

function ipv6Bytes(address) {
  if (isIP(address) !== 6) return null;
  let source = address.toLowerCase().split("%")[0];
  const embeddedIndex = source.lastIndexOf(":");
  if (source.includes(".") && embeddedIndex >= 0) {
    const embedded = ipv4Bytes(source.slice(embeddedIndex + 1));
    if (!embedded) return null;
    source = `${source.slice(0, embeddedIndex)}:${((embedded[0] << 8) | embedded[1]).toString(16)}` +
      `:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ((halves.length === 1 && left.length !== 8) ||
      (halves.length === 2 && left.length + right.length >= 8)) return null;
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.flatMap((word) => {
    const value = Number.parseInt(word, 16);
    return [value >>> 8, value & 0xff];
  });
}

function prefix(bytes, expected, bits) {
  const whole = Math.floor(bits / 8); const remainder = bits % 8;
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== expected[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === (expected[whole] & mask);
}

export function isForbiddenValidatorReadinessAddress(address) {
  const v4 = ipv4Bytes(address);
  if (v4) {
    const [a, b, c] = v4;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const v6 = ipv6Bytes(address);
  if (!v6) return true;
  // Fail closed outside IANA's currently allocated global-unicast block, then remove
  // transition/documentation/special-purpose sub-ranges within that block.
  return !prefix(v6, [0x20], 3) || prefix(v6, [0x20, 0x01, 0x00], 23) ||
    prefix(v6, [0x20, 0x01, 0x0d, 0xb8], 32) || prefix(v6, [0x20, 0x02], 16) ||
    prefix(v6, [0x3f, 0xfe], 16) || prefix(v6, [0x3f, 0xff, 0x00], 20);
}

function canonicalRemoteAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address ?? "");
  if (mapped) return mapped[1];
  const v6 = ipv6Bytes(address);
  return v6 ? Buffer.from(v6).toString("hex") : String(address ?? "").toLowerCase();
}

function resolveAll(hostname, resolver, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, new Error("validator readiness probe was aborted"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      resolver(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) finish(reject, new Error("validator readiness DNS resolution failed"));
        else finish(resolve, addresses);
      });
    } catch {
      finish(reject, new Error("validator readiness DNS resolution failed"));
    }
  });
}

function assertOptions({ allowPrivateNetworkForTesting, connectTimeoutMs, resolver, signal,
  totalTimeoutMs }) {
  if (typeof allowPrivateNetworkForTesting !== "boolean" || typeof resolver !== "function" ||
      !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 ||
      connectTimeoutMs > VALIDATOR_ADMISSION_READINESS_MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 ||
      totalTimeoutMs > VALIDATOR_ADMISSION_READINESS_MAX_TIMEOUT_MS ||
      connectTimeoutMs > totalTimeoutMs || (signal !== null &&
      (typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
       typeof signal.addEventListener !== "function"))) {
    throw new Error("validator readiness probe options are invalid");
  }
}

function responseBody(value) {
  const encoded = Buffer.from(canonicalJson(value));
  if (encoded.length > VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES) {
    throw new Error("validator readiness probe request is too large");
  }
  return encoded;
}

export async function probeValidatorAdmissionReadiness({
  allowPrivateNetworkForTesting = false,
  challenge,
  connectTimeoutMs = 3_000,
  context,
  resolver = dnsLookup,
  signal = null,
  totalTimeoutMs = 5_000,
  validators,
} = {}) {
  assertOptions({ allowPrivateNetworkForTesting, connectTimeoutMs, resolver, signal,
    totalTimeoutMs });
  if (signal?.aborted) throw new Error("validator readiness probe was aborted");
  const verifiedContext = verifyValidatorAdmissionReadinessContext(context);
  const verifiedChallenge = verifyValidatorAdmissionReadinessChallenge(challenge,
    { context: verifiedContext, validators });
  const endpoint = new URL(verifiedContext.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("validator readiness probe endpoint must be an HTTPS origin");
  }
  const target = new URL(VALIDATOR_ADMISSION_READINESS_PATH, endpoint.origin);
  const payload = responseBody({ challenge: verifiedChallenge, context: verifiedContext });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs);
  try {
    const hostname = endpoint.hostname.startsWith("[")
      ? endpoint.hostname.slice(1, -1) : endpoint.hostname;
    const literalFamily = isIP(hostname);
    const resolved = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await resolveAll(hostname, resolver, controller.signal);
    if (!Array.isArray(resolved) || resolved.length < 1 || resolved.length > MAX_DNS_ADDRESSES ||
        resolved.some((entry) => !entry || ![4, 6].includes(entry.family) ||
          isIP(entry.address) !== entry.family)) {
      throw new Error("validator readiness DNS response is invalid");
    }
    if (!allowPrivateNetworkForTesting &&
        resolved.some(({ address }) => isForbiddenValidatorReadinessAddress(address))) {
      throw new Error("validator readiness endpoint resolves to a forbidden address");
    }
    const selected = [...resolved].sort((left, right) => left.family - right.family ||
      left.address.localeCompare(right.address))[0];
    return await new Promise((resolve, reject) => {
      let settled = false; let request; let connectTimer = null;
      const cleanup = () => {
        clearTimeout(connectTimer);
        controller.signal.removeEventListener("abort", onAbort);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true; cleanup(); reject(error);
      };
      const onAbort = () => request?.destroy(new Error(signal?.aborted
        ? "validator readiness probe was aborted" : "validator readiness probe timed out"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      request = httpsRequest(target, {
        agent: false,
        headers: { "content-length": payload.length, "content-type": "application/json" },
        lookup: (_hostname, options, callback) => options?.all
          ? callback(null, [selected])
          : callback(null, selected.address, selected.family),
        maxHeaderSize: VALIDATOR_ADMISSION_READINESS_MAX_HEADER_BYTES,
        maxVersion: "TLSv1.3",
        method: "POST",
        minVersion: "TLSv1.3",
        rejectUnauthorized: false,
        servername: literalFamily ? "" : hostname,
      }, (response) => {
        clearTimeout(connectTimer);
        if (response.statusCode !== 200) {
          response.destroy();
          return fail(new Error("validator readiness probe response status is invalid"));
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) &&
            contentLength > VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES) {
          response.destroy();
          return fail(new Error("validator readiness probe response is too large"));
        }
        const chunks = []; let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > VALIDATOR_ADMISSION_READINESS_MAX_BODY_BYTES) {
            response.destroy(); fail(new Error("validator readiness probe response is too large"));
          } else chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          try {
            const encoded = Buffer.concat(chunks).toString("utf8");
            const parsed = parseConsensusJson(encoded);
            if (encoded !== canonicalJson(parsed)) {
              throw new Error("validator readiness probe response is not canonical JSON");
            }
            const verified = verifyValidatorAdmissionReadinessCandidateResponse(parsed,
              { validators });
            if (canonicalJson(verified.context) !== canonicalJson(verifiedContext) ||
                canonicalJson(verified.challenge) !== canonicalJson(verifiedChallenge)) {
              throw new Error("validator readiness probe response context is mismatched");
            }
            settled = true; cleanup(); resolve(verified);
          } catch (error) { fail(error); }
        });
      });
      request.once("socket", (socket) => {
        connectTimer = setTimeout(() => request.destroy(
          new Error("validator readiness probe connect timed out")), connectTimeoutMs);
        socket.once("secureConnect", () => {
          clearTimeout(connectTimer);
          if (socket.getProtocol() !== "TLSv1.3") {
            return request.destroy(new Error("validator readiness probe requires TLS 1.3"));
          }
          if (canonicalRemoteAddress(socket.remoteAddress) !==
              canonicalRemoteAddress(selected.address)) {
            return request.destroy(new Error("validator readiness socket address changed"));
          }
          try {
            const certificate = socket.getPeerCertificate(true);
            if (!Buffer.isBuffer(certificate?.raw) || certificate.raw.length === 0) {
              throw new Error("validator readiness TLS leaf certificate is unavailable");
            }
            const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
            if (fingerprint !== verifiedContext.tlsCertificateSha256) {
              throw new Error("validator readiness TLS leaf certificate pin mismatch");
            }
            const parsed = new X509Certificate(certificate.raw); const now = Date.now();
            if (now < Date.parse(parsed.validFrom) || now >= Date.parse(parsed.validTo)) {
              throw new Error("validator readiness TLS leaf certificate is not currently valid");
            }
          } catch (error) { request.destroy(error); }
        });
      });
      request.on("error", fail);
      request.end(payload);
    });
  } finally {
    clearTimeout(totalTimer);
    signal?.removeEventListener?.("abort", abort);
  }
}
