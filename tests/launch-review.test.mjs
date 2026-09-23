import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import { parseConsensusJson } from "../blockchain/consensus-json.mjs";
import { createLaunchReview, signLaunchReview, verifyLaunchReview } from "../blockchain/launch-review.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";

const NOW = 1_800_000_000_000;
const H = (value) => value.repeat(64);

function fixture() {
  const wallets = Array.from({ length: 6 }, generateWallet);
  const reviewers = wallets.map((wallet, index) => ({ ...publicWallet(wallet),
    reviewerId: `${index < 4 ? "operator" : "security"}-${index}`, role: index < 4 ? "operator" : "security-reviewer" }));
  const review = createLaunchReview({ evidence: [...Array(14).keys()].map((gate) => ({
    artifactHash: H(String(gate % 10)), gate, resultHash: H(String((gate + 1) % 10)),
  })), expiresAt: NOW + 60_000, networkId: "nir-public-dev", observedAt: NOW - 1_000, reviewers });
  return { review, reviewers, wallets };
}

test("launch review binds every gate and every configured reviewer", () => {
  const values = fixture(); let signed = values.review;
  values.wallets.forEach((wallet, index) => { signed = signLaunchReview(signed, wallet, values.reviewers[index].reviewerId); });
  assert.deepEqual(verifyLaunchReview(signed, { expectedNetworkId: "nir-public-dev", now: NOW }), {
    approvals: 6, evidenceGates: 14, networkId: "nir-public-dev", reviewHash: signed.reviewHash,
    status: "LAUNCH-REVIEW-CRYPTOGRAPHIC-PASS",
  });
});

test("launch review rejects missing gates, forged approvals, and stale contexts", () => {
  const values = fixture();
  assert.throws(() => createLaunchReview({ ...values.review, evidence: values.review.evidence.slice(1) }), /membership|evidence/);
  const reusedKey = structuredClone(values.review);
  reusedKey.reviewers[1].address = reusedKey.reviewers[0].address;
  reusedKey.reviewers[1].publicKey = reusedKey.reviewers[0].publicKey;
  assert.throws(() => createLaunchReview(reusedKey), /duplicated/);
  const partlySigned = signLaunchReview(values.review, values.wallets[0], values.reviewers[0].reviewerId);
  assert.throws(() => verifyLaunchReview(partlySigned, { expectedNetworkId: "nir-public-dev", now: NOW }), /every configured/);
  const forged = structuredClone(partlySigned); forged.approvals[0].signature = "AAAA";
  assert.throws(() => signLaunchReview(forged, values.wallets[1], values.reviewers[1].reviewerId), /forged/);
  let signed = values.review;
  values.wallets.forEach((wallet, index) => { signed = signLaunchReview(signed, wallet, values.reviewers[index].reviewerId); });
  assert.throws(() => verifyLaunchReview(signed, { expectedNetworkId: "nir-public-dev", now: NOW + 60_001 }), /context/);
});

test("launch review CLI fails closed without an exact command", () => {
  const result = spawnSync(process.execPath, ["blockchain/launch-review-cli.mjs"], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /launch review command failed/);
});

test("launch review CLI emits canonical JSON suitable for the next signed step", () => {
  const values = fixture(); const root = mkdtempSync(join(tmpdir(), "nir-launch-review-"));
  const inputPath = join(root, "input.json");
  try {
    const { approvals, reviewHash, ...input } = values.review;
    writeFileSync(inputPath, `${canonicalJson(input)}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, ["blockchain/launch-review-cli.mjs", "create", inputPath], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env },
    });
    assert.equal(result.status, 0);
    const created = parseConsensusJson(result.stdout);
    assert.equal(created.reviewHash, values.review.reviewHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("launch review CLI signs through an inherited restricted password descriptor", () => {
  const values = fixture(); const root = mkdtempSync(join(tmpdir(), "nir-launch-review-sign-"));
  const reviewPath = join(root, "review.json"); const vaultPath = join(root, "vault.json");
  const passwordPath = join(root, "password"); const password = "launch-review-password-long";
  let descriptor;
  try {
    writeFileSync(reviewPath, `${canonicalJson(values.review)}\n`, { mode: 0o600 });
    writeFileSync(vaultPath, `${canonicalJson(encryptWallet(values.wallets[0], password))}\n`, { mode: 0o600 });
    writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
    descriptor = openSync(passwordPath, "r");
    const result = spawnSync(process.execPath, ["blockchain/launch-review-cli.mjs", "sign",
      reviewPath, vaultPath, values.reviewers[0].reviewerId], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NIR_LAUNCH_REVIEW_PASSWORD_FD: "3" },
      stdio: ["ignore", "pipe", "pipe", descriptor],
    });
    closeSync(descriptor); descriptor = undefined;
    assert.equal(result.status, 0);
    const signed = parseConsensusJson(result.stdout);
    assert.equal(signed.approvals.length, 1);
    assert.equal(signed.approvals[0].reviewerId, values.reviewers[0].reviewerId);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});
