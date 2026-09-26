import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectValidatorAdmissionReadinessCertificate,
  VALIDATOR_READINESS_COLLECTOR_MAX_CONCURRENCY,
  VALIDATOR_READINESS_COLLECTOR_MAX_REQUEST_TIMEOUT_MS,
} from "../blockchain/validator-admission-readiness-collector.mjs";
import {
  createValidatorAdmissionReadinessCandidateResponse,
  createValidatorAdmissionReadinessChallenge,
  createValidatorAdmissionReadinessContext,
  createValidatorAdmissionReadinessReceipt,
  verifyValidatorAdmissionReadinessCertificate,
} from "../blockchain/validator-admission-readiness-auth.mjs";
import { generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { validatorSetId } from "../blockchain/validator-rotation.mjs";

const validatorWallets = Array.from({ length: 7 }, generateWallet);
const validators = validatorWallets.map((wallet, index) => ({
  ...publicWallet(wallet), operatorId: `validator-${index + 1}`,
}));
const peers = validators.map(({ address: validatorAddress }, index) => ({
  tlsCertificateSha256: (index + 1).toString(16).repeat(64),
  url: `https://validator-${index + 1}.example`, validatorAddress,
}));
const candidateWallet = generateWallet(); const transportWallet = generateWallet();
const context = createValidatorAdmissionReadinessContext({
  admission: { admissionId: "a".repeat(64), ...publicWallet(candidateWallet),
    endpoint: "https://candidate.example", operatorId: "candidate-one",
    tlsCertificateSha256: "b".repeat(64), transport: publicWallet(transportWallet) },
  chainIdentityGenesisHash: "c".repeat(64), checkpoint: { blockHash: "d".repeat(64),
    height: 100, stateRoot: "e".repeat(64), validatorSetId: validatorSetId(validators) },
  expiresAtHeight: 116, networkId: "nir-readiness-test", nonce: 3,
});
const receipts = new Map(validatorWallets.map((wallet, index) => {
  const challenge = createValidatorAdmissionReadinessChallenge({
    challengeNonce: (index + 1).toString(16).padStart(64, "0"), context,
    observerWallet: wallet, validators,
  });
  const candidateResponse = createValidatorAdmissionReadinessCandidateResponse({
    candidateWallet, challenge, context, transportWallet, validators,
  });
  return [wallet.address, createValidatorAdmissionReadinessReceipt({
    candidateResponse, observerWallet: wallet, validators,
  })];
}));

test("public collector verifies, deduplicates, sorts, and emits exactly one quorum", async () => {
  const delays = new Map(validators.map((validator, index) =>
    [validator.address, (validators.length - index) % 3]));
  const result = await collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ context: supplied, validator }) => {
      assert.deepEqual(supplied, context);
      supplied.networkId = "mutated-by-untrusted-collector-adapter";
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delays.get(validator.address)));
      return receipts.get(validator.address);
    },
    concurrency: 3, context, peers, validators,
  });
  const quorum = Math.floor((validators.length * 2) / 3) + 1;
  assert.equal(result.status, "certificate-collected");
  assert.equal(result.context.networkId, context.networkId);
  assert.equal(result.receipts.length, quorum);
  assert.deepEqual(result.receipts.map(({ observationAttestation }) =>
    observationAttestation.validator),
    validators.map(({ address: value }) => value).sort().slice(0, quorum));
  assert.match(result.certificateHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyValidatorAdmissionReadinessCertificate(result, { validators }), result);

  const repeated = await collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => receipts.get(validator.address),
    concurrency: 1, context, peers: [...peers].reverse(),
    validators: [...validators].reverse(),
  });
  assert.deepEqual(repeated, result);
});

test("collector bounds concurrency and tolerates failures only while a quorum remains", async () => {
  let active = 0; let maximum = 0;
  const failed = new Set(validators.slice(-2).map(({ address: value }) => value));
  const result = await collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      active -= 1;
      if (failed.has(validator.address)) throw new Error("offline");
      return receipts.get(validator.address);
    },
    concurrency: 2, context, peers, validators,
  });
  assert.equal(maximum, 2);
  assert.equal(result.receipts.length, 5);

  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => {
      if (validators.findIndex(({ address }) => address === validator.address) < 3) {
        throw new Error("offline");
      }
      return receipts.get(validator.address);
    },
    context, peers, validators,
  }), /quorum is not reached/);
});

