import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { multisigAddress } from "../blockchain/chain.mjs";
import { PROTOCOL_VERSION, TREASURY_BPS, TREASURY_VESTING_MS } from "../blockchain/constants.mjs";
import { generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import {
  initializeValidatorFromCeremony,
  reverifyValidatorFromCeremony,
} from "../blockchain/ceremony-validator-init.mjs";
import {
  compileGenesis, createGenesisApprovalEnvelope, createGenesisPlan, signGenesisPlan,
  signGenesisPeerRegistry,
} from "../blockchain/genesis-ceremony.mjs";
import {
  assembleCeremonyRegistryAnchor, signCeremonyRegistryAnchor,
} from "../blockchain/genesis-ceremony-anchor.mjs";
import { signReleaseManifest } from "../blockchain/release-manifest.mjs";
import { encryptWallet } from "../blockchain/vault.mjs";

const VALIDATOR_PASSWORD = "validator-password-2026";
const TRANSPORT_PASSWORD = "transport-password-2026";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function certificate(directory, name) {
  const key = join(directory, `${name}.key`);
  const cert = join(directory, `${name}.pem`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${name}.example`, "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  const pem = readFileSync(cert);
  return {
    fingerprint: new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase(),
    pem,
  };
}

function roles(wallets, prefix, port) {
  return wallets.map((wallet, index) => ({
    ...publicWallet(wallet), endpoint: `http://127.0.0.1:${port + index}`,
    operatorId: `${prefix}-${index}`,
  }));
}

function fixture(root) {
  const tls = certificate(root, "validator");
  const wrongTls = certificate(root, "wrong-validator");
  const validators = Array.from({ length: 4 }, generateWallet);
  const transports = Array.from({ length: 4 }, generateWallet);
  const evaluators = Array.from({ length: 4 }, generateWallet);
  const beacons = Array.from({ length: 4 }, generateWallet);
  const operators = Array.from({ length: 4 }, generateWallet);
  const guardians = Array.from({ length: 3 }, generateWallet);
  const releaseSigner = generateWallet();
  const releasePayload = {
    files: [{ executable: false, path: "package.json", sha3_256: digest("package"), size: 7 }],
    format: "nir-source-release-v1",
    releaseVersion: "0.2.0",
    sourceRevision: digest("source-revision"),
  };
  const releaseManifest = {
    ...releasePayload, manifestHash: hashObject(releasePayload, "RELEASE_MANIFEST_HASH"),
  };
  const signedRelease = signReleaseManifest(releaseManifest, releaseSigner);
  const releaseOptions = { signedRelease, trustedAddress: releaseSigner.address };
  const plan = createGenesisPlan({
    beaconAuthorities: roles(beacons, "beacon", 9300),
    ceremonyOperators: operators.map((wallet, index) => ({
      ...publicWallet(wallet), contribution: digest(`contribution-${index}`),
      nonce: digest(`nonce-${index}`), operatorId: `ceremony-${index}`,
    })),
    evaluators: roles(evaluators, "evaluator", 9200),
    genesisTimestamp: 0,
    networkId: "nir-validator-onboarding-devnet",
    protocolVersion: PROTOCOL_VERSION,
    sourceReleaseManifestHash: releaseManifest.manifestHash,
    treasury: {
      address: multisigAddress(guardians.map(({ publicKey }) => publicKey), 2),
      algorithm: "ml-dsa-65-multisig",
      memberPublicKeys: guardians.map(({ publicKey }) => publicKey),
      threshold: 2,
      vestingPolicy: {
        allocationBps: Number(TREASURY_BPS), durationMs: TREASURY_VESTING_MS,
        model: "linear-from-genesis",
      },
    },
    validators: validators.map((wallet, index) => ({
      ...publicWallet(wallet), endpoint: `https://validator-${index}.example:9443`,
      operatorId: `validator-${index}`, tlsCertificateSha256: tls.fingerprint,
      transport: publicWallet(transports[index]),
    })),
  }, releaseOptions);
  const envelope = createGenesisApprovalEnvelope(
    plan,
    operators.slice(0, 3).map((wallet) => signGenesisPlan(plan, wallet, releaseOptions)),
    validators.slice(0, 3).map((wallet) => signGenesisPeerRegistry(plan, wallet, releaseOptions)),
    releaseOptions,
  );
  const compiled = compileGenesis(plan, envelope, releaseOptions);
  const anchorPayload = {
    count: 1,
    latestGenesisHash: compiled.genesisHash,
    latestPlanCommitment: plan.commitment,
    registryHead: digest("external-registry-head"),
    releaseManifestHash: releaseManifest.manifestHash,
  };
  const anchor = assembleCeremonyRegistryAnchor(
    anchorPayload, plan,
    operators.slice(0, 3).map((wallet) =>
      signCeremonyRegistryAnchor(anchorPayload, plan, wallet, releaseOptions)),
    releaseOptions,
  );
  return {
    anchor, envelope, genesis: compiled.genesis, plan, signedRelease,
    tlsCertificatePem: tls.pem, transportPassword: TRANSPORT_PASSWORD,
    transportVault: encryptWallet(transports[0], TRANSPORT_PASSWORD, { label: "transport" }),
    trustedAddress: releaseSigner.address, validatorPassword: VALIDATOR_PASSWORD,
    validatorVault: encryptWallet(validators[0], VALIDATOR_PASSWORD, { label: "validator" }),
    validators, transports, wrongTls,
  };
}

