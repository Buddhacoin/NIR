import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyValidatorReadinessTlsCertificate }
  from "../blockchain/validator-readiness-tls.mjs";

const root = mkdtempSync(join(tmpdir(), "nir-readiness-tls-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

function certificate(name, san) {
  const keyPath = join(root, `${name}-key.pem`);
  const certificatePath = join(root, `${name}-cert.pem`);
  const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certificatePath, "-days", "1", "-subj", "/CN=localhost"];
  if (san) args.push("-addext", `subjectAltName=${san}`);
  execFileSync("openssl", args, { stdio: "ignore" });
  const pem = readFileSync(certificatePath);
  return { pem, key: readFileSync(keyPath),
    hash: createHash("sha256").update(new X509Certificate(pem).raw).digest("hex") };
}

test("readiness TLS accepts only a current, SAN-matched, pinned keypair", () => {
  const correct = certificate("correct", "IP:127.0.0.1,DNS:readiness.example");
  const other = certificate("other", "IP:127.0.0.2");
  const parsed = new X509Certificate(correct.pem);
  const now = Date.parse(parsed.validFrom) + 1_000;
  const options = { expectedHost: "127.0.0.1", expectedSha256: correct.hash, now };
  const verified = verifyValidatorReadinessTlsCertificate(correct.pem, correct.key, options);
  assert.equal(verified.certificateSha256, correct.hash);
  assert.equal(verified.host, "127.0.0.1");
  assert.equal(verifyValidatorReadinessTlsCertificate(correct.pem, correct.key,
    { ...options, expectedHost: "readiness.example" }).host, "readiness.example");
  assert.throws(() => verifyValidatorReadinessTlsCertificate(correct.pem, correct.key,
    { ...options, expectedHost: "127.0.0.2" }), /does not match the endpoint/);
  assert.throws(() => verifyValidatorReadinessTlsCertificate(correct.pem, correct.key,
    { ...options, expectedHost: "other.example" }), /does not match the endpoint/);
  assert.throws(() => verifyValidatorReadinessTlsCertificate(correct.pem, correct.key,
    { ...options, now: Date.parse(parsed.validFrom) - 1 }), /not currently valid/);
  assert.throws(() => verifyValidatorReadinessTlsCertificate(correct.pem, correct.key,
    { ...options, now: Date.parse(parsed.validTo) }), /not currently valid/);
  assert.throws(() => verifyValidatorReadinessTlsCertificate(correct.pem, other.key, options),
    /private key does not match/);
  assert.throws(() => verifyValidatorReadinessTlsCertificate(correct.pem, correct.key,
    { ...options, expectedSha256: other.hash }), /disagrees with the pin/);
});

test("readiness TLS rejects a legacy CN-only certificate for a DNS endpoint", () => {
  const legacy = certificate("cn-only", null);
  const parsed = new X509Certificate(legacy.pem);
  assert.throws(() => verifyValidatorReadinessTlsCertificate(legacy.pem, legacy.key,
    { expectedHost: "localhost", expectedSha256: legacy.hash,
      now: Date.parse(parsed.validFrom) + 1_000 }), /does not match the endpoint/);
});
