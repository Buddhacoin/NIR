import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { multisigAddress } from "../blockchain/chain.mjs";
import { PROTOCOL_VERSION, TREASURY_BPS, TREASURY_VESTING_MS } from "../blockchain/constants.mjs";
import { canonicalJson, generateWallet, hashObject, publicWallet } from "../blockchain/crypto.mjs";
import {
  initializeValidatorFromCeremony,
  loadValidatorRuntimeFromCeremony,
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
import { createPeerRequest } from "../blockchain/peer-auth.mjs";
import { requestJson } from "../blockchain/http-client.mjs";

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
    key, pem,
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startCeremonyProcess(target, port, inputs) {
  const environment = { ...process.env, NIR_TLS_KEY_PATH: inputs.tlsCertificateKeyPath };
  const child = spawn(process.execPath, [
    "blockchain/network-cli.mjs", "serve-validator", target, String(port),
    inputs.trustedAddress,
  ], {
    cwd: new URL("..", import.meta.url),
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].end(`${VALIDATOR_PASSWORD}\n`);
  child.stdio[4].end(`${TRANSPORT_PASSWORD}\n`);
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`validator startup timed out: ${errors}`)), 8_000);
    const poll = setInterval(() => {
      if (output.includes(" listening on ")) {
        clearTimeout(deadline); clearInterval(poll); resolve();
      } else if (child.exitCode !== null) {
        clearTimeout(deadline); clearInterval(poll);
        reject(new Error(`validator exited during startup: ${errors}`));
      }
    }, 10);
  });
  return {
    child,
    environment,
    logs: () => `${output}\n${errors}`,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
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
    tlsCertificateKeyPath: tls.key, tlsCertificatePem: tls.pem,
    transportPassword: TRANSPORT_PASSWORD,
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
      const metadata = lstatSync(join(generation, name));
      assert.equal(metadata.mode & 0o777, metadata.isDirectory() ? 0o700 : 0o600);
    }
    assert.equal(reverifyValidatorFromCeremony(target, {
      transportPassword: TRANSPORT_PASSWORD,
      trustedAddress: inputs.trustedAddress,
      validatorPassword: VALIDATOR_PASSWORD,
    }).verified, true);
    const installed = readdirSync(generation)
      .filter((name) => lstatSync(join(generation, name)).isFile())
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

test("ceremony runtime vault loading fails closed on password, mode, symlink, and plaintext fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "nir-validator-runtime-negative-"));
  try {
    const inputs = fixture(root);
    const target = join(root, "operator-0");
    initializeValidatorFromCeremony(target, cloneInputs(inputs));
    const generation = join(dirname(target), readlinkSync(target));
    const load = (validator = VALIDATOR_PASSWORD, transport = TRANSPORT_PASSWORD) =>
      loadValidatorRuntimeFromCeremony(target, {
        transportPasswordBuffer: Buffer.from(transport),
        trustedAddress: inputs.trustedAddress,
        validatorPasswordBuffer: Buffer.from(validator),
      });
    const validatorBuffer = Buffer.from(VALIDATOR_PASSWORD);
    const transportBuffer = Buffer.from(TRANSPORT_PASSWORD);
    const loaded = loadValidatorRuntimeFromCeremony(target, {
      transportPasswordBuffer: transportBuffer,
      trustedAddress: inputs.trustedAddress,
      validatorPasswordBuffer: validatorBuffer,
    });
    assert.ok(validatorBuffer.every((value) => value === 0));
    assert.ok(transportBuffer.every((value) => value === 0));
    loaded.validatorWallet.privateKey = "";
    loaded.transportWallet.privateKey = "";
    assert.throws(() => load("wrong-validator-password"), /vault password/);

    const validatorVaultPath = join(generation, "VALIDATOR-VAULT.json");
    chmodSync(validatorVaultPath, 0o640);
    assert.throws(() => load(), /file is unsafe/);
    chmodSync(validatorVaultPath, 0o600);

    const transportVaultPath = join(generation, "TRANSPORT-VAULT.json");
    const transportBackup = join(generation, "transport-vault-owned-backup");
    renameSync(transportVaultPath, transportBackup);
    symlinkSync("transport-vault-owned-backup", transportVaultPath);
    assert.throws(() => load(), /installed file set|file is unsafe|ELOOP/);
    unlinkSync(transportVaultPath);
    renameSync(transportBackup, transportVaultPath);

    writeFileSync(join(generation, "VALIDATOR-KEY.json"),
      `${canonicalJson(inputs.validators[0])}\n`, { mode: 0o600 });
    assert.throws(() => load(), /installed file set/);
    rmSync(join(generation, "VALIDATOR-KEY.json"));

    writeFileSync(transportVaultPath,
      `${canonicalJson(encryptWallet(inputs.transports[1], TRANSPORT_PASSWORD))}\n`,
      { mode: 0o600 });
    assert.throws(() => load(), /transport vault/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("serve-validator restarts from inherited vault-password FDs and serves TLS/P2P health", async () => {
  const root = mkdtempSync(join(tmpdir(), "nir-validator-runtime-live-"));
  let running;
  try {
    const inputs = fixture(root);
    const target = join(root, "operator-0");
    initializeValidatorFromCeremony(target, cloneInputs(inputs));
    const port = await availablePort();
    const url = `https://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      running = await startCeremonyProcess(target, port, inputs);
      const health = await requestJson(`${url}/health`, {
        tlsCertificateSha256: new X509Certificate(inputs.tlsCertificatePem)
          .fingerprint256.replaceAll(":", "").toLowerCase(),
      });
      assert.equal(health.status, 200);
      assert.equal(health.body.address, inputs.validators[0].address);
      const payload = {};
      const path = "/v1/p2p/health";
      const auth = createPeerRequest({
        body: payload, networkId: inputs.plan.networkId, path, wallet: inputs.transports[0],
      });
      const p2p = await requestJson(`${url}${path}`, {
        body: { auth, payload }, method: "POST",
        tlsCertificateSha256: inputs.plan.validators[0].tlsCertificateSha256,
      });
      assert.equal(p2p.status, 200);
      assert.equal(p2p.body.result.address, inputs.validators[0].address);
      assert.equal(running.child.spawnargs.join(" ").includes(VALIDATOR_PASSWORD), false);
      assert.equal(JSON.stringify(running.child.spawnargs).includes(TRANSPORT_PASSWORD), false);
      assert.equal(JSON.stringify(running.environment).includes(VALIDATOR_PASSWORD), false);
      assert.equal(JSON.stringify(running.environment).includes(TRANSPORT_PASSWORD), false);
      assert.equal(running.logs().includes(VALIDATOR_PASSWORD), false);
      assert.equal(running.logs().includes(TRANSPORT_PASSWORD), false);
      await running.stop();
      running = null;
    }
    const generation = join(dirname(target), readlinkSync(target));
    const scan = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? scan(path) : [readFileSync(path).toString("utf8")];
    }).join("\n");
    const contents = scan(generation);
    assert.equal(contents.includes("privateKey"), false);
    assert.equal(contents.includes(inputs.validators[0].privateKey), false);
    assert.equal(contents.includes(inputs.transports[0].privateKey), false);
  } finally {
    if (running) await running.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
