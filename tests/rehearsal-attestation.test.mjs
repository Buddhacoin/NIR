import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, generateWallet, publicWallet } from "../blockchain/crypto.mjs";
import {
  acceptRehearsalAttestationQuorum, assembleRehearsalAttestationPackage,
  createProductionPreflightRehearsalInput, createRehearsalAttestorSet,
  loadRehearsalAttestationStore, signRehearsalStatement,
  verifyProductionPreflightRehearsalInput, verifyRehearsalAttestation,
  verifyRehearsalAttestationPackage,
} from "../blockchain/rehearsal-attestation.mjs";

const NOW = 1_500;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nir-attestation-"));
  const wallets = Array.from({ length: 4 }, generateWallet);
  const operators = wallets.map((wallet, index) => ({ ...publicWallet(wallet),
    operatorId: `operator-${index}` }));
  const operatorSet = createRehearsalAttestorSet({ operators, threshold: 3 });
  const statement = { drillPlanHash: "0".repeat(64), expiresAt: 2_000,
    format: "nir-rehearsal-attestation-v1",
    genesisHash: "1".repeat(64), networkId: "nir-rehearsal-test",
    observedAt: 1_000, releaseCheckpointHash: `sha3-256:${"2".repeat(64)}`,
    releaseManifestHash: "3".repeat(64), reportHash: `sha3-256:${"4".repeat(64)}`,
    runNonce: "5".repeat(64), setId: operatorSet.setId, validatorTip: "6".repeat(64), version: 1 };
  const attestations = wallets.slice(0, 3).map((wallet, index) =>
    signRehearsalStatement(statement, { operatorId: `operator-${index}`, wallet }, operatorSet));
  const options = { maxFutureSkewMs: 100, now: NOW, operatorSet };
  return { attestations, operatorSet, options, root, statement, wallets };
}