test("collector aborts mid-flight and bounds a never-resolving request", async () => {
  const controller = new AbortController();
  const collecting = collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async () => new Promise(() => {}), concurrency: 2, context, peers,
    requestTimeoutMs: 1_000, signal: controller.signal, validators,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(collecting, /collection was aborted/);

  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async () => new Promise(() => {}), concurrency: 4, context, peers,
    requestTimeoutMs: 10, validators,
  }), /quorum is not reached/);
});

test("a hanging or late-rejecting minority cannot delay a deterministic exact quorum", async () => {
  const ordered = validators.map(({ address }) => address).sort();
  const minority = new Set(ordered.slice(-2));
  const result = await collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => {
      if (validator.address === ordered.at(-1)) return new Promise(() => {});
      if (minority.has(validator.address)) {
        return new Promise((resolve, reject) => setTimeout(() => reject(new Error("late")), 25));
      }
      return receipts.get(validator.address);
    },
    concurrency: 7, context, peers, requestTimeoutMs: 1_000, validators,
  });
  assert.deepEqual(result.receipts.map(({ observationAttestation }) =>
    observationAttestation.validator), ordered.slice(0, 5));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
});

test("collector rejects signer substitution, malformed topology, oversized data, and abort", async () => {
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => {
      const index = validators.findIndex(({ address }) => address === validator.address);
      return receipts.get(validators[(index + 1) % validators.length].address);
    },
    context, peers, validators,
  }), /quorum is not reached/);
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => receipts.get(validator.address), context,
    peers: peers.slice(1), validators,
  }), /membership is invalid/);
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => receipts.get(validator.address), context,
    peers: [...peers.slice(0, -1), peers[0]], validators,
  }), /peer set is invalid/);
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => receipts.get(validator.address),
    concurrency: VALIDATOR_READINESS_COLLECTOR_MAX_CONCURRENCY + 1,
    context, peers, validators,
  }), /options are invalid/);
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => receipts.get(validator.address), context, peers,
    requestTimeoutMs: VALIDATOR_READINESS_COLLECTOR_MAX_REQUEST_TIMEOUT_MS + 1, validators,
  }), /options are invalid/);
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => receipts.get(validator.address),
    context: { ...context, padding: "x".repeat(300 * 1024) }, peers, validators,
  }), /context is too large/);
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => ({ ...receipts.get(validator.address),
      padding: "x".repeat(300 * 1024) }),
    context, peers, validators,
  }), /quorum is not reached/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collectValidatorAdmissionReadinessCertificate({
    collectReceipt: async ({ validator }) => receipts.get(validator.address), context, peers,
    signal: controller.signal, validators,
  }), /aborted/);
});

test("collector import graph contains no network, vault, join, wallet, or signer authority", () => {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)),
    "../blockchain/validator-admission-readiness-collector.mjs");
  const visited = new Set(); const specifiers = new Set();
  const walk = (filename) => {
    if (visited.has(filename)) return;
    visited.add(filename);
    const source = readFileSync(filename, "utf8");
    const imports = /(?:^|\n)\s*import\s+(?!\()(?:(?:[\s\S]*?)\s+from\s+)?["']([^"']+)["']\s*;/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1]; specifiers.add(specifier);
      if (specifier.startsWith(".")) walk(resolve(dirname(filename), specifier));
    }
  };
  walk(entry);
  assert.equal([...visited].some((filename) =>
    /(?:vault|wallet|validator-join|offline-signer|wallet-files)\.mjs$/.test(filename)), false);
  for (const forbidden of ["node:http", "node:https", "node:net", "node:tls", "node:fs"]) {
    assert.equal(specifiers.has(forbidden), false);
  }
  const direct = readFileSync(entry, "utf8");
  assert.doesNotMatch(direct, /(?:\.\/crypto\.mjs|privateKey|wallet|vault|signObject)/);
});
