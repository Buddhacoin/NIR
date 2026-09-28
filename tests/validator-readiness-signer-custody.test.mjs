import assert from "node:assert/strict";
import { createCipheriv, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { Duplex } from "node:stream";
import test from "node:test";
import { inspect } from "node:util";

import { canonicalJson, verifyObject } from "../blockchain/crypto.mjs";
import { encryptedVaultPublicCommitment, encryptWallet } from "../blockchain/vault.mjs";
import {
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN,
  VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import {
  createValidatorReadinessTransportSignerEndpoint,
} from "../blockchain/validator-readiness-signer-channel.mjs";
import { createValidatorReadinessSignerCustody }
  from "../blockchain/validator-readiness-signer-custody.mjs";
import {
  createValidatorReadinessProcessBootstrapSet,
  createValidatorReadinessSignerReadyWithCapability,
  verifyValidatorReadinessSignerReady,
} from "../blockchain/validator-readiness-process-protocol.mjs";
import {
  createValidatorReadinessSignerFrameDecoder,
  createValidatorReadinessTransportSignRequest,
  encodeValidatorReadinessSignerFrame,
} from "../blockchain/validator-readiness-signer-protocol.mjs";
import {
  READINESS_SIGNER_NOW, validatorReadinessSignerFixture,
} from "./validator-readiness-signer-fixture.mjs";

const SOURCE = readFileSync(new URL(
  "../blockchain/validator-readiness-signer-custody.mjs", import.meta.url), "utf8");

class MemoryDuplex extends Duplex {
  peer = null;
  _read() {}
  _write(chunk, _encoding, callback) {
    if (!this.peer || this.peer.destroyed) return callback(new Error("memory peer unavailable"));
    this.peer.push(Buffer.from(chunk)); callback();
  }
  _final(callback) { this.peer?.push(null); callback(); }
  _destroy(error, callback) { if (this.peer && !this.peer.destroyed) this.peer.push(null); callback(error); }
}

function pair() {
  const left = new MemoryDuplex(); const right = new MemoryDuplex();
  left.peer = right; right.peer = left; return { left, right };
}

function setup() {
  const values = validatorReadinessSignerFixture();
  const consensusPassword = "consensus-custody-test-password";
  const transportPassword = "transport-custody-test-password";
  const consensusVault = encryptWallet(values.candidate, consensusPassword,
    { label: "Consensus custody" });
  const transportVault = encryptWallet(values.transport, transportPassword,
    { label: "Transport custody" });
  const bootstraps = createValidatorReadinessProcessBootstrapSet({
    consensusVault, gatewayRolePackage: values.gatewayRolePackage,
    initialHeight: values.context.checkpoint.height,
    tlsCertificateSha256: values.context.tlsCertificateSha256, transportVault,
  }, { now: READINESS_SIGNER_NOW });
  return { ...values, ...bootstraps, consensusPassword, consensusVault,
    transportPassword, transportVault };
}

function custody(values, role) {
  const passwordBuffer = Buffer.from(role === "transport"
    ? values.transportPassword : values.consensusPassword);
  const result = createValidatorReadinessSignerCustody({ encryptedVault: role === "transport"
    ? values.transportVault : values.consensusVault,
    expectedVaultCommitment: role === "transport"
      ? values.transportSignerBootstrap.vaultCommitment
      : values.consensusSignerBootstrap.vaultCommitment, passwordBuffer, role });
  assert.ok(passwordBuffer.equals(Buffer.alloc(passwordBuffer.length)));
  return result;
}

function launchTrust(values, expectedPid) {
  return { expectedLauncherNonce: values.launcherNonce, expectedPid,
    expectedReleaseProvenanceHash: values.session.releaseProvenanceHash,
    expectedSessionHash: values.session.sessionHash };
}

function replaceEncryptedPlaintext(vault, password, plaintext) {
  const result = structuredClone(vault);
  const salt = Buffer.from(result.kdf.salt, "base64");
  const iv = Buffer.from(result.cipher.iv, "base64");
  const key = scryptSync(password, salt, 32,
    { N: result.kdf.N, r: result.kdf.r, p: result.kdf.p, maxmem: 64 * 1024 * 1024 });
  const metadata = { address: result.address, algorithm: result.algorithm, format: result.format,
    label: result.label, publicKey: result.publicKey, version: result.version };
  const aad = Buffer.from(canonicalJson(metadata), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    try {
      result.cipher.ciphertext = ciphertext.toString("base64");
      result.cipher.tag = cipher.getAuthTag().toString("base64");
    } finally { ciphertext.fill(0); }
    return result;
  } finally { salt.fill(0); iv.fill(0); key.fill(0); aad.fill(0); }
}

test("custody exposes only a frozen null-prototype identity and role-fixed capabilities", () => {
  const values = setup();
  for (const role of ["consensus", "transport"]) {
    const signer = custody(values, role);
    const identity = role === "transport" ? values.transport : values.candidate;
    assert.equal(Object.getPrototypeOf(signer), null);
    assert.equal(Object.isFrozen(signer), true);
    assert.deepEqual(Reflect.ownKeys(signer).sort(), ["address", "algorithm", "publicKey",
      role === "transport" ? "signReadinessTransportInput" : "signReadinessConsensusInput",
      "signValidatorReadinessReadyInput"].sort());
    assert.deepEqual(Object.keys(signer), ["address", "algorithm", "publicKey"]);
    assert.deepEqual(JSON.parse(JSON.stringify(signer)), {
      address: identity.address, algorithm: identity.algorithm, publicKey: identity.publicKey,
    });
    assert.equal(signer.address, identity.address);
    assert.equal(typeof signer.sign, "undefined");
    assert.equal(typeof signer.privateKey, "undefined");
    assert.equal(typeof signer.keyObject, "undefined");
    assert.equal(typeof signer.signValidatorReadinessReadyInput, "function");
    assert.equal(typeof signer[role === "transport" ? "signReadinessTransportInput"
      : "signReadinessConsensusInput"], "function");
    assert.equal(typeof signer[role === "transport" ? "signReadinessConsensusInput"
      : "signReadinessTransportInput"], "undefined");
    const reflected = [JSON.stringify(signer), inspect(signer, { showHidden: true }),
      inspect(Object.getOwnPropertyDescriptors(signer), { showHidden: true })].join("\n");
    assert.equal(reflected.includes(identity.privateKey ?? "never-match"), false);
    assert.equal(reflected.includes((role === "transport" ? values.transportVault
      : values.consensusVault).cipher.ciphertext), false);
  }
});

test("both custody roles sign only their pinned operation and READY domains", () => {
  const values = setup();
  for (const role of ["consensus", "transport"]) {
    const signer = custody(values, role); const input = { purpose: `test-${role}` };
    const operationMethod = role === "transport" ? "signReadinessTransportInput"
      : "signReadinessConsensusInput";
    const operationDomain = role === "transport"
      ? VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN
      : VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN;
    const signature = signer[operationMethod](input);
    assert.equal(verifyObject(input, signature, signer.publicKey, operationDomain), true);
    assert.equal(verifyObject(input, signature, signer.publicKey,
      role === "transport" ? VALIDATOR_ADMISSION_READINESS_CANDIDATE_CONSENSUS_RESPONSE_DOMAIN
        : VALIDATOR_ADMISSION_READINESS_CANDIDATE_RESPONSE_DOMAIN), false);

    const bootstrap = role === "transport" ? values.transportSignerBootstrap
      : values.consensusSignerBootstrap;
    const ready = createValidatorReadinessSignerReadyWithCapability({ bootstrap, pid: 4321,
      signer }, { now: READINESS_SIGNER_NOW });
    assert.deepEqual(verifyValidatorReadinessSignerReady(ready, { bootstrap, expectedRole: role,
      now: READINESS_SIGNER_NOW, ...launchTrust(values, 4321) }), ready);
  }
});

test("custody clears caller password buffers on success and every failure", () => {
  const values = setup();
  const cases = [
    { encryptedVault: values.consensusVault, password: values.consensusPassword, role: "consensus",
      succeeds: true },
    { encryptedVault: values.consensusVault, password: "incorrect-custody-password", role: "consensus" },
    { encryptedVault: { ...values.consensusVault, extra: true },
      password: values.consensusPassword, role: "consensus" },
    { encryptedVault: values.consensusVault, password: values.consensusPassword, role: "transport",
      succeeds: true },
    { encryptedVault: values.consensusVault, password: "short", role: "consensus" },
  ];
  for (const item of cases) {
    const passwordBuffer = Buffer.from(item.password);
    const expectedVaultCommitment = values.consensusSignerBootstrap.vaultCommitment;
    if (item.succeeds) createValidatorReadinessSignerCustody({
      encryptedVault: item.encryptedVault, expectedVaultCommitment, passwordBuffer, role: item.role,
    });
    else assert.throws(() => createValidatorReadinessSignerCustody({
      encryptedVault: item.encryptedVault, expectedVaultCommitment, passwordBuffer, role: item.role,
    }), { message: "validator readiness signer custody initialization failed" });
    assert.ok(passwordBuffer.equals(Buffer.alloc(passwordBuffer.length)));
  }
});

test("vault identity, ciphertext, role, and input mutations fail closed", () => {
  const values = setup();
  const mutations = [
    (vault) => { vault.address = values.transport.address; },
    (vault) => { vault.publicKey = values.transport.publicKey; },
    (vault) => { vault.cipher.tag = Buffer.alloc(16).toString("base64"); },
    (vault) => { vault.cipher.ciphertext = Buffer.from("changed").toString("base64"); },
  ];
  for (const mutate of mutations) {
    const vault = structuredClone(values.consensusVault); mutate(vault);
    const passwordBuffer = Buffer.from(values.consensusPassword);
    assert.throws(() => createValidatorReadinessSignerCustody({ encryptedVault: vault,
      expectedVaultCommitment: values.consensusSignerBootstrap.vaultCommitment,
      passwordBuffer, role: "consensus" }), /custody initialization failed/);
    assert.ok(passwordBuffer.equals(Buffer.alloc(passwordBuffer.length)));
  }
  for (const role of ["gateway", "CONSENSUS", undefined]) {
    const passwordBuffer = Buffer.from(values.consensusPassword);
    assert.throws(() => createValidatorReadinessSignerCustody({
      encryptedVault: values.consensusVault,
      expectedVaultCommitment: values.consensusSignerBootstrap.vaultCommitment,
      passwordBuffer, role }), /custody initialization failed/);
    assert.ok(passwordBuffer.equals(Buffer.alloc(passwordBuffer.length)));
  }
});

test("custody requires the exact bootstrap vault commitment", () => {
  const values = setup();
  const freshEncryption = encryptWallet(values.candidate, values.consensusPassword,
    { label: "Consensus custody" });
  assert.notDeepEqual(freshEncryption, values.consensusVault);
  const commitments = [
    undefined,
    { ...values.consensusSignerBootstrap.vaultCommitment, vaultHash: "sha3-256:" + "00".repeat(32) },
    { ...values.consensusSignerBootstrap.vaultCommitment, extra: true },
  ];
  for (const expectedVaultCommitment of commitments) {
    const passwordBuffer = Buffer.from(values.consensusPassword);
    assert.throws(() => createValidatorReadinessSignerCustody({
      encryptedVault: values.consensusVault, expectedVaultCommitment, passwordBuffer,
      role: "consensus",
    }), /custody initialization failed/);
    assert.ok(passwordBuffer.equals(Buffer.alloc(passwordBuffer.length)));
  }
  const passwordBuffer = Buffer.from(values.consensusPassword);
  assert.throws(() => createValidatorReadinessSignerCustody({
    encryptedVault: freshEncryption,
    expectedVaultCommitment: values.consensusSignerBootstrap.vaultCommitment,
    passwordBuffer, role: "consensus",
  }), /custody initialization failed/);
  assert.ok(passwordBuffer.equals(Buffer.alloc(passwordBuffer.length)));
});

test("decrypted private-key base64 and DER parsing fail closed", () => {
  const values = setup();
  const validPlaintext = Buffer.from(values.candidate.privateKey, "ascii");
  const validRewrapped = replaceEncryptedPlaintext(values.consensusVault,
    values.consensusPassword, validPlaintext);
  const validPassword = Buffer.from(values.consensusPassword);
  createValidatorReadinessSignerCustody({ encryptedVault: validRewrapped,
    expectedVaultCommitment: encryptedVaultPublicCommitment(validRewrapped),
    passwordBuffer: validPassword, role: "consensus" });
  assert.ok(validPassword.equals(Buffer.alloc(validPassword.length)));
  validPlaintext.fill(0);

  for (const plaintext of [Buffer.from("AB==", "ascii"), Buffer.from("AA==", "ascii"),
    Buffer.from("A===", "ascii"), Buffer.from("AAAA\n", "ascii")]) {
    const malformed = replaceEncryptedPlaintext(values.consensusVault,
      values.consensusPassword, plaintext);
    const passwordBuffer = Buffer.from(values.consensusPassword);
    assert.throws(() => createValidatorReadinessSignerCustody({ encryptedVault: malformed,
      expectedVaultCommitment: encryptedVaultPublicCommitment(malformed), passwordBuffer,
      role: "consensus" }), /custody initialization failed/);
    assert.ok(passwordBuffer.equals(Buffer.alloc(passwordBuffer.length)));
    plaintext.fill(0);
  }
});

test("session-bound consumers reject a role capability created from the other role key", () => {
  const values = setup(); const passwordBuffer = Buffer.from(values.consensusPassword);
  const wrongIdentity = createValidatorReadinessSignerCustody({
    encryptedVault: values.consensusVault,
    expectedVaultCommitment: values.consensusSignerBootstrap.vaultCommitment,
    passwordBuffer, role: "transport",
  });
  assert.throws(() => createValidatorReadinessSignerReadyWithCapability({
    bootstrap: values.transportSignerBootstrap, pid: 4321, signer: wrongIdentity,
  }, { now: READINESS_SIGNER_NOW }), /capability is invalid/);
  const channel = pair();
  assert.throws(() => createValidatorReadinessTransportSignerEndpoint({
    now: () => READINESS_SIGNER_NOW, rolePackage: values.transportRolePackage,
    signer: wrongIdentity, stream: channel.right,
    trustedCurrentHeight: () => values.context.checkpoint.height,
  }), /endpoint signer is invalid/);
  channel.left.destroy(); channel.right.destroy();
});

test("READY constructor refuses a capability with any hidden or generic surface", () => {
  const values = setup(); const signer = custody(values, "consensus");
  for (const [name, value] of [["exportPrivateKey", () => "secret"],
    ["keyObject", {}], [Symbol("hidden"), true]]) {
    const expanded = Object.create(null);
    Object.defineProperties(expanded, Object.getOwnPropertyDescriptors(signer));
    Object.defineProperty(expanded, name, { value }); Object.freeze(expanded);
    assert.throws(() => createValidatorReadinessSignerReadyWithCapability({
      bootstrap: values.consensusSignerBootstrap, pid: 4321, signer: expanded,
    }, { now: READINESS_SIGNER_NOW }), /capability is invalid/);
  }
  const accessor = Object.create(null);
  for (const field of ["address", "algorithm", "publicKey"]) {
    Object.defineProperty(accessor, field, { enumerable: true, get: () => signer[field] });
  }
  for (const method of ["signReadinessConsensusInput",
    "signValidatorReadinessReadyInput"]) {
    Object.defineProperty(accessor, method, { value: signer[method] });
  }
  Object.freeze(accessor);
  assert.throws(() => createValidatorReadinessSignerReadyWithCapability({
    bootstrap: values.consensusSignerBootstrap, pid: 4321, signer: accessor,
  }, { now: READINESS_SIGNER_NOW }), /capability is invalid/);
});

test("fixed signers reject aborts before and immediately after the key operation", () => {
  const values = setup(); const signer = custody(values, "transport");
  const before = new AbortController(); before.abort(new Error("before"));
  assert.throws(() => signer.signReadinessTransportInput({ value: 1 },
    { signal: before.signal }), /before/);
  let reads = 0;
  const after = { get aborted() { reads += 1; return reads >= 3; },
    reason: new Error("after") };
  assert.throws(() => signer.signReadinessTransportInput({ value: 1 }, { signal: after }), /after/);
  assert.throws(() => signer.signReadinessTransportInput({ value: 1 }, { domain: "OTHER" }));
});

test("custody integrates with the existing endpoint and semantic duplicates sign once", async () => {
  const values = setup(); const signer = custody(values, "transport"); const channel = pair();
  const endpoint = createValidatorReadinessTransportSignerEndpoint({ maxOperations: 16,
    maxRequests: 32, now: () => READINESS_SIGNER_NOW,
    rolePackage: values.transportRolePackage, signer, stream: channel.right,
    trustedCurrentHeight: () => values.context.checkpoint.height });
  const requests = Array.from({ length: 20 }, () =>
    createValidatorReadinessTransportSignRequest({ challenge: values.challenge,
      gatewayRolePackage: values.gatewayRolePackage }, { now: READINESS_SIGNER_NOW }));
  const decoder = createValidatorReadinessSignerFrameDecoder(); const responses = [];
  await new Promise((resolve, reject) => {
    channel.left.on("data", (chunk) => {
      try { responses.push(...decoder.push(chunk)); if (responses.length === requests.length) resolve(); }
      catch (error) { reject(error); }
    });
    channel.left.on("error", reject);
    channel.left.write(Buffer.concat(requests.map(encodeValidatorReadinessSignerFrame)));
  });
  assert.equal(responses.length, 20);
  // ML-DSA signatures are randomized; equality here demonstrates that the endpoint returned one
  // cached key operation rather than invoking custody once per semantic duplicate.
  assert.equal(new Set(responses.map((item) =>
    item.transportResponse.transportSignature)).size, 1);
  assert.deepEqual(endpoint.metrics(), { completedOperations: 1, operations: 1, poisoned: false,
    requestIds: 20, requests: 20, reusedOperations: 19 });
  endpoint.close(); channel.left.destroy();
});

test("custody source exposes one factory and no generic/private serialization surface", () => {
  assert.deepEqual([...SOURCE.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
    .map((match) => match[1]), ["createValidatorReadinessSignerCustody"]);
  assert.doesNotMatch(SOURCE, /decryptWallet|\.toString\(["'](?:utf8|utf-8|ascii)["']\)|privateKey\s*:|export\s+\{/u);
  assert.doesNotMatch(SOURCE, /defineProperties[\s\S]*?\bsign\s*:/u);
});