function cloneInputs(inputs) {
  return structuredClone({
    anchor: inputs.anchor, envelope: inputs.envelope, genesis: inputs.genesis, plan: inputs.plan,
    signedRelease: inputs.signedRelease, tlsCertificatePem: inputs.tlsCertificatePem,
    transportPassword: inputs.transportPassword, transportVault: inputs.transportVault,
    trustedAddress: inputs.trustedAddress, validatorPassword: inputs.validatorPassword,
    validatorVault: inputs.validatorVault,
  });
}

test("ceremony onboarding installs and reverifies only local encrypted evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-validator-ceremony-"));
  try {
    const inputs = fixture(root);
    const target = join(root, "operator-0");
    const initialized = initializeValidatorFromCeremony(target, cloneInputs(inputs));
    assert.equal(initialized.validatorAddress, inputs.validators[0].address);
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    const generation = join(dirname(target), readlinkSync(target));
    assert.equal(lstatSync(generation).mode & 0o777, 0o700);
    for (const name of readdirSync(generation)) {
      assert.equal(lstatSync(join(generation, name)).mode & 0o777, 0o600);
    }
    assert.equal(reverifyValidatorFromCeremony(target, {
      transportPassword: TRANSPORT_PASSWORD,
      trustedAddress: inputs.trustedAddress,
      validatorPassword: VALIDATOR_PASSWORD,
    }).verified, true);
    const installed = readdirSync(generation)
      .map((name) => readFileSync(join(generation, name)))
      .map((value) => value.toString("utf8")).join("\n");
    assert.equal(installed.includes("privateKey"), false);
    assert.equal(installed.includes(inputs.validators[0].privateKey), false);
    assert.equal(installed.includes(inputs.transports[0].privateKey), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ceremony onboarding rejects identity, topology, release, anchor, and filesystem mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-validator-ceremony-negative-"));
  try {
    const inputs = fixture(root);
    const attempt = (name, mutate, pattern) => {
      const value = cloneInputs(inputs); mutate(value);
      assert.throws(() => initializeValidatorFromCeremony(join(root, name), value), pattern);
      assert.equal(readdirSync(root).some((entry) => entry.startsWith(`.${name}.nir-`)), false);
    };
    attempt("wrong-operator", (value) => {
      value.validatorVault = encryptWallet(generateWallet(), VALIDATOR_PASSWORD);
    }, /not a ceremony validator/);
    attempt("wrong-validator-password", (value) => {
      value.validatorPassword = "wrong-password-2026";
    }, /vault password/);
    attempt("wrong-transport", (value) => {
      value.transportVault = encryptWallet(inputs.transports[1], TRANSPORT_PASSWORD);
    }, /transport vault/);
    attempt("wrong-tls", (value) => { value.tlsCertificatePem = inputs.wrongTls.pem; }, /TLS certificate/);
    attempt("wrong-genesis", (value) => { value.genesis.networkId += "-mutated"; }, /compiled genesis/);
    attempt("wrong-release", (value) => { value.signedRelease.manifest.releaseVersion = "0.2.1"; },
      /manifest hash|not trusted/);
    attempt("wrong-anchor", (value) => { value.anchor.payload.registryHead = digest("mutated"); },
      /approval/);

    const existing = join(root, "existing");
    initializeValidatorFromCeremony(existing, cloneInputs(inputs));
    assert.throws(() => initializeValidatorFromCeremony(existing, cloneInputs(inputs)), /must not exist/);
    const link = join(root, "preexisting-link");
    symlinkSync(basename(existing), link);
    assert.throws(() => initializeValidatorFromCeremony(link, cloneInputs(inputs)), /must not exist/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