test("unique external operator quorum produces an offline-verifiable preflight input", () => {
  const values = fixture();
  try {
    const envelope = assembleRehearsalAttestationPackage(values.attestations, values.options);
    assert.equal(envelope.attestations.length, 3);
    assert.deepEqual(verifyRehearsalAttestationPackage(envelope, values.options), envelope);
    const input = createProductionPreflightRehearsalInput(envelope, values.options);
    assert.equal(input.physicalIndependenceClaimed, false);
    assert.deepEqual(verifyProductionPreflightRehearsalInput(input, values.options), input);
    const foreignWallets = Array.from({ length: 3 }, generateWallet);
    const foreignSet = createRehearsalAttestorSet({ threshold: 2,
      operators: foreignWallets.map((wallet, index) => ({ ...publicWallet(wallet),
        operatorId: `foreign-${index}` })) });
    assert.throws(() => verifyRehearsalAttestationPackage(envelope,
      { ...values.options, operatorSet: foreignSet }), /untrusted operator set/);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("forged, stale, future, duplicate, mixed-run, and equivocated attestations fail closed", () => {
  const values = fixture();
  try {
    const forged = structuredClone(values.attestations[0]); forged.signature = forged.signature.slice(0, -2) + "AA";
    assert.throws(() => verifyRehearsalAttestation(forged, values.options), /invalid/);
    assert.throws(() => verifyRehearsalAttestation(values.attestations[0],
      { ...values.options, now: 2_001 }), /stale/);
    assert.throws(() => verifyRehearsalAttestation(values.attestations[0],
      { ...values.options, now: 899, maxFutureSkewMs: 100 }), /future/);
    assert.throws(() => assembleRehearsalAttestationPackage([
      values.attestations[0], values.attestations[0], values.attestations[1], values.attestations[2],
    ], values.options), /duplicate/);
    const other = { ...values.statement, runNonce: "7".repeat(64) };
    const mixed = signRehearsalStatement(other,
      { operatorId: "operator-2", wallet: values.wallets[2] }, values.operatorSet);
    assert.throws(() => assembleRehearsalAttestationPackage([
      values.attestations[0], values.attestations[1], mixed,
    ], values.options), /mix/);
    const equivocated = signRehearsalStatement(other,
      { operatorId: "operator-0", wallet: values.wallets[0] }, values.operatorSet);
    assert.throws(() => assembleRehearsalAttestationPackage([
      values.attestations[0], equivocated, values.attestations[1], values.attestations[2],
    ], values.options), /equivocation/);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("durable store survives restart and rejects replay, nonce equivocation, and head rollback", () => {
  const values = fixture(); const store = join(values.root, "store");
  try {
    const first = acceptRehearsalAttestationQuorum(store, values.attestations, values.options);
    assert.equal(first.preflightInput.physicalIndependenceClaimed, false);
    assert.equal(loadRehearsalAttestationStore(store).length, 1);
    assert.throws(() => acceptRehearsalAttestationQuorum(store, values.attestations, values.options), /replayed/);

    const changed = { ...values.statement, validatorTip: "8".repeat(64) };
    const changedAttestations = values.wallets.slice(0, 3).map((wallet, index) =>
      signRehearsalStatement(changed, { operatorId: `operator-${index}`, wallet }, values.operatorSet));
    assert.throws(() => acceptRehearsalAttestationQuorum(store, changedAttestations, values.options),
      /nonce equivocation/);

    const oldHead = readFileSync(join(store, "HEAD.json"));
    const nextStatement = { ...values.statement, observedAt: 1_100, expiresAt: 2_100,
      runNonce: "9".repeat(64) };
    const next = values.wallets.slice(0, 3).map((wallet, index) =>
      signRehearsalStatement(nextStatement, { operatorId: `operator-${index}`, wallet }, values.operatorSet));
    acceptRehearsalAttestationQuorum(store, next, { ...values.options, now: 1_600 });
    assert.equal(loadRehearsalAttestationStore(store).length, 2);
    writeFileSync(join(store, "HEAD.json"), oldHead, { mode: 0o600 });
    assert.throws(() => loadRehearsalAttestationStore(store), /rolled back|divergent/);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("crash, symlink, hardlink, root swap, and concurrent writer lock fail closed", () => {
  const crash = fixture(); const crashStore = join(crash.root, "crash-store");
  try {
    assert.throws(() => acceptRehearsalAttestationQuorum(crashStore, crash.attestations,
      { ...crash.options, _crashAfterRecord: true }), /injected/);
    assert.throws(() => loadRehearsalAttestationStore(crashStore), /head copy is missing/);
  } finally { rmSync(crash.root, { force: true, recursive: true }); }

  const values = fixture(); const store = join(values.root, "store");
  try {
    acceptRehearsalAttestationQuorum(store, values.attestations, values.options);
    const record = join(store, readdirSync(store).find((name) => /^0/.test(name)));
    linkSync(record, join(values.root, "linked-record"));
    assert.throws(() => loadRehearsalAttestationStore(store), /unsafe/);
    rmSync(join(values.root, "linked-record"));

    const original = `${store}-original`; const replacement = `${store}-replacement`;
    mkdirSync(replacement, { mode: 0o700 });
    assert.throws(() => loadRehearsalAttestationStore(store, { _afterRootOpen: () => {
      renameSync(store, original); symlinkSync(replacement, store);
    } }), /changed/);
    rmSync(store); renameSync(original, store);

    const lock = join(store, ".writer.lock"); writeFileSync(lock, "owned\n", { mode: 0o600 });
    const nextStatement = { ...values.statement, observedAt: 1_100, expiresAt: 2_100,
      runNonce: "a".repeat(64) };
    const next = values.wallets.slice(0, 3).map((wallet, index) =>
      signRehearsalStatement(nextStatement, { operatorId: `operator-${index}`, wallet }, values.operatorSet));
    assert.throws(() => acceptRehearsalAttestationQuorum(store, next,
      { ...values.options, now: 1_600 }), /EEXIST/);
    assert.equal(readFileSync(lock, "utf8"), "owned\n");
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});

test("portable CLI accepts and offline-verifies a canonical quorum package", () => {
  const values = fixture();
  try {
    const setPath = join(values.root, "set.json");
    const attestationsPath = join(values.root, "attestations.json");
    writeFileSync(setPath, `${canonicalJson(values.operatorSet)}\n`, { mode: 0o600 });
    writeFileSync(attestationsPath, `${canonicalJson(values.attestations)}\n`, { mode: 0o600 });
    const accepted = JSON.parse(execFileSync(process.execPath,
      ["blockchain/rehearsal-attestation-cli.mjs", "accept", join(values.root, "cli-store"),
        setPath, attestationsPath, String(NOW), "100"], {
        cwd: new URL("..", import.meta.url), encoding: "utf8",
      }));
    const inputPath = join(values.root, "input.json");
    writeFileSync(inputPath, `${canonicalJson(accepted.preflightInput)}\n`, { mode: 0o600 });
    const verified = JSON.parse(execFileSync(process.execPath,
      ["blockchain/rehearsal-attestation-cli.mjs", "verify", inputPath, setPath,
        String(NOW), "100"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }));
    assert.deepEqual(verified, accepted.preflightInput);
  } finally { rmSync(values.root, { force: true, recursive: true }); }
});
